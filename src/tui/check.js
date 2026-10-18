'use strict';

const prompts = require('prompts');
const { formatBytes } = require('../util');
const { checkUpdates, reportLines, changedItems, markForRedownload, summarize } = require('../updater');
const { listCollectionIds, readCollection } = require('../storage');
const { t } = require('../i18n');
const view = require('./view');
const { runWithProgress } = require('./run');

async function askCollectionId(config, message) {
  const ids = listCollectionIds(config);
  if (!ids.length) {
    view.log(t('tui.check.noRecords'));
    return null;
  }
  const ans = await prompts({
    type: 'select',
    name: 'id',
    message,
    choices: [
      ...ids.map((id) => {
        const { snapshot } = readCollection(config, id, { allowCorrupt: true });
        return {
          title: t('tui.check.collectionLabel', { id }),
          value: id,
          description: t('tui.check.completionRecords', { count: snapshot ? snapshot.items.length : 0 }),
        };
      }),
      { title: t('tui.check.manualId'), value: '__manual__' },
      { title: t('tui.check.allCollections'), value: '__all__' },
    ],
  });
  if (!ans || ans.id === undefined) return null;
  if (ans.id === '__all__') return ids;
  if (ans.id !== '__manual__') return String(ans.id);

  const input = await prompts({
    type: 'text',
    name: 'id',
    message: t('tui.check.collectionIdLabel'),
    validate: (v) => (/^\d+$/.test(String(v).trim()) ? true : t('tui.check.invalidId')),
  });
  if (!input || input.id === undefined) return null;
  return String(input.id).trim();
}

async function checkFlow(config) {
  const picked = await askCollectionId(config, t('tui.check.pickCollection'));
  if (!picked) return;
  const ids = Array.isArray(picked) ? picked : [picked];

  const mode = await prompts({
    type: 'select',
    name: 'deep',
    message: t('tui.check.modeTitle'),
    choices: [
      {
        title: t('tui.check.modeQuick'),
        value: false,
        description: t('tui.check.modeQuickDesc'),
      },
      {
        title: t('tui.check.modeDeep'),
        value: true,
        description: t('tui.check.modeDeepDesc'),
      },
    ],
  });
  if (!mode || mode.deep === undefined) return;

  const reports = [];
  for (const id of ids) {
    if (ids.length > 1) view.log(t('tui.check.collectionHeader', { id }));
    const { report } = await checkUpdates(config, id, { verifyFiles: !!mode.deep, withPlan: true }, { log: view.log });
    report.stats = summarize(report);
    reports.push(report);
    for (const line of reportLines(report)) view.log(line);
  }

  const allChanges = reports.flatMap((r) => changedItems(r));
  if (!allChanges.length) {
    view.bell();
    return;
  }

  const go = await prompts({
    type: 'confirm',
    name: 'go',
    message: t('tui.check.downloadConfirm', { count: allChanges.length }),
    initial: true,
  });
  if (!go || !go.go) return;

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

module.exports = { checkFlow, askCollectionId };
