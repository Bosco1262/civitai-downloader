'use strict';

const { log, formatBytes, writeJson, readJson } = require('../util');
const { ensureBrowser } = require('../browser');
const { fetchCollectionItems } = require('../collection');
const { buildPlan } = require('../api');
const { dataPaths, writeCollection } = require('../storage');
const { parseCollectionId } = require('../urls');
const { createSiteLimiter } = require('../runtime');
const { ConfigError } = require('../errors');
const { t } = require('../i18n');

function usage() {
  console.error(t('list.usage'));
  process.exitCode = 1;
}

/**
 * Print the membership changes of the snapshot that was just written.
 * 打印刚刚写入的快照带来的成员变化。
 */
function reportChanges(collectionId, snapshot) {
  const changes = snapshot.changes || { added: [], removed: [], versionChanged: [] };
  log(
    t('list.snapshotSaved', {
      collectionId,
      count: snapshot.items.length,
      fetchedAt: snapshot.fetchedAt,
    })
  );
  log(
    t('list.changes', {
      added: changes.added.length,
      removed: changes.removed.length,
      versionChanged: changes.versionChanged.length,
      previousFetchedAt: changes.previousFetchedAt || t('list.firstSnapshot'),
    })
  );
  for (const item of changes.added) log(t('list.changeAdded', { name: item.name || item.modelId }));
  for (const item of changes.removed) log(t('list.changeRemoved', { name: item.name || item.modelId }));
  for (const item of changes.versionChanged) {
    log(
      t('list.changeVersion', {
        name: item.name || item.modelId,
        from: item.fromVersionId === null || item.fromVersionId === undefined ? t('common.unknown') : item.fromVersionId,
        to: item.toVersionId === null || item.toVersionId === undefined ? t('common.unknown') : item.toVersionId,
      })
    );
  }
}

async function main(config, args) {
  const collectionId = parseCollectionId(args.positionals[0]);
  if (!collectionId) return usage();

  const paths = dataPaths(config, collectionId);
  const fromCache = !!(args.flags['from-cache'] || args.flags.offline);
  let items;

  if (fromCache) {
    const cached = readJson(paths.items, null);
    if (!cached || !Array.isArray(cached.items) || !cached.items.length) {
      throw new ConfigError(t('list.cacheMissing', { file: paths.items }));
    }
    items = cached.items;
    log(
      t('list.usingCache', {
        file: paths.items,
        time: cached.fetchedAt || t('list.unknownTime'),
      })
    );
  } else {
    const browser = await ensureBrowser(config);
    try {
      log(t('list.enumerating', { collectionId }));
      items = await fetchCollectionItems(browser, config.site, collectionId, {
        trpcPath: config.trpcPath,
        trpcInput: config.trpcInput,
        limit: createSiteLimiter(config),
      });
    } finally {
      await browser.disconnect().catch(() => {});
    }
    writeJson(paths.items, {
      collectionId,
      count: items.length,
      fetchedAt: new Date().toISOString(),
      items,
    });
  }

  if (args.flags.json) {
    console.log(JSON.stringify(items, null, 2));
  } else {
    console.log('');
    console.log(t('list.countHeader', { collectionId, count: items.length }));
    console.log('-'.repeat(110));
    items.forEach((it, i) => {
      console.log(
        `${String(i + 1).padStart(3)}. [modelId=${it.modelId}] [versionId=${it.versionId}] ${it.baseModel || '-'} | ${it.type || '-'} | ${it.name}`
      );
    });
    console.log('-'.repeat(110));
  }

  // The collection is only a membership list: remember it (with the change report) so that
  // `check <id>` and the TUI can compare against it without enumerating again.
  //
  // 收藏集只是成员清单：记下它（含变化报告），
  // 这样 `check <收藏集ID>` 与 TUI 不必重新枚举即可比对。
  if (!fromCache) reportChanges(collectionId, writeCollection(config, collectionId, { items }));

  if (args.flags.plan) {
    log(t('list.fetchingMeta', { concurrency: config.metaConcurrency }));
    const { plan, totalBytes, failed } = await buildPlan(config.site, items, config.userAgent, {
      concurrency: config.metaConcurrency,
      fileTypes: config.fileTypes,
      primaryOnly: config.primaryOnly,
    });
    writeJson(paths.plan, {
      collectionId,
      totalBytes,
      count: plan.length,
      failed,
      plan,
    });
    log(t('list.totalSize', { size: formatBytes(totalBytes), file: paths.plan }));
    if (failed) log(t('list.metaFailed', { count: failed }));
  }

  if (!fromCache) log(t('list.saved', { file: paths.items }));
}

module.exports = { main, usage };
