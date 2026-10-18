'use strict';

/**
 * End-to-end integration test: it runs the whole chain
 * (enumerate → metadata → download → library → collection snapshot → check for updates → repair), with the three external dependencies replaced
 * by controllable implementations:
 *   - browser / page (deps.ensureBrowser / findSitePage / openUrl)
 *   - curl download (deps.downloadFile)
 *   - site metadata API (a local mock HTTP server, still going through the real api.js)
 *
 * 端到端集成测试：把「枚举 → 元数据 → 下载 → 模型库 → 收藏集快照 → 检查更新 → 修复」
 * 整条链路跑通，但把三处外部依赖替换为可控实现：
 *   - 浏览器 / 页面（deps.ensureBrowser / findSitePage / openUrl）
 *   - curl 下载（deps.downloadFile）
 *   - 站点元数据接口（用本地 mock HTTP 服务器，走真实 api.js）
 */

const test = require('node:test');
const assert = require('node:assert/strict');
const fs = require('fs');
const http = require('http');
const os = require('os');
const path = require('path');
const crypto = require('crypto');

const { runDownloadJob } = require('../src/job');
const { checkUpdates, changedItems, summarize, reportLines } = require('../src/updater');
const { readLibrary, readCollection, getVersion, versionIds } = require('../src/storage');
const { validateConfig, DEFAULTS } = require('../src/config');
const { configureApi } = require('../src/api');
const { verifyModels } = require('../src/commands/verify');

const FILE_A = Buffer.from('AAAA-content-of-model-a\n'.repeat(64));
const FILE_B = Buffer.from('BBBB-content-of-model-b\n'.repeat(64));
const SHA_A = crypto.createHash('sha256').update(FILE_A).digest('hex').toUpperCase();
const SHA_B = crypto.createHash('sha256').update(FILE_B).digest('hex').toUpperCase();

function makeEnv() {
  const root = fs.mkdtempSync(path.join(os.tmpdir(), 'civitai-it-'));
  const config = validateConfig({
    ...DEFAULTS,
    site: 'http://127.0.0.1:1',
    outDir: path.join(root, 'downloads'),
    profileDir: path.join(root, 'profile'),
    userAgent: 'it-agent',
    retries: 0,
    requestTimeoutMs: 5000,
    apiRateLimit: 0,
  });
  config.root = root;
  config.dataDir = path.join(root, '.data');
  config.cookiesFile = path.join(config.dataDir, 'cookies.txt');
  fs.mkdirSync(config.dataDir, { recursive: true });
  fs.writeFileSync(config.cookiesFile, '# Netscape HTTP Cookie File\n', 'utf8');
  return config;
}

/**
 * Mock site: /api/v1/model-versions/:id
 * mock 站点：/api/v1/model-versions/:id
 */
function startSite(versionMap) {
  return new Promise((resolve) => {
    const state = { requested: [] };
    const server = http.createServer((req, res) => {
      state.requested.push(req.url);
      const m = /\/api\/v1\/model-versions\/(\d+)/.exec(req.url);
      if (m && versionMap[m[1]]) {
        res.writeHead(200, { 'content-type': 'application/json' });
        res.end(JSON.stringify(versionMap[m[1]]));
        return;
      }
      res.writeHead(404);
      res.end('not found');
    });
    server.listen(0, '127.0.0.1', () => {
      const { port } = server.address();
      resolve({
        site: `http://127.0.0.1:${port}`,
        state,
        close: () =>
          new Promise((r) => {
            if (typeof server.closeAllConnections === 'function') server.closeAllConnections();
            server.close(r);
          }),
      });
    });
  });
}

function versionFor(id, name, fileId, fileName, bytes, sha256, versionName) {
  return {
    id,
    name: versionName || `v-${id}`,
    files: [
      {
        id: fileId,
        name: fileName,
        type: 'Model',
        primary: true,
        sizeKB: bytes / 1024,
        hashes: { SHA256: sha256 },
        downloadUrl: `https://civitai.com/api/download/models/${id}?fileId=${fileId}`,
      },
    ],
  };
}

/**
 * Fake browser: enumeration comes from items, and the exported cookies are an empty file.
 * 假浏览器：枚举由 items 提供，Cookie 导出写成空文件
 */
function makeDeps({ items, contentById, counters }) {
  const fakePage = {
    url: () => 'https://civitai.red/collections/1',
    goto: async () => {},
    waitForFunction: async () => {},
    createCDPSession: async () => ({ send: async () => ({ cookies: [] }) }),
    evaluate: async () => ({ status: 200, text: '{}' }),
  };
  return {
    ensureBrowser: async () => ({ pages: async () => [], newPage: async () => fakePage, disconnect: async () => {} }),
    findSitePage: async () => fakePage,
    openUrl: async () => fakePage,
    exportCookies: async () => [],
    checkCurl: () => 'curl',
    fetchCollectionItems: async () => {
      if (counters) counters.enumerate++;
      return items.map((it) => ({ ...it }));
    },
    downloadFile: async (opts) => {
      if (counters) counters.download++;
      const content = contentById[path.basename(opts.fileName)] || FILE_A;
      fs.mkdirSync(opts.dir, { recursive: true });
      fs.writeFileSync(path.join(opts.dir, opts.fileName), content);
      return 'downloaded';
    },
  };
}

function makeItems() {
  return [
    { modelId: 101, name: 'Model A', type: 'LORA', baseModel: 'SDXL', versionId: 1001, versionName: 'v-1001' },
    { modelId: 102, name: 'Model B', type: 'LORA', baseModel: 'SDXL', versionId: 1002, versionName: 'v-1002' },
  ];
}

function makeContent() {
  return { 'model-a.safetensors': FILE_A, 'model-b.safetensors': FILE_B };
}

test('集成：首次下载写入模型库与收藏集快照（含 fileId / 下载直链 / 布局目录）', async (t) => {
  const config = makeEnv();
  const site = await startSite({
    1001: versionFor(1001, 'Model A', 11, 'model-a.safetensors', FILE_A.length, SHA_A),
    1002: versionFor(1002, 'Model B', 12, 'model-b.safetensors', FILE_B.length, SHA_B),
  });
  t.after(() => site.close());
  config.site = site.site;
  configureApi({ retries: 0, requestTimeoutMs: 5000, apiRateLimit: 0 });

  const counters = { enumerate: 0, download: 0 };
  const summary = await runDownloadJob(
    config,
    { collectionId: '777', outDir: config.outDir, jobs: 1, deps: makeDeps({ items: makeItems(), contentById: makeContent(), counters }) },
    { log: () => {} }
  );

  assert.equal(summary.done, 2);
  assert.equal(summary.failed, 0);
  assert.equal(summary.skipped, 0);
  assert.equal(summary.totalBytes, FILE_A.length + FILE_B.length);

  const a = path.join(config.outDir, 'Lora', 'Model A', 'model-a.safetensors');
  const b = path.join(config.outDir, 'Lora', 'Model B', 'model-b.safetensors');
  assert.ok(fs.existsSync(a) && fs.existsSync(b), '文件应落到「类型目录/模型标题」下');

  const { entries } = readLibrary(config);
  assert.equal(Object.keys(entries).length, 2, '一个模型一条记录');
  const vA = getVersion(entries['101'], 1001);
  assert.ok(vA, '记录里应有版本 1001');
  assert.equal(vA.dirName, 'Lora/Model A');
  assert.equal(vA.baseModel, 'SDXL');
  assert.equal(vA.files[0].fileId, 11, '记录文件 fileId');
  assert.ok(vA.files[0].downloadUrl.includes('/api/download/models/1001'), '记录下载直链');
  assert.equal(vA.files[0].sha256, SHA_A);
  assert.ok(vA.site && Array.isArray(vA.site.files), '站点返回的原始版本对象被镜像进记录');
  assert.equal(vA.site.id, 1001);

  const { snapshot } = readCollection(config, '777');
  assert.equal(snapshot.items.length, 2, '枚举后写入成员快照');
  assert.equal(snapshot.changes.added.length, 0, '首次快照没有变化可比');
});

test('集成：第二次运行惰性跳过，且不再请求元数据', async (t) => {
  const config = makeEnv();
  const site = await startSite({
    1001: versionFor(1001, 'Model A', 11, 'model-a.safetensors', FILE_A.length, SHA_A),
    1002: versionFor(1002, 'Model B', 12, 'model-b.safetensors', FILE_B.length, SHA_B),
  });
  t.after(() => site.close());
  config.site = site.site;
  configureApi({ retries: 0, requestTimeoutMs: 5000, apiRateLimit: 0 });

  const counters = { enumerate: 0, download: 0 };
  const deps = makeDeps({ items: makeItems(), contentById: makeContent(), counters });
  await runDownloadJob(config, { collectionId: '777', outDir: config.outDir, jobs: 1, deps }, { log: () => {} });

  site.state.requested.length = 0;
  counters.download = 0;
  const second = await runDownloadJob(
    config,
    { collectionId: '777', outDir: config.outDir, jobs: 1, deps },
    { log: () => {} }
  );

  assert.equal(second.skipped, 2, '两项都应被跳过');
  assert.equal(second.done, 0);
  assert.equal(counters.download, 0, '不应再下载');
  assert.equal(site.state.requested.length, 0, '不应再请求任何元数据');
});

test('集成：--refresh-meta 会重新拉元数据，但内容未变时仍然跳过', async (t) => {
  const config = makeEnv();
  const site = await startSite({
    1001: versionFor(1001, 'Model A', 11, 'model-a.safetensors', FILE_A.length, SHA_A),
    1002: versionFor(1002, 'Model B', 12, 'model-b.safetensors', FILE_B.length, SHA_B),
  });
  t.after(() => site.close());
  config.site = site.site;
  configureApi({ retries: 0, requestTimeoutMs: 5000, apiRateLimit: 0 });

  const counters = { enumerate: 0, download: 0 };
  const deps = makeDeps({ items: makeItems(), contentById: makeContent(), counters });
  await runDownloadJob(config, { collectionId: '777', outDir: config.outDir, jobs: 1, deps }, { log: () => {} });

  site.state.requested.length = 0;
  counters.download = 0;
  const second = await runDownloadJob(
    config,
    { collectionId: '777', outDir: config.outDir, jobs: 1, deps, refreshMeta: true },
    { log: () => {} }
  );

  assert.ok(site.state.requested.length >= 2, 'refresh-meta 应重新请求元数据');
  assert.equal(second.skipped, 2, '内容一致时仍应跳过');
  assert.equal(counters.download, 0);
});

test('集成：站点发布新版本 → 重新下载并更新记录（同名冲突双方加版本后缀）', async (t) => {
  const config = makeEnv();
  const versionMap = {
    1001: versionFor(1001, 'Model A', 11, 'model-a.safetensors', FILE_A.length, SHA_A),
    1002: versionFor(1002, 'Model B', 12, 'model-b.safetensors', FILE_B.length, SHA_B),
  };
  const site = await startSite(versionMap);
  t.after(() => site.close());
  config.site = site.site;
  configureApi({ retries: 0, requestTimeoutMs: 5000, apiRateLimit: 0 });

  const counters = { enumerate: 0, download: 0 };
  const items = makeItems();
  const deps = makeDeps({ items, contentById: makeContent(), counters });
  await runDownloadJob(config, { collectionId: '777', outDir: config.outDir, jobs: 1, deps }, { log: () => {} });

  // Site: model A moves up to 2001, its content changed but the file name did not
  // 站点：模型 A 升到 2001，文件名不变但内容变了
  const NEW_A = Buffer.from('NEW-A-content-v2\n'.repeat(80));
  const NEW_SHA_A = crypto.createHash('sha256').update(NEW_A).digest('hex').toUpperCase();
  versionMap['2001'] = versionFor(2001, 'Model A', 21, 'model-a.safetensors', NEW_A.length, NEW_SHA_A);
  items[0].versionId = 2001;
  items[0].versionName = 'v-2001';
  const deps2 = makeDeps({ items, contentById: { 'model-a.safetensors': NEW_A, 'model-a-v-2001.safetensors': NEW_A, 'model-b.safetensors': FILE_B }, counters });

  const summary = await runDownloadJob(
    config,
    { collectionId: '777', outDir: config.outDir, jobs: 1, deps: deps2 },
    { log: () => {} }
  );
  assert.equal(summary.done, 1);
  assert.equal(summary.skipped, 1);
  const { entries } = readLibrary(config);
  assert.deepEqual(versionIds(entries['101']).sort(), ['1001', '2001'], '多版本应同时保留');
  assert.equal(getVersion(entries['101'], 2001).files[0].sha256, NEW_SHA_A);
  assert.equal(getVersion(entries['101'], 1001).files[0].remoteName, 'model-a.safetensors', '旧版本记录仍在');
  assert.equal(
    getVersion(entries['101'], 1001).files[0].name,
    'model-a-v-1001.safetensors',
    '同名冲突时旧版本整版加版本后缀'
  );
  assert.equal(getVersion(entries['101'], 2001).files[0].name, 'model-a-v-2001.safetensors');
  const dir = path.join(config.outDir, 'Lora', 'Model A');
  assert.deepEqual(fs.readdirSync(dir).sort(), ['model-a-v-1001.safetensors', 'model-a-v-2001.safetensors']);
});

test('集成：checkUpdates 快速模式报告最新 / 深度模式发现文件变化', async (t) => {
  const config = makeEnv();
  const versionMap = {
    1001: versionFor(1001, 'Model A', 11, 'model-a.safetensors', FILE_A.length, SHA_A),
    1002: versionFor(1002, 'Model B', 12, 'model-b.safetensors', FILE_B.length, SHA_B),
  };
  const site = await startSite(versionMap);
  t.after(() => site.close());
  config.site = site.site;
  configureApi({ retries: 0, requestTimeoutMs: 5000, apiRateLimit: 0 });

  const counters = { enumerate: 0, download: 0 };
  const deps = makeDeps({ items: makeItems(), contentById: makeContent(), counters });
  await runDownloadJob(config, { collectionId: '777', outDir: config.outDir, jobs: 1, deps }, { log: () => {} });

  const quick = await checkUpdates(config, '777', { deps }, { log: () => {} });
  assert.equal(quick.report.upToDate.length, 2);
  assert.equal(quick.report.fileChanged.length, 0);
  assert.equal(quick.report.deepChecked, false);
  assert.equal(summarize(quick.report).problems, 0);

  // The site replaced A's content (same version re-uploaded)
  // 站点把 A 的内容换了（同版本重传）
  const SWAPPED = Buffer.from('SWAPPED-A\n'.repeat(100));
  const SWAPPED_SHA = crypto.createHash('sha256').update(SWAPPED).digest('hex').toUpperCase();
  versionMap['1001'] = versionFor(1001, 'Model A', 11, 'model-a.safetensors', SWAPPED.length, SWAPPED_SHA);

  const deep = await checkUpdates(config, '777', { verifyFiles: true, deps }, { log: () => {} });
  assert.equal(deep.report.fileChanged.length, 1, '深度模式应发现同版本重传');
  assert.equal(deep.report.fileChanged[0].item.modelId, 101);
  const lines = reportLines({ ...deep.report, stats: summarize(deep.report) }).join('\n');
  assert.match(lines, /文件变化/);
});

test('集成：本地文件被删除 → check 报缺失，verify 报损坏，可只重下坏文件', async (t) => {
  const config = makeEnv();
  const site = await startSite({
    1001: versionFor(1001, 'Model A', 11, 'model-a.safetensors', FILE_A.length, SHA_A),
    1002: versionFor(1002, 'Model B', 12, 'model-b.safetensors', FILE_B.length, SHA_B),
  });
  t.after(() => site.close());
  config.site = site.site;
  configureApi({ retries: 0, requestTimeoutMs: 5000, apiRateLimit: 0 });

  const counters = { enumerate: 0, download: 0 };
  const deps = makeDeps({ items: makeItems(), contentById: makeContent(), counters });
  await runDownloadJob(config, { collectionId: '777', outDir: config.outDir, jobs: 1, deps }, { log: () => {} });

  // Delete A's file
  // 删掉 A 的文件
  fs.rmSync(path.join(config.outDir, 'Lora', 'Model A', 'model-a.safetensors'));

  const deep = await checkUpdates(config, '777', { verifyFiles: true, withPlan: true, deps }, { log: () => {} });
  assert.equal(deep.report.missing.length, 1);
  assert.equal(deep.report.missing[0].item.modelId, 101);
  const items = changedItems(deep.report);
  assert.equal(items.length, 1);
  assert.ok(items[0].files.length >= 1, '--download 用的计划应带上文件信息');

  // From the verify command's point of view, the local check should report a problem
  // verify 命令视角：本地校验应报异常
  const verified = await verifyModels(config, ['101', '102'], { noHash: false });
  assert.equal(verified.broken.length, 1);
  assert.match(verified.broken[0].reasons.join('；'), /缺失/);
  assert.equal(verified.broken[0].brokenFiles.length, 1);
  assert.ok(verified.broken[0].brokenFiles[0].downloadUrl, '修复需要下载直链');

  // Use the repair plan to re-download only the broken file
  // 用修复计划只重下坏文件
  const prev = readLibrary(config).entries['101'];
  const versionRec = getVersion(prev, 1001);
  const repair = await runDownloadJob(
    config,
    {
      collectionId: '777',
      plan: [
        {
          modelId: '101',
          name: prev.name,
          type: prev.type,
          baseModel: prev.baseModel,
          versionId: versionRec.versionId,
          versionName: versionRec.versionName,
          outDirOverride: versionRec.outDir,
          dirName: versionRec.dirName,
          files: verified.broken[0].brokenFiles,
          totalBytes: FILE_A.length,
        },
      ],
      outDir: config.outDir,
      force: true,
      jobs: 1,
      deps,
    },
    { log: () => {} }
  );
  assert.equal(repair.done, 1);
  assert.ok(fs.existsSync(path.join(config.outDir, 'Lora', 'Model A', 'model-a.safetensors')), '文件应被修复');

  const after = readLibrary(config).entries;
  const repaired = getVersion(after['101'], 1001);
  assert.equal(repaired.files.length, 1, '修复后清单不应丢文件');
  assert.deepEqual(versionIds(after['101']), ['1001']);
});

test('集成：取消时保存断点清单，--resume 可继续', async (t) => {
  const config = makeEnv();
  const site = await startSite({
    1001: versionFor(1001, 'Model A', 11, 'model-a.safetensors', FILE_A.length, SHA_A),
    1002: versionFor(1002, 'Model B', 12, 'model-b.safetensors', FILE_B.length, SHA_B),
    1003: versionFor(1003, 'Model C', 13, 'model-c.safetensors', FILE_A.length, SHA_A),
  });
  t.after(() => site.close());
  config.site = site.site;
  configureApi({ retries: 0, requestTimeoutMs: 5000, apiRateLimit: 0 });

  const items = [
    ...makeItems(),
    { modelId: 103, name: 'Model C', type: 'LORA', baseModel: 'SDXL', versionId: 1003, versionName: 'v-1003' },
  ];
  const content = { ...makeContent(), 'model-c.safetensors': FILE_A };

  // Trigger cancellation once the first model has finished downloading
  // 第一个模型下载完成后触发取消
  let downloaded = 0;
  const counters = { enumerate: 0, download: 0 };
  const deps = makeDeps({ items, contentById: content, counters });
  const originalDownload = deps.downloadFile;
  deps.downloadFile = async (opts) => {
    const r = await originalDownload(opts);
    downloaded++;
    return r;
  };

  const summary = await runDownloadJob(
    config,
    { collectionId: '777', outDir: config.outDir, jobs: 1, deps, isCancelled: () => downloaded >= 1 },
    { log: () => {} }
  );
  assert.equal(summary.cancelled, true);
  assert.equal(summary.done, 1);
  assert.equal(summary.remaining, 2);

  const queueFile = path.join(config.dataDir, 'queue-777.json');
  assert.ok(fs.existsSync(queueFile), '取消后应保存断点清单');
  const queue = JSON.parse(fs.readFileSync(queueFile, 'utf8'));
  assert.equal(queue.items.length, 2);
  assert.ok(queue.items[0].files[0].downloadUrl, '断点清单需含下载直链');

  const resumed = await runDownloadJob(
    config,
    { collectionId: '777', outDir: config.outDir, jobs: 1, deps, items: queue.items, resume: true },
    { log: () => {} }
  );
  assert.equal(resumed.done, 2);
  assert.ok(!fs.existsSync(queueFile), '完成后应清理断点清单');
  const { entries } = readLibrary(config);
  assert.equal(Object.keys(entries).length, 3);
});

test('集成：全局锁阻止并发运行，--force-lock 可接管', async (t) => {
  const config = makeEnv();
  const site = await startSite({
    1001: versionFor(1001, 'Model A', 11, 'model-a.safetensors', FILE_A.length, SHA_A),
  });
  t.after(() => site.close());
  config.site = site.site;
  configureApi({ retries: 0, requestTimeoutMs: 5000, apiRateLimit: 0 });

  const lockFile = path.join(config.dataDir, 'library.lock');
  fs.writeFileSync(lockFile, JSON.stringify({ pid: process.pid, startedAt: new Date().toISOString() }), 'utf8');

  const counters = { enumerate: 0, download: 0 };
  const deps = makeDeps({
    items: [{ modelId: 101, name: 'Model A', versionId: 1001 }],
    contentById: makeContent(),
    counters,
  });

  await assert.rejects(
    () => runDownloadJob(config, { collectionId: '777', outDir: config.outDir, jobs: 1, deps }, { log: () => {} }),
    /另一个进程/
  );
  assert.ok(fs.existsSync(lockFile), '失败时不应删除他人的锁');

  const ok = await runDownloadJob(
    config,
    { collectionId: '777', outDir: config.outDir, jobs: 1, deps, forceLock: true },
    { log: () => {} }
  );
  assert.equal(ok.done, 1);
  assert.ok(!fs.existsSync(lockFile), '完成后应释放锁');
});

test('集成：磁盘空间不足时拒绝下载（可用 --ignore-space 覆盖）', async (t) => {
  const config = makeEnv();
  const site = await startSite({
    1001: versionFor(1001, 'Model A', 11, 'model-a.safetensors', FILE_A.length, SHA_A),
  });
  t.after(() => site.close());
  config.site = site.site;
  configureApi({ retries: 0, requestTimeoutMs: 5000, apiRateLimit: 0 });

  const counters = { enumerate: 0, download: 0 };
  const deps = makeDeps({
    items: [{ modelId: 101, name: 'Model A', versionId: 1001 }],
    contentById: makeContent(),
    counters,
  });
  // Forge a requirement far larger than the free space
  // 伪造一个远超剩余空间的需求
  deps.buildPlan = async (site, items, ua, opts) => {
    const built = await require('../src/api').buildPlan(site, items, ua, opts);
    built.plan[0].files[0].bytes = Number.MAX_SAFE_INTEGER / 2;
    built.plan[0].totalBytes = Number.MAX_SAFE_INTEGER / 2;
    return built;
  };

  const summary = await runDownloadJob(
    config,
    { collectionId: '777', outDir: config.outDir, jobs: 1, deps },
    { log: () => {} }
  );
  assert.equal(summary.error, 'insufficient-space');
  assert.equal(counters.download, 0, '空间不足时不应开始下载');
});
