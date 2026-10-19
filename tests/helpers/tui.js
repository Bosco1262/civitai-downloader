'use strict';

/**
 * Shared fake terminal for TUI tests.
 *
 * The app shell owns stdout, stdin and raw mode, so a test that exercises it needs all three replaced
 * for the duration of one test. Keeping the replacement here means every TUI test starts from the same
 * state and restores it the same way; a leaked fake terminal would make the next test file fail.
 *
 *
 * TUI 测试共用的假终端。
 *
 * 应用外壳会接管 stdout、stdin 与原始模式，因此演练它的测试需要在这一个测试期间替换三者。
 * 集中在这里意味着每个 TUI 测试都从同一状态开始、以同一方式还原；泄漏的假终端会让下一个测试文件失败。
 */

const { EventEmitter } = require('events');
const screen = require('../../src/tui/screen');

/**
 * ANSI escape sequence used by the tests when a painted frame must be inspected as plain text.
 * 测试把绘制帧当纯文本检查时使用的 ANSI 转义序列。
 */
const ANSI = /\u001b\[[0-9;?]*[a-zA-Z]/g;

/**
 * Strip every ANSI escape sequence from one string.
 * 去掉字符串里的所有 ANSI 转义序列。
 *
 * @param {string} text
 * @returns {string}
 */
function stripAnsi(text) {
  return String(text === undefined || text === null ? '' : text).replace(ANSI, '');
}

/**
 * Install a fake terminal for the duration of `fn`, then restore everything.
 *
 * The callback receives `{ frames, frame, key, settle, stdin }`: `frames` keeps every raw write,
 * `frame()` returns the latest painted frame as plain text, `key()` emits one keypress, `settle()`
 * lets the shell's scheduled repaint run, and `stdin` is the fake TTY itself.
 *
 *
 * 在 `fn` 执行期间安装假终端，结束后全部还原。
 *
 * 回调收到 `{ frames, frame, key, settle, stdin }`：`frames` 保留每次原始写入，
 * `frame()` 返回最新一帧的纯文本，`key()` 发出一次按键，`settle()` 让外壳排队的重绘跑完，
 * `stdin` 则是假 TTY 本身。
 *
 * @param {(ctx:{frames:string[],frame:()=>string[],key:(name:string,text?:string,ctrl?:boolean)=>void,settle:()=>Promise<void>,stdin:EventEmitter})=>Promise<any>} fn
 * @param {{columns?:number, rows?:number}} [opts]
 * @returns {Promise<any>}
 */
async function withFakeTerminal(fn, opts = {}) {
  const frames = [];
  const original = {
    write: process.stdout.write,
    isTTY: process.stdout.isTTY,
    columns: process.stdout.columns,
    rows: process.stdout.rows,
    stdin: process.stdin,
    cp: process.env.CIVITAI_CONSOLE_CP,
    ascii: process.env.CIVITAI_ASCII,
    plain: process.env.CIVITAI_PLAIN,
  };
  const stdin = new EventEmitter();
  stdin.isTTY = true;
  stdin.isRaw = false;
  stdin.setRawMode = (value) => {
    stdin.isRaw = !!value;
  };
  stdin.resume = () => {};
  stdin.pause = () => {};
  stdin.setEncoding = () => {};

  process.stdout.isTTY = true;
  process.stdout.columns = opts.columns || 100;
  process.stdout.rows = opts.rows || 30;
  process.stdout.write = (chunk) => {
    frames.push(String(chunk));
    return true;
  };
  Object.defineProperty(process, 'stdin', { value: stdin, configurable: true, writable: true });
  process.env.CIVITAI_CONSOLE_CP = '65001';
  delete process.env.CIVITAI_ASCII;
  delete process.env.CIVITAI_PLAIN;

  const frame = () => (frames[frames.length - 1] || '').split('\n').map((line) => line.replace(ANSI, ''));

  const key = (name, text, ctrl) =>
    stdin.emit('keypress', text === undefined ? '' : text, {
      name,
      ctrl: !!ctrl,
      meta: false,
      shift: false,
    });

  const settle = () => new Promise((resolve) => setImmediate(resolve));

  try {
    return await fn({ frames, frame, key, settle, stdin });
  } finally {
    screen.stop();
    screen.resetState();
    process.stdout.write = original.write;
    process.stdout.isTTY = original.isTTY;
    process.stdout.columns = original.columns;
    process.stdout.rows = original.rows;
    Object.defineProperty(process, 'stdin', { value: original.stdin, configurable: true, writable: true });
    if (original.cp === undefined) delete process.env.CIVITAI_CONSOLE_CP;
    else process.env.CIVITAI_CONSOLE_CP = original.cp;
    if (original.ascii === undefined) delete process.env.CIVITAI_ASCII;
    else process.env.CIVITAI_ASCII = original.ascii;
    if (original.plain === undefined) delete process.env.CIVITAI_PLAIN;
    else process.env.CIVITAI_PLAIN = original.plain;
  }
}

module.exports = {
  ANSI,
  stripAnsi,
  withFakeTerminal,
};
