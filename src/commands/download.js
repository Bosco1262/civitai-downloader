'use strict';

const fs = require('fs');
const path = require('path');
const { log, ts, formatBytes, sanitizeName, writeJson, readJson, ensureDir } = require('../util');
const { ensureBrowser, findSitePage, openUrl } = require('../browser');
const { fetchCollectionItems } = require('../collection');
const { buildPlan } = require('../api');
const { exportCookies } = require('../cookies');
const { checkCurl, downloadFile } = require('../downloader');

function usage() {
  console.error(`用法: node cli.js download <收藏集ID> [选项]

选项:
  --out <目录>       下载到指定目录（默认使用 config.json 中的 outDir）
  --only <id[,id]>   只处理指定 modelId / versionId（逗号分隔）
  --force            忽略已完成记录，强制重新下载
  --dry-run          只列出下载计划，不实际下载
`);
  process.exitCode = 1;
}

function parseOnly(raw) {
  if (!raw || raw === true) return null;
  return String(raw)
    .split(',')
    .map((s) => s.trim())
    .filter(Boolean);
}

function matchesOnly(item, only) {
  if (!only) return true;
  return only.some((v) => String(item.modelId) === v || String(item.versionId) === v);
}

async function main(config, args) {
  const collectionId = args.positionals[0];
  if (!collectionId) return usage();
  checkCurl();

  const outDir = args.flags.out ? path.resolve(String(args.flags.out)) : config.outDir;
  const force = !!args.flags.force;
  const dryRun = !!args.flags['dry-run'];
  const only = parseOnly(args.flags.only);

  const stateFile = path.join(config.dataDir, `state-${collectionId}.json`);
  const logFile = path.join(config.dataDir, `download-${collectionId}.log`);
  ensureDir(config.dataDir);
  const logBoth = (msg) => {
    log(msg);
    try {
      fs.appendFileSync(logFile, `[${ts()}] ${msg}\n`, 'utf8');
    } catch (e) {
      // ignore log write failure
    }
  };

  logBoth(`=== 开始 === 收藏集 ${collectionId} | 输出目录: ${outDir}`);
  const browser = await ensureBrowser(config);
  try {
    let items = await fetchCollectionItems(browser, config.site, collectionId);
    if (!items.length) {
      logBoth('收藏集为空，无内容可下载');
      return;
    }
    if (only) {
      const before = items.length;
      items = items.filter((it) => matchesOnly(it, only));
      logBoth(`--only 过滤: ${before} -> ${items.length} 项`);
      if (!items.length) {
        logBoth('没有匹配 --only 的项目，请检查 ID');
        process.exitCode = 1;
        return;
      }
    }

    log(`获取文件元数据（${items.length} 项）…`);
    const { plan, totalBytes } = await buildPlan(config.site, items, config.userAgent);
    logBoth(`下载计划: ${plan.filter((p) => !p.error).length} 项可用，共 ${formatBytes(totalBytes)}`);

    for (const p of plan.filter((p) => p.error)) {
      logBoth(`元数据失败: ${p.name} -> ${p.error}`);
    }

    if (dryRun) {
      for (const p of plan) {
        if (p.error) continue;
        for (const f of p.files) {
          logBoth(`  [计划] ${p.name} / ${f.name} (${formatBytes(f.bytes)})`);
        }
      }
      logBoth('--dry-run 结束，未下载任何文件');
      return;
    }

    const page =
      (await findSitePage(browser, config.site)) ||
      (await openUrl(browser, `${config.site}/collections/${collectionId}`));
    const cookies = await exportCookies(page, config.cookiesFile);
    logBoth(`已导出浏览器 Cookie（${cookies.length} 条）-> ${config.cookiesFile}`);

    const state = readJson(stateFile, {});
    let done = 0;
    let skipped = 0;
    let failed = plan.filter((p) => p.error).length;
    let index = 0;

    for (const item of plan) {
      index++;
      if (item.error) continue;
      if (!force && state[item.modelId]) {
        skipped++;
        logBoth(`SKIP ${item.name}（已完成，可加 --force 重下）`);
        continue;
      }

      const dir = path.join(outDir, sanitizeName(item.name));
      ensureDir(dir);
      let itemOk = true;

      for (const f of item.files) {
        try {
          logBoth(`下载 [${index}/${plan.length}] ${item.name} / ${f.name} (${formatBytes(f.bytes)})`);
          const status = await downloadFile({
            url: f.downloadUrl,
            cookieFile: config.cookiesFile,
            dir,
            fileName: sanitizeName(f.name),
            expectedSha256: f.sha256,
            expectedBytes: f.bytes,
            userAgent: config.userAgent,
            force,
          });
          logBoth(status === 'verified' ? `  已存在且校验通过: ${f.name}` : `  下载完成并校验通过: ${f.name}`);
        } catch (e) {
          itemOk = false;
          logBoth(`  失败: ${f.name} -> ${e.message}`);
          break;
        }
      }

      if (itemOk) {
        state[item.modelId] = { name: item.name, verifiedAt: new Date().toISOString() };
        writeJson(stateFile, state);
        done++;
        logBoth(`完成 ${item.name}（完成 ${done} / 跳过 ${skipped} / 失败 ${failed}）`);
      } else {
        failed++;
      }
    }

    logBoth(`=== 结束 === 完成 ${done}，跳过 ${skipped}，失败 ${failed}`);
    logBoth(`日志文件: ${logFile}`);
    if (failed) process.exitCode = 1;
  } finally {
    await browser.disconnect().catch(() => {});
  }
}

module.exports = { main };
