'use strict';

/**
 * TUI flow for "check for updates" by collection: pick one collection (or all), choose quick/deep,
 * then optionally download what changed.
 *
 * The collection list is the same interactive picker used everywhere else, so long snapshot lists
 * can be searched and scrolled instead of being printed as a wall of text. The check itself is also
 * reachable from the page of one collection (`checkCollectionsFlow`), which is why the two halves are
 * separate functions.
 *
 *
 * 「按收藏集检查更新」的 TUI 流程：选收藏集（或全部）→ 快速/深度 → 可选下载变化项。
 *
 * 收藏集列表用的也是全局同一套交互选择器，快照很多时可以搜索与滚动，而不是直接糊一屏文字。
 * 检查本身也能从某个收藏集的页面直接发起（`checkCollectionsFlow`），因此这两半是分开的函数。
 */

const { formatBytes } = require('../util');
const {
  checkUpdates,
  checkModelUpdates,
  reportLines,
  changedItems,
  markForRedownload,
  summarize,
} = require('../updater');
const { listCollectionIds, readCollection } = require('../storage');
const { t } = require('../i18n');
const view = require('./view');
const pages = require('./pages');
const reportPage = require('./report');
const screen = require('./screen');
const { runWithProgress } = require('./run');
const { color, format } = require('./tokens');

/**
 * Ask which collection(s) to check. Returns a single id, an array of ids, or null when cancelled.
 * 询问要检查哪个（些）收藏集。返回单个 ID、ID 数组，或取消时的 null。
 */
async function askCollectionId(config, message) {
  const ids = listCollectionIds(config);
  if (!ids.length) {
    view.log(t('tui.check.noRecords'));
    return null;
  }
  const rows = ids.map((id) => {
    const { snapshot } = readCollection(config, id, { allowCorrupt: true });
    const changes = (snapshot && snapshot.changes) || { added: [], removed: [], versionChanged: [] };
    return {
      modelId: String(id),
      name: t('tui.check.collectionLabel', { id }),
      type: `${snapshot ? snapshot.items.length : 0}`,
      baseModel: '',
      totalBytes: 0,
      members: snapshot ? snapshot.items.length : 0,
      fetchedAt: (snapshot && snapshot.fetchedAt) || null,
      changed: changes.added.length + changes.removed.length + changes.versionChanged.length,
    };
  });

  const scope = await pages.promptMenu(message, [
    { title: t('tui.check.allCollections'), value: '__all__', description: t('tui.check.allCollectionsDesc', { count: ids.length }) },
    { title: t('tui.check.pickOne'), value: '__pick__', description: t('tui.check.pickOneDesc') },
    { title: t('tui.check.manualId'), value: '__manual__' },
  ]);
  if (scope === null) return null;
  if (scope === '__all__') return ids;

  if (scope === '__pick__') {
    const chosen = await pages.pickOne(rows, {
      message: t('tui.check.pickCollection'),
      title: t('tui.check.pickCollection'),
      describe: (row) =>
        [
          t('tui.check.completionRecords', { count: row.members }),
          row.fetchedAt ? String(row.fetchedAt) : t('tui.manage.unknownTime'),
          row.changed ? t('tui.check.changesShort', { count: row.changed }) : t('tui.check.noChangesShort'),
        ].join(view.separator()),
      // The picker echoes the row label, which here is "Collection 12345" — the id is clearer.
      // 选择器默认回显行标题（这里是「收藏集 12345」），直接报 ID 更清楚。
      decidedMessage: 'tui.check.selected',
      decidedParams: (row) => ({ id: row.modelId }),
    });
    if (!chosen) return null;
    return String(chosen.modelId);
  }

  const manual = await pages.promptText(t('tui.check.collectionIdLabel'), {
    validate: (v) => (/^\d+$/.test(String(v).trim()) ? true : t('tui.check.invalidId')),
  });
  return manual === null ? null : String(manual).trim();
}

// ---------------------------------------------------------------------------
// Report pages
// 报告页
// ---------------------------------------------------------------------------

/**
 * Display name of one report target (collection label or model name/id).
 * 一个报告目标的显示名（收藏集标签或模型名/ID）。
 */
function targetLabel(report) {
  if (!report) return '';
  if (report.kind === 'model') {
    return report.modelName || t('tui.manage.modelIdLabel', { modelId: report.modelId });
  }
  return t('tui.check.collectionLabel', { id: report.collectionId });
}

/**
 * Human name of a version, falling back to the id and then to "unknown".
 * 版本的可读名称：名称 → ID → 未知。
 */
function versionLabel(name, versionId) {
  if (name) return String(name);
  if (versionId === undefined || versionId === null || versionId === '') return t('common.unknown');
  return String(versionId);
}

/**
 * Describe the file differences of one `fileChanged` bucket entry (changed/added/removed/renamed).
 * 描述 `fileChanged` 桶里一条记录的文件差异（变化/新增/移除/改名）。
 */
function fileDiffParts(diff) {
  const parts = [];
  if (!diff) return parts;
  if (diff.changed && diff.changed.length) {
    parts.push(
      t('updater.changePart', {
        names: diff.changed.map((item) => item.online.name || item.online.remoteName).join(t('updater.nameSeparator')),
      })
    );
  }
  if (diff.added && diff.added.length) {
    parts.push(
      t('updater.addedPart', {
        names: diff.added.map((item) => item.name || item.remoteName).join(t('updater.nameSeparator')),
      })
    );
  }
  if (diff.removed && diff.removed.length) {
    parts.push(
      t('updater.removedPart', {
        names: diff.removed.map((item) => item.name || item.remoteName).join(t('updater.nameSeparator')),
      })
    );
  }
  if (diff.renamed && diff.renamed.length) {
    parts.push(
      t('updater.renamedPart', {
        names: diff.renamed
          .map((pair) =>
            t('updater.renamePair', {
              from: pair.from.name || pair.from.remoteName,
              to: pair.to.name || pair.to.remoteName,
            })
          )
          .join(t('updater.nameSeparator')),
      })
    );
  }
  return parts;
}

/**
 * Build the sections of one report: only non-empty buckets get a section, so a clean check is short.
 * 生成单个报告的分区：只有非空桶才出现，干净的检查结果因此很短。
 */
function reportSections(report) {
  const sections = [
    {
      title: t('tui.check.report.sectionUpdated'),
      rows: report.updated.map(({ item, prev }) => ({
        label: item.name || item.modelId,
        detail: t('tui.report.fromTo', {
          from: prev
            ? versionLabel(prev.versionName, prev.pinnedVersionId || Object.keys(prev.versions || {}).join('/'))
            : t('updater.notDownloadedShort'),
          to: versionLabel(item.versionName, item.versionId),
        }),
      })),
    },
    {
      title: t('tui.check.report.sectionFileChanged'),
      rows: report.fileChanged.map(({ item, diff }) => ({
        label: item.name || item.modelId,
        detail: fileDiffParts(diff).join(t('common.reasonSeparator')),
      })),
    },
    {
      title: t('tui.check.report.sectionMissing'),
      rows: report.missing.map(({ item, reasons }) => ({
        label: item.name || item.modelId,
        detail: (Array.isArray(reasons) ? reasons : []).join(t('common.reasonSeparator')),
      })),
    },
    {
      title: t('tui.check.report.sectionNotDownloaded'),
      rows: report.notDownloaded.map((item) => ({
        label: item.name || item.modelId,
        detail: versionLabel(item.versionName, item.versionId),
      })),
    },
    {
      title: t('tui.check.report.sectionRemoved'),
      rows: report.removed.map((entry) => ({
        label: (entry.prev && entry.prev.name) || t('tui.manage.modelIdLabel', { modelId: entry.modelId }),
        detail: entry.versionId ? versionLabel(null, entry.versionId) : '',
      })),
    },
    {
      title: t('tui.check.report.sectionFailed'),
      rows: report.failed.map(({ item, error }) => ({
        label: (item && item.name) || (item && item.modelId) || '',
        detail: String(error || ''),
      })),
    },
  ].filter((section) => section.rows.length);

  if (!sections.length) {
    sections.push({
      title: t('tui.check.report.sectionResult'),
      rows: [],
      emptyText: t('tui.check.report.allGood'),
      emptyColor: color.success,
    });
  }
  return sections;
}

/**
 * Report model of one check report (collection or single model).
 * 单个检查报告（收藏集或单模型）的报告模型。
 */
function checkReportModel(config, report) {
  const stats = report.stats || summarize(report);
  const deep = !!report.deepChecked;
  const noSnapshot = report.kind !== 'model' && !report.hasSnapshot;
  const emptySnapshot =
    report.kind !== 'model' && report.hasSnapshot && (report.snapshotCount || 0) === 0;
  const needsSnapshot = noSnapshot || emptySnapshot;
  const summary = [
    { label: t('tui.check.report.factTarget'), value: targetLabel(report) },
    {
      label: t('tui.check.report.factMode'),
      value: deep ? t('tui.check.report.modeDeep') : t('tui.check.report.modeQuick'),
    },
    ...(report.kind === 'model'
      ? []
      : [
          {
            label: t('tui.check.report.factSnapshot'),
            value: noSnapshot
              ? t('tui.check.report.noSnapshot')
              : emptySnapshot
                ? t('tui.check.report.emptySnapshot')
                : t('tui.check.report.snapshotSaved', { count: report.snapshotCount || 0 }),
            color: needsSnapshot ? color.warning : null,
          },
        ]),
    { label: t('tui.check.report.factTotal'), value: String(stats.total) },
    { label: t('tui.check.report.factUpdated'), value: String(stats.updated) },
    { label: t('tui.check.report.factFileChanged'), value: String(stats.fileChanged) },
    { label: t('tui.check.report.factMissing'), value: String(stats.missing) },
    { label: t('tui.check.report.factNotDownloaded'), value: String(stats.notDownloaded) },
    { label: t('tui.check.report.factRemoved'), value: String(stats.removed) },
    { label: t('tui.check.report.factFailed'), value: String(stats.failed) },
    {
      label: t('tui.check.report.factCheckedAt'),
      value: format.dateTimeFull(report.checkedAt || ''),
    },
  ];
  if (report.corrupt) {
    summary.push({
      label: t('tui.check.report.factState'),
      value: t('tui.check.report.corrupt', { message: report.corrupt }),
      color: color.danger,
    });
  }

  const changes = changedItems(report);
  const actions = [];
  if (needsSnapshot) {
    // A manual collection id may point at a collection that was never enumerated, or at one whose
    // last enumeration returned nothing. Offer the enumeration right here: afterwards the check
    // runs against the fresh snapshot.
    //
    // 手动输入的收藏集 ID 可能从未枚举过，也可能上次枚举没读到任何成员。
    // 这里直接提供枚举入口，完成后再自动重新检查。
    actions.push({
      label: noSnapshot
        ? t('tui.check.report.actionSnapshot')
        : t('tui.check.report.actionSnapshotEmpty'),
      description: t('tui.check.report.actionSnapshotDesc'),
      run: async () => {
        await require('./download').downloadFlow(config, { collectionId: report.collectionId });
        const { snapshot } = readCollection(config, report.collectionId, { allowCorrupt: true });
        return snapshot ? 'recheck' : undefined;
      },
    });
  }
  if (changes.length) {
    actions.push({
      label: t('tui.check.report.actionDownload'),
      description: t('tui.check.report.actionDownloadDesc', { count: changes.length }),
      run: () => downloadReportChanges(config, [report]),
    });
  }
  actions.push({ label: t('tui.check.report.actionRecheck'), run: () => 'recheck' });
  actions.push({ label: t('tui.manage.back'), run: () => reportPage.BACK });

  const sections = needsSnapshot
    ? [
        {
          title: t('tui.check.report.sectionResult'),
          rows: [],
          emptyText: noSnapshot
            ? t('tui.check.report.noSnapshotHint')
            : t('tui.check.report.emptySnapshotHint'),
          emptyColor: color.warning,
        },
      ]
    : reportSections(report);

  return {
    title:
      report.kind === 'model'
        ? t('tui.check.report.titleModel', { name: targetLabel(report) })
        : t('tui.check.report.titleCollection', { id: report.collectionId }),
    summary,
    sections,
    actions,
    rebuild: () => checkReportModel(config, report),
  };
}

/**
 * Report model of several targets: one row per target, Enter opens its own report.
 * 多目标的报告模型：每个目标一行，Enter 进入它自己的报告。
 */
function checkReportsModel(config, reports) {
  const rows = reports.map((report) => {
    const stats = report.stats || summarize(report);
    return {
      label: targetLabel(report),
      detail:
        report.kind === 'collection' && !report.hasSnapshot
          ? t('tui.check.report.noSnapshotShort')
          : report.kind === 'collection' && (report.snapshotCount || 0) === 0
            ? t('tui.check.report.emptySnapshotShort')
            : t('tui.check.report.targetDetail', {
              members: report.snapshotCount || stats.total,
              problems: stats.problems || 0,
              changes: changedItems(report).length,
            }),
      raw: report,
    };
  });
  const changes = reports.reduce((sum, report) => sum + changedItems(report).length, 0);
  const problems = reports.reduce(
    (sum, report) => sum + ((report.stats || summarize(report)).problems || 0),
    0
  );
  return {
    title: t('tui.check.report.listTitle'),
    summary: [
      { label: t('tui.check.report.factTargets'), value: String(reports.length) },
      { label: t('tui.check.report.factProblems'), value: String(problems) },
      { label: t('tui.check.report.factChanges'), value: String(changes) },
    ],
    sections: [
      {
        title: t('tui.check.report.sectionTargets'),
        rows,
        onEnter: (report) => reportPage.showReportPage(config, checkReportModel(config, report)),
      },
    ],
    actions: [
      ...(changes
        ? [
            {
              label: t('tui.check.report.actionDownloadAll'),
              description: t('tui.check.report.actionDownloadAllDesc', { count: changes }),
              run: () => downloadReportChanges(config, reports),
            },
          ]
        : []),
      { label: t('tui.check.report.actionRecheck'), run: () => 'recheck' },
      { label: t('tui.manage.back'), run: () => reportPage.BACK },
    ],
  };
}

/**
 * Export the reports as a page (single target) or a list page (several targets).
 * 把报告显示成页面：单个目标直接进报告，多个目标先进列表。
 *
 * @returns {Promise<'recheck'|null>}
 */
async function showCheckReports(config, reports) {
  const list = (Array.isArray(reports) ? reports : []).filter(Boolean);
  if (!list.length) return null;
  if (list.length === 1) {
    return reportPage.showReportPage(config, checkReportModel(config, list[0]));
  }
  return reportPage.showReportPage(config, checkReportsModel(config, list));
}

/**
 * Reset the records the report points at and hand the changed items to the shared download plan.
 * 重置报告涉及的状态记录，并把变化项交给共享下载计划。
 */
async function downloadReportChanges(config, reports) {
  const list = (Array.isArray(reports) ? reports : []).filter(Boolean);
  const parts = list
    .map((report) => ({ report, plan: changedItems(report) }))
    .filter((part) => part.plan.length);
  if (!parts.length) {
    view.notice(t('tui.check.report.noChanges'), color.warning);
    return undefined;
  }

  for (const { report } of parts) {
    // Reset only the problematic version; the other versions of the same model keep their records.
    // 只重置「有问题的那个版本」，保留同一模型的其它版本记录。
    const redownload = [...report.fileChanged, ...report.missing].map((entry) => ({
      modelId: String(entry.item.modelId),
      versionId:
        entry.item.versionId === undefined || entry.item.versionId === null
          ? null
          : String(entry.item.versionId),
    }));
    const n = markForRedownload(config, redownload);
    if (n) view.log(t('tui.check.stateReset', { count: n }));
  }

  const plan = parts.flatMap((part) => part.plan);
  const totalBytes = plan.reduce((sum, item) => sum + (Number(item.totalBytes) || 0), 0);
  const single = parts.length === 1 ? parts[0].report : null;
  const collectionId = single
    ? single.kind === 'model'
      ? `model-${single.modelId}`
      : String(single.collectionId)
    : `check-${Date.now()}`;
  const name = single ? targetLabel(single) : t('tui.check.report.allTargets', { count: parts.length });

  return require('./download').runDownloadPlan(config, {
    plan,
    collectionId,
    name,
    sourceLine: t('tui.check.report.planSource', {
      count: plan.length,
      size: formatBytes(totalBytes),
    }),
    outDir: config.outDir,
    jobs: config.jobs,
  });
}

/**
 * Collect the reports of one model-check run (used by the model page's "check updates").
 * 收集一次模型检查的报告（模型页的「检查更新」使用）。
 */
async function collectModelReports(config, targets, mode) {
  const reports = [];
  for (const modelId of targets) {
    // Deep checks hash the local files: name the model being checked so a slow one is not "frozen".
    // 深度检查会计算本地文件哈希：把正在检查的模型报出来，慢的时候才不像卡死。
    view.log(
      t('tui.models.checkingModel', {
        label: t('tui.manage.modelIdLabel', { modelId }),
      })
    );
    const { report } = await checkModelUpdates(
      config,
      modelId,
      { verifyFiles: mode === 'deep' },
      { log: view.log }
    );
    report.stats = summarize(report);
    reports.push(report);
  }
  return reports;
}

/**
 * Collect the reports of one collection-check run.
 * 收集一次收藏集检查的报告。
 */
async function collectCollectionReports(config, ids, mode) {
  const reports = [];
  for (const id of ids) {
    view.log(t('tui.check.collectionHeader', { id }));
    const { report } = await checkUpdates(
      config,
      id,
      { verifyFiles: mode === 'deep', withPlan: true },
      { log: view.log }
    );
    report.stats = summarize(report);
    reports.push(report);
  }
  return reports;
}

/**
 * Check the given collections and offer to download what changed.
 * 检查给定的收藏集，并询问是否下载变化项。
 *
 * @param {string[]} ids collection ids to check
 */
async function checkCollectionsFlow(config, ids) {
  const targets = (Array.isArray(ids) ? ids : [ids]).map(String).filter(Boolean);
  if (!targets.length) return;

  const mode = await pages.promptMenu(
    t('tui.check.modeTitle'),
    [
      { title: t('tui.check.modeQuick'), value: 'quick', description: t('tui.check.modeQuickDesc') },
      { title: t('tui.check.modeDeep'), value: 'deep', description: t('tui.check.modeDeepDesc') },
    ],
    { stage: t('tui.app.menuCheck') }
  );
  if (mode === null) return;

  // Inside the shell the report is a page: statistics and buckets are visible without pressing `L`,
  // and "download changes" goes through the shared plan/confirm flow.
  //
  // 外壳接管时报告是一页：统计与明细不必按 `L` 就能看到，
  // 「下载变化项」走共享的计划/确认流程。
  if (screen.isActive()) {
    for (;;) {
      const reports = await pages.withSpinner(t('tui.check.checking'), () =>
        collectCollectionReports(config, targets, mode)
      );
      const outcome = await showCheckReports(config, reports);
      if (outcome !== 'recheck') return;
    }
  }

  const reports = [];
  for (const id of targets) {
    if (targets.length > 1) view.log(t('tui.check.collectionHeader', { id }));
    const { report } = await checkUpdates(
      config,
      id,
      { verifyFiles: mode === 'deep', withPlan: true },
      { log: view.log }
    );
    report.stats = summarize(report);
    reports.push(report);
    for (const line of reportLines(report)) view.log(line);
  }

  const allChanges = reports.flatMap((r) => changedItems(r));
  if (!allChanges.length) {
    view.bell();
    return;
  }

  const go = await pages.promptConfirm(t('tui.check.downloadConfirm', { count: allChanges.length }));
  if (!go) return;

  let failed = 0;
  for (const report of reports) {
    const items = changedItems(report);
    if (!items.length) continue;
    // Reset only the problematic version; the other versions of the same model keep their records.
    // 只重置「有问题的那个版本」，保留同一模型的其它版本记录
    const redownloadItems = [...report.fileChanged, ...report.missing].map((r) => ({
      modelId: String(r.item.modelId),
      versionId: r.item.versionId,
    }));
    const n = markForRedownload(config, redownloadItems);
    if (n) view.log(t('tui.check.stateReset', { count: n }));

    const totalBytes = items.reduce((sum, p) => sum + (p.totalBytes || 0), 0);
    view.log(
      t('tui.check.startUpdate', {
        collectionId: report.collectionId,
        count: items.length,
        size: formatBytes(totalBytes),
      })
    );
    const summary = await runWithProgress(config, {
      collectionId: report.collectionId,
      name: t('tui.check.collectionLabel', { id: report.collectionId }),
      plan: items,
      outDir: config.outDir,
      force: false,
      totalBytes,
      jobs: config.jobs,
      attempts: config.downloadAttempts,
    });
    if (summary.failed) failed++;
    const stats = { done: summary.done, skipped: summary.skipped, failed: summary.failed };
    view.notice(
      summary.cancelled ? t('tui.check.summaryCancelled', stats) : t('tui.check.summaryDone', stats),
      summary.cancelled || summary.failed ? color.warning : color.success
    );
  }
  view.bell();
  if (failed) view.notice(t('tui.check.failedNotice'), color.danger);
}

/**
 * Standalone entry: ask which collections, then run the check.
 * 独立入口：先问要检查哪些收藏集，再执行检查。
 */
async function checkFlow(config) {
  const picked = await askCollectionId(config, t('tui.check.pickCollection'));
  if (!picked) return;
  return checkCollectionsFlow(config, Array.isArray(picked) ? picked : [picked]);
}

module.exports = {
  checkFlow,
  checkCollectionsFlow,
  askCollectionId,
  collectCollectionReports,
  collectModelReports,
  showCheckReports,
  checkReportModel,
  checkReportsModel,
  downloadReportChanges,
};
