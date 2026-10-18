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
const { writeJson, formatBytes, mapPool } = require('../util');
const { dataPaths, readLibrary, getVersion } = require('../storage');
const { ensureBrowser } = require('../browser');
const { fetchCollectionItems } = require('../collection');
const { buildPlan, fetchModelDetail, extractFiles, versionToItem } = require('../api');
const { resolveOutDir } = require('../config');
const { parseCollectionId } = require('../urls');
const { createSiteLimiter } = require('../runtime');
const { setPin } = require('../updater');
const { freeSpaceBytes } = require('../job');
const { t } = require('../i18n');
const view = require('./view');
const pages = require('./pages');
const { selectItems, isInteractive } = require('./select');
const { runWithProgress } = require('./run');

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
    view.log(t('tui.download.noDownloadable'));
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
      onEnter: () => console.log(view.colors.dim(`  ${prefilterSummary(available, state)}`)),
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
          row.publishedAt ? String(row.publishedAt).slice(0, 10) : t('tui.download.unknownDate'),
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
      return `  ${view.colors.dim('·')} ${view.truncateTo(p.name, 44)}  ${view.colors.dim(
        [formatBytes(p.totalBytes || 0), mark].filter(Boolean).join(view.separator())
      )}`;
    });
    console.log('');
    console.log(
      view.colors.bold(
        `  ${t('tui.download.planTitle', { count: selectedPlan.length, size: formatBytes(selectedBytes) })}`
      )
    );
    for (const line of lines) console.log(line);
    if (selectedPlan.length > lines.length) {
      console.log(view.colors.dim(`  ${t('tui.download.planMore', { count: selectedPlan.length - lines.length })}`));
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
        view.colors.yellow(
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

async function downloadFlow(config) {
  const rawId = await pages.promptText(t('tui.download.collectionIdPrompt'), {
    validate: (v) => (parseCollectionId(v) ? true : t('tui.download.invalidCollectionId')),
  });
  if (rawId === null) return;
  const collectionId = parseCollectionId(rawId);
  if (!collectionId) {
    view.log(t('tui.download.invalidCollectionId'));
    return;
  }

  const items = await pages.withSpinner(t('tui.download.enumerating', { collectionId }), () =>
    fetchItems(config, collectionId)
  );
  if (!items.length) {
    view.log(t('tui.download.collectionEmpty'));
    return;
  }
  view.log(t('tui.download.collectionCount', { collectionId, count: items.length }));

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
  view.log(
    summary.cancelled
      ? t('tui.download.summaryCancelled', stats)
      : t(summary.metaFailed ? 'tui.download.summaryDoneMeta' : 'tui.download.summaryDone', stats)
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
    view.log(t('tui.download.opened', { dir: options.outDir }));
  }
}

module.exports = { downloadFlow, prefilter, askOptions, versionChoices };
