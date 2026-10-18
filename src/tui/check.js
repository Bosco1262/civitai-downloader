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
const { checkUpdates, reportLines, changedItems, markForRedownload, summarize } = require('../updater');
const { listCollectionIds, readCollection } = require('../storage');
const { t } = require('../i18n');
const view = require('./view');
const pages = require('./pages');
const { runWithProgress } = require('./run');

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
    view.log(summary.cancelled ? t('tui.check.summaryCancelled', stats) : t('tui.check.summaryDone', stats));
  }
  view.bell();
  if (failed) view.log(view.colors.red(t('tui.check.failedNotice')));
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

module.exports = { checkFlow, checkCollectionsFlow, askCollectionId };
