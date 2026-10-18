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

const prompts = require('prompts');
const { readLibrary, readCollection, listCollectionIds } = require('../storage');
const { markForRedownload } = require('../updater');
const { t } = require('../i18n');
const view = require('./view');

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

  const ans = await prompts({
    type: 'multiselect',
    name: 'ids',
    message: t('tui.manage.resetPick'),
    instructions: t('tui.manage.unpinInstructions'),
    choices: members.map((it) => {
      const entry = entries[it.modelId];
      const versions = Object.keys((entry && entry.versions) || {}).length;
      return {
        title: view.truncate(entry.name || t('tui.manage.modelIdLabel', { modelId: it.modelId }), 70),
        value: String(it.modelId),
        description: t('tui.manage.memberVersions', {
          versions,
          pinned: entry.pinnedVersionId ? t('tui.manage.pinnedVersion') : t('tui.manage.notPinned'),
        }),
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
    message: t('tui.manage.resetConfirm', { count: chosen.length }),
    initial: true,
  });
  if (!confirm || !confirm.ok) {
    view.log(t('tui.manage.cancelled'));
    return;
  }

  const n = markForRedownload(config, chosen);
  const names = chosen
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

  const pick = await prompts({
    type: 'select',
    name: 'id',
    message: t('tui.manage.pickCollection'),
    choices: ids.map((id) => {
      const { snapshot } = readCollection(config, id, { allowCorrupt: true });
      const changes = (snapshot && snapshot.changes) || { added: [], removed: [], versionChanged: [] };
      return {
        title: t('tui.manage.collectionLabel', { id }),
        value: id,
        description:
          t('tui.manage.memberCount', { count: snapshot ? snapshot.items.length : 0 }) +
          ` · ${t('tui.manage.changesShort', {
            added: changes.added.length,
            removed: changes.removed.length,
            versionChanged: changes.versionChanged.length,
          })}`,
      };
    }),
  });
  if (!pick || pick.id === undefined) return;
  const collectionId = String(pick.id);

  console.log('');
  const { snapshot } = readCollection(config, collectionId, { allowCorrupt: true });
  printSnapshot(snapshot);

  const action = await prompts({
    type: 'select',
    name: 'action',
    message: t('tui.manage.actionPrompt', { collectionId }),
    choices: [
      { title: t('tui.manage.resetAction'), value: 'reset', description: t('tui.manage.resetActionDesc') },
      { title: t('tui.manage.back'), value: 'back' },
    ],
  });
  if (!action || action.action === undefined || action.action === 'back') return;

  if (action.action === 'reset') return resetModels(config, collectionId);
}

module.exports = { manageFlow, printSnapshot, resetModels };
