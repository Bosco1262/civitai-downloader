'use strict';

const test = require('node:test');
const assert = require('node:assert/strict');
const http = require('http');

const api = require('../src/api');
const { AuthError, NotFoundError, RateLimitError, NetworkError, SiteInterfaceError } = require('../src/errors');

/**
 * Start a programmable mock site.
 * 启动一个可编程的 mock 站点
 */
function startServer(handler) {
  return new Promise((resolve) => {
    const server = http.createServer(handler);
    server.listen(0, '127.0.0.1', () => {
      const { port } = server.address();
      resolve({
        site: `http://127.0.0.1:${port}`,
        close: () =>
          new Promise((r) => {
            if (typeof server.closeAllConnections === 'function') server.closeAllConnections();
            server.close(r);
          }),
      });
    });
  });
}

function versionPayload(id, files) {
  return JSON.stringify({
    id,
    name: `v${id}`,
    files:
      files ||
      [
        { id: 11, name: 'a.safetensors', type: 'Model', primary: true, sizeKB: 2, hashes: { SHA256: 'ab' }, downloadUrl: `https://blob.example/a.safetensors` },
        { id: 12, name: 'vae.pt', type: 'VAE', primary: false, sizeKB: 1, hashes: { SHA256: 'cd' }, downloadUrl: `https://blob.example/vae.pt` },
      ],
  });
}

test('parseRetryAfter: 秒数与 HTTP 日期', () => {
  assert.equal(api.parseRetryAfter('30'), 30000);
  assert.equal(api.parseRetryAfter(null), 0);
  assert.equal(api.parseRetryAfter('abc'), 0);
  const future = new Date(Date.now() + 5000).toUTCString();
  const ms = api.parseRetryAfter(future);
  assert.ok(ms > 1000 && ms <= 6000, `HTTP 日期应解析为毫秒（实际 ${ms}）`);
});

test('extractFiles: 默认只取 primary 的 Model 文件', () => {
  const meta = {
    files: [
      { id: 1, name: 'a.safetensors', type: 'Model', primary: true, sizeKB: 10, hashes: { SHA256: 'aa' }, downloadUrl: 'https://civitai.com/api/download/models/1?fileId=1' },
      { id: 2, name: 'b.safetensors', type: 'Model', primary: false, sizeKB: 20, hashes: {}, downloadUrl: 'https://civitai.com/x' },
      { id: 3, name: 'vae.pt', type: 'VAE', primary: true, sizeKB: 30, hashes: {}, downloadUrl: 'https://civitai.com/y' },
    ],
  };
  const files = api.extractFiles(meta, 'https://civitai.red');
  assert.equal(files.length, 1);
  assert.equal(files[0].name, 'a.safetensors');
  assert.equal(files[0].bytes, 10 * 1024);
  assert.equal(files[0].sha256, 'AA', '哈希统一大写');
  assert.ok(files[0].downloadUrl.startsWith('https://civitai.red/api/download'), '下载直链换到当前站点');

  const all = api.extractFiles(meta, null, { primaryOnly: false, fileTypes: ['Model', 'VAE'] });
  assert.equal(all.length, 3, 'primaryOnly=false + 多类型时全部返回');
});

test('extractFiles: 必需组件与关联 VAE 不受默认类型过滤', () => {
  const meta = {
    vaeId: 99,
    files: [
      {
        id: 1,
        name: 'model.safetensors',
        type: 'Model',
        primary: true,
        sizeKB: 10,
        hashes: {},
        downloadUrl: '',
      },
      {
        id: 2,
        name: 'text_encoder.safetensors',
        type: 'Text Encoder',
        sizeKB: 20,
        metadata: { isRequired: true },
        hashes: {},
        downloadUrl: '',
      },
      {
        id: 3,
        name: 'vae.safetensors',
        type: 'VAE',
        sizeKB: 30,
        hashes: {},
        downloadUrl: '',
      },
    ],
  };
  const files = api.extractFiles(meta, null, { fileTypes: ['Model'], primaryOnly: true });
  assert.deepEqual(files.map((file) => file.name), [
    'text_encoder.safetensors',
    'vae.safetensors',
    'model.safetensors',
  ]);
});

test('versionToItem: 汇总文件与总体积', () => {
  const item = api.versionToItem('https://civitai.red', {
    id: 7,
    name: 'v7',
    files: [{ id: 1, name: 'a', type: 'Model', primary: true, sizeKB: 3, hashes: {}, downloadUrl: '' }],
  });
  assert.equal(item.versionId, 7);
  assert.equal(item.totalBytes, 3 * 1024);
});

test('fetchVersionMeta: 成功时返回 JSON', async (t) => {
  const server = await startServer((req, res) => {
    res.writeHead(200, { 'content-type': 'application/json' });
    res.end(versionPayload(5));
  });
  t.after(() => server.close());

  api.configureApi({ retries: 1, requestTimeoutMs: 5000, apiRateLimit: 0 });
  const meta = await api.fetchVersionMeta(server.site, 5, 'ua');
  assert.equal(meta.id, 5);
});

test('fetchVersionMeta: 500 会重试并按次数最终成功', async (t) => {
  let calls = 0;
  const server = await startServer((req, res) => {
    calls++;
    if (calls < 3) {
      res.writeHead(500);
      res.end('boom');
      return;
    }
    res.writeHead(200, { 'content-type': 'application/json' });
    res.end(versionPayload(5));
  });
  t.after(() => server.close());

  api.configureApi({ retries: 3, requestTimeoutMs: 5000, apiRateLimit: 0 });
  const meta = await api.fetchVersionMeta(server.site, 5, 'ua');
  assert.equal(meta.id, 5);
  assert.equal(calls, 3, '应重试到第 3 次成功');
});

test('fetchVersionMeta: 404 立即抛 NotFoundError 不重试；401 抛 AuthError', async (t) => {
  let calls404 = 0;
  const server = await startServer((req, res) => {
    if (req.url.includes('/model-versions/404')) {
      calls404++;
      res.writeHead(404);
      res.end('nope');
      return;
    }
    res.writeHead(401);
    res.end('unauthorized');
  });
  t.after(() => server.close());

  api.configureApi({ retries: 3, requestTimeoutMs: 5000, apiRateLimit: 0 });
  await assert.rejects(() => api.fetchVersionMeta(server.site, 404, 'ua'), (e) => e instanceof NotFoundError);
  assert.equal(calls404, 1, '404 不应重试');
  await assert.rejects(() => api.fetchVersionMeta(server.site, 1, 'ua'), (e) => e instanceof AuthError);
});

test('fetchVersionMeta: 429 带上 Retry-After 并最终成功', async (t) => {
  let calls = 0;
  const server = await startServer((req, res) => {
    calls++;
    if (calls === 1) {
      res.writeHead(429, { 'retry-after': '0' });
      res.end('slow down');
      return;
    }
    res.writeHead(200, { 'content-type': 'application/json' });
    res.end(versionPayload(9));
  });
  t.after(() => server.close());

  api.configureApi({ retries: 2, requestTimeoutMs: 5000, apiRateLimit: 0 });
  const meta = await api.fetchVersionMeta(server.site, 9, 'ua');
  assert.equal(meta.id, 9);
  assert.equal(calls, 2);
});

test('fetchVersionMeta: 非法 JSON 抛 SiteInterfaceError（不重试）', async (t) => {
  let calls = 0;
  const server = await startServer((req, res) => {
    calls++;
    res.writeHead(200, { 'content-type': 'text/html' });
    res.end('<html>changed</html>');
  });
  t.after(() => server.close());

  api.configureApi({ retries: 3, requestTimeoutMs: 5000, apiRateLimit: 0 });
  await assert.rejects(() => api.fetchVersionMeta(server.site, 1, 'ua'), (e) => e instanceof SiteInterfaceError);
  assert.equal(calls, 1);
});

test('fetchJson: 连接失败抛 NetworkError', async () => {
  api.configureApi({ retries: 1, requestTimeoutMs: 2000, apiRateLimit: 0 });
  await assert.rejects(
    () => api.fetchVersionMeta('http://127.0.0.1:1', 1, 'ua'),
    (e) => e instanceof NetworkError
  );
});

test('限流器：每秒 N 个请求会被拉开发送间隔', async (t) => {
  const stamps = [];
  const server = await startServer((req, res) => {
    stamps.push(Date.now());
    res.writeHead(200, { 'content-type': 'application/json' });
    res.end(versionPayload(1));
  });
  t.after(() => server.close());

  api.configureApi({ retries: 0, requestTimeoutMs: 5000, apiRateLimit: 10 });
  const started = Date.now();
  await Promise.all([1, 2, 3].map((i) => api.fetchVersionMeta(server.site, i, 'ua')));
  const elapsed = Date.now() - started;
  assert.equal(stamps.length, 3);
  assert.ok(elapsed >= 200, `3 个请求 @10/s 至少需要约 200ms（实际 ${elapsed}ms）`);
  assert.ok(stamps[2] - stamps[0] >= 150, '首尾请求应有间隔');
});

test('fetchJson: 请求超时抛 NetworkError（超时有 1000ms 下限）', async (t) => {
  let calls = 0;
  const server = await startServer((req, res) => {
    calls++;
    setTimeout(() => {
      try {
        res.writeHead(200, { 'content-type': 'application/json' });
        res.end(versionPayload(3));
      } catch (e) {
        // The client has already disconnected.
        // 客户端已断开
      }
    }, 1500);
  });
  t.after(() => server.close());

  const ctx = api.configureApi({ retries: 0, requestTimeoutMs: 100, apiRateLimit: 0 });
  assert.equal(ctx.timeoutMs, 1000, '超时下限为 1000ms');
  await assert.rejects(() => api.fetchVersionMeta(server.site, 3, 'ua'), (e) => e instanceof NetworkError);
  assert.equal(calls, 1, 'retries=0 时不重试');
});

test('buildPlan: 并发获取、失败项带 error 不中断整体', async (t) => {
  const server = await startServer((req, res) => {
    if (req.url.includes('/model-versions/2')) {
      res.writeHead(500);
      res.end('boom');
      return;
    }
    res.writeHead(200, { 'content-type': 'application/json' });
    res.end(versionPayload(1));
  });
  t.after(() => server.close());

  api.configureApi({ retries: 0, requestTimeoutMs: 5000, apiRateLimit: 0 });
  const items = [
    { modelId: 1, name: 'ok1', versionId: 1 },
    { modelId: 2, name: 'bad', versionId: 2 },
    { modelId: 3, name: 'ok2', versionId: 3 },
    { modelId: 4, name: 'noversion', versionId: null },
  ];
  const { plan, totalBytes, failed } = await api.buildPlan(server.site, items, 'ua', { concurrency: 2 });
  assert.equal(plan.length, 4);
  assert.equal(failed, 2, '版本 2 与无版本项应失败');
  assert.equal(plan[0].files.length, 1);
  assert.ok(plan[1].error);
  assert.ok(plan[3].error);
  assert.equal(totalBytes, plan[0].totalBytes + plan[2].totalBytes);
});
