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

const { readLibrary, readCollection, listCollectionIds } = require('../storage');
const { markForRedownload } = require('../updater');
const { t } = require('../i18n');
const view = require('./view');
const pages = require('./pages');

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
  view.log(t('tui.manage.resetDone', { count: n, names: view.truncate(names, 120) }));
}

/**
 * Page of one collection: everything that can be done to it.
 * 单个收藏集的页面：针对它能做的一切。
 */
async function collectionActions(config, collectionId) {
  const { snapshot } = readCollection(config, collectionId, { allowCorrupt: true });
  view.note('');
  view.note(view.colors.bold(`  ${t('tui.manage.collectionLabel', { id: collectionId })}`));
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
 * 收藏集分区的入口：选中一个收藏集，然后进入它的页面。
 */
async function collectionsFlow(config) {
  const rows = collectionRows(config);
  if (!rows.length) {
    view.log(t('tui.manage.noRecords'));
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

module.exports = { collectionsFlow, collectionActions, collectionRows, manageFlow, printSnapshot, resetModels };
