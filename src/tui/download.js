'use strict';

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
const { selectItems } = require('./select');
const { runWithProgress } = require('./run');

/**
 * Rows per page in the full-screen picker (shrinks when the terminal is short).
 * 全屏选择器每页行数（终端太矮时会自动收缩）
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

function hasTTY() {
  return !!(process.stdout.isTTY && process.stdin.isTTY);
}

async function fetchItems(config, collectionId) {
  const browser = await ensureBrowser(config);
  try {
    return await fetchCollectionItems(browser, config.site, collectionId, {
      trpcPath: config.trpcPath,
      trpcInput: config.trpcInput,
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

  if (hasTTY()) {
    view.log(t('tui.download.prefilterHint'));
    return available;
  }

  const kwAns = await prompts({
    type: 'text',
    name: 'kw',
    message: t('tui.download.keywordPrompt', { count: available.length }),
  });
  if (!kwAns || kwAns.kw === undefined) return null;
  const keyword = String(kwAns.kw).trim().toLowerCase();
  let filtered = available;
  if (keyword) {
    filtered = filtered.filter(
      (p) => String(p.name).toLowerCase().includes(keyword) || String(p.modelId).includes(keyword)
    );
  }

  const types = [...new Set(available.map((p) => p.type).filter(Boolean))];
  if (types.length > 1) {
    const ans = await prompts({
      type: 'select',
      name: 'type',
      message: t('tui.download.filterByType'),
      choices: [
        { title: t('tui.download.allTypes'), value: '__all__' },
        ...types.map((type) => ({ title: type, value: type })),
      ],
    });
    if (!ans || ans.type === undefined) return null;
    if (ans.type !== '__all__') filtered = filtered.filter((p) => p.type === ans.type);
  }

  const baseModels = [...new Set(available.map((p) => p.baseModel).filter(Boolean))];
  if (baseModels.length > 1 && baseModels.length <= 12) {
    const ans = await prompts({
      type: 'select',
      name: 'base',
      message: t('tui.download.filterByBaseModel'),
      choices: [
        { title: t('tui.download.allBaseModels'), value: '__all__' },
        ...baseModels.map((b) => ({ title: b, value: b })),
      ],
    });
    if (!ans || ans.base === undefined) return null;
    if (ans.base !== '__all__') filtered = filtered.filter((p) => p.baseModel === ans.base);
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

async function pickItems(plan, totalBytes, state) {
  const failed = plan.filter((p) => p.error);
  if (failed.length) view.log(t('tui.download.metaExcluded', { count: failed.length }));

  let available = await prefilter(plan);
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
      .join(' · ');

  const selected = new Set();
  const selectTitle = t('tui.download.selectTitle', { count: available.length, size: formatBytes(bytes) });

  // Prefer the full-screen interactive picker (search, sort and paging are all built in);
  // fall back to the prompts multiselect when there is no TTY or the terminal misbehaves.
  //
  // 首选全屏交互选择器（搜索/排序/翻页都在里面）；非 TTY 或终端异常时回退到 prompts 多选
  if (hasTTY()) {
    const picked = await selectItems(available, {
      pageSize: PICK_PAGE_SIZE,
      initialSelected: available.filter((p) => !state[p.modelId]).map((p) => String(p.modelId)),
      title: selectTitle,
      state,
      describe,
    });
    if (!picked) {
      view.log(t('tui.download.selectionCancelled'));
      return null;
    }
    for (const id of picked.selected) selected.add(String(id));
  } else {
    const ans = await prompts({
      type: 'multiselect',
      name: 'ids',
      message: selectTitle,
      instructions: t('tui.download.multiselectInstructions'),
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

async function chooseVersions(config, selectedPlan) {
  const multi = selectedPlan.filter((p) => p.versions && p.versions.length > 1);
  if (!multi.length) {
    view.log(t('tui.download.singleVersionOnly'));
    return true;
  }
  view.log(t('tui.download.multiVersionNotice', { count: multi.length }));

  const pinned = [];
  for (const item of multi) {
    const versions = item.versions;
    const choices = versions.map((v) => {
      const files = extractFiles(v.raw, config.site, {
        fileTypes: config.fileTypes,
        primaryOnly: config.primaryOnly,
      });
      const bytes = files.reduce((sum, f) => sum + f.bytes, 0);
      const current = String(v.id) === String(item.versionId) ? t('tui.download.currentMark') : '';
      return {
        title: view.truncate(`${v.name}${current}`, 64),
        value: v.id,
        description: t('tui.download.versionDescription', {
          baseModel: v.baseModel || '-',
          files: t('tui.download.fileCount', { count: files.length }),
          size: formatBytes(bytes),
          date: v.publishedAt ? String(v.publishedAt).slice(0, 10) : t('tui.download.unknownDate'),
        }),
      };
    });
    const initial = Math.max(
      0,
      versions.findIndex((v) => String(v.id) === String(item.versionId))
    );
    const ans = await prompts({
      type: 'select',
      name: 'versionId',
      message: t('tui.download.chooseVersionTitle', { name: view.truncate(item.name, 56) }),
      choices,
      initial,
    });
    if (!ans || ans.versionId === undefined) return false;

    if (String(ans.versionId) !== String(item.versionId)) {
      const chosen = versions.find((v) => String(v.id) === String(ans.versionId));
      Object.assign(
        item,
        versionToItem(config.site, chosen.raw, {
          fileTypes: config.fileTypes,
          primaryOnly: config.primaryOnly,
        })
      );
      view.log(t('tui.download.versionSwitched', { name: item.name, version: item.versionName }));
      pinned.push({ item, versionId: ans.versionId });
    }
  }

  if (pinned.length) {
    const ans = await prompts({
      type: 'confirm',
      name: 'pin',
      message: t('tui.download.pinConfirm', { count: pinned.length }),
      initial: true,
    });
    if (ans && ans.pin) {
      for (const p of pinned) p.item.pinVersionId = p.versionId;
      view.log(t('tui.download.pinMarked'));
    }
  }
  return true;
}

async function askOptions(config, selectedPlan, state) {
  const outAns = await prompts({
    type: 'text',
    name: 'dir',
    message: t('tui.download.outDirPrompt', { root: config.root }),
    initial: config.outDir,
    validate: (v) => (String(v).trim() ? true : t('tui.download.notEmpty')),
  });
  if (!outAns || outAns.dir === undefined) return null;
  const outDir = resolveOutDir(config, String(outAns.dir).trim());

  let force = false;
  const completedSelected = selectedPlan.filter((p) => stateMatches(p, state)).length;
  if (completedSelected) {
    const fAns = await prompts({
      type: 'confirm',
      name: 'force',
      message: t('tui.download.forceConfirm', { count: completedSelected }),
      initial: false,
    });
    if (!fAns) return null;
    force = !!fAns.force;
  }

  const selectedBytes = selectedPlan.reduce((sum, p) => sum + (p.totalBytes || 0), 0);
  const free = freeSpaceBytes(config.outDir);
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
  }

  let concurrency = Number(config.jobs) || 1;
  if (concurrency <= 1 && selectedPlan.length > 1) {
    const jobsAns = await prompts({
      type: 'select',
      name: 'jobs',
      message: t('tui.download.concurrencyPrompt'),
      choices: [
        { title: t('tui.download.jobsOne'), value: 1 },
        { title: t('tui.download.jobsTwo'), value: 2 },
        { title: t('tui.download.jobsThree'), value: 3 },
      ],
      initial: 0,
    });
    if (!jobsAns || jobsAns.jobs === undefined) return null;
    concurrency = jobsAns.jobs;
  }

  const go = await prompts({
    type: 'confirm',
    name: 'ok',
    message: t(force ? 'tui.download.startConfirmForce' : 'tui.download.startConfirm', {
      count: selectedPlan.length,
      size: formatBytes(selectedBytes),
      dir: outDir,
    }),
    initial: true,
  });
  if (!go || !go.ok) return null;

  return { outDir, force, selectedBytes, jobs: concurrency };
}

async function downloadFlow(config) {
  const idAns = await prompts({
    type: 'text',
    name: 'id',
    message: t('tui.download.collectionIdPrompt'),
    validate: (v) => (parseCollectionId(v) ? true : t('tui.download.invalidCollectionId')),
  });
  if (!idAns || idAns.id === undefined) return;
  const collectionId = parseCollectionId(idAns.id);

  const items = await fetchItems(config, collectionId);
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
  const selectedPlan = await pickItems(plan, totalBytes, state);
  if (!selectedPlan) return;

  const strategy = await prompts({
    type: 'select',
    name: 'mode',
    message: t('tui.download.versionStrategy'),
    choices: [
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
    ],
  });
  if (!strategy || strategy.mode === undefined) return;
  if (strategy.mode === 'choose') {
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

  const openAns = await prompts({
    type: 'confirm',
    name: 'open',
    message: t('tui.download.openDirConfirm'),
    initial: false,
  });
  if (openAns && openAns.open && view.openDir(options.outDir)) {
    view.log(t('tui.download.opened', { dir: options.outDir }));
  }
}

module.exports = { downloadFlow, prefilter };
