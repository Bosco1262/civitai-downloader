'use strict';

/**
 * Platform capability tests: Chrome profile isolated per site, aria2 arguments and engine selection,
 * cross-collection content dedup, and job-finished notifications.
 *
 * 平台能力测试：站点隔离的 Chrome profile、aria2 参数与引擎选择、
 * 跨收藏集内容去重、任务结束通知。
 */

const test = require('node:test');
const assert = require('node:assert/strict');
const fs = require('fs');
const http = require('http');
const os = require('os');
const path = require('path');
const crypto = require('crypto');

const { loadConfig, safeHostSlug, DEFAULTS } = require('../src/config');
const downloader = require('../src/downloader');
const browser = require('../src/browser');
const { createDedupIndex, loadIndex, indexPath } = require('../src/dedup');
const notify = require('../src/notify');

function tempDir(tag) {
  return fs.mkdtempSync(path.join(os.tmpdir(), `civitai-${tag}-`));
}

function writeConfig(dir, extra = {}) {
  const file = path.join(dir, 'config.json');
  fs.writeFileSync(file, JSON.stringify({ ...extra }), 'utf8');
  return file;
}

// ---------------------------------------------------------------------------
// Browser launch decisions
// 浏览器启动决策
// ---------------------------------------------------------------------------

test('browser: 识别无头实例，并只在需要窗口时替换它', () => {
  assert.equal(
    browser.isHeadlessBrowser({
      'User-Agent': 'Mozilla/5.0 Chrome/155.0.0.0 Safari/537.36 HeadlessChrome/155.0.0.0',
    }),
    true
  );
  assert.equal(
    browser.isHeadlessBrowser({ 'User-Agent': 'Mozilla/5.0 Chrome/155.0.0.0 Safari/537.36' }),
    false
  );
  assert.equal(browser.isHeadlessBrowser({}), false);
  assert.equal(browser.isHeadlessBrowser(null), false);

  const dir = tempDir('browser');
  const cookiesFile = path.join(dir, 'cookies.txt');
  const config = {
    headless: 'auto',
    cookiesFile,
    debugPort: 9333,
    profileDir: path.join(dir, 'profile'),
  };
  try {
    assert.equal(browser.wantsHeadless(config), false, '没有 Cookie 时需要可见窗口');
    fs.writeFileSync(cookiesFile, 'x', 'utf8');
    assert.equal(browser.wantsHeadless(config), true, '已有 Cookie 时 auto 走无头');
    assert.equal(browser.wantsHeadless(config, { headless: false }), false, '登录强制可见');
    assert.equal(browser.wantsHeadless({ ...config, headless: 'always' }), true);
    assert.equal(browser.wantsHeadless({ ...config, headless: 'never' }), false);

    const headful = browser.browserArgs(config, { headless: false });
    assert.ok(!headful.includes('--headless=new'));
    assert.ok(headful.includes('--remote-debugging-port=9333'));
    assert.ok(headful.includes(`--user-data-dir=${config.profileDir}`));
    const headless = browser.browserArgs(config, { headless: true });
    assert.ok(headless.includes('--headless=new'));
    assert.ok(headless.includes('--no-startup-window'));
  } finally {
    fs.rmSync(dir, { recursive: true, force: true });
  }
});

// ---------------------------------------------------------------------------
// Site-isolated Chrome profile
// 站点隔离的 Chrome profile
// ---------------------------------------------------------------------------

test('safeHostSlug: 主机名安全化', () => {
  assert.equal(safeHostSlug('https://civitai.red'), 'civitai.red');
  assert.equal(safeHostSlug('https://civitai.com/'), 'civitai.com');
  assert.equal(safeHostSlug('http://127.0.0.1:8080'), '127.0.0.1_8080');
  assert.equal(safeHostSlug('not a url'), 'default');
  assert.equal(safeHostSlug(''), 'default');
});

test('loadConfig: profileDir 默认按站点隔离', () => {
  const dir = tempDir('profile-site');
  writeConfig(dir, { site: 'https://civitai.red' });
  const cfg = loadConfig({ root: dir });
  assert.equal(cfg.profileDirExplicit, false);
  assert.equal(cfg.profileDir, path.join(cfg.profileDirBase, 'civitai.red'));

  writeConfig(dir, { site: 'https://civitai.com' });
  const cfg2 = loadConfig({ root: dir });
  assert.equal(cfg2.profileDir, path.join(cfg2.profileDirBase, 'civitai.com'));
  assert.notEqual(cfg.profileDir, cfg2.profileDir, '不同站点应使用不同 profile');
});

test('loadConfig: 显式配置 profileDir 时不做站点隔离', () => {
  const dir = tempDir('profile-explicit');
  const custom = path.join(dir, 'my-chrome');
  writeConfig(dir, { site: 'https://civitai.red', profileDir: custom });
  const cfg = loadConfig({ root: dir });
  assert.equal(cfg.profileDirExplicit, true);
  assert.equal(cfg.profileDir, custom);
});

test('loadConfig: 显式写成默认值仍按站点隔离（老配置不会卡在共享目录）', () => {
  const dir = tempDir('profile-default-literal');
  writeConfig(dir, { site: 'https://civitai.red', profileDir: DEFAULTS.profileDir });
  const cfg = loadConfig({ root: dir });
  assert.equal(cfg.profileDirExplicit, false);
  assert.equal(cfg.profileDir, path.join(cfg.profileDirBase, 'civitai.red'));
});

test('loadConfig: engine / dedup / notify 校验', () => {
  const dir = tempDir('engine-cfg');
  writeConfig(dir, { engine: 'auto', dedup: 'hardlink', notifyWebhook: 'https://example.com/hook' });
  const cfg = loadConfig({ root: dir });
  assert.equal(cfg.engine, 'auto');
  assert.equal(cfg.dedup, 'hardlink');
  assert.equal(cfg.notifyWebhook, 'https://example.com/hook');

  writeConfig(dir, { engine: 'wget' });
  assert.throws(() => loadConfig({ root: dir }), /engine/);

  writeConfig(dir, { dedup: 'symlink' });
  assert.throws(() => loadConfig({ root: dir }), /dedup/);

  writeConfig(dir, { notifyWebhook: 'ftp://x' });
  assert.throws(() => loadConfig({ root: dir }), /notifyWebhook/);

  writeConfig(dir, {});
  const defaults = loadConfig({ root: dir });
  assert.equal(defaults.engine, DEFAULTS.engine);
  assert.equal(defaults.dedup, 'off');
});

// ---------------------------------------------------------------------------
// aria2 engine
// aria2 引擎
// ---------------------------------------------------------------------------

test('buildAria2Args: 关键参数齐全，且仍下载到 .part', () => {
  const args = downloader.buildAria2Args({
    url: 'https://civitai.red/api/download/models/1?fileId=2',
    out: 'D:/models/a.safetensors.part',
    cookieFile: 'D:/data/cookies.txt',
    userAgent: 'UA/1.0',
    proxy: 'http://127.0.0.1:7890',
  });
  const has = (needle) => args.some((a) => a === needle || a.startsWith(needle));
  assert.ok(has('--no-conf'), '不应读取用户 aria2 配置');
  assert.ok(has('--continue=true'), '需要断点续传');
  assert.ok(has('--auto-file-renaming=false'), '不能改名成 file.1');
  assert.ok(has('--max-connection-per-server=8'));
  assert.ok(has('--split=8'));
  assert.ok(has('--summary-interval=0'));
  assert.ok(args.includes('--user-agent=UA/1.0'));
  assert.ok(args.includes('--load-cookies=D:/data/cookies.txt'));
  assert.ok(args.includes('--all-proxy=http://127.0.0.1:7890'));
  assert.equal(args[args.indexOf('-o') + 1], 'D:/models/a.safetensors.part');
  assert.equal(args[args.length - 1], 'https://civitai.red/api/download/models/1?fileId=2');
});

test('buildAria2Args: 无代理/无 cookie 时不加对应参数', () => {
  const args = downloader.buildAria2Args({ url: 'https://x/y', out: 'a.part' });
  assert.ok(!args.some((a) => a.startsWith('--all-proxy')));
  assert.ok(!args.some((a) => a.startsWith('--load-cookies')));
  assert.ok(!args.some((a) => a.startsWith('--user-agent')));
});

test('parseAria2HttpCode: 从输出中识别状态码', () => {
  assert.equal(downloader.parseAria2HttpCode('| ERR | 403 Forbidden | https://x'), 403);
  assert.equal(downloader.parseAria2HttpCode('errorCode=24 HTTP authorization failed 401'), 401);
  assert.equal(downloader.parseAria2HttpCode('503 Service Unavailable'), 503);
  assert.equal(downloader.parseAria2HttpCode('CUID#7 - Not found'), 404);
  assert.equal(downloader.parseAria2HttpCode('everything is fine'), 0);
  assert.equal(downloader.parseAria2HttpCode(''), 0);
});

test('resolveEngine: curl 始终可用；aria2 缺失时 auto 回退且强制 aria2 报错', () => {
  assert.equal(downloader.resolveEngine('curl'), 'curl');
  assert.equal(downloader.resolveEngine(undefined), 'curl');
  if (downloader.checkAria2()) {
    assert.equal(downloader.resolveEngine('aria2'), 'aria2');
    assert.equal(downloader.resolveEngine('auto'), 'aria2');
  } else {
    assert.equal(downloader.resolveEngine('auto'), 'curl', '没有 aria2c 时 auto 应回退 curl');
    assert.throws(() => downloader.resolveEngine('aria2'), /aria2c/);
  }
});

// ---------------------------------------------------------------------------
// Content dedup
// 内容去重
// ---------------------------------------------------------------------------

test('dedup: remember / findSource / materialize(hardlink) / 持久化', async () => {
  const dir = tempDir('dedup');
  const config = { dataDir: dir };
  const content = Buffer.from('identical-bytes\n'.repeat(100));
  const sha = crypto.createHash('sha256').update(content).digest('hex').toUpperCase();

  const src = path.join(dir, 'src.bin');
  fs.writeFileSync(src, content);

  const index = createDedupIndex(config);
  index.remember(src, sha, content.length);
  assert.equal(index.save(), true);

  const reloaded = loadIndex(config);
  assert.ok(reloaded.entries[sha], '索引应持久化');
  assert.equal(reloaded.entries[sha].files[0], src);

  const index2 = createDedupIndex(config);
  const found = await index2.findSource(sha, content.length, path.join(dir, 'other.bin'));
  assert.equal(found, src);

  const target = path.join(dir, 'linked.bin');
  const how = index2.materialize(found, target, 'hardlink');
  assert.equal(how, 'hardlink');
  assert.deepEqual(fs.readFileSync(target), content);
  if (process.platform !== 'win32' || true) {
    const st = fs.statSync(target);
    assert.ok(st.nlink >= 1);
  }
  fs.rmSync(target);
});

test('dedup: copy 模式与哈希不符/文件消失时的处理', async () => {
  const dir = tempDir('dedup2');
  const config = { dataDir: dir };
  const content = Buffer.from('abc'.repeat(1000));
  const sha = crypto.createHash('sha256').update(content).digest('hex').toUpperCase();
  const src = path.join(dir, 'src.bin');
  fs.writeFileSync(src, content);

  const index = createDedupIndex(config);
  index.remember(src, sha, content.length);

  const target = path.join(dir, 'copy.bin');
  assert.equal(index.materialize(src, target, 'copy'), 'copy');
  assert.deepEqual(fs.readFileSync(target), content);

  // Content replaced → entries in the index can no longer be trusted
  // 内容被替换 → 索引里的条目不能再被信任
  fs.writeFileSync(src, Buffer.from('different'));
  assert.equal(await index.findSource(sha, content.length, 'x'), null, '哈希不符应拒绝');

  // File gone → skip
  // 文件消失 → 跳过
  fs.rmSync(src);
  assert.equal(await index.findSource(sha, content.length, 'x'), null);
});

test('dedup: 目标自身被排除，且索引文件损坏时按空处理', async () => {
  const dir = tempDir('dedup3');
  const config = { dataDir: dir };
  const content = Buffer.from('zzz');
  const sha = crypto.createHash('sha256').update(content).digest('hex').toUpperCase();
  const src = path.join(dir, 'a.bin');
  fs.writeFileSync(src, content);

  const index = createDedupIndex(config);
  index.remember(src, sha, content.length);
  assert.equal(await index.findSource(sha, content.length, src), null, '不应把目标自身当来源');

  fs.writeFileSync(indexPath(config), '{ broken', 'utf8');
  const broken = loadIndex(config);
  assert.deepEqual(broken.entries, {});
});

// ---------------------------------------------------------------------------
// Notifications
// 通知
// ---------------------------------------------------------------------------

test('notify: 负载与摘要文案', () => {
  const payload = notify.buildPayload({
    collectionId: 777,
    done: 3,
    skipped: 1,
    failed: 2,
    metaFailed: 1,
    cancelled: false,
    totalBytes: 1024,
    outDir: 'D:/models',
    elapsedMs: 5000,
  });
  assert.equal(payload.event, 'download-finished');
  assert.equal(payload.collectionId, '777');
  assert.equal(payload.done, 3);
  assert.equal(payload.failed, 2);
  assert.equal(payload.bytes, 1024);
  assert.ok(!Number.isNaN(Date.parse(payload.at)));

  assert.match(notify.describe({ done: 1, skipped: 2, failed: 0 }), /完成 1/);
  assert.match(notify.describe({ cancelled: true, done: 1, skipped: 0, failed: 0 }), /已取消/);
  assert.equal(notify.describe(null), '任务结束');
});

test('notify: toastCommand 依平台返回可用命令', () => {
  const spec = notify.toastCommand('标题', '内容');
  assert.ok(spec && typeof spec.cmd === 'string' && Array.isArray(spec.args));
  if (process.platform === 'win32') {
    assert.equal(spec.cmd, 'powershell.exe');
    assert.ok(spec.env.CIVITAI_TOAST_TITLE === '标题', '标题应通过环境变量传递，避免引号问题');
  } else if (process.platform === 'darwin') {
    assert.equal(spec.cmd, 'osascript');
  } else {
    assert.equal(spec.cmd, 'notify-send');
  }
});

test('notify: Webhook 发送成功与失败', async (t) => {
  const received = [];
  const server = http.createServer((req, res) => {
    let body = '';
    req.on('data', (c) => {
      body += c.toString('utf8');
    });
    req.on('end', () => {
      received.push({ method: req.method, body });
      res.writeHead(200);
      res.end('ok');
    });
  });
  await new Promise((r) => server.listen(0, '127.0.0.1', r));
  t.after(
    () =>
      new Promise((r) => {
        if (typeof server.closeAllConnections === 'function') server.closeAllConnections();
        server.close(r);
      })
  );
  const { port } = server.address();

  const ok = await notify.sendWebhook(`http://127.0.0.1:${port}/hook`, { hello: 'world' });
  assert.equal(ok.ok, true);
  assert.equal(received.length, 1);
  assert.equal(received[0].method, 'POST');
  assert.deepEqual(JSON.parse(received[0].body), { hello: 'world' });

  const bad = await notify.sendWebhook('http://127.0.0.1:1/hook', { hello: 'x' });
  assert.equal(bad.ok, false);
  assert.ok(bad.error);

  const none = await notify.sendWebhook('', {});
  assert.equal(none.ok, false);
});

test('notify: notifyFinished 在未启用时不发通知', async () => {
  const result = await notify.notifyFinished({ notifyWebhook: '', notifyToast: false }, { done: 1 });
  assert.equal(result.toast, false);
  assert.equal(result.webhook, null);
});
