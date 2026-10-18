'use strict';

/**
 * Web UI tests: job manager, progress arithmetic, HTTP routing/guards and the static layer.
 *
 * Everything runs against a temporary config (own output directory, own `.data`) so the developer's
 * real library and config.json are never touched, and no network is needed.
 *
 *
 * Web UI 测试：任务管理、进度换算、HTTP 路由/防护与静态文件层。
 *
 * 全部跑在临时配置上（独立输出目录与独立 `.data`），不会碰开发者真实的模型库与 config.json，
 * 也不需要联网。
 */

const test = require('node:test');
const assert = require('node:assert/strict');
const fs = require('fs');
const os = require('os');
const path = require('path');
const http = require('http');

const { validateConfig, loadConfig, DEFAULTS } = require('../src/config');
const { upsertVersion, readLibrary, writeLibrary, writeCollection } = require('../src/storage');
const { createJobs } = require('../src/webui/jobs');
const { createTracker, sizeOnDisk } = require('../src/webui/progress');
const { resolveStaticPath } = require('../src/webui/http');
const { createWebServer } = require('../src/webui/server');
const { normalizeRefs } = require('../src/webui/actions');
const i18n = require('../src/i18n');
const webEntry = require('../web.js');

const LANGUAGE_AT_LOAD = i18n.getLanguage();
test.after(() => i18n.setLanguage(LANGUAGE_AT_LOAD));

// ---------------------------------------------------------------------------
// Helpers
// 助手
// ---------------------------------------------------------------------------

// Temporary config with its own directories and config.json.
// 独立目录与 config.json 的临时配置。
function makeConfig() {
  const root = fs.mkdtempSync(path.join(os.tmpdir(), 'civitai-webui-'));
  const configFile = path.join(root, 'config.json');
  fs.writeFileSync(configFile, JSON.stringify({ ...DEFAULTS, outDir: path.join(root, 'downloads') }, null, 2));
  const config = validateConfig({
    ...DEFAULTS,
    site: 'http://127.0.0.1:1',
    outDir: path.join(root, 'downloads'),
    profileDir: path.join(root, 'profile'),
    userAgent: 'test-agent',
    retries: 0,
    apiRateLimit: 0,
  });
  config.root = root;
  config.configFile = configFile;
  config.dataDir = path.join(root, '.data');
  config.cookiesFile = path.join(config.dataDir, 'cookies.txt');
  fs.mkdirSync(config.dataDir, { recursive: true });
  fs.mkdirSync(config.outDir, { recursive: true });
  return config;
}

// Seed one downloaded model with one real file on disk.
// 造一个真实落盘的模型记录。
function seed(config, modelId, versionId, fileName = 'a.bin') {
  const dirName = `Model ${modelId}`;
  const dir = path.join(config.outDir, dirName);
  fs.mkdirSync(dir, { recursive: true });
  const content = 'abcd';
  fs.writeFileSync(path.join(dir, fileName), content);
  const { entries } = readLibrary(config);
  upsertVersion(entries, modelId, {
    name: `Model ${modelId}`,
    type: 'LORA',
    versionId,
    versionName: `v${versionId}`,
    dirName,
    outDir: config.outDir,
    files: [{ fileId: 1, name: fileName, remoteName: fileName, sha256: 'A'.repeat(64), bytes: content.length }],
  });
  writeLibrary(config, entries);
  return { dir, fileName };
}

// Start the server on an ephemeral port.
// 在临时端口启动服务器。
async function startServer(config) {
  const wrapper = createWebServer({
    config,
    // Settings reloads must read the temporary config.json, never the one in the working directory.
    // 设置重新加载必须读临时 config.json，绝不能读工作目录里的那份。
    loadConfig: () => loadConfig({ root: config.root, file: config.configFile }),
  });
  const started = await wrapper.start({ port: 0 });
  return { wrapper, ...started };
}

// Let the job manager's promise chain start the task.
// 让任务管理器的 promise 链把任务跑起来。
function tick() {
  return new Promise((resolve) => setTimeout(resolve, 0));
}

// Tiny JSON request helper.
// 极简 JSON 请求助手。
function request(base, method, urlPath, { body, headers } = {}) {
  return new Promise((resolve, reject) => {
    const target = new URL(urlPath, base);
    const payload = body === undefined ? null : JSON.stringify(body);
    const options = {
      method,
      hostname: target.hostname,
      port: target.port,
      path: `${target.pathname}${target.search}`,
      headers: { ...(headers || {}) },
    };
    if (payload !== null) {
      options.headers['Content-Type'] = options.headers['Content-Type'] || 'application/json';
      options.headers['Content-Length'] = Buffer.byteLength(payload);
    }
    const req = http.request(options, (res) => {
      const chunks = [];
      res.on('data', (chunk) => chunks.push(chunk));
      res.on('end', () => {
        const text = Buffer.concat(chunks).toString('utf8');
        let json = null;
        try {
          json = JSON.parse(text);
        } catch (e) {
          json = null;
        }
        resolve({ status: res.statusCode, headers: res.headers, text, json });
      });
    });
    req.on('error', reject);
    if (payload !== null) req.write(payload);
    req.end();
  });
}

// Poll a job until it leaves the running state.
// 轮询直到任务结束。
async function waitJob(base, id, timeoutMs = 8000) {
  const started = Date.now();
  for (;;) {
    const res = await request(base, 'GET', `/api/jobs/${id}`);
    const job = res.json;
    if (job && job.status !== 'running') return job;
    if (Date.now() - started > timeoutMs) throw new Error('job did not finish in time');
    await new Promise((resolve) => setTimeout(resolve, 40));
  }
}

// ---------------------------------------------------------------------------
// Job manager
// 任务管理
// ---------------------------------------------------------------------------

test('webui/jobs: 任务状态、日志与进度事件', async () => {
  const events = [];
  const jobs = createJobs({ emit: (event) => events.push(event), progressIntervalMs: 0 });
  const job = jobs.start({ kind: 'test', title: 'demo' }, async (ctx) => {
    ctx.log('line one');
    ctx.progress({ phase: 'download', bytes: 5 });
    return { answer: 42 };
  });
  assert.equal(job.status, 'running');
  assert.equal(jobs.active().id, job.id);

  const finished = await waitJobDirect(jobs, job.id);
  assert.equal(finished.status, 'done');
  assert.deepEqual(finished.result, { answer: 42 });
  assert.ok(finished.logs.includes('line one'));
  assert.equal(finished.progress.bytes, 5);
  assert.ok(events.some((event) => event.type === 'log'));
  assert.ok(events.some((event) => event.type === 'job' && event.job.status === 'done'));
});

test('webui/jobs: 同一时间只允许一个任务', async () => {
  const jobs = createJobs({ emit: () => {} });
  let release = null;
  const first = jobs.start({ kind: 'a' }, () => new Promise((resolve) => {
    release = resolve;
  }));
  assert.ok(first);
  await tick();
  assert.equal(jobs.start({ kind: 'b' }, async () => 'nope'), null);
  release('ok');
  await waitJobDirect(jobs, first.id);
  assert.ok(jobs.start({ kind: 'c' }, async () => 'yes'));
});

test('webui/jobs: 取消任务后状态为 cancelled，取消回调只跑一次', async () => {
  const jobs = createJobs({ emit: () => {} });
  let cancels = 0;
  const job = jobs.start({ kind: 'slow' }, (ctx) => {
    ctx.onCancel(() => {
      cancels++;
    });
    return new Promise(() => {});
  });
  await tick();
  assert.equal(jobs.cancel(job.id), true);
  // The status flips immediately; a second request is refused because the job is no longer running.
  // 状态立刻翻转；第二次请求会被拒绝，因为任务已经不在运行。
  assert.equal(jobs.cancel(job.id), false);
  const view = jobs.get(job.id);
  assert.equal(view.status, 'cancelled');
  assert.equal(cancels, 1);
});

test('webui/jobs: 抛错的任务记为 failed，并保留错误信息', async () => {
  const jobs = createJobs({ emit: () => {} });
  const job = jobs.start({ kind: 'boom' }, async () => {
    throw new Error('kaboom');
  });
  const view = await waitJobDirect(jobs, job.id);
  assert.equal(view.status, 'failed');
  assert.match(view.error, /kaboom/);
});

test('webui/jobs: note 把外部日志写进正在运行的任务', async () => {
  const jobs = createJobs({ emit: () => {} });
  let release = null;
  const job = jobs.start({ kind: 'x' }, () => new Promise((resolve) => {
    release = resolve;
  }));
  await tick();
  assert.equal(jobs.note('from the global sink'), true);
  const view = jobs.get(job.id);
  assert.ok(view.logs.includes('from the global sink'));
  release();
  await waitJobDirect(jobs, job.id);
  assert.equal(jobs.note('after the end'), false);
});

// Wait for a job using the manager directly (no HTTP).
// 直接用管理器等待任务结束。
async function waitJobDirect(jobs, id, timeoutMs = 5000) {
  const started = Date.now();
  for (;;) {
    const job = jobs.get(id);
    if (job && job.status !== 'running') return job;
    if (Date.now() - started > timeoutMs) throw new Error('job did not finish');
    await new Promise((resolve) => setTimeout(resolve, 20));
  }
}

// ---------------------------------------------------------------------------
// Progress arithmetic
// 进度换算
// ---------------------------------------------------------------------------

test('webui/progress: 已完成项 + 在途文件大小换算成总量与百分比', () => {
  const sizes = new Map();
  const statFile = (file) => {
    if (!sizes.has(file)) throw new Error('missing');
    return { size: sizes.get(file) };
  };
  let clock = 1000;
  const now = () => clock;
  const plan = [
    { modelId: '1', name: 'A', totalBytes: 1000 },
    { modelId: '2', name: 'B', totalBytes: 500 },
  ];
  const tracker = createTracker({ plan, now, statFile });
  const dir = path.join(os.tmpdir(), 'progress-test');

  // Item 1 starts: its `.part` file already holds 400 of 1000 bytes.
  // 第 1 项开始：`.part` 里已有 400 / 1000 字节。
  tracker.fileStarted(plan[0], { name: 'a.bin', bytes: 1000 }, dir);
  sizes.set(path.join(dir, 'a.bin.part'), 400);
  let snap = tracker.snapshot();
  assert.equal(snap.expected, 1500);
  assert.equal(snap.bytes, 400);
  assert.equal(snap.running.length, 1);
  assert.ok(snap.percent > 26 && snap.percent < 27);

  // Item 1 completes (its bytes count from the plan) and item 2 starts and completes.
  // 第 1 项完成（按计划字节计入），第 2 项开始并完成。
  tracker.itemDone(plan[0], true, 'done');
  plan[1].totalBytes = 500;
  tracker.fileStarted(plan[1], { name: 'b.bin', bytes: 500 }, dir);
  sizes.set(path.join(dir, 'b.bin'), 500);
  snap = tracker.snapshot();
  assert.equal(snap.done, 1);
  assert.equal(snap.bytes, 1500);
  assert.equal(snap.percent, 100);
  tracker.itemDone(plan[1], true, 'done');
  snap = tracker.snapshot();
  assert.equal(snap.done, 2);
  assert.equal(snap.failed, 0);
  assert.equal(snap.skipped, 0);
});

test('webui/progress: 跳过与失败分别计数，速度不会为负', () => {
  let clock = 10000;
  const tracker = createTracker({
    plan: [{ modelId: 'a', totalBytes: 100 }],
    now: () => clock,
    statFile: () => ({ size: 0 }),
  });
  tracker.itemDone({ modelId: 'a', totalBytes: 100 }, false, 'skipped');
  let snap = tracker.snapshot();
  assert.equal(snap.skipped, 1);
  assert.equal(snap.done, 0);
  tracker.itemDone({ modelId: 'b', totalBytes: 100 }, false, 'failed');
  snap = tracker.snapshot();
  assert.equal(snap.failed, 1);
  clock += 1000;
  snap = tracker.snapshot();
  assert.ok(snap.speed >= 0);
});

test('webui/progress: sizeOnDisk 优先成品文件，封顶到预期大小', () => {
  const stat = (file) => {
    if (file === '/x/a.bin') return { size: 9999 };
    throw new Error('missing');
  };
  assert.equal(sizeOnDisk({ target: '/x/a.bin', part: '/x/a.bin.part', expected: 100 }, stat), 100);
  const partOnly = (file) => {
    if (file === '/x/a.bin.part') return { size: 60 };
    throw new Error('missing');
  };
  assert.equal(sizeOnDisk({ target: '/x/a.bin', part: '/x/a.bin.part', expected: 100 }, partOnly), 60);
  assert.equal(sizeOnDisk({ target: '/x/a.bin', part: '/x/a.bin.part', expected: 0 }, () => ({ size: 7 })), 7);
  assert.equal(sizeOnDisk({ target: '/x/a.bin', part: '/x/a.bin.part', expected: 0 }, () => {
    throw new Error('nope');
  }), 0);
});

// ---------------------------------------------------------------------------
// Static path resolution
// 静态路径解析
// ---------------------------------------------------------------------------

test('webui/http: 路径穿越与非法编码被拒绝', () => {
  const root = path.join(os.tmpdir(), 'webui-static');
  assert.equal(resolveStaticPath(root, '/index.html'), path.join(root, 'index.html'));
  assert.equal(resolveStaticPath(root, '/'), path.join(root));
  assert.equal(resolveStaticPath(root, '/../secret'), null);
  assert.equal(resolveStaticPath(root, '/a/../../secret'), null);
  assert.equal(resolveStaticPath(root, '/%2e%2e/secret'), null);
  assert.equal(resolveStaticPath(root, '/%zz'), null);
  assert.equal(resolveStaticPath(root, '/a\u0000b'), null);
});

// ---------------------------------------------------------------------------
// Reference parsing + collection snapshots
// 引用解析与收藏集快照
// ---------------------------------------------------------------------------

test('webui/actions: normalizeRefs 支持多行、逗号、注释与去重', () => {
  assert.deepEqual(normalizeRefs('model:1\nversion:2, https://x/models/3 # note'), [
    'model:1',
    'version:2',
    'https://x/models/3',
  ]);
  assert.deepEqual(normalizeRefs(['model:1', 'model:1', '  ']), ['model:1']);
  assert.deepEqual(normalizeRefs(''), []);
  assert.deepEqual(normalizeRefs(undefined), []);
});

test('webui/api: 收藏集快照详情（成员 / 变化 / 重置）', async (t) => {
  const config = makeConfig();
  seed(config, 1, 10);
  // First enumeration records the baseline, the second one has an addition and a version change.
  // 第一次枚举记录基线，第二次包含一个新增与一个版本变化。
  writeCollection(config, '123', { items: [{ modelId: 1, name: 'A', versionId: 10 }] });
  writeCollection(config, '123', {
    items: [
      { modelId: 1, name: 'A', versionId: 11 },
      { modelId: 2, name: 'B', versionId: 20 },
    ],
  });

  const { wrapper, url } = await startServer(config);
  t.after(() => wrapper.stop());

  const detail = await request(url, 'GET', '/api/collections/123');
  assert.equal(detail.status, 200);
  assert.equal(detail.json.count, 2);
  assert.ok(detail.json.fetchedAt);
  assert.equal(detail.json.changes.added.length >= 1, true);
  const changed = detail.json.changes.versionChanged.find((item) => item.modelId === '1');
  assert.ok(changed, JSON.stringify(detail.json.changes));
  assert.equal(changed.versionId, '11', '版本变化应给出新版本');

  const missing = await request(url, 'GET', '/api/collections/999');
  assert.equal(missing.status, 404);

  const invalid = await request(url, 'GET', '/api/collections/abc');
  assert.equal(invalid.status, 404);

  const reset = await request(url, 'POST', '/api/models/reset', {
    body: { items: [{ modelId: '1', versionId: '11' }] },
  });
  assert.equal(reset.status, 200);
  assert.equal(typeof reset.json.reset, 'number');
});

test('webui/api: 粘贴引用的下载会先解析（无法识别的引用让任务失败）', async (t) => {
  const config = makeConfig();
  // A fake cookie file keeps the job browser-free; the reference itself is unresolvable, so the job
  // must fail before any network access.
  //
  // 放一个假 Cookie 文件让任务不碰浏览器；引用本身无法识别，任务应在联网前失败。
  fs.writeFileSync(config.cookiesFile, '');
  const { wrapper, url } = await startServer(config);
  t.after(() => wrapper.stop());

  const start = await request(url, 'POST', '/api/download', {
    body: { refs: ['not-a-reference'], outDir: config.outDir },
  });
  assert.equal(start.status, 200);
  const job = await waitJob(url, start.json.job.id);
  assert.equal(job.status, 'failed');
  assert.match(job.error, /not-a-reference|没有可下载/);
});

// ---------------------------------------------------------------------------
// HTTP API endpoints
// HTTP API 接口
// ---------------------------------------------------------------------------

test('webui/api: 首页、状态、i18n、模型库与固定版本', async (t) => {
  const config = makeConfig();
  seed(config, 900, 5);
  const { wrapper, url } = await startServer(config);
  t.after(() => wrapper.stop());

  const index = await request(url, 'GET', '/');
  assert.equal(index.status, 200);
  assert.match(index.headers['content-type'], /text\/html/);
  assert.match(index.text, /<title>civitai-downloader<\/title>/);

  const state = await request(url, 'GET', '/api/state');
  assert.equal(state.status, 200);
  assert.equal(state.json.site, config.site);
  assert.equal(state.json.library.models, 1);
  assert.equal(state.json.library.versions, 1);
  assert.equal(state.json.loggedIn, false);

  const i18nZh = await request(url, 'GET', '/api/i18n');
  assert.equal(i18nZh.status, 200);
  assert.equal(i18nZh.json.language, 'zh-CN');
  assert.equal(i18nZh.json.dict['web.nav.dashboard'], '仪表盘');
  assert.ok(Object.keys(i18nZh.json.dict).length > 200);

  const library = await request(url, 'GET', '/api/library?q=900');
  assert.equal(library.status, 200);
  assert.equal(library.json.items.length, 1);
  assert.equal(library.json.items[0].modelId, '900');

  const detail = await request(url, 'GET', '/api/library/900');
  assert.equal(detail.status, 200);
  assert.equal(detail.json.versions[0].versionName, 'v5');

  const pin = await request(url, 'POST', '/api/library/900/pin', { body: { versionId: '5' } });
  assert.equal(pin.status, 200);
  assert.equal(pin.json.pinnedVersionId, '5');

  const unpin = await request(url, 'POST', '/api/library/900/pin', { body: { versionId: null } });
  assert.equal(unpin.json.pinnedVersionId, null);

  const badVersion = await request(url, 'POST', '/api/library/900/pin', { body: { versionId: '404' } });
  assert.equal(badVersion.status, 400);

  const missing = await request(url, 'GET', '/api/library/123');
  assert.equal(missing.status, 404);
  assert.match(missing.json.error, /123/);

  const unknown = await request(url, 'GET', '/api/nope');
  assert.equal(unknown.status, 404);
});

test('webui/api: 校验任务端到端（无网络）', async (t) => {
  const config = makeConfig();
  seed(config, 900, 5);
  const { wrapper, url } = await startServer(config);
  t.after(() => wrapper.stop());

  const start = await request(url, 'POST', '/api/verify', { body: { modelIds: ['900'], noHash: true } });
  assert.equal(start.status, 200);
  const job = await waitJob(url, start.json.job.id);
  assert.equal(job.status, 'done');
  assert.equal(job.result.total, 1);
  assert.equal(job.result.ok, 1);
  assert.deepEqual(job.result.broken, []);

  // A finished job cannot be cancelled.
  // 已完成的任务不能再取消。
  const cancel = await request(url, 'POST', `/api/jobs/${job.id}/cancel`, { body: {} });
  assert.equal(cancel.status, 409);
});

test('webui/api: 请求守卫（内容类型 / 跨源 / 空选择）', async (t) => {
  const config = makeConfig();
  const { wrapper, url } = await startServer(config);
  t.after(() => wrapper.stop());

  const wrongType = await request(url, 'POST', '/api/verify', {
    body: { modelIds: [] },
    headers: { 'Content-Type': 'text/plain' },
  });
  assert.equal(wrongType.status, 415);

  const crossOrigin = await request(url, 'POST', '/api/verify', {
    body: { modelIds: [] },
    headers: { Origin: 'http://evil.example' },
  });
  assert.equal(crossOrigin.status, 403);

  const noItems = await request(url, 'POST', '/api/download', { body: { items: [] } });
  assert.equal(noItems.status, 400);

  const noModels = await request(url, 'POST', '/api/verify', { body: {} });
  assert.equal(noModels.status, 400);

  const badCollection = await request(url, 'POST', '/api/collections/plan', { body: { collectionId: 'abc' } });
  assert.equal(badCollection.status, 400);

  const notPending = await request(url, 'POST', '/api/login/confirm', { body: {} });
  assert.equal(notPending.status, 409);
});

test('webui/api: 设置校验与保存（写到临时 config.json）', async (t) => {
  const config = makeConfig();
  const { wrapper, url } = await startServer(config);
  t.after(() => wrapper.stop());

  const current = await request(url, 'GET', '/api/settings');
  assert.equal(current.status, 200);
  assert.equal(current.json.values.site, config.site);

  const invalid = await request(url, 'POST', '/api/settings', { body: { proxy: 'not a url' } });
  assert.equal(invalid.status, 400);
  assert.match(invalid.json.error, /proxy/i);

  const invalidJobs = await request(url, 'POST', '/api/settings', { body: { jobs: 99 } });
  assert.equal(invalidJobs.status, 400);

  const newDir = path.join(config.root, 'other-downloads');
  const saved = await request(url, 'POST', '/api/settings', { body: { outDir: newDir, jobs: 3 } });
  assert.equal(saved.status, 200);
  assert.equal(saved.json.values.jobs, 3);

  const raw = JSON.parse(fs.readFileSync(config.configFile, 'utf8'));
  assert.equal(raw.outDir, newDir);
  assert.equal(raw.jobs, 3);
});

test('webui/api: 打开目录限制在输出目录内', async (t) => {
  const config = makeConfig();
  const { wrapper, url } = await startServer(config);
  t.after(() => wrapper.stop());

  const outside = await request(url, 'POST', '/api/open', { body: { dir: config.root } });
  // The project root contains the output directory but is not inside it.
  // 项目根包含输出目录，但不在其内部。
  assert.equal(outside.status, 403);

  const missing = await request(url, 'POST', '/api/open', { body: { dir: path.join(config.outDir, 'nope') } });
  assert.equal(missing.status, 404);
});

test('webui/api: 静态资源、SPA 回落与真实 404', async (t) => {
  const config = makeConfig();
  const { wrapper, url } = await startServer(config);
  t.after(() => wrapper.stop());

  const appJs = await request(url, 'GET', '/app.js');
  assert.equal(appJs.status, 200);
  assert.match(appJs.headers['content-type'], /javascript/);
  assert.match(appJs.text, /civitai-downloader web UI/);

  const styles = await request(url, 'GET', '/styles.css');
  assert.equal(styles.status, 200);
  assert.match(styles.headers['content-type'], /text\/css/);

  // Unknown client route → the SPA shell (hash routing happens in the browser).
  // 未知的前端路由 → 单页应用外壳（hash 路由在浏览器里完成）。
  const shell = await request(url, 'GET', '/some/route');
  assert.equal(shell.status, 200);
  assert.match(shell.text, /<title>civitai-downloader<\/title>/);

  // Missing asset with an extension → a real 404.
  // 带扩展名的缺失资源 → 真正的 404。
  const missing = await request(url, 'GET', '/nope.js');
  assert.equal(missing.status, 404);

  const traversal = await request(url, 'GET', '/../package.json');
  // The URL is normalised to /package.json before routing, so it is simply a missing asset.
  // URL 会被规范化为 /package.json 再路由，因此只是一个缺失的资源。
  assert.equal(traversal.status, 404);
});

test('webui: 入口参数解析', () => {
  assert.deepEqual(webEntry.parseArgs([]), { port: null, host: null, open: true, lang: null, help: false });
  assert.equal(webEntry.parseArgs(['--port', '5000']).port, '5000');
  assert.equal(webEntry.parseArgs(['--port=5001']).port, '5001');
  assert.equal(webEntry.parseArgs(['-p', '5002']).port, '5002');
  assert.equal(webEntry.parseArgs(['--no-open']).open, false);
  assert.equal(webEntry.parseArgs(['--host', '0.0.0.0']).host, '0.0.0.0');
  assert.equal(webEntry.parseArgs(['--help']).help, true);
});
