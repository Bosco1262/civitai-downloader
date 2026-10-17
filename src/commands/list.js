'use strict';

const path = require('path');
const { log, formatBytes, writeJson } = require('../util');
const { ensureBrowser } = require('../browser');
const { fetchCollectionItems } = require('../collection');
const { buildPlan } = require('../api');

async function main(config, args) {
  const collectionId = args.positionals[0];
  if (!collectionId) {
    console.error('用法: node cli.js list <收藏集ID> [--json] [--plan]');
    process.exitCode = 1;
    return;
  }

  const browser = await ensureBrowser(config);
  try {
    log(`枚举收藏集 ${collectionId} 的条目…`);
    const items = await fetchCollectionItems(browser, config.site, collectionId);
    const cacheFile = path.join(config.dataDir, `items-${collectionId}.json`);
    writeJson(cacheFile, {
      collectionId,
      count: items.length,
      fetchedAt: new Date().toISOString(),
      items,
    });

    if (args.flags.json) {
      console.log(JSON.stringify(items, null, 2));
    } else {
      console.log('');
      console.log(`收藏集 ${collectionId} 共 ${items.length} 项:`);
      console.log('-'.repeat(110));
      items.forEach((it, i) => {
        console.log(
          `${String(i + 1).padStart(3)}. [modelId=${it.modelId}] [versionId=${it.versionId}] ${it.baseModel || '-'} | ${it.type || '-'} | ${it.name}`
        );
      });
      console.log('-'.repeat(110));
    }

    if (args.flags.plan) {
      log('获取文件元数据…');
      const { plan, totalBytes } = await buildPlan(config.site, items, config.userAgent);
      writeJson(path.join(config.dataDir, `plan-${collectionId}.json`), {
        collectionId,
        totalBytes,
        count: plan.length,
        plan,
      });
      log(`全部文件合计: ${formatBytes(totalBytes)}（已保存到 .data/plan-${collectionId}.json）`);
    }

    log(`结果已保存: ${cacheFile}`);
  } finally {
    await browser.disconnect().catch(() => {});
  }
}

module.exports = { main };
