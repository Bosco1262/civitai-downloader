'use strict';

const test = require('node:test');
const assert = require('node:assert/strict');
const fs = require('fs');
const os = require('os');
const path = require('path');
const crypto = require('crypto');

const downloader = require('../src/downloader');
const { AuthError, NotFoundError, DownloadError, CancelError } = require('../src/errors');

const CONTENT = Buffer.from('civitai-downloader-test-payload\n'.repeat(512));
const SHA = crypto.createHash('sha256').update(CONTENT).digest('hex').toUpperCase();
const OTHER = Buffer.from('different-content\n'.repeat(100));

function tempDir(tag) {
  return fs.mkdtempSync(path.join(os.tmpdir(), `civitai-dl-${tag}-`));
}

function writeHeaders(opts, etag) {
  if (!opts.headerFile) return;
  fs.writeFileSync(
    opts.headerFile,
    `HTTP/1.1 307 Temporary Redirect\r\nLocation: https://blob.example/x\r\n\r\n` +
      `HTTP/1.1 200 OK\r\nETag: ${etag}\r\nContent-Length: ${CONTENT.length}\r\n\r\n`,
    'utf8'
  );
}

/**
 * Install a curl stub: steps[i] decides how the i-th call behaves (the last step repeats once exhausted).
 * 安装 curl 桩：steps[i] 决定第 i 次调用的行为（超出则重复最后一个）
 */
function installStub(steps) {
  const calls = [];
  downloader.setCurlImplementations({
    sleep: async () => {},
    head: async () => ({ ok: true, etag: '"remote-1"', length: CONTENT.length }),
    runCurl: async (opts) => {
      const index = calls.length;
      calls.push({
        index,
        out: opts.out,
        resume: opts.resume,
        partExists: fs.existsSync(opts.out),
        partSize: fs.existsSync(opts.out) ? fs.statSync(opts.out).size : 0,
        sidecarExists: fs.existsSync(`${opts.out}.json`),
      });
      const step = steps[Math.min(index, steps.length - 1)];
      return step(opts, index);
    },
  });
  return calls;
}

function writeFull(opts, etag = '"remote-1"') {
  fs.writeFileSync(opts.out, CONTENT);
  writeHeaders(opts, etag);
  return { exitCode: 0, httpCode: 200, stderr: '' };
}

function writePartial(opts, bytes, etag = '"remote-1"') {
  fs.writeFileSync(opts.out, CONTENT.subarray(0, bytes));
  writeHeaders(opts, etag);
  return { exitCode: 0, httpCode: 206, stderr: '' };
}

function baseOpts(dir, extra = {}) {
  return {
    url: 'https://civitai.red/api/download/models/1?fileId=2',
    cookieFile: path.join(dir, 'cookies.txt'),
    dir,
    fileName: 'model.safetensors',
    expectedSha256: SHA,
    expectedBytes: CONTENT.length,
    userAgent: 'test-agent',
    quiet: true,
    attempts: 2,
    ...extra,
  };
}

function cleanup(t) {
  t.after(() => {
    downloader.resetCurlImplementations();
    downloader.resetCancel();
  });
}

test('parseHeaders: 取最后一次响应（跟随重定向后）', () => {
  const text =
    'HTTP/1.1 307 Temporary Redirect\r\nLocation: https://x/y\r\n\r\n' +
    'HTTP/1.1 200 OK\r\nETag: "abc"\r\nContent-Length: 42\r\n\r\n';
  const h = downloader.parseHeaders(text);
  assert.equal(h.etag, '"abc"');
  assert.equal(h['content-length'], '42');
  assert.equal(h.location, undefined, '不应取到重定向那一段的头');
  assert.deepEqual(downloader.parseHeaders(''), {});
});

test('目标文件已存在且校验通过 → 直接跳过，不调用 curl', async (t) => {
  cleanup(t);
  const dir = tempDir('skip');
  fs.writeFileSync(path.join(dir, 'model.safetensors'), CONTENT);
  const calls = installStub([writeFull]);

  const status = await downloader.downloadFile(baseOpts(dir));
  assert.equal(status, 'verified');
  assert.equal(calls.length, 0, '不应发起下载');
});

test('--force 时忽略已有文件重新下载', async (t) => {
  cleanup(t);
  const dir = tempDir('force');
  fs.writeFileSync(path.join(dir, 'model.safetensors'), CONTENT);
  const calls = installStub([writeFull]);

  const status = await downloader.downloadFile(baseOpts(dir, { force: true }));
  assert.equal(status, 'downloaded');
  assert.equal(calls.length, 1);
  assert.equal(calls[0].resume, false, 'force 时不应带断点续传参数');
});

test('已完整的 .part 直接改名，不再发起 Range 请求（避免 416）', async (t) => {
  cleanup(t);
  const dir = tempDir('completepart');
  const target = path.join(dir, 'model.safetensors');
  fs.writeFileSync(`${target}.part`, CONTENT);
  const calls = installStub([() => ({ exitCode: 22, httpCode: 416, stderr: '' })]);

  const status = await downloader.downloadFile(baseOpts(dir));
  assert.equal(status, 'downloaded');
  assert.equal(calls.length, 0, '完整分片不应再发起请求');
  assert.ok(fs.existsSync(target));
  assert.ok(!fs.existsSync(`${target}.part`));
});

test('HTTP 416 → 丢弃分片后重新下载成功', async (t) => {
  cleanup(t);
  const dir = tempDir('416');
  const target = path.join(dir, 'model.safetensors');
  fs.writeFileSync(`${target}.part`, CONTENT.subarray(0, 10));
  const calls = installStub([() => ({ exitCode: 22, httpCode: 416, stderr: '' }), writeFull]);

  const status = await downloader.downloadFile(baseOpts(dir));
  assert.equal(status, 'downloaded');
  assert.equal(calls.length, 2);
  assert.equal(calls[1].partExists, false, '第二次请求前旧分片应已删除');
  assert.equal(fs.readFileSync(target).length, CONTENT.length);
});

test('401 / 404 分别抛出认证与不存在错误（不重试）', async (t) => {
  cleanup(t);
  const dir1 = tempDir('401');
  installStub([() => ({ exitCode: 22, httpCode: 401, stderr: '' })]);
  await assert.rejects(() => downloader.downloadFile(baseOpts(dir1)), (e) => e instanceof AuthError);

  const dir2 = tempDir('404');
  installStub([() => ({ exitCode: 22, httpCode: 404, stderr: '' })]);
  await assert.rejects(() => downloader.downloadFile(baseOpts(dir2)), (e) => e instanceof NotFoundError);
});

test('未下载完 → 记录 ETag sidecar 并续传完成', async (t) => {
  cleanup(t);
  const dir = tempDir('resume');
  const target = path.join(dir, 'model.safetensors');
  const calls = installStub([(opts) => writePartial(opts, 4096), writeFull]);

  const status = await downloader.downloadFile(baseOpts(dir));
  assert.equal(status, 'downloaded');
  assert.equal(calls.length, 2);
  assert.equal(calls[1].sidecarExists, true, '续传前应已有 ETag sidecar');
  assert.ok(calls[1].partSize > 0, '续传时应有残留分片');
  assert.ok(!fs.existsSync(`${target}.part.json`), '完成后应清理 sidecar');
  assert.ok(!fs.existsSync(`${target}.headers.tmp`), '完成后应清理临时头文件');
});

test('远端 ETag 变化 → 丢弃旧分片重新下载', async (t) => {
  cleanup(t);
  const dir = tempDir('etag');
  const target = path.join(dir, 'model.safetensors');
  fs.writeFileSync(`${target}.part`, CONTENT.subarray(0, 4096));
  fs.writeFileSync(
    `${target}.part.json`,
    JSON.stringify({ etag: '"old-etag"', length: CONTENT.length, url: 'x', at: '2026-01-01' })
  );
  const calls = installStub([writeFull]);
  downloader.setCurlImplementations({
    sleep: async () => {},
    head: async () => ({ ok: true, etag: '"new-etag"', length: CONTENT.length }),
    runCurl: async (opts) => {
      calls.push({ partExists: fs.existsSync(opts.out) });
      return writeFull(opts);
    },
  });

  const status = await downloader.downloadFile(baseOpts(dir));
  assert.equal(status, 'downloaded');
  assert.equal(calls[0].partExists, false, 'ETag 不一致时旧分片应被丢弃');
});

test('校验不通过 → 删除分片并重新下载', async (t) => {
  cleanup(t);
  const dir = tempDir('badhash');
  const target = path.join(dir, 'model.safetensors');
  const calls = installStub([
    (opts) => {
      fs.writeFileSync(opts.out, OTHER);
      writeHeaders(opts, '"remote-1"');
      return { exitCode: 0, httpCode: 200, stderr: '' };
    },
    writeFull,
  ]);

  const status = await downloader.downloadFile(baseOpts(dir));
  assert.equal(status, 'downloaded');
  assert.equal(calls.length, 2);
  assert.equal(fs.readFileSync(target).toString(), CONTENT.toString());
});

test('文件超出预期大小 → 丢弃后重试', async (t) => {
  cleanup(t);
  const dir = tempDir('toobig');
  const calls = installStub([
    (opts) => {
      fs.writeFileSync(opts.out, Buffer.concat([CONTENT, Buffer.alloc(10 * 1024, 1)]));
      writeHeaders(opts, '"remote-1"');
      return { exitCode: 0, httpCode: 200, stderr: '' };
    },
    writeFull,
  ]);

  const status = await downloader.downloadFile(baseOpts(dir));
  assert.equal(status, 'downloaded');
  assert.equal(calls.length, 2);
});

test('重试耗尽 → DownloadError', async (t) => {
  cleanup(t);
  const dir = tempDir('exhaust');
  const calls = installStub([() => ({ exitCode: 7, httpCode: 0, stderr: 'connection refused' })]);

  await assert.rejects(
    () => downloader.downloadFile(baseOpts(dir, { attempts: 3 })),
    (e) => e instanceof DownloadError && /重试 3 次/.test(e.message)
  );
  assert.equal(calls.length, 3);
});

test('取消后立即抛出 CancelError', async (t) => {
  cleanup(t);
  const dir = tempDir('cancel');
  installStub([writeFull]);
  downloader.cancelCurrentDownload();
  await assert.rejects(() => downloader.downloadFile(baseOpts(dir)), (e) => e instanceof CancelError);
});

test('onAttempt 回调收到尝试次数与 HTTP 状态', async (t) => {
  cleanup(t);
  const dir = tempDir('attempts');
  installStub([(opts) => writePartial(opts, 2048), writeFull]);
  const seen = [];
  await downloader.downloadFile(baseOpts(dir, { onAttempt: (info) => seen.push(info) }));
  assert.equal(seen.length, 2);
  assert.deepEqual(
    seen.map((s) => s.attempt),
    [1, 2]
  );
  assert.equal(seen[0].max, 2);
});
