'use strict';

/**
 * TUI flow for "collection members and changes".
 *
 * A collection is only a membership snapshot (.data/collections/<id>.json): this page shows when it
 * was enumerated and what changed (added / removed / version changed), and can reset the record of
 * a model so the next download fetches it again.
 *
 *
 * 「收藏集成员与变化」的 TUI 流程。
 *
 * 收藏集只是成员快照（.data/collections/<ID>.json）：本页显示枚举时间与变化
 * （新增 / 移除 / 版本变化），并可重置某个模型的记录，让下次下载重新拉取。
 */

const { readLibrary, readCollection, listCollectionIds } = require('../storage');
const { markForRedownload } = require('../updater');
const { t } = require('../i18n');
const view = require('./view');
const pages = require('./pages');

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
      describe: (row) =>
        t('tui.manage.memberVersions', { versions: row.versions, pinned: row.pinned }),
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

async function manageFlow(config) {
  const ids = listCollectionIds(config);
  if (!ids.length) {
    view.log(t('tui.manage.noRecords'));
    return;
  }

  const picked = await pages.promptMenu(
    t('tui.manage.pickCollection'),
    ids.map((id) => {
      const { snapshot } = readCollection(config, id, { allowCorrupt: true });
      const changes = (snapshot && snapshot.changes) || { added: [], removed: [], versionChanged: [] };
      return {
        title: t('tui.manage.collectionLabel', { id }),
        value: id,
        description:
          t('tui.manage.memberCount', { count: snapshot ? snapshot.items.length : 0 }) +
          ` ${view.separator()}${t('tui.manage.changesShort', {
            added: changes.added.length,
            removed: changes.removed.length,
            versionChanged: changes.versionChanged.length,
          })}`,
      };
    })
  );
  if (picked === null) return;
  const collectionId = String(picked);

  console.log('');
  const { snapshot } = readCollection(config, collectionId, { allowCorrupt: true });
  printSnapshot(snapshot);

  const action = await pages.promptMenu(t('tui.manage.actionPrompt', { collectionId }), [
    { title: t('tui.manage.resetAction'), value: 'reset', description: t('tui.manage.resetActionDesc') },
    { title: t('tui.manage.back'), value: 'back' },
  ]);
  if (action === null || action === 'back') return;

  if (action === 'reset') return resetModels(config, collectionId);
  return undefined;
}

module.exports = { manageFlow, printSnapshot, resetModels };
