'use strict';

/**
 * TUI flow for the model library (one model with several versions, one record per model).
 *
 * Unlike "download a collection": no collection enumeration happens here; models are located
 * directly by model URL / model:<ID> / version:<ID>, then each model picks its version and output
 * directory and gets downloaded; every record lives in .data/library.json. A collection is only a
 * membership snapshot used as an optional filter.
 *
 *
 * 模型库（一个模型多个版本、一模型一记录）的 TUI 流程。
 *
 * 与「下载收藏集」的区别：这里不做收藏集枚举，直接按模型 URL / model:<ID> / version:<ID>
 * 定位模型，逐模型选版本、选目录、下载；记录统一落在 .data/library.json。
 * 收藏集只是成员快照，用作可选的筛选条件。
 */

const prompts = require('prompts');
const { formatBytes } = require('../util');
const { readLibrary, readCollection, listCollectionIds, entryVersions, getVersion } = require('../storage');
const {
  checkModelUpdates,
  reportLines,
  changedItems,
  summarize,
  markForRedownload,
  setPin,
} = require('../updater');
const { fetchModelDetail, versionToItem, extractFiles } = require('../api');
const { resolveOutDir } = require('../config');
const {
  collectModels,
  filterModels,
  sortModels,
  printList,
  forgetModels,
} = require('../commands/models');
const { verifyModels } = require('../commands/verify');
const { refToTarget } = require('../commands/download');
const { t } = require('../i18n');
const view = require('./view');
const { runWithProgress } = require('./run');

/**
 * Parse pasted batch input: split on lines and commas, ignoring empty entries and # comments.
 * 解析粘贴的批量输入：按行/逗号切分，忽略空项与 # 注释
 */
function parseRefs(text) {
  return String(text === undefined || text === null ? '' : text)
    .split(/[\r\n,]+/)
    .map((s) => s.replace(/#.*$/, '').trim())
    .filter(Boolean);
}

/**
 * Library entries keyed by model ID.
 * 模型库记录（按模型 ID 索引）。
 */
function libraryEntries(config) {
  return readLibrary(config, { allowCorrupt: true }).entries;
}

function readEntry(config, modelId) {
  return libraryEntries(config)[String(modelId)] || null;
}

function libraryModelIds(config) {
  return Object.keys(libraryEntries(config)).sort();
}

function entryBytes(entry) {
  return entryVersions(entry).reduce(
    (sum, v) => sum + (v.files || []).reduce((s, f) => s + (Number(f.bytes) || 0), 0),
    0
  );
}

function modelLabel(config, modelId) {
  const entry = readEntry(config, modelId);
  return (entry && entry.name) || t('tui.manage.modelIdLabel', { modelId });
}

function versionSummary(entry) {
  const versions = entryVersions(entry);
  return {
    count: versions.length,
    size: formatBytes(entryBytes(entry)),
    pinned: entry && entry.pinnedVersionId ? t('tui.manage.pinnedVersion') : t('tui.models.notPinned'),
  };
}

/**
 * Pick a single model (log a hint and return null when the library is empty).
 * 选择一个模型（模型库为空时给出提示并返回 null）
 */
async function pickModel(config, message) {
  const ids = libraryModelIds(config);
  if (!ids.length) {
    view.log(t('tui.models.noRecords'));
    return null;
  }
  const ans = await prompts({
    type: 'select',
    name: 'modelId',
    message,
    choices: ids.map((modelId) => {
      const entry = readEntry(config, modelId);
      return {
        title: view.truncate(modelLabel(config, modelId), 70),
        value: modelId,
        description: t('tui.models.modelChoiceDesc', versionSummary(entry)),
      };
    }),
  });
  if (!ans || ans.modelId === undefined) return null;
  return String(ans.modelId);
}

// ---------------------------------------------------------------------------
// Download a single model
// 下载单个模型
// ---------------------------------------------------------------------------

/**
 * Resolve user input into [{modelId, versionId}] (version:<id> looks up modelId online).
 * 把用户输入解析为 [{modelId, versionId}]（version:<id> 会联网反查 modelId）
 */
async function resolveRefs(config, raws) {
  const picks = [];
  const seen = new Set();
  for (const raw of raws) {
    let target = null;
    try {
      target = await refToTarget(config, raw);
    } catch (e) {
      view.log(view.colors.red(t('tui.models.fetchFailed', { name: raw, error: e.message })));
      continue;
    }
    if (!target || target.kind !== 'model') {
      view.log(t('tui.models.refInvalid', { value: raw }));
      continue;
    }
    const key = `${target.ref.modelId}:${target.ref.versionId || ''}`;
    if (seen.has(key)) continue;
    seen.add(key);
    picks.push(target.ref);
  }
  return picks;
}

/**
 * Choose the version to download for one model (choose one by one when there are several,
 * marking the downloaded / pinned ones).
 *
 * 为一个模型选出要下载的版本（多版本时逐个选择，标注已下载/已固定）
 */
async function chooseVersion(config, detail, wanted) {
  const versions = Array.isArray(detail.modelVersions) ? detail.modelVersions : [];
  const entry = readEntry(config, detail.id);
  const localIds = new Set(entryVersions(entry).map((v) => String(v.versionId)));
  const pinnedId = entry && entry.pinnedVersionId ? String(entry.pinnedVersionId) : null;
  const initialId = wanted || (versions[0] ? String(versions[0].id) : null);
  let version = versions.find((v) => String(v.id) === String(initialId)) || versions[0] || null;
  if (!version) return null;
  if (versions.length <= 1) return version;

  const choices = versions.map((v) => {
    const files = extractFiles(v, config.site, {
      fileTypes: config.fileTypes,
      primaryOnly: config.primaryOnly,
    });
    const bytes = files.reduce((sum, f) => sum + (Number(f.bytes) || 0), 0);
    const marks = [
      String(v.id) === String(initialId) ? t('tui.download.currentMark') : '',
      localIds.has(String(v.id)) ? t('tui.download.statusDownloaded') : '',
      pinnedId === String(v.id) ? t('tui.download.statusPinned') : '',
    ].filter(Boolean);
    return {
      title: view.truncate(marks.length ? `${v.name} ${marks.join(' ')}` : String(v.name), 64),
      value: v.id,
      description: t('tui.download.versionDescription', {
        baseModel: v.baseModel || '-',
        files: t('tui.download.fileCount', { count: files.length }),
        size: formatBytes(bytes),
        date: v.publishedAt ? String(v.publishedAt).slice(0, 10) : t('tui.download.unknownDate'),
      }),
    };
  });

  const ans = await prompts({
    type: 'select',
    name: 'versionId',
    message: t('tui.models.chooseVersion', { name: view.truncate(String(detail.name), 56) }),
    choices,
    initial: Math.max(
      0,
      versions.findIndex((v) => String(v.id) === String(initialId))
    ),
  });
  if (!ans || ans.versionId === undefined) return null;
  return versions.find((v) => String(v.id) === String(ans.versionId)) || version;
}

async function downloadFlow(config) {
  const ans = await prompts({
    type: 'text',
    name: 'refs',
    message: t('tui.models.downloadPrompt'),
    validate: (v) => (parseRefs(v).length ? true : t('tui.models.notEmpty')),
  });
  if (!ans || ans.refs === undefined) return;

  const picks = await resolveRefs(config, parseRefs(ans.refs));
  if (!picks.length) {
    view.log(t('tui.models.noRefs'));
    return;
  }

  const items = [];
  for (const ref of picks) {
    view.log(t('tui.models.fetchingModel', { modelId: ref.modelId }));
    let detail = null;
    try {
      detail = await fetchModelDetail(config.site, ref.modelId, config.userAgent);
    } catch (e) {
      view.log(view.colors.red(t('tui.models.fetchFailed', { name: ref.modelId, error: e.message })));
      continue;
    }
    const versions = Array.isArray(detail.modelVersions) ? detail.modelVersions : [];
    if (!versions.length) {
      view.log(t('tui.models.noVersionsOnline', { name: detail.name }));
      continue;
    }
    const version = await chooseVersion(config, detail, ref.versionId);
    if (!version) {
      view.log(t('tui.manage.cancelled'));
      return;
    }
    const item = Object.assign(
      {
        modelId: detail.id,
        name: detail.name,
        type: detail.type,
        baseModel: version.baseModel,
        // Raw site object: mirrored into the library so every known field is recorded
        // 站点原始对象：镜像进模型库，完整记录已知字段
        modelMeta: detail,
      },
      versionToItem(config.site, version, {
        fileTypes: config.fileTypes,
        primaryOnly: config.primaryOnly,
      })
    );
    if (!item.files.length) {
      view.log(t('tui.models.noFiles', { name: detail.name, version: version.name || version.id }));
      continue;
    }
    items.push(item);
  }
  if (!items.length) return;

  const outAns = await prompts({
    type: 'text',
    name: 'dir',
    message: t('tui.download.outDirPrompt', { root: config.root }),
    initial: config.outDir,
    validate: (v) => (String(v).trim() ? true : t('tui.download.notEmpty')),
  });
  if (!outAns || outAns.dir === undefined) return;
  const outDir = resolveOutDir(config, String(outAns.dir).trim());

  const totalBytes = items.reduce((sum, item) => sum + (item.totalBytes || 0), 0);
  const doneCount = items.filter((item) => getVersion(readEntry(config, item.modelId), item.versionId)).length;
  let force = false;
  if (doneCount) {
    const forceAns = await prompts({
      type: 'confirm',
      name: 'force',
      message: t('tui.download.forceConfirm', { count: doneCount }),
      initial: false,
    });
    if (!forceAns) return;
    force = !!forceAns.force;
  }

  const go = await prompts({
    type: 'confirm',
    name: 'ok',
    message: t('tui.download.startConfirm', {
      count: items.length,
      size: formatBytes(totalBytes),
      dir: outDir,
    }),
    initial: true,
  });
  if (!go || !go.ok) {
    view.log(t('tui.manage.cancelled'));
    return;
  }

  // Downloads share the global library, so they run one model at a time through the progress panel.
  // 下载共用全局模型库，因此逐个模型走进度面板。
  let failed = 0;
  for (const item of items) {
    const summary = await runWithProgress(config, {
      collectionId: `model-${item.modelId}`,
      plan: [item],
      outDir,
      force,
      totalBytes: item.totalBytes || 0,
      jobs: 1,
      attempts: config.downloadAttempts,
    });
    if (summary.failed) failed++;
    const stats = { done: summary.done, skipped: summary.skipped, failed: summary.failed };
    view.log(
      summary.cancelled
        ? t('tui.download.summaryCancelled', stats)
        : t('tui.download.summaryDone', stats)
    );
  }
  view.bell();
  if (failed) view.log(view.colors.red(t('tui.models.downloadFailed')));

  const openAns = await prompts({
    type: 'confirm',
    name: 'open',
    message: t('tui.download.openDirConfirm'),
    initial: false,
  });
  if (openAns && openAns.open && view.openDir(outDir)) {
    view.log(t('tui.download.opened', { dir: outDir }));
  }
}

// ---------------------------------------------------------------------------
// List the library
// 列出模型库
// ---------------------------------------------------------------------------

/**
 * Optional collection filter: the membership snapshot decides which models are shown.
 * 可选的收藏集筛选：由成员快照决定显示哪些模型。
 */
async function askCollectionFilter(config) {
  const ids = listCollectionIds(config);
  if (!ids.length) return { ids: null };
  const ans = await prompts({
    type: 'select',
    name: 'collection',
    message: t('tui.models.filterCollection'),
    choices: [
      { title: t('tui.models.allCollections'), value: '__all__' },
      ...ids.map((id) => {
        const { snapshot } = readCollection(config, id, { allowCorrupt: true });
        return {
          title: t('tui.models.collectionItem', {
            id,
            count: snapshot ? snapshot.items.length : 0,
          }),
          value: id,
        };
      }),
    ],
  });
  if (!ans || ans.collection === undefined) return null;
  if (ans.collection === '__all__') return { ids: null };
  const { snapshot } = readCollection(config, String(ans.collection), { allowCorrupt: true });
  return { ids: snapshot ? snapshot.items.map((it) => String(it.modelId)) : [] };
}

async function listFlow(config) {
  const all = collectModels(config);
  if (!all.length) {
    view.log(t('tui.models.noRecords'));
    return;
  }

  const filter = await askCollectionFilter(config);
  if (!filter) return;
  const scoped = filter.ids ? all.filter((m) => filter.ids.includes(m.modelId)) : all;

  const ans = await prompts({
    type: 'text',
    name: 'kw',
    message: t('tui.download.keywordPrompt', { count: scoped.length }),
  });
  if (!ans || ans.kw === undefined) return;
  const keyword = String(ans.kw).trim();
  printList(sortModels(filterModels(scoped, keyword), 'recent'), { filtered: !!keyword });
}

// ---------------------------------------------------------------------------
// Check for updates
// 检查更新
// ---------------------------------------------------------------------------

async function checkFlow(config) {
  const ids = libraryModelIds(config);
  if (!ids.length) {
    view.log(t('tui.models.noRecords'));
    return;
  }

  const scope = await prompts({
    type: 'select',
    name: 'scope',
    message: t('tui.models.checkScope'),
    choices: [
      { title: t('tui.models.checkAll', { count: ids.length }), value: '__all__' },
      { title: t('tui.models.checkOne'), value: '__one__' },
    ],
  });
  if (!scope || scope.scope === undefined) return;
  let targets = ids;
  if (scope.scope === '__one__') {
    const picked = await pickModel(config, t('tui.models.checkPick'));
    if (!picked) return;
    targets = [picked];
  }

  const mode = await prompts({
    type: 'select',
    name: 'deep',
    message: t('tui.check.modeTitle'),
    choices: [
      { title: t('tui.check.modeQuick'), value: false, description: t('tui.check.modeQuickDesc') },
      { title: t('tui.check.modeDeep'), value: true, description: t('tui.check.modeDeepDesc') },
    ],
  });
  if (!mode || mode.deep === undefined) return;

  const reports = [];
  for (const modelId of targets) {
    if (targets.length > 1) view.log(t('tui.models.header', { label: modelLabel(config, modelId) }));
    const { report } = await checkModelUpdates(
      config,
      modelId,
      { verifyFiles: !!mode.deep },
      { log: view.log }
    );
    report.stats = summarize(report);
    reports.push(report);
    for (const line of reportLines(report)) view.log(line);
  }

  const changes = reports.flatMap((report) => changedItems(report));
  if (!changes.length) {
    view.bell();
    return;
  }

  const go = await prompts({
    type: 'confirm',
    name: 'go',
    message: t('tui.check.downloadConfirm', { count: changes.length }),
    initial: true,
  });
  if (!go || !go.go) return;

  let failed = 0;
  for (const report of reports) {
    const plan = changedItems(report);
    if (!plan.length) continue;
    const redownload = [...report.fileChanged, ...report.missing].map((r) => ({
      modelId: String(r.item.modelId),
      versionId:
        r.item.versionId === undefined || r.item.versionId === null ? null : String(r.item.versionId),
    }));
    const n = markForRedownload(config, redownload);
    if (n) view.log(t('tui.check.stateReset', { count: n }));

    const totalBytes = plan.reduce((sum, item) => sum + (item.totalBytes || 0), 0);
    view.log(
      t('tui.models.startUpdate', {
        label: modelLabel(config, report.modelId),
        count: plan.length,
        size: formatBytes(totalBytes),
      })
    );
    const summary = await runWithProgress(config, {
      collectionId: `model-${report.modelId}`,
      plan,
      outDir: config.outDir,
      force: false,
      totalBytes,
      jobs: config.jobs,
      attempts: config.downloadAttempts,
    });
    if (summary.failed) failed++;
    const stats = { done: summary.done, skipped: summary.skipped, failed: summary.failed };
    view.log(summary.cancelled ? t('tui.check.summaryCancelled', stats) : t('tui.check.summaryDone', stats));
  }
  view.bell();
  if (failed) view.log(view.colors.red(t('tui.check.failedNotice')));
}

// ---------------------------------------------------------------------------
// Verify / repair
// 校验 / 修复
// ---------------------------------------------------------------------------

async function verifyFlow(config) {
  const ids = libraryModelIds(config);
  if (!ids.length) {
    view.log(t('tui.models.noRecords'));
    return;
  }
  const scope = await prompts({
    type: 'select',
    name: 'scope',
    message: t('tui.models.verifyPick'),
    choices: [
      { title: t('tui.models.verifyAll', { count: ids.length }), value: '__all__' },
      { title: t('tui.models.checkOne'), value: '__one__' },
    ],
  });
  if (!scope || scope.scope === undefined) return;
  let targets = ids;
  if (scope.scope === '__one__') {
    const picked = await pickModel(config, t('tui.models.checkPick'));
    if (!picked) return;
    targets = [picked];
  }

  const deep = await prompts({
    type: 'confirm',
    name: 'deep',
    message: t('tui.manage.hashConfirm'),
    initial: true,
  });
  if (!deep || deep.deep === undefined) return;

  view.log(t('tui.manage.verifying'));
  const result = await verifyModels(config, targets, { noHash: !deep.deep });
  console.log('');
  console.log(
    t('tui.manage.verifySummary', {
      label: result.label,
      total: result.total,
      size: formatBytes(result.totalBytes),
    })
  );
  if (result.corrupt) console.log(`  ! ${result.corrupt}`);
  console.log(`  ${t('tui.manage.verifyCounts', { ok: result.ok.length, broken: result.broken.length })}`);
  for (const b of result.broken) {
    console.log(
      `  ! ${t('tui.manage.brokenLine', {
        name: b.name,
        reasons: b.reasons.join(t('tui.manage.reasonSeparator')),
      })}`
    );
    console.log(`    ${t('tui.manage.dirLine', { dir: b.dir })}`);
  }
  if (!result.broken.length) {
    view.log(t('tui.manage.verifyAllOk'));
    return;
  }

  const repair = await prompts({
    type: 'confirm',
    name: 'go',
    message: t('tui.manage.repairConfirm', { count: result.broken.length }),
    initial: true,
  });
  if (!repair || !repair.go) return;

  let failed = 0;
  for (const item of result.broken) {
    // Re-read the library every time: the previous repair already rewrote it
    // 每次都重读模型库：上一次修复已经改写过它
    const prev = readEntry(config, item.modelId);
    const versionRec = getVersion(prev, item.versionId);
    if (!prev || !versionRec) continue;
    const files = (item.brokenFiles || []).filter((f) => f.downloadUrl);
    if (!files.length) {
      view.log(t('tui.manage.skipNoUrl', { name: item.name }));
      continue;
    }
    const summary = await runWithProgress(config, {
      collectionId: `model-${item.modelId}`,
      plan: [
        {
          modelId: item.modelId,
          name: prev.name,
          type: prev.type,
          baseModel: prev.baseModel,
          versionId: versionRec.versionId,
          versionName: versionRec.versionName,
          outDirOverride: versionRec.outDir || null,
          dirName: versionRec.dirName || null,
          files,
          totalBytes: files.reduce((sum, f) => sum + (f.bytes || 0), 0),
        },
      ],
      outDir: versionRec.outDir || config.outDir,
      force: true,
      totalBytes: files.reduce((sum, f) => sum + (f.bytes || 0), 0),
      jobs: 1,
      attempts: config.downloadAttempts,
    });
    if (summary.failed) failed++;
  }
  view.bell();
  if (failed) view.log(view.colors.red(t('tui.manage.repairFailed')));
}

// ---------------------------------------------------------------------------
// Pin / unpin
// 固定 / 取消固定
// ---------------------------------------------------------------------------

async function pinFlow(config) {
  const modelId = await pickModel(config, t('tui.models.pinPick'));
  if (!modelId) return;
  const entry = readEntry(config, modelId);
  const versions = entryVersions(entry);
  if (!versions.length) {
    view.log(t('tui.manage.noVersionId'));
    return;
  }
  const pinnedId = entry && entry.pinnedVersionId ? String(entry.pinnedVersionId) : null;

  const mode = await prompts({
    type: 'select',
    name: 'mode',
    message: t('tui.models.pinMode'),
    choices: [
      { title: t('tui.manage.pinAction'), value: 'pin', description: t('tui.manage.pinActionDesc') },
      { title: t('tui.manage.unpinAction'), value: 'unpin', description: t('tui.manage.unpinActionDesc') },
      { title: t('tui.manage.back'), value: 'back' },
    ],
  });
  if (!mode || mode.mode === undefined || mode.mode === 'back') return;

  if (mode.mode === 'unpin') {
    if (!pinnedId) {
      view.log(t('tui.manage.noPinned'));
      return;
    }
    setPin(config, modelId, null);
    view.log(t('pin.unpinned', { name: entry.name || modelId }));
    return;
  }

  const ans = await prompts({
    type: 'select',
    name: 'versionId',
    message: t('tui.models.pinVersionPick'),
    choices: versions.map((v) => {
      const bytes = (v.files || []).reduce((sum, f) => sum + (Number(f.bytes) || 0), 0);
      const mark = String(v.versionId) === pinnedId ? ` ${t('tui.manage.pinnedMark')}` : '';
      return {
        title: view.truncate(`${v.versionName || v.versionId}${mark}`, 64),
        value: String(v.versionId),
        description: t('tui.models.versionChoiceDesc', {
          versionId: v.versionId,
          size: formatBytes(bytes),
          date: v.verifiedAt ? String(v.verifiedAt).slice(0, 10) : t('tui.manage.unknownTime'),
        }),
      };
    }),
    initial: Math.max(
      0,
      versions.findIndex((v) => String(v.versionId) === pinnedId)
    ),
  });
  if (!ans || ans.versionId === undefined) return;

  const rec = getVersion(entry, ans.versionId);
  setPin(config, modelId, ans.versionId);
  view.log(
    t('pin.pinned', {
      name: entry.name || modelId,
      version: (rec && rec.versionName) || ans.versionId,
    })
  );
}

// ---------------------------------------------------------------------------
// Delete records
// 删除记录
// ---------------------------------------------------------------------------

async function forgetFlow(config) {
  const ids = libraryModelIds(config);
  if (!ids.length) {
    view.log(t('tui.models.noRecords'));
    return;
  }
  const ans = await prompts({
    type: 'multiselect',
    name: 'ids',
    message: t('tui.models.forgetPick'),
    instructions: t('tui.manage.unpinInstructions'),
    choices: ids.map((modelId) => {
      const entry = readEntry(config, modelId);
      return {
        title: view.truncate(modelLabel(config, modelId), 70),
        value: modelId,
        description: t('tui.models.modelChoiceDesc', versionSummary(entry)),
      };
    }),
  });
  if (!ans || ans.ids === undefined) return;
  const chosen = ans.ids.map(String);
  if (!chosen.length) {
    view.log(t('tui.manage.noChanges'));
    return;
  }

  const confirm = await prompts({
    type: 'confirm',
    name: 'ok',
    message: t('tui.models.forgetConfirm', { count: chosen.length }),
    initial: false,
  });
  if (!confirm || !confirm.ok) {
    view.log(t('tui.manage.cancelled'));
    return;
  }
  const filesAns = await prompts({
    type: 'confirm',
    name: 'files',
    message: t('tui.models.forgetFilesConfirm'),
    initial: false,
  });
  if (!filesAns || filesAns.files === undefined) return;

  for (const modelId of chosen) {
    forgetModels(config, modelId, { deleteFiles: !!filesAns.files });
  }
}

// ---------------------------------------------------------------------------
// Entry point
// 入口
// ---------------------------------------------------------------------------

async function modelsFlow(config) {
  const ans = await prompts({
    type: 'select',
    name: 'action',
    message: t('tui.models.menuTitle'),
    choices: [
      {
        title: t('tui.models.menuDownload'),
        value: 'download',
        description: t('tui.models.menuDownloadDesc'),
      },
      { title: t('tui.models.menuList'), value: 'list', description: t('tui.models.menuListDesc') },
      { title: t('tui.models.menuCheck'), value: 'check', description: t('tui.models.menuCheckDesc') },
      {
        title: t('tui.models.menuVerify'),
        value: 'verify',
        description: t('tui.models.menuVerifyDesc'),
      },
      { title: t('tui.models.menuPin'), value: 'pin', description: t('tui.models.menuPinDesc') },
      {
        title: t('tui.models.menuForget'),
        value: 'forget',
        description: t('tui.models.menuForgetDesc'),
      },
      { title: t('tui.manage.back'), value: 'back' },
    ],
  });
  const action = ans && ans.action;
  if (action === undefined || action === 'back') return;

  if (action === 'download') return downloadFlow(config);
  if (action === 'list') return listFlow(config);
  if (action === 'check') return checkFlow(config);
  if (action === 'verify') return verifyFlow(config);
  if (action === 'pin') return pinFlow(config);
  if (action === 'forget') return forgetFlow(config);
}

module.exports = {
  modelsFlow,
  parseRefs,
  resolveRefs,
  chooseVersion,
  pickModel,
  libraryEntries,
  libraryModelIds,
  verifyFlow,
};
