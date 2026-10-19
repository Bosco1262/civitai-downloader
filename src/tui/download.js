'use strict';

/**
 * TUI flow for "download a collection": enumerate → pick items → pick versions → start.
 *
 * The flow is deliberately short: one question in, one full-screen confirmation out. Everything the
 * user may want to change (output directory, concurrency, already-finished items) is collected on
 * that confirmation screen instead of being asked one question at a time, and Esc at any point
 * returns without starting a download.
 *
 *
 * 「下载收藏集」的 TUI 流程：枚举 → 勾选条目 → 选版本 → 开始。
 *
 * 流程刻意做短：进来一个问题，出去一屏确认。所有可能想改的东西
 * （输出目录、并发、已完成项）都收在这一屏里，不再逐个追问；
 * 任何一步按 Esc 都直接返回，不会开始下载。
 */

const prompts = require('prompts');
const fs = require('fs');
const path = require('path');
const { writeJson, formatBytes, mapPool } = require('../util');
const { dataPaths, readLibrary, getVersion, writeCollection } = require('../storage');
const { ensureBrowser } = require('../browser');
const { fetchCollectionItems } = require('../collection');
const { buildPlan, fetchModelDetail, extractFiles, versionToItem } = require('../api');
const { resolveOutDir } = require('../config');
const { parseCollectionId } = require('../urls');
const { createSiteLimiter } = require('../runtime');
const { setPin, applyPinsToItems } = require('../updater');
const { freeSpaceBytes } = require('../job');
const { t } = require('../i18n');
const view = require('./view');
const pages = require('./pages');
const screen = require('./screen');
const tasks = require('./tasks');
const { selectItems, isInteractive } = require('./select');
const { startDownloadTask, queuedDownloads } = require('./downloadTask');
const { runWithProgress } = require('./run');
const { showPlanWorkspace } = require('./ui/planWorkspace');
const list = require('./ui/list');
const { color, glyph, format } = require('./tokens');

/**
 * Rows per screen in the full-screen picker (shrinks when the terminal is short).
 * 全屏选择器每屏行数（终端太矮时会自动缩小）
 */
const PICK_PAGE_SIZE = 15;

/**
 * Whether the library already has a record of the version this plan item wants.
 * 模型库里是否已有该计划项所要版本的记录。
 */
function stateMatches(planItem, state) {
  const prev = state[planItem.modelId];
  if (!prev) return false;
  return !!getVersion(prev, planItem.versionId);
}

async function fetchItems(config, collectionId) {
  // Browser launch/navigation can stay silent for many seconds; say what is happening so a slow
  // start is not mistaken for a frozen TUI.
  //
  // 浏览器启动/导航可能好几秒没有任何输出；先把正在做什么说清楚，以免把慢启动误认为卡死。
  view.log(t('tui.download.connectingBrowser'));
  const browser = await ensureBrowser(config);
  try {
    return await fetchCollectionItems(browser, config.site, collectionId, {
      trpcPath: config.trpcPath,
      trpcInput: config.trpcInput,
      requestTimeoutMs: config.requestTimeoutMs,
      limit: createSiteLimiter(config),
      onLog: view.log,
    });
  } finally {
    await browser.disconnect().catch(() => {});
  }
}

/**
 * Pre-download filtering so that hundreds of entries need no manual scrolling through the list
 * (under a TTY the full-screen picker does it internally).
 *
 * 下载前的筛选，避免几百项时在列表里翻找（TTY 下改由全屏选择器内部完成）
 */
async function prefilter(plan) {
  const available = plan.filter((p) => !p.error);
  if (available.length <= 20) return available;

  if (isInteractive()) {
    view.log(t('tui.download.prefilterHint'));
    return available;
  }

  const keyword = await pages.promptText(t('tui.download.keywordPrompt', { count: available.length }), {
    initial: '',
  });
  if (keyword === null) return null;
  let filtered = available;
  if (keyword) {
    const needle = keyword.toLowerCase();
    filtered = filtered.filter(
      (p) => String(p.name).toLowerCase().includes(needle) || String(p.modelId).includes(needle)
    );
  }

  const types = [...new Set(available.map((p) => p.type).filter(Boolean))];
  if (types.length > 1) {
    const type = await pages.promptMenu(t('tui.download.filterByType'), [
      { title: t('tui.download.allTypes'), value: '__all__' },
      ...types.map((type_) => ({ title: type_, value: type_ })),
    ]);
    if (type === null) return null;
    if (type !== '__all__') filtered = filtered.filter((p) => p.type === type);
  }

  const baseModels = [...new Set(available.map((p) => p.baseModel).filter(Boolean))];
  if (baseModels.length > 1 && baseModels.length <= 12) {
    const base = await pages.promptMenu(t('tui.download.filterByBaseModel'), [
      { title: t('tui.download.allBaseModels'), value: '__all__' },
      ...baseModels.map((b) => ({ title: b, value: b })),
    ]);
    if (base === null) return null;
    if (base !== '__all__') filtered = filtered.filter((p) => p.baseModel === base);
  }

  if (!filtered.length) {
    view.log(t('tui.download.noMatch'));
    return null;
  }
  if (filtered.length !== available.length) {
    view.log(t('tui.download.filterResult', { filtered: filtered.length, available: available.length }));
  }
  return filtered;
}

/**
 * One-line recap of the enumerated items, shown as the picker takes over the screen.
 * 枚举结果的一行摘要，在选择器接管屏幕时显示。
 */
function prefilterSummary(available, state) {
  const bytes = available.reduce((sum, p) => sum + (p.totalBytes || 0), 0);
  const done = available.filter((p) => stateMatches(p, state)).length;
  return t('tui.download.prefilterSummary', {
    count: available.length,
    size: formatBytes(bytes),
    done: done ? t('tui.download.prefilterDone', { count: done }) : '',
  }).trim();
}

async function pickItems(plan, state) {
  const failed = plan.filter((p) => p.error);
  if (failed.length) view.log(t('tui.download.metaExcluded', { count: failed.length }));

  const available = await prefilter(plan);
  if (!available) return null;
  if (!available.length) {
    view.notice(t('tui.download.noDownloadable'), color.warning);
    return null;
  }

  const doneCount = available.filter((p) => state[p.modelId]).length;
  if (doneCount) view.log(t('tui.download.doneCount', { count: doneCount }));

  const bytes = available.reduce((sum, p) => sum + (p.totalBytes || 0), 0);
  const describe = (item) =>
    [
      item.type || '-',
      item.baseModel || '-',
      t('tui.download.fileCount', { count: (item.files || []).length }),
      stateMatches(item, state)
        ? t('tui.download.statusDownloaded')
        : state[item.modelId]
          ? t('tui.download.statusUpdated')
          : null,
      state[item.modelId] && state[item.modelId].pinnedVersionId ? t('tui.download.statusPinned') : null,
    ]
      .filter(Boolean)
      .join(view.separator());

  const selected = new Set();
  const selectTitle = t('tui.download.selectTitle', { count: available.length, size: formatBytes(bytes) });
  const initialSelected = available.filter((p) => !state[p.modelId]).map((p) => String(p.modelId));

  // Prefer the full-screen interactive picker (search, sort and scrolling are all built in);
  // fall back to the prompts multiselect when there is no TTY or the terminal misbehaves.
  //
  // 首选全屏交互选择器（搜索/排序/滚动都在里面）；非 TTY 或终端异常时回退到 prompts 多选
  if (isInteractive()) {
    const picked = await selectItems(available, {
      pageSize: PICK_PAGE_SIZE,
      initialSelected,
      title: selectTitle,
      state,
      describe,
      // The picker takes over the whole screen, so the enumeration summary would be gone: print it
      // as the first line of the takeover.
      //
      // 选择器会接管整屏，之前的枚举摘要会消失：把它作为接管后的第一行打印出来。
      onEnter: () => view.note(color.muted(`  ${prefilterSummary(available, state)}`)),
    });
    if (!picked) {
      view.decision('tui.view.decisionCancelled');
      return null;
    }
    for (const id of picked.selected) selected.add(String(id));
    view.decision('tui.view.decisionPicked', { count: selected.size });
  } else {
    const ans = await prompts({
      type: 'multiselect',
      name: 'ids',
      message: `${selectTitle}${pages.hint()}`,
      instructions: t('tui.pages.multiselectInstructions'),
      choices: available.map((p) => ({
        title: view.truncate(p.name, 70),
        value: p.modelId,
        selected: !state[p.modelId],
        description: describe(p),
      })),
    });
    if (!ans || ans.ids === undefined) return null;
    for (const id of ans.ids) selected.add(String(id));
  }

  const selectedPlan = available.filter((p) => selected.has(String(p.modelId)));
  if (!selectedPlan.length) {
    view.log(t('tui.download.noneSelected'));
    return null;
  }
  return selectedPlan;
}

async function fetchVersions(config, selectedPlan) {
  await mapPool(selectedPlan, 4, async (item) => {
    try {
      const detail = await fetchModelDetail(config.site, item.modelId, config.userAgent);
      item.versions = (detail.modelVersions || []).map((v) => ({
        id: v.id,
        name: v.name,
        baseModel: v.baseModel,
        publishedAt: v.publishedAt,
        raw: v,
      }));
      // Raw site object: mirrored into the library so every known field is recorded
      // 站点原始对象：镜像进模型库，完整记录已知字段
      item.modelMeta = detail;
    } catch (e) {
      item.versions = null;
      view.log(t('tui.download.versionListFailed', { name: item.name, error: e.message }));
    }
  });
}

/**
 * Version rows of one plan item, shaped for the shared picker.
 * 把计划项的版本转成公共选择器需要的行。
 */
function versionChoices(config, item) {
  return (item.versions || []).map((v) => {
    const files = extractFiles(v.raw, config.site, {
      fileTypes: config.fileTypes,
      primaryOnly: config.primaryOnly,
    });
    return {
      modelId: String(v.id),
      name: view.truncate(String(v.name), 64),
      type: item.type || '',
      baseModel: v.baseModel || '',
      totalBytes: files.reduce((sum, f) => sum + (Number(f.bytes) || 0), 0),
      fileCount: files.length,
      publishedAt: v.publishedAt || null,
      current: String(v.id) === String(item.versionId),
      raw: v.raw,
    };
  });
}

async function chooseVersions(config, selectedPlan) {
  const multi = selectedPlan.filter((p) => p.versions && p.versions.length > 1);
  if (!multi.length) {
    view.log(t('tui.download.singleVersionOnly'));
    return true;
  }
  view.log(t('tui.download.multiVersionNotice', { count: multi.length }));

  const pinned = [];
  for (const item of multi) {
    const rows = versionChoices(config, item);
    const initialCursor = Math.max(
      0,
      rows.findIndex((row) => String(row.modelId) === String(item.versionId))
    );
    const chosen = await pages.pickOne(rows, {
      message: t('tui.download.chooseVersionTitle', { name: view.truncate(item.name, 56) }),
      title: t('tui.download.chooseVersionTitle', { name: view.truncate(item.name, 56) }),
      describe: (row) =>
        [
          row.baseModel || '-',
          t('tui.download.fileCount', { count: row.fileCount }),
          formatBytes(row.totalBytes || 0),
          row.publishedAt ? format.date(row.publishedAt) : t('tui.download.unknownDate'),
          row.current ? t('tui.download.currentMark') : null,
        ]
          .filter(Boolean)
          .join(view.separator()),
      initialCursor,
    });
    if (!chosen) return false;

    if (String(chosen.modelId) !== String(item.versionId)) {
      Object.assign(
        item,
        versionToItem(config.site, chosen.raw, {
          fileTypes: config.fileTypes,
          primaryOnly: config.primaryOnly,
        })
      );
      view.log(t('tui.download.versionSwitched', { name: item.name, version: item.versionName }));
      pinned.push({ item, versionId: chosen.modelId });
    }
  }

  if (pinned.length) {
    const pin = await pages.promptConfirm(t('tui.download.pinConfirm', { count: pinned.length }));
    if (pin) {
      for (const p of pinned) p.item.pinVersionId = p.versionId;
      view.log(t('tui.download.pinMarked'));
    }
  }
  return true;
}

/**
 * Output directory + concurrency + plan, asked on a single confirmation screen.
 * 输出目录 + 并发 + 计划，收在一屏确认里。
 */
async function askOptions(config, selectedPlan, state) {
  let outDir = resolveOutDir(config, config.outDir);
  const completedSelected = selectedPlan.filter((p) => stateMatches(p, state)).length;
  let force = false;
  const selectedBytes = selectedPlan.reduce((sum, p) => sum + (p.totalBytes || 0), 0);

  for (;;) {
    const lines = selectedPlan.slice(0, 5).map((p) => {
      const mark = stateMatches(p, state) ? t('tui.download.statusDownloaded') : '';
      return `  ${color.muted(glyph.bullet)} ${view.truncateTo(p.name, 44)}  ${color.muted(
        [formatBytes(p.totalBytes || 0), mark].filter(Boolean).join(view.separator())
      )}`;
    });
    view.note('');
    view.note(
      color.emphasis(
        `  ${t('tui.download.planTitle', { count: selectedPlan.length, size: formatBytes(selectedBytes) })}`
      )
    );
    for (const line of lines) view.note(line);
    if (selectedPlan.length > lines.length) {
      view.note(color.muted(`  ${t('tui.download.planMore', { count: selectedPlan.length - lines.length })}`));
    }

    const choice = await pages.promptMenu(t('tui.download.optionPrompt'), [
      {
        title: t('tui.download.startNow'),
        value: 'go',
        description: t('tui.download.startNowDesc', { count: selectedPlan.length }),
      },
      {
        title: t('tui.download.changeDir'),
        value: 'dir',
        description: t('tui.download.changeDirDesc', { root: config.root, dir: outDir }),
      },
      {
        title: t('tui.download.changeJobs'),
        value: 'jobs',
        description: t('tui.download.jobsCurrent', { jobs: Number(config.jobs) || 1 }),
      },
      ...(completedSelected
        ? [
            {
              title: force ? t('tui.download.forceOn') : t('tui.download.forceOff'),
              value: 'force',
              description: t('tui.download.forceToggleDesc', { count: completedSelected }),
            },
          ]
        : []),
      { title: t('tui.manage.back'), value: 'back' },
    ]);
    if (choice === null || choice === 'back') return null;

    if (choice === 'dir') {
      const text = await pages.promptOutDir(config, outDir);
      if (text !== null) outDir = resolveOutDir(config, text);
      continue;
    }
    if (choice === 'jobs') {
      const jobs = await pages.promptMenu(t('tui.download.concurrencyPrompt'), [
        { title: t('tui.download.jobsOne'), value: 1 },
        { title: t('tui.download.jobsTwo'), value: 2 },
        { title: t('tui.download.jobsThree'), value: 3 },
      ]);
      if (jobs !== null) config.jobs = jobs;
      continue;
    }
    if (choice === 'force') {
      force = !force;
      continue;
    }

    const free = freeSpaceBytes(outDir);
    if (free !== null && selectedBytes > free) {
      view.log(
        color.warning(
          t('tui.download.lowSpace', {
            planned: formatBytes(selectedBytes),
            dir: outDir,
            free: formatBytes(free),
          })
        )
      );
      const anyway = await pages.promptConfirm(t('tui.download.lowSpaceConfirm'));
      if (!anyway) continue;
    }
    return { outDir, force, selectedBytes, jobs: Number(config.jobs) || 1 };
  }
}

/**
 * Download one collection: enumerate → pick items → pick versions → start.
 * 下载单个收藏集：枚举 → 勾选条目 → 选版本 → 开始。
 *
 * @param {{collectionId?:string|number}} [opts] `collectionId` skips the first question (used when the
 *   download is started from a collection's own page)
 */
async function downloadFlow(config, opts = {}) {
  if (screen.isActive()) return downloadCollectionShell(config, opts);
  let collectionId = opts.collectionId === undefined || opts.collectionId === null ? '' : String(opts.collectionId);
  if (collectionId) collectionId = parseCollectionId(collectionId) || collectionId;
  if (!collectionId) {
    const rawId = await pages.promptText(t('tui.download.collectionIdPrompt'), {
      stage: t('tui.app.menuDownload'),
      validate: (v) => (parseCollectionId(v) ? true : t('tui.download.invalidCollectionId')),
    });
    if (rawId === null) return;
    collectionId = parseCollectionId(rawId);
    if (!collectionId) {
      view.notice(t('tui.download.invalidCollectionId'), color.danger);
      return;
    }
  }

  const items = await pages.withSpinner(t('tui.download.enumerating', { collectionId }), () =>
    fetchItems(config, collectionId)
  );
  if (!items.length) {
    // An empty result is the one outcome that used to look like "nothing happened": say it out loud,
    // and remind that enumeration needs a logged-in browser session.
    //
    // 空结果是唯一会被当成「点了没反应」的情形：明确说出来，
    // 并提醒枚举需要浏览器里已登录的会话。
    view.notice(t('tui.download.collectionEmpty'), color.warning);
    view.notice(t('tui.download.collectionEmptyHint'), color.muted);
    return;
  }
  view.log(t('tui.download.collectionCount', { collectionId, count: items.length }));

  // Pins decide the target version before metadata is fetched, so the plan and the job agree.
  // 在拉元数据之前先按固定版本决定目标版本，计划与任务才会一致。
  const pinnedCount = applyPinsToItems(readLibrary(config, { allowCorrupt: true }).entries, items);
  if (pinnedCount) view.log(t('tui.download.pinsApplied', { count: pinnedCount }));

  view.log(t('tui.download.fetchMeta', { count: items.length, concurrency: config.metaConcurrency }));
  const { plan, totalBytes, failed } = await buildPlan(config.site, items, config.userAgent, {
    concurrency: config.metaConcurrency,
    fileTypes: config.fileTypes,
    primaryOnly: config.primaryOnly,
    onLog: view.log,
  });
  if (failed) view.log(t('tui.download.metaFailed', { count: failed }));

  const paths = dataPaths(config, collectionId);
  writeJson(paths.plan, {
    collectionId,
    totalBytes,
    count: plan.length,
    failed,
    plan: plan.map((p) => ({ ...p, versions: undefined })),
  });

  const { entries: state } = readLibrary(config, { allowCorrupt: true });
  const selectedPlan = await pickItems(plan, state);
  if (!selectedPlan) return;

  const strategy = await pages.promptMenu(t('tui.download.versionStrategy'), [
    {
      title: t('tui.download.strategyLatest'),
      value: 'latest',
      description: t('tui.download.strategyLatestDesc'),
    },
    {
      title: t('tui.download.strategyChoose'),
      value: 'choose',
      description: t('tui.download.strategyChooseDesc'),
    },
  ]);
  if (strategy === null) return;
  if (strategy === 'choose') {
    view.log(t('tui.download.fetchVersions'));
    await fetchVersions(config, selectedPlan);
    if (!(await chooseVersions(config, selectedPlan))) return;
  }

  const options = await askOptions(config, selectedPlan, state);
  if (!options) return;

  // Persist pin requests for models that already have records first; models without a record
  // are written after the download completes.
  //
  // 先把已有记录的固定请求落库；尚无记录的等下载完成后再写
  for (const item of selectedPlan) {
    if (!item.pinVersionId) continue;
    if (state[item.modelId]) setPin(config, item.modelId, item.pinVersionId);
  }

  const summary = await runWithProgress(config, {
    collectionId,
    name: t('tui.check.collectionLabel', { id: collectionId }),
    plan: selectedPlan,
    outDir: options.outDir,
    force: options.force,
    totalBytes: options.selectedBytes,
    jobs: options.jobs,
    attempts: config.downloadAttempts,
  });

  const pendingPins = selectedPlan.filter((p) => p.pinVersionId && !state[p.modelId]);
  if (pendingPins.length) {
    const { entries: fresh } = readLibrary(config, { allowCorrupt: true });
    let n = 0;
    for (const p of pendingPins) {
      if (fresh[p.modelId]) {
        setPin(config, p.modelId, p.pinVersionId);
        n++;
      }
    }
    if (n) view.log(t('tui.download.pinsApplied', { count: n }));
  }

  const stats = {
    done: summary.done,
    skipped: summary.skipped,
    failed: summary.failed,
    metaFailed: summary.metaFailed,
  };
  // The outcome is a toast; the elapsed time and the log-file path stay in the log page.
  // 结果用 toast 显示；用时与日志文件路径留在日志页里。
  view.notice(
    summary.cancelled
      ? t('tui.download.summaryCancelled', stats)
      : t(summary.metaFailed ? 'tui.download.summaryDoneMeta' : 'tui.download.summaryDone', stats),
    summary.cancelled || summary.failed ? color.warning : color.success
  );
  view.log(
    t('tui.download.elapsed', {
      elapsed: view.formatDuration((summary.elapsedMs || 0) / 1000),
      file: summary.logFile,
    })
  );
  view.bell();

  const openIt = await pages.promptConfirm(t('tui.download.openDirConfirm'), { initial: false });
  if (openIt && view.openDir(options.outDir)) {
    view.notice(t('tui.download.opened', { dir: options.outDir }), color.muted);
  }
}

// ---------------------------------------------------------------------------
// Shell flow: plan → confirm → receipt
// 外壳流程：计划 → 确认 → 回执
// ---------------------------------------------------------------------------

/**
 * Library record of a plan item.
 * 计划项在模型库里的记录。
 */
function entryOf(entries, item) {
  return (entries && item && entries[String(item.modelId)]) || null;
}

/**
 * Whether the exact version a plan item targets already has a record.
 * 计划项目标版本是否已有记录。
 */
function recordedOf(entries, item) {
  const entry = entryOf(entries, item);
  return !!getVersion(entry, item.versionId);
}

/**
 * Pinned version of a plan item (id and human name).
 * 计划项的固定版本（ID 与可读名称）。
 */
function pinOf(entries, item) {
  const entry = entryOf(entries, item);
  const versionId = entry && entry.pinnedVersionId
    ? String(entry.pinnedVersionId)
    : item && item.pinVersionId
      ? String(item.pinVersionId)
      : null;
  if (!versionId) return { versionId: null, versionName: '', matches: false };
  const record = getVersion(entry, versionId);
  return {
    versionId,
    versionName: record && record.versionName ? String(record.versionName) : versionId,
    matches: String(item.versionId) === versionId,
  };
}

/**
 * Items that can actually be downloaded (metadata succeeded and a file list exists).
 * 真正可下载的计划项（元数据成功且有文件清单）。
 */
function selectablePlan(plan) {
  return plan.filter((item) => !item.error && Array.isArray(item.files) && item.files.length > 0);
}

/**
 * Unique key of one plan row.
 *
 * A model may occupy several rows now (several versions downloaded together), so the model id alone
 * is not a key. The version is: the picker never allows two identical versions of one model.
 *
 *
 * 计划行的唯一键。
 *
 * 同一模型现在可以占多行（一次下载多个版本），因此只用模型 ID 不唯一；版本号才是唯一的，
 * 因为选择器不允许同一模型出现两个相同版本。
 */
function planRowKey(item) {
  if (!item) return '';
  const version = item.versionId === undefined || item.versionId === null ? '' : item.versionId;
  return `${item.modelId}:${version}`;
}

/**
 * The initial selection: everything selected whose target version is not recorded yet. That includes
 * both brand-new items and items whose collection version moved on (the old code only selected the
 * former).
 *
 * 初始勾选：目标版本尚未记录的全部条目。既包括新条目，也包括收藏集版本已变化的条目
 * （旧实现只勾后者中的新模型）。
 */
function defaultSelection(plan, entries) {
  return new Set(
    selectablePlan(plan)
      .filter((item) => !recordedOf(entries, item))
      .map(planRowKey)
  );
}

/**
 * Right-hand detail of one plan row. Status comes first so a narrow terminal truncates the
 * type/base-model/file-count tail instead of the state the user is deciding on.
 *
 * 计划行的右侧说明。状态放在最前，窄终端先截掉类型/底模/文件数，而不是用户正在决定的状态。
 */
function planRowDetail(config, item, entries) {
  if (item.error) {
    return t('tui.download.statusMetaFailed', { error: view.truncate(String(item.error), 48) });
  }
  const recorded = recordedOf(entries, item);
  const entry = entryOf(entries, item);
  const parts = [
    recorded
      ? t('tui.download.statusDownloaded')
      : entry
        ? t('tui.download.statusUpdated')
        : t('tui.download.statusNew'),
    `v${item.versionName || item.versionId}`,
  ];
  if (item.manual) parts.push(t('tui.download.statusManual'));
  const pin = pinOf(entries, item);
  if (pin.matches) parts.push(t('tui.download.statusPinned'));
  else if (pin.versionId) {
    parts.push(
      t('tui.download.statusPinConflict', {
        pinned: pin.versionName,
        plan: item.versionName || item.versionId,
      })
    );
  }
  if (item.type) parts.push(String(item.type));
  if (item.baseModel) parts.push(String(item.baseModel));
  if (item.files) parts.push(t('tui.download.fileCount', { count: item.files.length }));
  return parts.join(view.separator());
}

/**
 * Second header line of the plan page: selection, size, status and free space.
 * 计划页第二行表头：已选、体积、状态与磁盘余量。
 */
function planSummaryText(config, plan, selected, entries, outDir) {
  const chosen = plan.filter((item) => !item.error && selected.has(planRowKey(item)));
  const selectable = selectablePlan(plan);
  const bytes = chosen.reduce((sum, item) => sum + (item.totalBytes || 0), 0);
  const done = chosen.filter((item) => recordedOf(entries, item)).length;
  const updates = chosen.filter((item) => !recordedOf(entries, item) && entryOf(entries, item)).length;
  const failed = plan.filter((item) => item.error).length;
  const free = freeSpaceBytes(outDir);
  return t('tui.download.planSummary', {
    selected: chosen.length,
    total: selectable.length,
    size: formatBytes(bytes),
    done,
    updates,
    failed,
    free: free === null ? t('tui.download.freeUnknown') : formatBytes(free),
  });
}

/**
 * Source/totals line of the plan page.
 * 计划页的来源/合计行。
 */
function collectionSourceLine(collectionId, count, size, snapshot) {
  const time =
    snapshot && snapshot.fetchedAt
      ? format.dateTime(snapshot.fetchedAt)
      : t('tui.download.unknownDate');
  return t('tui.download.planSourceCollection', {
    id: collectionId,
    count,
    size,
    time,
  });
}

/**
 * Run the shared shell plan flow: plan page → confirm page → receipt page.
 *
 * Returns true when a task was submitted, false when the user cancelled. The task keeps running after
 * this function returns.
 *
 *
 * 运行共享的外壳计划流程：计划页 → 确认页 → 回执页。
 *
 * 提交任务后返回 true，用户取消返回 false。函数返回后任务仍继续运行。
 */
async function runDownloadPlan(config, opts) {
  const plan = Array.isArray(opts.plan) ? opts.plan : [];
  // Remember the version the plan came with, so "manually specified" can be computed later.
  // 记住计划原本的版本，之后才能判断「手动指定」。
  for (const item of plan) {
    if (item.baseVersionId === undefined && item.versionId !== undefined) {
      item.baseVersionId = String(item.versionId);
    }
  }
  const entries = opts.entries || readLibrary(config, { allowCorrupt: true }).entries;
  if (!selectablePlan(plan).length) {
    view.notice(t('tui.download.noDownloadable'), color.warning);
    const failed = plan.filter((item) => item.error);
    if (failed.length) {
      view.notice(
        t('tui.download.noDownloadableReason', {
          count: failed.length,
          error: view.truncate(String(failed[0].error), 120),
        }),
        color.danger
      );
    }
    return false;
  }

  let state = {
    selected: defaultSelection(plan, entries),
    cursor: 0,
    windowStart: 0,
    search: '',
    type: null,
    baseModel: null,
    sort: 'default',
  };
  let outDir = opts.outDir || resolveOutDir(config, config.outDir);
  let jobs = Math.max(1, Math.min(Number(opts.jobs) || Number(config.jobs) || 1, 8));
  let force = !!opts.force;
  const sourceLine = opts.sourceLine || t('tui.download.planSourceModels', {
    count: plan.length,
    size: formatBytes(plan.reduce((sum, item) => sum + (item.totalBytes || 0), 0)),
  });

  for (;;) {
    const answer = await selectItems(plan, {
      mode: 'multi',
      pageSize: PICK_PAGE_SIZE,
      title: sourceLine,
      summary: (selection) => planSummaryText(config, plan, selection.selected, entries, outDir),
      hints: () => t('tui.hint.downloadPlan'),
      actions: { v: 'version', o: 'options', n: 'new', c: 'clear' },
      disabledOf: (item) => !!item.error,
      describe: (item) => planRowDetail(config, item, entries),
      state: entries,
      selected: state.selected,
      initialCursor: state.cursor,
      windowStart: state.windowStart,
      search: state.search,
      type: state.type,
      baseModel: state.baseModel,
      sort: state.sort,
      label: (item) => item.name || String(item.modelId),
      idOf: planRowKey,
      onLog: view.log,
    });
    if (!answer) return false;
    state = {
      ...state,
      ...(answer.state || {}),
      selected: answer.selected instanceof Set ? answer.selected : new Set(answer.selected || []),
    };

    if (answer.action === 'new') {
      state.selected = defaultSelection(plan, entries);
      continue;
    }
    if (answer.action === 'clear') {
      state.selected = new Set();
      continue;
    }
    if (answer.action === 'version') {
      const item = plan.find((entry) => planRowKey(entry) === String(answer.currentId));
      if (item) {
        const picked = await pickPlanVersions(config, item, entries, plan);
        if (picked) replacePlanRows(config, plan, item, picked.detail, picked.rows, state);
      }
      continue;
    }

    // Enter and `o` both go through the confirmation page: the plan page selects, the confirmation
    // page is the one screen where the start decision is made.
    //
    // 回车与 `o` 都进入确认页：计划页负责选择，确认页才是做出「开始」决定的那一屏。
    const chosen = plan.filter(
      (item) => state.selected.has(planRowKey(item)) && !item.error && Array.isArray(item.files) && item.files.length
    );
    if (!chosen.length) {
      view.notice(t('tui.download.noSelection'), color.warning);
      continue;
    }
    const confirmed = await confirmPage(config, {
      sourceLine,
      plan,
      entries,
      chosen,
      outDir,
      jobs,
      force,
    });
    if (!confirmed) continue;
    outDir = confirmed.outDir;
    jobs = confirmed.jobs;
    force = confirmed.force;

    const toDownload = force
      ? chosen
      : chosen.filter((item) => !recordedOf(entries, item));
    if (!toDownload.length) {
      view.notice(t('tui.download.allSkipped'), color.warning);
      continue;
    }
    // Progress is measured against what will actually be transferred; recorded items selected while
    // "skip finished" is on are counted as skipped, not as a percentage that can never reach 100.
    //
    // 进度只按真正会传输的字节计算；开启「跳过已完成」时，已有记录的行计入跳过，
    // 而不是让百分比永远到不了 100。
    const totalBytes = toDownload.reduce((sum, item) => sum + (Number(item.totalBytes) || 0), 0);
    // Pins of models that already have a record can be written before the run. Models without a
    // record are written after the download creates the record.
    //
    // 已有记录的模型可以在下载前写固定；还没有记录的模型等下载创建记录后再写。
    const pendingPins = [];
    for (const item of chosen) {
      if (!item.pinVersionId) continue;
      if (entryOf(entries, item)) setPin(config, item.modelId, item.pinVersionId);
      else pendingPins.push(item);
    }

    const started = startDownloadTask(config, {
      collectionId: opts.collectionId,
      name: opts.name,
      plan: chosen,
      outDir,
      force,
      totalBytes,
      jobs,
      attempts: config.downloadAttempts,
      runner: opts.runner,
      onComplete: async () => {
        if (!pendingPins.length) return;
        const { entries: fresh } = readLibrary(config, { allowCorrupt: true });
        let applied = 0;
        for (const item of pendingPins) {
          if (fresh[item.modelId]) {
            setPin(config, item.modelId, item.pinVersionId);
            applied++;
          }
        }
        if (applied) view.log(t('tui.download.pinsApplied', { count: applied }));
      },
    });
    await receiptPage(started.taskId);
    return true;
  }
}

/**
 * Rows of every online version of one model, shaped for the shared picker.
 * 把一个模型的全部线上版本转成公共选择器需要的行。
 */
function versionChoiceRows(config, detail, item, entries) {
  const entry = entryOf(entries, item);
  return (Array.isArray(detail.modelVersions) ? detail.modelVersions : []).map((version) => {
    const files = extractFiles(version, config.site, {
      fileTypes: config.fileTypes,
      primaryOnly: config.primaryOnly,
    });
    const versionId = String(version.id);
    return {
      modelId: versionId,
      versionId,
      name: version.name || versionId,
      baseModel: version.baseModel || '',
      totalBytes: files.reduce((sum, file) => sum + (Number(file.bytes) || 0), 0),
      fileCount: files.length,
      publishedAt: version.publishedAt || null,
      raw: version,
      current: versionId === String(item.versionId),
      downloaded: !!getVersion(entry, versionId),
      pinned: !!(entry && entry.pinnedVersionId && String(entry.pinnedVersionId) === versionId),
    };
  });
}

/**
 * One plan row built from an online version (files, totals and the model context the job needs).
 * 用一个线上版本构造计划行（文件、合计，以及下载任务需要的模型上下文）。
 */
function versionPlanItem(config, item, detail, row) {
  const built = versionToItem(config.site, row.raw, {
    fileTypes: config.fileTypes,
    primaryOnly: config.primaryOnly,
  });
  const versionId = String(built.versionId);
  return {
    ...built,
    modelId: item.modelId,
    name: item.name,
    type: item.type,
    baseModel: row.baseModel || built.baseModel,
    modelMeta: detail,
    versionId: built.versionId,
    versionName: built.versionName,
    totalBytes: built.files.reduce((sum, file) => sum + (Number(file.bytes) || 0), 0),
    baseVersionId:
      item.baseVersionId === undefined || item.baseVersionId === null
        ? versionId
        : String(item.baseVersionId),
    manual: String(built.versionId) !== String(item.baseVersionId),
    pinVersionId: String(item.pinVersionId) === versionId ? item.pinVersionId : undefined,
  };
}

/**
 * Version picker of one plan row, multi-select.
 *
 * The plan row is no longer "one version per model": opening `v` shows every online version with
 * the versions already in the plan pre-checked, so ticking another one adds it to the same plan.
 * `p` still pins the version under the cursor (the picker reopens so the mark is visible).
 *
 *
 * 计划行的版本选择器，可多选。
 *
 * 计划行不再「一个模型只对应一个版本」：按 `v` 会列出全部线上版本，并预选计划里已有的版本；
 * 再勾一个就会把同一模型的另一个版本加进同一份计划。`p` 仍然固定光标所在版本
 * （之后选择器会重新打开，以便看到固定标记）。
 *
 * @returns {Promise<{detail:object, rows:Array<object>}|null>}
 */
async function pickPlanVersions(config, item, entries, plan) {
  view.log(t('tui.download.fetchVersions'));
  let detail = null;
  try {
    detail = await pages.withSpinner(t('tui.download.fetchVersions'), () =>
      fetchModelDetail(config.site, item.modelId, config.userAgent)
    );
  } catch (e) {
    view.notice(t('tui.download.versionListFailed', { name: item.name, error: e.message }), color.danger);
    return null;
  }
  const rows = versionChoiceRows(config, detail, item, entries);
  if (!rows.length) {
    view.notice(t('tui.download.noVersions'), color.warning);
    return null;
  }
  const entry = entryOf(entries, item);
  const inPlan = new Set(
    plan.filter((row) => String(row.modelId) === String(item.modelId)).map((row) => String(row.versionId))
  );
  let selectedIds = new Set(inPlan);

  for (;;) {
    const answer = await selectItems(rows, {
      mode: 'multi',
      pageSize: PICK_PAGE_SIZE,
      title: t('tui.download.versionTitle', { name: view.truncateTo(String(item.name), 56) }),
      hints: () => t('tui.hint.downloadVersion'),
      actions: { p: 'pin' },
      disabledOf: (row) => row.fileCount === 0,
      describe: (row) =>
        [
          row.current ? t('tui.download.currentMark') : null,
          row.downloaded ? t('tui.download.statusDownloaded') : null,
          row.pinned ? t('tui.download.statusPinned') : null,
          inPlan.has(row.versionId) ? t('tui.download.inPlanMark') : null,
          row.baseModel || t('common.unknown'),
          t('tui.download.fileCount', { count: row.fileCount }),
          formatBytes(row.totalBytes || 0),
          row.publishedAt ? format.date(row.publishedAt) : t('tui.download.unknownDate'),
        ]
          .filter(Boolean)
          .join(view.separator()),
      initialSelected: selectedIds,
      initialCursor: Math.max(0, rows.findIndex((row) => row.current)),
      label: (row) => row.name,
      idOf: (row) => row.versionId,
      onLog: view.log,
    });
    if (!answer) return null;

    // Keep what the user already toggled when the picker reopens after a pin.
    // 固定之后选择器会重新打开，保留用户已经勾好的版本。
    selectedIds = new Set(Array.from(answer.selected || [], (value) => String(value)));

    if (answer.action === 'pin') {
      const pinRow = rows.find((row) => row.versionId === String(answer.currentId));
      if (pinRow) {
        if (entry) {
          setPin(config, item.modelId, pinRow.versionId);
          entry.pinnedVersionId = pinRow.versionId;
          view.notice(t('tui.download.pinMarkedOne', { version: pinRow.name }), color.success);
        } else {
          item.pinVersionId = pinRow.versionId;
          view.notice(t('tui.download.pinPending', { count: 1 }), color.muted);
        }
        for (const row of rows) row.pinned = row.versionId === pinRow.versionId;
      }
      continue;
    }

    if (!selectedIds.size) {
      view.notice(t('tui.download.noSelection'), color.warning);
      continue;
    }

    const pinnedId = entry && entry.pinnedVersionId ? String(entry.pinnedVersionId) : null;
    if (pinnedId && !selectedIds.has(pinnedId)) {
      const unpin = await pages.promptConfirm(
        t('tui.download.unpinToDownload', { pinned: pinnedId }),
        { initial: false }
      );
      if (!unpin) continue;
      setPin(config, item.modelId, null);
      entry.pinnedVersionId = null;
    }

    return { detail, rows: rows.filter((row) => selectedIds.has(row.versionId)) };
  }
}

/**
 * Replace every plan row of one model with the rows of the selected versions.
 *
 * Rows that already exist keep their object (files, manual flag, overrides); new versions get a
 * fresh row built from the online metadata. The selection follows the model: if any of its rows was
 * selected, every version of the new set is selected too.
 *
 *
 * 用一个模型所选版本的行替换它的全部计划行。
 *
 * 已存在的行保留原对象（文件、手动标记、目录覆盖）；新版本用线上元数据新建一行。
 * 勾选状态跟随这个模型：只要它原来有任意一行被勾选，新的整组版本都会被勾选。
 */
function replacePlanRows(config, plan, item, detail, chosenRows, state) {
  const modelId = String(item.modelId);
  const oldRows = plan.filter((row) => String(row.modelId) === modelId);
  if (!oldRows.length) return;
  const start = plan.indexOf(oldRows[0]);
  const wasSelected = oldRows.some((row) => state.selected.has(planRowKey(row)));
  const existing = new Map(oldRows.map((row) => [String(row.versionId), row]));
  const newRows = chosenRows.map(
    (row) => existing.get(String(row.versionId)) || versionPlanItem(config, item, detail, row)
  );
  if (item.pinVersionId) {
    for (const row of newRows) {
      row.pinVersionId = String(row.versionId) === String(item.pinVersionId) ? item.pinVersionId : undefined;
    }
  }

  plan.splice(start, oldRows.length, ...newRows);
  for (const row of oldRows) state.selected.delete(planRowKey(row));
  for (const row of newRows) if (wasSelected) state.selected.add(planRowKey(row));

  view.log(
    t('tui.download.versionsPlanned', {
      name: item.name,
      count: newRows.length,
      versions: newRows.map((row) => row.versionName || row.versionId).join(t('updater.nameSeparator')),
    })
  );
}

/**
 * Confirmation page: the one screen with the plan totals, the options and the start action.
 * 确认页：把计划合计、选项和「开始」放在同一屏的唯一页面。
 */
async function confirmPage(config, data) {
  const rows = ['dir', 'jobs', 'force', 'start', 'back'];
  let cursor = 0;
  let windowStart = 0;
  let outDir = data.outDir;
  let jobs = data.jobs;
  let force = data.force;
  const chosen = data.chosen;
  const entries = data.entries;

  const labels = {
    dir: t('tui.download.optionDir'),
    jobs: t('tui.download.optionJobs'),
    force: t('tui.download.optionForce'),
    start: t('tui.download.optionStart'),
    back: t('tui.download.optionBack'),
  };
  const labelWidth = Object.values(labels).reduce((max, label) => Math.max(max, view.displayWidth(label)), 0);
  const completed = chosen.filter((item) => recordedOf(entries, item)).length;
  const failed = data.plan.filter((item) => item.error).length;
  const pinned = chosen.filter((item) => pinOf(entries, item).matches).length;
  const manual = chosen.filter((item) => item.manual).length;
  const types = (config.fileTypes || []).join(',') || '-';

  // With "skip finished items" the recorded rows are not downloaded, so the start action must quote
  // the real amount and the progress expectation must use the same number.
  //
  // 选择「跳过已完成」时，已有记录的行不会下载，因此「开始」行与进度期望都只能用真实会下载的数量。
  const downloadable = () => (force ? chosen : chosen.filter((item) => !recordedOf(entries, item)));
  const downloadableBytes = () =>
    downloadable().reduce((sum, item) => sum + (Number(item.totalBytes) || 0), 0);

  const valueOf = (key) => {
    if (key === 'dir') return outDir;
    if (key === 'jobs') return String(jobs);
    if (key === 'force') {
      if (!completed) return t('tui.download.forceNone');
      return force
        ? t('tui.download.forceRedownload', { count: completed })
        : t('tui.download.forceSkip', { count: completed });
    }
    if (key === 'start') {
      return t('tui.download.startSummary', {
        count: downloadable().length,
        size: formatBytes(downloadableBytes()),
      });
    }
    return '';
  };

  return screen.prompt({
    title: t('tui.download.confirmTitle'),
    hints: () => [t('tui.hint.downloadConfirm')],
    render(_state, ctx) {
      const width = Math.max(20, Math.floor(ctx.width) || 80);
      const room = Math.max(3, Math.floor(ctx.rows) || 3);
      const free = freeSpaceBytes(outDir);
      const lines = [
        t('tui.download.confirmPlan', {
          count: downloadable().length,
          size: formatBytes(downloadableBytes()),
          source: view.truncateTo(data.sourceLine, Math.max(20, width - 30)),
        }),
        t('tui.download.confirmStatus', {
          done: completed,
          updates: chosen.filter((item) => !recordedOf(entries, item) && entryOf(entries, item)).length,
          failed,
          pinned,
          manual,
        }),
        t('tui.download.confirmTarget', {
          dir: view.truncateTo(outDir, Math.max(20, width - 34)),
          free: free === null ? t('tui.download.freeUnknown') : formatBytes(free),
          jobs,
        }),
        t('tui.download.confirmFiles', { types, primary: config.primaryOnly ? t('common.yes') : t('common.no'), engine: config.engine, dedup: config.dedup }),
      ];
      lines.push('');
      const listRoom = Math.max(1, room - lines.length);
      const win = pages.windowOf(rows.length, cursor, listRoom, windowStart);
      windowStart = win.start;
      for (const key of rows.slice(win.start, win.end)) {
        lines.push(
          pages.rowLine(labels[key], valueOf(key), {
            cursor: key === rows[cursor],
            labelWidth,
            width,
          })
        );
      }
      if (win.end - win.start < rows.length) {
        lines.push(color.muted(t('tui.pages.listPosition', { index: cursor + 1, total: rows.length })));
      }
      return lines;
    },
    async onKey(text, key, entry) {
      const index = rows[cursor];
      if (key.name === 'up') {
        cursor = cursor <= 0 ? rows.length - 1 : cursor - 1;
        return;
      }
      if (key.name === 'down') {
        cursor = cursor >= rows.length - 1 ? 0 : cursor + 1;
        return;
      }
      if (key.name === 'home') {
        cursor = 0;
        return;
      }
      if (key.name === 'end') {
        cursor = rows.length - 1;
        return;
      }
      if (key.name !== 'return') return;

      if (index === 'back') {
        entry.settle(null);
        return;
      }
      if (index === 'dir') {
        const value = await pages.promptText(t('tui.download.outDirPrompt', { root: config.root }), {
          initial: outDir,
          pick: 'directory',
          validate: (value_) => (String(value_).trim() ? true : t('tui.download.notEmpty')),
        });
        if (value !== null) outDir = resolveOutDir(config, value);
        return;
      }
      if (index === 'jobs') {
        const options = [];
        for (let n = 1; n <= 8; n++) {
          options.push({
            title: n === 1 ? t('tui.download.jobsSerial') : String(n),
            value: n,
            description: n === 1 ? t('tui.download.jobsSerialDesc') : undefined,
          });
        }
        const picked = await pages.promptMenu(t('tui.download.concurrencyPrompt'), options, {
          initial: Math.max(0, jobs - 1),
        });
        if (picked !== null) jobs = Number(picked) || 1;
        return;
      }
      if (index === 'force') {
        force = !force;
        view.notice(
          force && completed
            ? t('tui.download.forceRedownload', { count: completed })
            : t('tui.download.forceSkip', { count: completed }),
          force ? color.warning : color.muted
        );
        return;
      }
      if (index === 'start') {
        const needed = downloadableBytes();
        if (!downloadable().length) {
          view.notice(t('tui.download.allSkipped'), color.warning);
          return;
        }
        const free = freeSpaceBytes(outDir);
        if (free !== null && needed > free) {
          const anyway = await pages.promptConfirm(
            t('tui.download.lowSpaceConfirmNumbers', {
              planned: formatBytes(needed),
              dir: outDir,
              free: formatBytes(free),
            })
          );
          if (!anyway) return;
        }
        if (force && completed) {
          const overwrite = await pages.promptConfirm(
            t('tui.download.forceConfirm', { count: completed }),
            { danger: true }
          );
          if (!overwrite) return;
        }
        entry.settle({ outDir, jobs, force });
      }
    },
  });
}

/**
 * Receipt page: the task was submitted; progress and result live in the task view.
 * 回执页：任务已提交；进度和结果都在任务视图。
 */
async function receiptPage(taskId) {
  await screen.prompt({
    title: t('tui.download.receiptTitle'),
    hints: () => [t('tui.hint.receipt')],
    render(_state, ctx) {
      const task = tasks.getTask(taskId);
      const width = Math.max(20, Math.floor(ctx.width) || 80);
      const lines = [];
      if (!task) {
        lines.push(color.danger(t('tui.download.receiptMissing')));
        return lines;
      }
      const failed = task.status === tasks.FAILED;
      lines.push(
        failed
          ? color.danger(t('tui.download.receiptFailedTitle'))
          : color.success(t('tui.download.receiptJoined'))
      );
      lines.push('');
      lines.push(
        t('tui.download.receiptSummary', {
          name: view.truncateTo(task.name || task.id, Math.max(16, width - 12)),
          count: task.total,
          size: formatBytes(task.totalBytes),
          dir: view.truncateTo(task.outDir || '-', Math.max(16, width - 16)),
          jobs: task.jobs,
        })
      );
      lines.push('');
      if (failed) {
        lines.push(color.danger(t('tui.download.receiptFailed', { error: (task.result && task.result.error) || '' })));
      } else if (task.status === tasks.QUEUED) {
        lines.push(
          color.warning(
            t('tui.download.receiptQueued', {
              position: tasks.queuePosition(taskId),
              waiting: queuedDownloads(),
            })
          )
        );
      } else if (task.status === tasks.RUNNING) {
        lines.push(color.success(t('tui.download.receiptRunning')));
      } else if (task.status === tasks.DONE) {
        lines.push(color.success(t('tui.download.receiptDone')));
      } else {
        lines.push(color.warning(t('tui.download.receiptCancelled')));
      }
      lines.push('');
      lines.push(color.muted(t('tui.download.receiptHint')));
      return lines;
    },
  });
}

/**
 * Shell flow for one collection: enumerate → write snapshot → plan → shared plan pages.
 * 单个收藏集的外壳流程：枚举 → 写快照 → 计划 → 共享计划页面。
 */
async function downloadCollectionShell(config, opts = {}) {
  let collectionId =
    opts.collectionId === undefined || opts.collectionId === null ? '' : String(opts.collectionId);
  if (collectionId) collectionId = parseCollectionId(collectionId) || collectionId;
  if (!collectionId) {
    const rawId = await pages.promptText(t('tui.download.collectionIdPrompt'), {
      stage: t('tui.app.menuDownload'),
      validate: (value) => (parseCollectionId(value) ? true : t('tui.download.invalidCollectionId')),
    });
    if (rawId === null) return;
    collectionId = parseCollectionId(rawId);
    if (!collectionId) {
      view.notice(t('tui.download.invalidCollectionId'), color.danger);
      return;
    }
  }

  const items = await pages.withSpinner(t('tui.download.enumerating', { collectionId }), () =>
    fetchItems(config, collectionId)
  );
  if (!items.length) {
    view.notice(t('tui.download.collectionEmpty'), color.warning);
    view.notice(t('tui.download.collectionEmptyHint'), color.muted);
    return;
  }

  // A plan is also a membership snapshot: record it now (the old shell flow only wrote it when the
  // core job enumerated by itself, which the TUI never does because it passes a ready-made plan).
  //
  // 计划同时也是成员快照：现在就记下来（旧外壳流程只在核心任务自己枚举时才写，
  // 而 TUI 总是把现成计划传进去，因此从未写过收藏集快照）。
  let snapshot = null;
  try {
    snapshot = writeCollection(config, collectionId, { items });
  } catch (e) {
    view.log(t('tui.download.snapshotFailed', { error: e.message }));
  }

  // The snapshot above records the collection's own versions; the download plan follows the pins.
  // 上面的快照记录收藏集自己的版本；下面的下载计划跟随固定版本。
  const pinnedCount = applyPinsToItems(readLibrary(config, { allowCorrupt: true }).entries, items);
  if (pinnedCount) view.log(t('tui.download.pinsApplied', { count: pinnedCount }));

  view.log(t('tui.download.fetchMeta', { count: items.length, concurrency: config.metaConcurrency }));
  const { plan, totalBytes, failed } = await buildPlan(config.site, items, config.userAgent, {
    concurrency: config.metaConcurrency,
    fileTypes: config.fileTypes,
    primaryOnly: config.primaryOnly,
    onLog: view.log,
  });
  if (failed) view.log(t('tui.download.metaFailed', { count: failed }));

  const paths = dataPaths(config, collectionId);
  try {
    writeJson(paths.plan, {
      collectionId,
      totalBytes,
      count: plan.length,
      failed,
      plan: plan.map((item) => ({ ...item, versions: undefined })),
    });
  } catch (e) {
    view.log(t('tui.download.planWriteFailed', { error: e.message }));
  }

  return runDownloadWorkspace(config, {
    plan,
    collectionId,
    name: t('tui.check.collectionLabel', { id: collectionId }),
    outDir: resolveOutDir(config, config.outDir),
    jobs: config.jobs,
  });
}

/**
 * Workspace row label: model name plus the target version.
 * 工作台行标签：模型名与目标版本。
 */
function workspaceRowLabel(item) {
  const version = item.versionName || item.versionId || '';
  return version ? t('tui.workspace.rowVersion', { name: item.name || item.modelId, version }) : String(item.name || item.modelId || '');
}

/**
 * Delete downloaded versions: remove the files first, then the library records.
 * 删除已下载版本：先删文件，再删模型库记录。
 */
function deletePlanVersions(config, rows) {
  const { entries } = readLibrary(config, { allowCorrupt: true });
  let count = 0;
  for (const row of rows) {
    const entry = entries[String(row.modelId)];
    const version = getVersion(entry, row.versionId);
    if (!version) continue;
    const dir = path.join(version.outDir || config.outDir, version.dirName || '');
    for (const file of version.files || []) {
      try {
        fs.rmSync(path.join(dir, file.name), { force: true });
      } catch (e) {
        // A missing file must not block the record cleanup.
        // 缺失文件不阻塞记录清理。
      }
    }
    markForRedownload(config, [{ modelId: row.modelId, versionId: row.versionId }]);
    count++;
  }
  return count;
}

/**
 * Read-only confirmation page: selected rows + start/back. Tab switches the two regions.
 * 只读确认页：选中行 + 开始/返回。Tab 在两个区域间切换。
 */
async function workspaceConfirmPage(config, data) {
  const deletions = Array.isArray(data.deletions) ? data.deletions : [];
  const deletionBytes = deletions.reduce((sum, item) => sum + (Number(item.totalBytes) || 0), 0);
  let region = 'rows';
  let cursor = 0;
  const rows = data.chosen;

  return screen.prompt({
    title: t('tui.download.confirmTitle'),
    handlesHelp: true,
    hints: () => [t('tui.hint.workspaceConfirm')],
    render(_state, ctx) {
      const lines = [];
      lines.push(
        color.muted(
          truncateTo(
            `${t('tui.download.optionDir')}: ${data.outDir} | ${t('tui.download.optionJobs')}: ${data.jobs}`,
            ctx.width
          )
        )
      );
      lines.push(
        color.muted(
          t('tui.workspace.selected', {
            count: rows.length,
            total: Math.max(rows.length, deletions.length + rows.length),
          })
        )
      );
      if (deletions.length) {
        lines.push(
          color.warning(
            t('tui.workspace.deleteSummary', { count: deletions.length, size: formatBytes(deletionBytes) })
          )
        );
      }
      lines.push('');
      const listRoom = Math.max(1, Math.floor(ctx.rows) || 3 - lines.length - 2);
      const win = list.windowOf(rows.length, cursor, listRoom, data.windowStart || 0);
      for (let index = win.start; index < win.end; index++) {
        const row = rows[index];
        const mark = region === 'rows' && index === cursor ? color.cursor(layout.glyphs().cursor) : ' ';
        lines.push(`${mark} ${truncateTo(workspaceRowLabel(row), ctx.width - 4)}`);
      }
      lines.push('');
      lines.push(
        region === 'start'
          ? color.accent(`▸ ${t('tui.workspace.confirmNext')}`)
          : color.muted(`  ${t('tui.workspace.confirmBack')}`)
      );
      return lines;
    },
    onKey(text, key, entry) {
      const name = key && key.name;
      if (name === 'escape') {
        entry.settle(null);
        return;
      }
      if (name === 'tab') {
        region = region === 'rows' ? 'start' : 'rows';
        return;
      }
      if (region === 'rows') {
        if (name === 'up') {
          cursor = Math.max(0, cursor - 1);
          return;
        }
        if (name === 'down') {
          cursor = Math.min(rows.length - 1, cursor + 1);
          return;
        }
      }
      if (name !== 'return') return;
      if (region === 'rows') {
        region = 'start';
        return;
      }
      entry.settle({ confirmed: true });
    },
  });
}

/**
 * New shell download flow: workspace selection -> read-only confirmation -> receipt.
 * 新的外壳下载流程：工作台选择 -> 只读确认 -> 回执。
 */
async function runDownloadWorkspace(config, opts = {}) {
  const plan = Array.isArray(opts.plan) ? opts.plan : [];
  const entries = opts.entries || readLibrary(config, { allowCorrupt: true }).entries;
  const selected = opts.selected instanceof Set ? opts.selected : new Set(plan.map(planRowKey));

  const workspace = await showPlanWorkspace({
    title: opts.name || t('tui.download.planTitle', { count: plan.length, size: formatBytes(plan.reduce((sum, item) => sum + (item.totalBytes || 0), 0)) }),
    inputLabel: opts.inputLabel,
    emptyText: opts.emptyText,
    nextLabel: t('tui.workspace.next'),
    rows: plan,
    selected,
    idOf: planRowKey,
    resolveInput: typeof opts.resolveInput === 'function' ? opts.resolveInput : undefined,
    openRow: async (row) => {
      const detail = await fetchModelDetail(config.site, row.modelId, config.userAgent);
      const versions = Array.isArray(detail.modelVersions) ? detail.modelVersions : [];
      const rows = versions
        .map((version) => {
          const files = extractFiles(version, config.site, {
            fileTypes: config.fileTypes,
            primaryOnly: config.primaryOnly,
          });
          return { version, files };
        })
        .filter((entry) => entry.files.length)
        .map((entry) => ({
          ...versionToItem(config.site, entry.version, {
            fileTypes: config.fileTypes,
            primaryOnly: config.primaryOnly,
          }),
          modelId: row.modelId,
          name: row.name,
          type: row.type,
          baseModel: entry.version.baseModel,
          modelMeta: detail,
        }));
      return rows.map((next) => ({ ...next, detail: workspaceRowLabel(next) }));
    },
  });
  if (!workspace) return false;

  const chosen = workspace.rows;
  const deletions = plan.filter((row) => !workspace.selected.has(planRowKey(row)) && recordedOf(entries, row));
  const confirmed = await workspaceConfirmPage(config, {
    chosen,
    deletions,
    outDir: opts.outDir || resolveOutDir(config, config.outDir),
    jobs: opts.jobs || config.jobs,
  });
  if (!confirmed) return false;

  const started = startDownloadTask(config, {
    collectionId: opts.collectionId,
    name: opts.name,
    plan: chosen,
    outDir: opts.outDir || resolveOutDir(config, config.outDir),
    force: false,
    totalBytes: chosen.reduce((sum, item) => sum + (Number(item.totalBytes) || 0), 0),
    jobs: opts.jobs || config.jobs,
    attempts: config.downloadAttempts,
    onComplete: async () => {
      if (!deletions.length) return;
      const count = deletePlanVersions(config, deletions);
      if (count) view.notice(t('tui.workspace.deleteDone', { count }), color.success);
    },
  });
  await receiptPage(started.taskId);
  return true;
}

module.exports = {
  downloadFlow,
  downloadCollectionShell,
  runDownloadPlan,
  runDownloadWorkspace,
  prefilter,
  askOptions,
  versionChoices,
  planRowKey,
  replacePlanRows,
  versionPlanItem,
  versionChoiceRows,
};

