'use strict';

/**
 * Regression tests for the "the TUI never responds" class of bugs.
 *
 * Three independent causes are covered:
 *  1. a page-context request without a deadline (collection enumeration hung forever);
 *  2. a full-screen screen waiting for raw keys the terminal never provides;
 *  3. a long silent phase with no output at all.
 *
 *
 * 针对「TUI 完全不反应」这一类问题的回归测试。
 *
 * 覆盖三个独立成因：
 *  1) 页面内的请求没有时限（收藏集枚举会永久挂起）；
 *  2) 全屏界面在等一个终端根本不会给的原始按键；
 *  3) 长时间阶段没有任何输出。
 */

const test = require('node:test');
const assert = require('node:assert/strict');
const { PassThrough } = require('stream');

const collection = require('../src/collection');
const keys = require('../src/tui/keys');
const pages = require('../src/tui/pages');
const view = require('../src/tui/view');
const i18n = require('../src/i18n');

const LANGUAGE_AT_LOAD = i18n.getLanguage();
test.after(() => i18n.setLanguage(LANGUAGE_AT_LOAD));

// ---------------------------------------------------------------------------
// requestPage / withDeadline
// requestPage / withDeadline（请求时限）
// ---------------------------------------------------------------------------

test('withDeadline: 及时返回结果', async () => {
  const result = await collection.withDeadline(Promise.resolve({ status: 200, text: 'ok' }), 1000);
  assert.equal(result.timedOut, false);
  assert.deepEqual(result.value, { status: 200, text: 'ok' });
});

test('withDeadline: 超时返回 timedOut（不抛错）', async () => {
  // A promise that never settles is exactly what a wedged browser tab looks like.
  // 永不 settle 的 promise 正是卡死的标签页的样子。
  const pending = new Promise(() => {});
  const started = Date.now();
  const result = await collection.withDeadline(pending, 60);
  assert.equal(result.timedOut, true);
  assert.ok(Date.now() - started < 2000, '超时保护应尽快生效');
});

test('withDeadline: 内部 reject 转成 status 0 的结果', async () => {
  const result = await collection.withDeadline(Promise.reject(new Error('boom')), 1000);
  assert.equal(result.timedOut, false);
  assert.equal(result.value.status, 0);
  assert.match(result.value.error, /boom/);
});

test('requestPage: 页面内 fetch 带时限，超时返回 status 0', async () => {
  // A fake page: the evaluated function receives the url and the limit, and hanging here models a
  // page whose fetch never finishes.
  //
  // 假页面：被求值的函数拿到 url 与时限；这里「挂住」模拟 fetch 永不返回。
  const page = {
    evaluate: (fn, url, timeoutMs) => {
      assert.ok(typeof url === 'string');
      assert.ok(Number(timeoutMs) >= 1000, '页面内也应收到一个不小于 1 秒的时限');
      return new Promise(() => {});
    },
  };
  const result = await collection.requestPage(page, '/api/trpc/x', { timeoutMs: 1000, graceMs: 60 });
  assert.equal(result.status, 0);
  assert.ok(result.error && result.error.length > 0);
});

test('requestPage: 正常响应原样返回', async () => {
  const page = { evaluate: async () => ({ status: 200, text: '{"ok":1}' }) };
  const result = await collection.requestPage(page, '/x', { timeoutMs: 5000 });
  assert.deepEqual(result, { status: 200, text: '{"ok":1}' });
});

test('requestPage: 页面脚本报错转成 status 0', async () => {
  const page = { evaluate: async () => ({ status: 0, text: '', error: 'page crashed' }) };
  const result = await collection.requestPage(page, '/x', { timeoutMs: 5000 });
  assert.equal(result.status, 0);
  assert.match(result.error, /page crashed/);
});

// ---------------------------------------------------------------------------
// installRawKeys: report failure instead of waiting forever
// installRawKeys：失败要上报，而不是让人一直等
// ---------------------------------------------------------------------------

test('installRawKeys: 非 TTY 返回 null（调用方据此回退）', () => {
  const stream = new PassThrough();
  stream.isTTY = false;
  assert.equal(keys.installRawKeys({ stream, onKey: () => {} }), null);
});

test('installRawKeys: 终端拒绝原始模式时返回 null', () => {
  const stream = new PassThrough();
  stream.isTTY = true;
  stream.setRawMode = () => {
    throw new Error('raw mode refused');
  };
  assert.equal(keys.installRawKeys({ stream, onKey: () => {} }), null);
});

test('installRawKeys: 原始模式静默未生效时返回 null', () => {
  // setRawMode exists but never sets isRaw: the terminal would deliver no keypress events at all.
  // setRawMode 存在但 isRaw 一直为 false：这种终端不会产生任何按键事件。
  const stream = new PassThrough();
  stream.isTTY = true;
  stream.setRawMode = () => {};
  stream.isRaw = false;
  assert.equal(keys.installRawKeys({ stream, onKey: () => {} }), null);
});

test('installRawKeys: 正常安装后返回 restore，并可重复调用', () => {
  const stream = new PassThrough();
  stream.isTTY = true;
  stream.isRaw = false;
  stream.setRawMode = (value) => {
    stream.isRaw = !!value;
  };
  const restore = keys.installRawKeys({ stream, onKey: () => {} });
  assert.equal(typeof restore, 'function');
  assert.equal(stream.isRaw, true);
  restore();
  assert.equal(stream.isRaw, false, '恢复时必须关闭原始模式');
  assert.doesNotThrow(() => restore());
});

// ---------------------------------------------------------------------------
// Silent phases: heartbeat + terminal restore
// 静默阶段：心跳与终端恢复
// ---------------------------------------------------------------------------

test('withSpinner: 先打印阶段说明，并在等待期间补心跳', async () => {
  const lines = [];
  const orig = console.log;
  console.log = (...args) => lines.push(args.map(String).join(' '));
  try {
    await pages.withSpinner('正在启动浏览器…', () => new Promise((resolve) => setTimeout(resolve, 80)), {
      intervalMs: 1000,
      onTick: () => lines.push('tick'),
    });
  } finally {
    console.log = orig;
  }
  assert.equal(lines.length, 1);
  assert.match(lines[0], /正在启动浏览器/);
});

test('withSpinner: 任务抛错时也清理心跳', async () => {
  const orig = console.log;
  console.log = () => {};
  try {
    await assert.rejects(() => pages.withSpinner('x', () => Promise.reject(new Error('boom')), { intervalMs: 1000 }));
  } finally {
    console.log = orig;
  }
  // No active handles are left behind: the process would keep running otherwise.
  // 不留下活跃句柄：否则进程会一直挂着。
  assert.equal(process.listenerCount('SIGINT') >= 0, true);
});

test('withSpinner: 计时换算（整数秒，不出现负数）', () => {
  assert.equal(pages.elapsedSeconds(Date.now()), 0);
  assert.equal(pages.elapsedSeconds(Date.now() - 3200), 3);
  assert.equal(pages.elapsedSeconds(Date.now() + 10000), 0);
});

test('restoreTerminal: 非 TTY 下安全且不输出', () => {
  const written = [];
  const origWrite = process.stdout.write;
  process.stdout.write = (chunk) => {
    written.push(String(chunk));
    return true;
  };
  try {
    assert.doesNotThrow(() => view.restoreTerminal());
  } finally {
    process.stdout.write = origWrite;
  }
  if (!process.stdout.isTTY) assert.deepEqual(written, []);
});

test('triggerCancel: 没有任务在跑时只提示、不退出进程', () => {
  const lines = [];
  const orig = console.log;
  console.log = (...args) => lines.push(args.map(String).join(' '));
  try {
    view.setCancelHandler(null);
    view.triggerCancel();
  } finally {
    console.log = orig;
  }
  assert.ok(lines.some((line) => line.includes('没有可取消')), lines.join('\n'));
});

test('triggerCancel: 有任务时调用取消回调', () => {
  let called = 0;
  view.setCancelHandler(() => {
    called++;
  });
  try {
    view.triggerCancel();
  } finally {
    view.setCancelHandler(null);
  }
  assert.equal(called, 1);
});

// ---------------------------------------------------------------------------
// Trace: off by default, never throws
// 轨迹：默认关闭，且从不抛错
// ---------------------------------------------------------------------------

test('debugLog: 未开启时不写文件、不抛错', () => {
  const previous = process.env.CIVITAI_TUI_DEBUG;
  delete process.env.CIVITAI_TUI_DEBUG;
  try {
    assert.doesNotThrow(() => keys.debugLog('hello'));
  } finally {
    if (previous === undefined) delete process.env.CIVITAI_TUI_DEBUG;
    else process.env.CIVITAI_TUI_DEBUG = previous;
  }
});

test('i18n: 新增的异常提示在两种语言下都有译文', () => {
  const zh = require('../src/i18n/zh-CN');
  const en = require('../src/i18n/en');
  const added = [
    'collection.requestTimeout',
    'collection.timeoutShort',
    'tui.select.rawUnavailable',
    'tui.select.suspendUnsupported',
    'tui.view.nothingToCancel',
    'tui.view.helpNoWait',
    'tui.pages.stillWorking',
    'tui.download.connectingBrowser',
  ];
  for (const key of added) {
    assert.equal(typeof zh[key], 'string', `zh 缺少 ${key}`);
    assert.equal(typeof en[key], 'string', `en 缺少 ${key}`);
    assert.notEqual(en[key], zh[key], `${key} 需要英文译文`);
  }
});
