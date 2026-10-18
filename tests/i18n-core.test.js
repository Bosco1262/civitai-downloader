'use strict';

/**
 * Core-module i18n regression tests.
 *
 * Three things matter here:
 *  1. under the default language (zh-CN) the errors/logs really raised by the core modules match the
 *     pre-extraction wording word for word;
 *  2. after switching to en those messages really become English and non-empty, while technical terms
 *     (curl / aria2c / SHA256 / ETag / tRPC / Webhook / Chrome / Cookie / HTTP status codes) stay as is;
 *  3. placeholders (retry counts, file names, paths…) really get substituted and both catalogs share one key set.
 *
 * Note: this file switches language temporarily, so it must restore it in try/finally (run-tests.js runs
 * every test file in order within the same process).
 *
 *
 * 核心模块 i18n 回归测试。
 *
 * 关注三件事：
 *  1. 默认语言（zh-CN）下，从各核心模块真实抛出的错误/日志与抽取前逐字一致；
 *  2. 切到 en 后这些文案确实变成英文、非空，且技术名词（curl / aria2c / SHA256 /
 *     ETag / tRPC / Webhook / Chrome / Cookie / HTTP 状态码）保留原样；
 *  3. 占位符（重试次数、文件名、路径…）确实被替换，语言包键集合一致。
 *
 * 注意：本文件会临时切换语言，必须用 try/finally 恢复（run-tests.js 在同一进程里
 * 顺序执行全部测试文件）。
 */

const test = require('node:test');
const assert = require('node:assert/strict');
const fs = require('fs');
const os = require('os');
const path = require('path');

const i18n = require('../src/i18n');
const zh = require('../src/i18n/zh-CN');
const en = require('../src/i18n/en');
const util = require('../src/util');
const config = require('../src/config');
const storage = require('../src/storage');
const notify = require('../src/notify');
const downloader = require('../src/downloader');
const updater = require('../src/updater');
const browser = require('../src/browser');
const { AppError, DownloadError, NotFoundError, StateCorruptError, ConfigError } = require('../src/errors');

/**
 * CJK characters and full-width punctuation: used to tell whether a message is Chinese.
 * 中日韩文字与全角标点：用来判断文案是否为中文
 */
const CJK = /[\u3000-\u303f\u3400-\u4dbf\u4e00-\u9fff\uf900-\ufaff\uff00-\uffef]/;
/**
 * Module prefixes covered by this extraction.
 * 本次抽取涉及的模块前缀
 */
const CORE_PREFIX = /^(util|notify|config|browser|collection|api|storage|downloader|job|updater)\./;
/**
 * Language at catalog load time, used to confirm this file does not leak language state to other test files.
 * 语言包加载时的语言，用于确认本文件没有把语言状态泄漏给其它测试文件
 */
const LANGUAGE_AT_LOAD = i18n.getLanguage();

/**
 * Keys added by this change (relative to the earlier cli/login/list/download/check/verify/doctor/pin/runtime batch).
 * 本次新增的键（相对 cli/login/list/download/check/verify/doctor/pin/runtime 那批）
 */
const CORE_KEYS = Object.keys(zh).filter((key) => CORE_PREFIX.test(key));
/**
 * Keys whose English and Chinese text is identical (pure technical formats); every other key must be really translated.
 * 中英文本就相同（纯技术格式）的键，其余键必须真正翻译过
 */
const SAME_IN_BOTH = new Set([
  'updater.updatedLine',
  'updater.renamePair',
  'updater.fileChangedLine',
  'updater.missingLine',
  'updater.legacyLine',
  'updater.failedLine',
  'updater.removedLine',
  'updater.corruptLine',
  'updater.modelIdLabel',
]);

function tempDir(tag) {
  return fs.mkdtempSync(path.join(os.tmpdir(), `civitai-i18nc-${tag}-`));
}

function withLanguage(lang, fn) {
  const prev = i18n.getLanguage();
  i18n.setLanguage(lang);
  try {
    return fn();
  } finally {
    i18n.setLanguage(prev);
  }
}

async function withLanguageAsync(lang, fn) {
  const prev = i18n.getLanguage();
  i18n.setLanguage(lang);
  try {
    return await fn();
  } finally {
    i18n.setLanguage(prev);
  }
}

function escapeRegExp(text) {
  return String(text).replace(/[.*+?^${}()|[\]\\]/g, '\\$&');
}

/**
 * Install a curl stub: run decides the return value of every call.
 * 安装 curl 桩：run 决定每次调用的返回值
 */
function installCurlStub(run) {
  const calls = [];
  downloader.setCurlImplementations({
    sleep: async () => {},
    head: async () => ({ ok: true, etag: '"remote-1"', length: 1024 }),
    runCurl: async (opts) => {
      calls.push(opts);
      return run(opts, calls.length);
    },
  });
  return calls;
}

function cleanupDownloader(t) {
  t.after(() => {
    downloader.resetCurlImplementations();
    downloader.resetCancel();
  });
}

/**
 * Options accepted by downloadFile.
 * 可被 downloadFile 接受的参数
 */
function downloadOpts(dir, extra = {}) {
  return {
    url: 'https://civitai.red/api/download/models/1?fileId=2',
    cookieFile: path.join(dir, 'cookies.txt'),
    dir,
    fileName: 'model.safetensors',
    userAgent: 'test-agent',
    quiet: true,
    attempts: 3,
    ...extra,
  };
}

// ---------------------------------------------------------------------------
// Catalog consistency
// 语言包一致性
// ---------------------------------------------------------------------------

test('i18n-core: 语言包键集合一致，en 无缺翻，核心模块键数量充足', () => {
  assert.deepEqual(i18n.missingKeys('en'), [], 'en 不允许缺翻');
  assert.deepEqual(Object.keys(en).sort(), Object.keys(zh).sort(), 'en 与 zh-CN 的键必须一一对应');
  assert.ok(CORE_KEYS.length >= 150, `核心模块文案键数量偏少：${CORE_KEYS.length}`);
  for (const key of CORE_KEYS) {
    assert.equal(typeof zh[key], 'string', `${key} 的 zh-CN 必须是字符串`);
    assert.ok(zh[key].length > 0, `${key} 的 zh-CN 不能为空`);
    assert.ok(en[key] !== undefined && en[key].length > 0, `${key} 在 en 中必须非空`);
  }
  assert.equal(i18n.getLanguage(), LANGUAGE_AT_LOAD, '本文件不应把语言状态泄漏出去');
});

test('i18n-core: en 的新键确实是英文，技术名词保留原样', () => {
  for (const key of CORE_KEYS) {
    assert.ok(!CJK.test(en[key]), `${key} 的 en 文案不应含中文：${en[key]}`);
    if (!SAME_IN_BOTH.has(key)) {
      assert.notEqual(en[key], zh[key], `${key} 的 en 文案应与 zh-CN 不同`);
    }
  }
  // Confirm the technical terms one by one
  // 技术名词逐个确认
  assert.ok(en['downloader.curlMissing'].includes('curl'));
  assert.ok(en['downloader.aria2Missing'].includes('aria2c'));
  assert.ok(en['downloader.shaMismatch'].includes('SHA256'));
  assert.ok(en['downloader.remoteChanged'].includes('ETag'));
  assert.ok(en['downloader.notFound404'].includes('HTTP 404'));
  assert.ok(en['api.rateLimited'].includes('HTTP 429'));
  assert.ok(en['collection.trpcBadJson'].includes('tRPC'));
  assert.ok(en['collection.trpcDevalueFailed'].includes('devalue'));
  assert.ok(en['notify.webhookFailed'].includes('Webhook'));
  assert.ok(en['browser.notFound'].includes('Chrome'));
  assert.ok(en['browser.portNoWsUrl'].includes('webSocketDebuggerUrl'));
  assert.ok(en['job.offlineNoCookies'].toLowerCase().includes('cookie'));
  assert.ok(en['job.modeHardlink'].includes('hardlink'));
});

// ---------------------------------------------------------------------------
// zh-CN verbatim regression (real code paths)
// zh-CN 逐字回归（真实代码路径）
// ---------------------------------------------------------------------------

test('i18n-core: zh-CN 回归 —— 未找到 curl 的提示逐字一致', () => {
  // Original pre-extraction text:
  // 原文：`未找到可用的 curl${detail}。请安装 curl（Windows 10/11 自带）或将其加入 PATH。`
  assert.equal(
    i18n.t('downloader.curlMissing', { detail: '' }),
    '未找到可用的 curl。请安装 curl（Windows 10/11 自带）或将其加入 PATH。'
  );
  assert.equal(
    i18n.t('downloader.curlMissing', {
      detail: i18n.t('downloader.curlLastError', { error: i18n.t('downloader.curlExitCode', { bin: 'curl', code: 1 }) }),
    }),
    '未找到可用的 curl（最后一次尝试：curl 退出码 1）。请安装 curl（Windows 10/11 自带）或将其加入 PATH。'
  );
  assert.match(i18n.t('downloader.curlMissing'), /curl/);
  assert.equal(i18n.t('downloader.curlExitCode', { bin: 'curl.exe', code: 9009 }), 'curl.exe 退出码 9009');
});

test('i18n-core: zh-CN 回归 —— 指定 engine=aria2 但缺少 aria2c（真实抛错）', async (t) => {
  cleanupDownloader(t);
  await withLanguageAsync('zh-CN', async () => {
    const expected = 'config.json 指定了 engine=aria2，但未找到 aria2c（请安装后加入 PATH，或改用 curl）';
    assert.equal(zh['downloader.aria2Missing'], expected);
    if (downloader.checkAria2()) {
      // aria2c is installed on this machine: take the happy path, the wording assertion above stands.
      // 本机装了 aria2c：走通分支，文案断言以上面为准
      assert.equal(downloader.resolveEngine('aria2'), 'aria2');
      return;
    }
    assert.throws(
      () => downloader.resolveEngine('aria2'),
      (e) => e instanceof DownloadError && e.message === expected
    );
  });
});

test('i18n-core: zh-CN 回归 —— 下载重试耗尽（真实 downloadFile）', async (t) => {
  cleanupDownloader(t);
  const dir = tempDir('exhaust');
  installCurlStub(() => ({ exitCode: 7, httpCode: 0, stderr: 'connection refused' }));

  await withLanguageAsync('zh-CN', async () => {
    await assert.rejects(
      () => downloader.downloadFile(downloadOpts(dir, { attempts: 3 })),
      (e) => {
        assert.ok(e instanceof DownloadError, '应为 DownloadError');
        assert.equal(e.message, '下载失败（已重试 3 次）: model.safetensors');
        assert.match(e.message, /重试 3 次/);
        assert.match(e.message, /model\.safetensors/, '文件名应出现在消息里');
        return true;
      }
    );
  });
});

test('i18n-core: zh-CN 回归 —— HTTP 404 下载失效（真实 downloadFile）', async (t) => {
  cleanupDownloader(t);
  const dir = tempDir('404');
  installCurlStub(() => ({ exitCode: 22, httpCode: 404, stderr: '' }));

  await withLanguageAsync('zh-CN', async () => {
    await assert.rejects(
      () => downloader.downloadFile(downloadOpts(dir, { attempts: 1 })),
      (e) => e instanceof NotFoundError && e.message === 'HTTP 404: 下载链接无效或文件已下架'
    );
  });
});

test('i18n-core: zh-CN 回归 —— 锁冲突提示逐字一致（真实 acquireLock）', async (t) => {
  const dir = tempDir('lock');
  const cfg = { dataDir: dir };
  const lockFile = path.join(dir, 'library.lock');
  fs.writeFileSync(lockFile, JSON.stringify({ pid: process.pid, startedAt: '2026-01-02T03:04:05.000Z' }), 'utf8');

  await withLanguageAsync('zh-CN', async () => {
    assert.throws(
      () => storage.acquireLock(cfg),
      (e) => {
        assert.ok(e instanceof AppError, '应为 AppError');
        assert.match(e.message, /另一个进程/);
        assert.equal(
          e.message,
          `另一个进程正在使用模型库（PID ${process.pid}，开始于 2026-01-02T03:04:05.000Z）。\n` +
            `若确认没有其它任务在运行，可加 --force 重试，或删除锁文件：${lockFile}`
        );
        return true;
      }
    );
    // Falls back to "unknown" when the start time is unknown
    // 未知开始时间时回落到「未知」
    fs.writeFileSync(lockFile, JSON.stringify({ pid: process.pid }), 'utf8');
    assert.throws(() => storage.acquireLock(cfg), /开始于 未知/);
    // Usable again after a forced takeover
    // force 抢占后可用
    const lock = storage.acquireLock(cfg, { force: true });
    assert.equal(typeof lock.release, 'function');
    lock.release();
    assert.ok(!fs.existsSync(lockFile));
  });
  t.after(() => fs.rmSync(dir, { recursive: true, force: true }));
});

test('i18n-core: zh-CN 回归 —— 模型库损坏提示逐字一致（真实 readLibrary）', async (t) => {
  const dir = tempDir('library');
  const cfg = { dataDir: dir };
  const file = path.join(dir, 'library.json');
  fs.writeFileSync(file, '   \n', 'utf8');

  await withLanguageAsync('zh-CN', async () => {
    assert.throws(
      () => storage.readLibrary(cfg),
      (e) => {
        assert.ok(e instanceof StateCorruptError, '应为 StateCorruptError');
        assert.match(
          e.message,
          new RegExp(
            `^文件无法解析（文件为空）：${escapeRegExp(file)}\\n` +
              `已备份为 ${escapeRegExp(file)}\\.corrupt-\\d+。` +
              '确认后删除该文件可重新开始记录（本地已下载文件不会被删除）。$'
          )
        );
        assert.ok(e.backupFile && fs.existsSync(e.backupFile), '应已备份损坏文件');
        return true;
      }
    );

    // Top level is not an object
    // 顶层不是对象
    fs.writeFileSync(file, '[1,2,3]', 'utf8');
    assert.throws(() => storage.readLibrary(cfg), /文件无法解析（顶层不是对象）：/);

    // allowCorrupt: an empty library plus the error object when the file is corrupt
    // allowCorrupt：损坏时返回空记录并带出错误对象
    const r = storage.readLibrary(cfg, { allowCorrupt: true });
    assert.deepEqual(r.entries, {});
    assert.ok(r.corrupt instanceof StateCorruptError);
  });
  t.after(() => fs.rmSync(dir, { recursive: true, force: true }));
});

test('i18n-core: zh-CN 回归 —— 下载日志行走文案表（416 / 续传）', async (t) => {
  cleanupDownloader(t);
  const dir = tempDir('log');
  installCurlStub(() => ({ exitCode: 0, httpCode: 416, stderr: '' }));
  const lines = [];
  util.setLogSink((m) => lines.push(String(m)));
  t.after(() => util.setLogSink(null));

  await withLanguageAsync('zh-CN', async () => {
    await assert.rejects(() => downloader.downloadFile(downloadOpts(dir, { attempts: 1 })));
    assert.equal(lines[0], '  服务端拒绝续传（HTTP 416），丢弃分片重新下载');
  });

  lines.length = 0;
  await withLanguageAsync('en', async () => {
    await assert.rejects(() => downloader.downloadFile(downloadOpts(dir, { attempts: 1 })));
    assert.ok(lines[0].length > 0, 'en 下日志不应为空');
    assert.ok(!CJK.test(lines[0]), `en 下日志不应含中文：${lines[0]}`);
    assert.match(lines[0], /HTTP 416/);
  });
});

test('i18n-core: zh-CN 回归 —— 通知摘要 / 时长 / 配置校验逐字一致', async () => {
  assert.equal(notify.describe(null), '任务结束');
  assert.equal(notify.describe({ done: 1, skipped: 2, failed: 0 }), '完成 1，跳过 2，失败 0');
  assert.equal(
    notify.describe({ cancelled: true, done: 1, skipped: 0, failed: 0 }),
    '已取消：完成 1，跳过 0，失败 0'
  );

  assert.equal(util.formatDuration(30), '30 秒');
  assert.equal(util.formatDuration(90), '1 分 30 秒');
  assert.equal(util.formatDuration(3720), '1 时 2 分');
  assert.equal(util.formatDuration(-1), '--');

  await withLanguageAsync('zh-CN', async () => {
    const cfg = { ...config.DEFAULTS, myCustom: 1 };
    const warnings = [];
    config.validateConfig(cfg, { warnings });
    assert.equal(warnings[0], '未知配置项 "myCustom"（已忽略，请检查是否拼写错误）');

    assert.throws(
      () => config.validateConfig({ ...config.DEFAULTS, engine: 'wget' }),
      (e) => e instanceof ConfigError && e.message === 'config.json 中 engine 只能是 "curl"、"aria2" 或 "auto"'
    );
    assert.throws(
      () => config.validateConfig({ ...config.DEFAULTS, dedup: 'symlink' }),
      /config\.json 中 dedup 只能是 "off"、"hardlink" 或 "copy"/
    );
    assert.throws(
      () => config.validateConfig({ ...config.DEFAULTS, debugPort: 0 }),
      /config\.json 中 debugPort 必须是 1-65535 之间的整数（当前：0）/
    );
    assert.throws(
      () => config.validateConfig({ ...config.DEFAULTS, site: '' }),
      /config\.json 中 site 不能为空（需以 http\(s\):\/\/ 开头）/
    );
    assert.throws(
      () => config.validateConfig({ ...config.DEFAULTS, site: 'x' }),
      /config\.json 中 site 格式不正确：x（需以 http\(s\):\/\/ 开头）/
    );
    assert.throws(
      () => config.validateConfig({ ...config.DEFAULTS, notifyWebhook: 'ftp://x' }),
      /config\.json 中 notifyWebhook 格式不正确：ftp:\/\/x（如 https:\/\/example\.com\/hook）/
    );
  });
});

test('i18n-core: zh-CN 回归 —— 本地校验原因与检查报告逐字一致（真实函数）', async (t) => {
  const dir = tempDir('report');
  const cfg = { outDir: dir };
  // v3 layout: versions are recorded under each model
  // v3 结构：一个模型下按版本记录
  const prev = {
    name: 'Model A',
    versions: {
      1001: {
        versionName: 'v1',
        dirName: 'Model A',
        outDir: dir,
        files: [{ name: 'model-a.safetensors', bytes: 2048, sha256: 'AA' }],
        verifiedAt: '2026-01-01T00:00:00.000Z',
      },
    },
  };

  await withLanguageAsync('zh-CN', async () => {
    const local = await updater.checkLocalFiles(cfg, prev, {});
    assert.deepEqual(local.reasons, ['缺失 model-a.safetensors']);
    assert.deepEqual(local.missingFiles, ['model-a.safetensors']);
    assert.equal(local.perVersion.length, 1);
  });

  const report = {
    collectionId: '777',
    checkedAt: '2026-01-02T03:04:05.000Z',
    deepChecked: true,
    hasState: true,
    upToDate: [{ item: { name: 'Model U' }, prev }],
    upgraded: [],
    updated: [
      { item: { name: 'Model A', versionName: 'v2', versionId: 2001 }, prev: { versionName: 'v1', versionId: 1001 } },
    ],
    pinned: [
      {
        item: { name: 'Model P', versionName: 'v9', versionId: 9001 },
        prev: { versionName: 'v8' },
        pinnedVersionId: 8001,
        onlineVersionId: 9001,
      },
    ],
    fileChanged: [
      {
        item: { name: 'Model F' },
        diff: {
          changed: [{ online: { name: 'a.bin' } }],
          added: [{ name: 'b.bin' }],
          removed: [{ name: 'c.bin' }],
          renamed: [{ from: { name: 'd.bin' }, to: { name: 'e.bin' } }],
        },
      },
    ],
    missing: [{ item: { name: 'Model M' }, reasons: ['缺失 a.bin', '大小不符 b.bin'] }],
    legacy: [],
    failed: [],
    removed: [],
    notDownloaded: [{ modelId: 5 }],
    uncheckedChanges: false,
    stats: { total: 9, updated: 1, fileChanged: 1, missing: 1, notDownloaded: 1, pinned: 1 },
  };

  await withLanguageAsync('zh-CN', async () => {
    assert.deepEqual(updater.reportLines(report), [
      '检查完成：收藏集 777 @ 2026-01-02T03:04:05.000Z（深度校验）',
      '【有更新】1 项',
      '  ↑ Model A: v1 → v2',
      '【已固定版本（不随线上更新）】1 项',
      '  * Model P: 固定 v8，线上已是 v9',
      '【文件变化（同版本重传）】1 项',
      '  ~ Model F: 内容变化: a.bin；新增: b.bin；移除: c.bin；改名: d.bin→e.bin',
      '【本地缺失/损坏】1 项',
      '  ! Model M: 缺失 a.bin；大小不符 b.bin',
      '【收藏集中未下载】1 项（需要下载请在下载流程中勾选）',
      '统计：共 9 项（有更新 1，文件变化 1，缺失 1，未下载 1，固定版本 1）',
    ]);
  });

  // The "file changes not checked" hint of quick mode, plus the "legacy records" section hint
  // 快速模式下「文件变化未检查」的提示，以及「旧记录」段落的提示
  const quick = {
    ...report,
    deepChecked: false,
    fileChanged: [],
    pinned: [],
    uncheckedChanges: true,
    stats: null,
    legacy: [{ item: { name: 'Model L' } }],
  };
  await withLanguageAsync('zh-CN', async () => {
    assert.deepEqual(updater.reportLines(quick), [
      '检查完成：收藏集 777 @ 2026-01-02T03:04:05.000Z（快速检查）',
      '【有更新】1 项',
      '  ↑ Model A: v1 → v2',
      '【文件变化】未检查（快速模式只比对版本号与本地文件大小；加 --verify-files 可检查同版本重传）',
      '【本地缺失/损坏】1 项',
      '  ! Model M: 缺失 a.bin；大小不符 b.bin',
      '【旧记录（无文件清单，未做本地校验）】1 项',
      '  ? Model L',
      '  提示: 用 --verify-files（TUI 中勾选深度校验）可校验本地文件并补齐清单',
      '【收藏集中未下载】1 项（需要下载请在下载流程中勾选）',
    ]);
  });

  t.after(() => fs.rmSync(dir, { recursive: true, force: true }));
});

// ---------------------------------------------------------------------------
// Genuinely English after switching to en
// 切到 en 后确实是英文
// ---------------------------------------------------------------------------

test('i18n-core: en —— 下载重试耗尽与 404 都是英文且保留技术名词', async (t) => {
  cleanupDownloader(t);
  const dir = tempDir('en-dl');
  installCurlStub(() => ({ exitCode: 7, httpCode: 0, stderr: 'connection refused' }));

  await withLanguageAsync('en', async () => {
    await assert.rejects(
      () => downloader.downloadFile(downloadOpts(dir, { attempts: 2 })),
      (e) => {
        assert.ok(!CJK.test(e.message), `en 下不应残留中文：${e.message}`);
        assert.equal(e.message, 'Download failed (retried 2 times): model.safetensors');
        return true;
      }
    );
  });

  installCurlStub(() => ({ exitCode: 22, httpCode: 404, stderr: '' }));
  await withLanguageAsync('en', async () => {
    await assert.rejects(
      () => downloader.downloadFile(downloadOpts(dir, { attempts: 1 })),
      (e) => {
        assert.ok(e instanceof NotFoundError);
        assert.ok(!CJK.test(e.message), `en 下不应残留中文：${e.message}`);
        assert.ok(e.message.includes('HTTP 404'));
        return true;
      }
    );
  });
});

test('i18n-core: en —— 锁冲突与模型库损坏都是英文', async (t) => {
  const dir = tempDir('en-state');
  const cfg = { dataDir: dir };
  const lockFile = path.join(dir, 'library.lock');
  fs.writeFileSync(lockFile, JSON.stringify({ pid: process.pid, startedAt: '2026-01-02T03:04:05.000Z' }), 'utf8');

  await withLanguageAsync('en', async () => {
    assert.throws(
      () => storage.acquireLock(cfg),
      (e) => {
        assert.ok(!CJK.test(e.message), `en 下不应残留中文：${e.message}`);
        assert.ok(e.message.includes('PID'), '应保留 PID 字样');
        assert.ok(e.message.includes(String(process.pid)), '应插入具体 PID');
        assert.ok(e.message.includes('--force'));
        return true;
      }
    );
  });

  fs.writeFileSync(path.join(dir, 'library.json'), '   \n', 'utf8');
  await withLanguageAsync('en', async () => {
    assert.throws(
      () => storage.readLibrary(cfg),
      (e) => {
        assert.ok(!CJK.test(e.message), `en 下不应残留中文：${e.message}`);
        assert.ok(e.message.includes('library.json'));
        assert.ok(e.message.includes('Backed up as'), 'en 下应说明备份位置');
        return true;
      }
    );
  });

  t.after(() => fs.rmSync(dir, { recursive: true, force: true }));
});

test('i18n-core: en —— 检查报告与通知文案为英文，占位符仍被替换', async () => {
  await withLanguageAsync('en', async () => {
    const lines = updater.reportLines({
      collectionId: '777',
      checkedAt: '2026-01-02T03:04:05.000Z',
      deepChecked: false,
      hasState: false,
      upToDate: [],
      upgraded: [],
      updated: [],
      pinned: [],
      fileChanged: [],
      missing: [{ item: { name: 'Model M' }, reasons: [i18n.t('updater.missingFile', { file: 'a.bin' })] }],
      legacy: [],
      failed: [],
      removed: [],
      notDownloaded: [],
      uncheckedChanges: true,
      stats: null,
    });
    assert.equal(lines[0], 'Check finished: collection 777 @ 2026-01-02T03:04:05.000Z (quick check)');
    for (const line of lines) {
      assert.ok(line.length > 0, 'en 下不应有空行');
      assert.ok(!CJK.test(line), `en 下不应残留中文：${line}`);
    }
    assert.ok(lines.some((l) => l.includes('Model M') && l.includes('a.bin')), '占位符应被替换');
    assert.ok(lines.some((l) => l.includes('missing a.bin')), '原因文案应为英文');

    assert.equal(notify.describe(null), 'Job finished');
    assert.equal(notify.describe({ done: 1, skipped: 2, failed: 0 }), '1 done, 2 skipped, 0 failed');
    assert.ok(!CJK.test(notify.describe({ cancelled: true, done: 1, skipped: 0, failed: 3 })));
    assert.match(notify.describe({ cancelled: true, done: 1, skipped: 0, failed: 3 }), /Cancelled: 1 done/);
  });
});

test('i18n-core: en —— 浏览器与配置错误为英文（真实函数）', async (t) => {
  const dir = tempDir('en-browser');
  await withLanguageAsync('en', async () => {
    assert.throws(
      () => browser.findBrowserPath({ chromePath: path.join(dir, 'nope', 'chrome.exe') }),
      (e) => {
        assert.ok(e instanceof ConfigError);
        assert.ok(!CJK.test(e.message), `en 下不应残留中文：${e.message}`);
        assert.ok(e.message.includes('chromePath'));
        return true;
      }
    );

    // Probe a port that is guaranteed not to respond: both reason messages must be English
    // 探测一个必然无响应的端口：两种原因文案都必须是英文
    const probe = await browser.probeDebugPort(1);
    assert.equal(probe.info, null);
    assert.ok(
      probe.reason === i18n.t('browser.portNoResponse') || probe.reason === i18n.t('browser.connectTimeout'),
      `意外原因：${probe.reason}`
    );
    assert.ok(!CJK.test(probe.reason), `en 下不应残留中文：${probe.reason}`);

    assert.throws(
      () => config.validateConfig({ ...config.DEFAULTS, jobs: 99 }),
      (e) => {
        assert.ok(!CJK.test(e.message), `en 下不应残留中文：${e.message}`);
        assert.ok(e.message.includes('jobs'));
        return true;
      }
    );
  });
  t.after(() => fs.rmSync(dir, { recursive: true, force: true }));
});

// ---------------------------------------------------------------------------
// Placeholder substitution
// 占位符替换
// ---------------------------------------------------------------------------

test('i18n-core: 占位符确实被替换（数字、文件名、路径、URL）', async () => {
  await withLanguageAsync('zh-CN', async () => {
    assert.equal(
      i18n.t('downloader.failed', { attempts: 5, file: 'a.safetensors' }),
      '下载失败（已重试 5 次）: a.safetensors'
    );
    assert.equal(
      i18n.t('job.downloadLine', { index: 1, total: 3, name: 'Model A', file: 'a.bin', size: '1 KiB' }),
      '下载 [1/3] Model A / a.bin (1 KiB)'
    );
    assert.equal(i18n.t('notify.summary', { done: 1, skipped: 2, failed: 3 }), '完成 1，跳过 2，失败 3');
    assert.equal(
      i18n.t('storage.lockFailed', { file: 'D:/x/library.lock' }),
      '无法获取模型库的锁文件：D:/x/library.lock'
    );
    assert.equal(i18n.t('api.notFound', { url: 'https://civitai.red/api/v1/models/1' }), 'HTTP 404：https://civitai.red/api/v1/models/1');
    assert.equal(i18n.t('downloader.resuming', { size: '1 MiB', total: '2 MiB', attempt: 2, attempts: 5 }), '  已下载 1 MiB / 2 MiB，继续断点续传（第 2/5 次）');
    assert.equal(i18n.t('job.summary', { head: '=== 结束 ===', done: 1, skipped: 2, failed: 0, metaFailed: '', elapsed: '3 秒' }), '=== 结束 === 完成 1，跳过 2，失败 0（用时 3 秒）');
    assert.equal(i18n.t('job.summary', { head: '=== 结束 ===', done: 1, skipped: 2, failed: 0, metaFailed: '，元数据失败 4', elapsed: '3 秒' }), '=== 结束 === 完成 1，跳过 2，失败 0，元数据失败 4（用时 3 秒）');
    // Missing parameters leave the placeholder untouched (so an omitted value is easy to spot)
    // 未提供参数时保留占位符原样（便于发现漏传）
    assert.equal(i18n.t('storage.lockFailed', {}), '无法获取模型库的锁文件：{file}');
  });

  await withLanguageAsync('en', async () => {
    assert.equal(
      i18n.t('downloader.failed', { attempts: 5, file: 'a.safetensors' }),
      'Download failed (retried 5 times): a.safetensors'
    );
    assert.equal(i18n.t('notify.summary', { done: 1, skipped: 2, failed: 3 }), '1 done, 2 skipped, 3 failed');
    assert.equal(
      i18n.t('job.dedupEnabled', { mode: i18n.t('job.modeHardlink') }),
      'Content dedup enabled (hardlink)'
    );
  });
});

test('i18n-core: 语言状态在测试结束后恢复为默认', () => {
  assert.equal(i18n.getLanguage(), LANGUAGE_AT_LOAD, '本文件不应把语言状态泄漏给其它测试文件');
  assert.deepEqual(i18n.missingKeys('en'), [], 'en 不允许缺翻');
});
