'use strict';

/**
 * TUI flow for the "local collection management" section: every collection the tool has a snapshot
 * of, and everything that can be done to one of them.
 *
 * A collection is only a membership snapshot (.data/collections/<id>.json): the page shows when it was
 * enumerated, what changed (added / removed / version changed), and offers to check it for updates,
 * download it again, or reset the records of its members so the next download fetches them again.
 *
 *
 * 「本地收藏集管理」的 TUI 流程：工具记录过的每个收藏集，以及针对某一个收藏集能做的一切。
 *
 * 收藏集只是成员快照（.data/collections/<ID>.json）：本页显示枚举时间与变化
 * （新增 / 移除 / 版本变化），并提供检查更新、重新下载、重置成员记录等操作，
 * 让下次下载重新拉取。
 */

const { readLibrary, readCollection, listCollectionIds, entryVersions } = require('../../storage');
const { markForRedownload } = require('../../updater');
const { t } = require('../../i18n');
const view = require('../adapters/view');
const pages = require('../ui/pages');
const screen = require('../shell/screen');
const { present } = require('../shell/present');
const reportPage = require('../ui/report');
const { color } = require('../ui/tokens');

/**
 * One picker row per known collection.
 * 每个已知收藏集一行，供选择器使用。
 */
function collectionRows(config) {
  return listCollectionIds(config).map((id) => {
    const { snapshot } = readCollection(config, id, { allowCorrupt: true });
    const changes = (snapshot && snapshot.changes) || { added: [], removed: [], versionChanged: [] };
    return {
      modelId: String(id),
      name: t('tui.manage.collectionLabel', { id }),
      type: t('tui.manage.memberCount', { count: snapshot ? snapshot.items.length : 0 }),
      baseModel: '',
      totalBytes: 0,
      members: snapshot ? snapshot.items.length : 0,
      fetchedAt: (snapshot && snapshot.fetchedAt) || null,
      changes: changes.added.length + changes.removed.length + changes.versionChanged.length,
    };
  });
}

/**
 * Print the snapshot time and the change report of one collection.
 * 打印某个收藏集的快照时间与变化报告。
 */
function printSnapshot(snapshot) {
  const changes = (snapshot && snapshot.changes) || { added: [], removed: [], versionChanged: [] };
  view.log(
    t('tui.manage.snapshotLine', {
      count: snapshot ? snapshot.items.length : 0,
      fetchedAt: (snapshot && snapshot.fetchedAt) || t('tui.manage.unknownTime'),
    })
  );
  view.log(
    t('tui.manage.changesLine', {
      added: changes.added.length,
      removed: changes.removed.length,
      versionChanged: changes.versionChanged.length,
      previousFetchedAt: changes.previousFetchedAt || t('tui.manage.firstSnapshot'),
    })
  );
  for (const item of changes.added) {
    view.log(t('tui.manage.changeAdded', { name: item.name || item.modelId }));
  }
  for (const item of changes.removed) {
    view.log(t('tui.manage.changeRemoved', { name: item.name || item.modelId }));
  }
  for (const item of changes.versionChanged) {
    view.log(
      t('tui.manage.changeVersion', {
        name: item.name || item.modelId,
        from: item.fromVersionId === null || item.fromVersionId === undefined ? t('common.unknown') : item.fromVersionId,
        to: item.toVersionId === null || item.toVersionId === undefined ? t('common.unknown') : item.toVersionId,
      })
    );
  }
}

/**
 * Reset the records of the models that belong to this collection (they will be downloaded again).
 * 重置该收藏集中各模型的记录（下次会重新下载）。
 */
async function resetModels(config, collectionId) {
  const { snapshot } = readCollection(config, collectionId, { allowCorrupt: true });
  const entries = readLibrary(config, { allowCorrupt: true }).entries;
  const members = snapshot ? snapshot.items.filter((it) => entries[it.modelId]) : [];
  if (!members.length) {
    view.log(t('tui.manage.resetEmpty', { collectionId }));
    return;
  }

  const chosen = await pages.pickMany(
    members.map((it) => {
      const entry = entries[it.modelId];
      return {
        modelId: String(it.modelId),
        name: entry.name || t('tui.manage.modelIdLabel', { modelId: it.modelId }),
        type: entry.type || '',
        baseModel: '',
        totalBytes: 0,
        versions: Object.keys((entry && entry.versions) || {}).length,
        pinned: entry.pinnedVersionId ? t('tui.manage.pinnedVersion') : t('tui.manage.notPinned'),
      };
    }),
    {
      message: t('tui.manage.resetPick'),
      title: t('tui.manage.resetPick'),
      describe: (row) => t('tui.manage.memberVersions', { versions: row.versions, pinned: row.pinned }),
    }
  );
  if (chosen === null) return;
  const chosenIds = chosen.map((row) => String(row.modelId));
  if (!chosenIds.length) {
    view.log(t('tui.manage.noChanges'));
    return;
  }

  const confirm = await pages.promptConfirm(t('tui.manage.resetConfirm', { count: chosenIds.length }), {
    danger: true,
  });
  if (!confirm) {
    view.log(t('tui.manage.cancelled'));
    return;
  }

  const n = markForRedownload(config, chosenIds);
  const names = chosenIds
    .map((modelId) => {
      const entry = entries[modelId];
      return (entry && entry.name) || t('tui.manage.modelIdLabel', { modelId });
    })
    .join(t('tui.manage.nameSeparator'));
  view.notice(t('tui.manage.resetDone', { count: n, names: view.truncate(names, 120) }), color.success);
}

// ---------------------------------------------------------------------------
// Snapshot page
// 快照页
// ---------------------------------------------------------------------------

/**
 * Change buckets of a snapshot, always complete (callers never have to check for missing arrays).
 * 快照的变化桶，始终完整（调用方不必检查数组是否存在）。
 */
function changeBuckets(snapshot) {
  const changes = (snapshot && snapshot.changes) || {};
  return {
    added: Array.isArray(changes.added) ? changes.added : [],
    removed: Array.isArray(changes.removed) ? changes.removed : [],
    versionChanged: Array.isArray(changes.versionChanged) ? changes.versionChanged : [],
    previousFetchedAt: changes.previousFetchedAt || null,
  };
}

/**
 * Reset the records of the changes a snapshot reports: added models and the "to" version of every
 * version change. Removed members have no record left to reset, so they are skipped.
 *
 * 重置快照里变化项的记录：新增的模型，以及每条版本变化的目标版本。
 * 已移除的成员没有记录可重置，直接跳过。
 *
 * @returns {number} how many records were reset
 */
function resetChangedRecords(config, collectionId) {
  const { snapshot } = readCollection(config, collectionId, { allowCorrupt: true });
  const changes = changeBuckets(snapshot);
  const items = [
    ...changes.added.map((item) => ({ modelId: String(item.modelId) })),
    ...changes.versionChanged.map((item) => ({
      modelId: String(item.modelId),
      versionId:
        item.toVersionId === undefined || item.toVersionId === null ? null : String(item.toVersionId),
    })),
  ];
  return markForRedownload(config, items);
}

/**
 * Member list of one snapshot: searchable picker, Enter opens the member's model page when the
 * model has a local record.
 *
 * 一份快照的成员列表：可搜索的选择器，成员有本地记录时 Enter 打开它的模型页面。
 */
async function openMembers(config, collectionId) {
  const { snapshot } = readCollection(config, collectionId, { allowCorrupt: true });
  if (!snapshot) return null;
  const entries = readLibrary(config, { allowCorrupt: true }).entries;
  const rows = snapshot.items.map((item) => {
    const entry = entries[item.modelId] || null;
    return {
      modelId: String(item.modelId),
      name: (entry && entry.name) || item.name || t('tui.manage.modelIdLabel', { modelId: item.modelId }),
      versions: entryVersions(entry).length,
      pinned: entry && entry.pinnedVersionId ? t('tui.manage.pinnedVersion') : t('tui.manage.notPinned'),
      hasRecord: !!entry,
    };
  });
  const chosen = await pages.pickOne(rows, {
    message: t('tui.manage.membersPick'),
    title: t('tui.manage.membersAction'),
    describe: (row) => t('tui.manage.memberVersions', { versions: row.versions, pinned: row.pinned }),
    decidedMessage: 'tui.check.selectedModel',
    decidedParams: (row) => ({ id: row && row.modelId }),
  });
  if (!chosen) return null;
  if (!chosen.hasRecord) {
    view.notice(t('tui.manage.memberNoRecord', { modelId: chosen.modelId }), color.warning);
    return null;
  }
  return require('./models').modelActions(config, chosen.modelId);
}

/**
 * Report model of one collection: snapshot facts, the three change buckets and its actions.
 * 单个收藏集的报告模型：快照事实、三个变化分区与操作。
 */
function snapshotReportModel(config, collectionId) {
  const { snapshot, corrupt } = readCollection(config, collectionId, { allowCorrupt: true });
  if (!snapshot) return null;
  const changes = changeBuckets(snapshot);
  const total = changes.added.length + changes.removed.length + changes.versionChanged.length;

  const summary = [
    { label: t('tui.manage.snapshot.factId'), value: String(collectionId) },
    { label: t('tui.manage.snapshot.factMembers'), value: String(snapshot.items.length) },
    {
      label: t('tui.manage.snapshot.factFetchedAt'),
      value: snapshot.fetchedAt || t('tui.manage.unknownTime'),
    },
    {
      label: t('tui.manage.snapshot.factPrevious'),
      value: changes.previousFetchedAt || t('tui.manage.firstSnapshot'),
    },
    { label: t('tui.manage.snapshot.factChanges'), value: String(total) },
  ];
  if (corrupt) {
    summary.push({
      label: t('tui.manage.snapshot.factCorrupt'),
      value: t('tui.manage.snapshot.corrupt', { message: corrupt.message }),
      color: color.danger,
    });
  }

  const modelName = (item) =>
    (item && item.name) || t('tui.manage.modelIdLabel', { modelId: item && item.modelId });

  const sections = [
    {
      title: t('tui.manage.snapshot.sectionAdded'),
      rows: changes.added.map((item) => ({
        label: modelName(item),
        detail: t('tui.manage.modelIdLabel', { modelId: item.modelId }),
      })),
      emptyText: t('tui.manage.snapshot.emptyAdded'),
    },
    {
      title: t('tui.manage.snapshot.sectionRemoved'),
      rows: changes.removed.map((item) => ({
        label: modelName(item),
        detail: t('tui.manage.modelIdLabel', { modelId: item.modelId }),
      })),
      emptyText: t('tui.manage.snapshot.emptyRemoved'),
    },
    {
      title: t('tui.manage.snapshot.sectionChanged'),
      rows: changes.versionChanged.map((item) => ({
        label: modelName(item),
        detail: t('tui.report.fromTo', {
          from:
            item.fromVersionId === undefined || item.fromVersionId === null
              ? t('common.unknown')
              : item.fromVersionId,
          to:
            item.toVersionId === undefined || item.toVersionId === null
              ? t('common.unknown')
              : item.toVersionId,
        }),
      })),
      emptyText: t('tui.manage.snapshot.emptyChanged'),
    },
  ];

  const title = t('tui.manage.collectionLabel', { id: collectionId });
  return {
    title,
    crumbPath: [t('tui.app.menuCollections'), title],
    summary,
    sections,
    actions: [
      {
        label: t('tui.app.menuCheck'),
        description: t('tui.app.menuCheckDesc'),
        run: () => require('./check').checkCollectionsFlow(config, [String(collectionId)]),
      },
      {
        label: t('tui.app.menuDownload'),
        description: t('tui.manage.downloadActionDesc'),
        run: () => require('./download').downloadFlow(config, { collectionId: String(collectionId) }),
      },
      {
        label: t('tui.manage.resetChanged'),
        description: t('tui.manage.resetChangedDesc'),
        run: async () => {
          if (!total) {
            view.notice(t('tui.manage.resetChangedEmpty'), color.warning);
            return reportPage.REFRESH;
          }
          const confirm = await pages.promptConfirm(
            t('tui.manage.resetChangedConfirm', { count: total }),
            { danger: true }
          );
          if (!confirm) return reportPage.REFRESH;
          const n = resetChangedRecords(config, collectionId);
          view.notice(t('tui.manage.resetChangedDone', { count: n }), color.success);
          return reportPage.REFRESH;
        },
      },
      {
        label: t('tui.manage.resetAction'),
        description: t('tui.manage.resetActionDesc'),
        run: () => resetModels(config, collectionId),
      },
      {
        label: t('tui.manage.membersAction'),
        description: t('tui.manage.membersActionDesc'),
        run: () => openMembers(config, collectionId),
      },
      { label: t('tui.manage.back'), run: () => reportPage.BACK },
    ],
    rebuild: () => snapshotReportModel(config, collectionId),
  };
}

/**
 * Shell page of one collection: the snapshot report page.
 * 单个收藏集的外壳页面：快照报告页。
 */
async function collectionSnapshotPage(config, collectionId) {
  const model = snapshotReportModel(config, collectionId);
  if (!model) {
    const { corrupt } = readCollection(config, collectionId, { allowCorrupt: true });
    const title = t('tui.manage.collectionLabel', { id: collectionId });
    const lines = [t('tui.manage.snapshotMissing', { id: collectionId }), '', t('tui.manage.noRecordsHint')];
    if (corrupt) lines.unshift(t('tui.manage.snapshot.corrupt', { message: corrupt.message }));
    await pages.promptMessage(title, lines, {
      crumbPath: [t('tui.app.menuCollections'), title],
    });
    return null;
  }
  return reportPage.showReportPage(config, model);
}

/**
 * Page of one collection: everything that can be done to it.
 * 单个收藏集的页面：针对它能做的一切。
 */
async function collectionActions(config, collectionId) {
  return present({
    shell: () => collectionSnapshotPage(config, collectionId),
    plain: () => collectionActionsPlain(config, collectionId),
  });
}

async function collectionActionsPlain(config, collectionId) {
  const { snapshot } = readCollection(config, collectionId, { allowCorrupt: true });
  view.note('');
  view.note(color.emphasis(`  ${t('tui.manage.collectionLabel', { id: collectionId })}`));
  printSnapshot(snapshot);

  for (;;) {
    const action = await pages.promptMenu(
      t('tui.manage.actionPrompt', { collectionId }),
      [
        {
          title: t('tui.app.menuCheck'),
          value: 'check',
          description: t('tui.app.menuCheckDesc'),
        },
        {
          title: t('tui.app.menuDownload'),
          value: 'download',
          description: t('tui.manage.downloadActionDesc'),
        },
        {
          title: t('tui.manage.resetAction'),
          value: 'reset',
          description: t('tui.manage.resetActionDesc'),
        },
        { title: t('tui.manage.back'), value: 'back' },
      ],
      { stage: t('tui.app.menuCollections') }
    );
    if (action === null || action === 'back') return;

    if (action === 'check') {
      const { checkCollectionsFlow } = require('./check');
      await checkCollectionsFlow(config, [String(collectionId)]);
      continue;
    }
    if (action === 'download') {
      const { downloadFlow } = require('./download');
      await downloadFlow(config, { collectionId: String(collectionId) });
      continue;
    }
    if (action === 'reset') {
      await resetModels(config, collectionId);
      continue;
    }
  }
}

/**
 * Entry point of the collection section: pick one collection, then open its page.
 *
 * With no snapshot yet the section still opens a page that explains what to do; answering the key
 * press with a log line only made it look like nothing had happened.
 *
 *
 * 收藏集分区的入口：选中一个收藏集，然后进入它的页面。
 *
 * 还没有任何快照时，本分区也会打开一页说明该怎么做；只在日志里回一行会让人以为按键没生效。
 */
async function collectionsFlow(config) {
  const rows = collectionRows(config);
  if (!rows.length) {
    await pages.promptMessage(t('tui.app.menuCollections'), [
      t('tui.manage.noRecords'),
      '',
      t('tui.manage.noRecordsHint'),
    ]);
    return;
  }
  const chosen = await pages.pickOne(rows, {
    message: t('tui.manage.pickCollection'),
    title: t('tui.app.menuCollections'),
    describe: (row) =>
      [
        row.type,
        row.fetchedAt ? String(row.fetchedAt) : t('tui.manage.unknownTime'),
        row.changes ? t('tui.check.changesShort', { count: row.changes }) : t('tui.check.noChangesShort'),
      ].join(view.separator()),
    idOf: (row) => row.modelId,
    label: (row) => row.name,
    decidedMessage: 'tui.check.selected',
    decidedParams: (row) => ({ id: row && row.modelId }),
  });
  if (!chosen) return;
  return collectionActions(config, String(chosen.modelId));
}

/**
 * Legacy single-collection flow kept for callers that only want the change report.
 * 仅需要变化报告的老流程，保留给这类调用方。
 */
async function manageFlow(config) {
  return collectionsFlow(config);
}

module.exports = {
  collectionsFlow,
  collectionActions,
  collectionRows,
  collectionSnapshotPage,
  snapshotReportModel,
  resetChangedRecords,
  openMembers,
  manageFlow,
  printSnapshot,
  resetModels,
};
