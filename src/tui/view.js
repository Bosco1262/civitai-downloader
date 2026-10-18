'use strict';

const readline = require('readline');
const { spawn } = require('child_process');
const { ts, formatDuration, truncate } = require('../util');
const { t } = require('../i18n');
const glyphSet = require('./layout');

const isTTY = !!process.stdout.isTTY;
const useColor = isTTY && !process.env.NO_COLOR;

function paint(code) {
  return (s) => (useColor ? `\u001b[${code}m${s}\u001b[0m` : String(s));
}

const colors = {
  bold: paint('1'),
  dim: paint('2'),
  red: paint('31'),
  green: paint('32'),
  yellow: paint('33'),
  cyan: paint('36'),
  magenta: paint('35'),
  // Reverse video is a cursor highlight, not decoration: it stays on even with NO_COLOR, because a
  // full-screen list without it shows no cursor at all.
  //
  // 反显是光标高亮而不是装饰：即使 NO_COLOR 也保留，否则全屏列表根本看不出光标在哪。
  reverse: (s) => `\u001b[7m${s}\u001b[0m`,
};

/**
 * Glyph set of the current console (ASCII when it cannot render the box/cursor characters).
 * 当前控制台使用的字符集（画不出光标/制表字符时退回 ASCII）。
 */
function glyphs() {
  return glyphSet.glyphs();
}

/**
 * Enter the alternate screen buffer (the full-screen screens paint there, so the menu, the fetched
 * list and the log lines are restored untouched when they exit). No-op without a TTY.
 *
 * 进入备用屏幕缓冲区（全屏界面画在里面，退出时菜单、已拉取的列表与日志行原样恢复）。
 * 非 TTY 时不做任何事。
 */
function beginFullScreen() {
  if (!isTTY || process.env.CIVITAI_PLAIN) return false;
  try {
    process.stdout.write(`${glyphSet.ANSI_ALT_SCREEN_ON}${glyphSet.ANSI_CLEAR}`);
    return true;
  } catch (e) {
    return false;
  }
}

/**
 * Leave the alternate screen buffer, restoring whatever was on screen before.
 * 退出备用屏幕缓冲区，恢复进入前屏幕上的内容。
 */
function endFullScreen() {
  if (!isTTY || process.env.CIVITAI_PLAIN) return;
  try {
    process.stdout.write(glyphSet.ANSI_ALT_SCREEN_OFF);
  } catch (e) {
    // Ignore failures when the terminal is gone.
    // 终端已消失时忽略。
  }
}

/**
 * Decision line printed after a full-screen screen closes.
 *
 * Full-screen screens run in the alternate buffer, so this short line is the only trace they leave:
 * it confirms what happened and reminds the user that the list output is not lost. Without a TTY the
 * plain prompt path is used and nothing is echoed (the prompt library prints its own answer).
 *
 *
 * 全屏界面关闭后打印的决定回显行。
 *
 * 全屏界面跑在备用缓冲区里，这一行是它留下的唯一痕迹：确认刚才做了什么，
 * 并提醒用户列表输出并没有丢。非 TTY 时走的是简易提问路径，不回显（prompts 自己会打印答案）。
 *
 * @param {string} messageKey e.g. `tui.view.decisionPicked`
 * @param {Record<string, any>} [params]
 */
function decision(messageKey, params) {
  if (!isTTY || process.env.CIVITAI_PLAIN) return;
  console.log(`${colors.cyan(cursorMark(true))} ${t(messageKey, params)}`);
}

/**
 * Row cursor marker, blank for the rows that are not selected.
 * 行首的光标标记，非当前行为空格。
 */
function cursorMark(on) {
  return on ? glyphs().cursor : ' ';
}

/**
 * Checkbox text of a list row.
 * 列表行的勾选框文本。
 */
function checkbox(checked) {
  const g = glyphs();
  return checked ? g.checked : g.unchecked;
}

/**
 * Column separator, downgraded together with the other glyphs.
 * 列分隔符，随其它字符一起降级。
 */
function separator() {
  return glyphs().separator;
}

let statusRenderer = null;
let statusRows = 0;

/**
 * Number of terminal columns the string occupies (ANSI escapes are not counted; CJK
 * double-width characters count as 2 columns).
 *
 * 字符串在终端里占用的列数（ANSI 转义不计；CJK 等宽字符算 2 列）
 */
function displayWidth(s) {
  let w = 0;
  for (const ch of s.replace(/\u001b\[[0-9;]*m/g, '')) {
    w += ch.codePointAt(0) >= 0x2e80 ? 2 : 1;
  }
  return w;
}

function countRows(text) {
  const cols = Math.max(20, process.stdout.columns || 120);
  let rows = 0;
  for (const line of String(text).split('\n')) {
    rows += Math.max(1, Math.ceil(displayWidth(line) / cols));
  }
  return rows;
}

function clearStatus() {
  if (!statusRenderer || !isTTY || statusRows === 0) return;
  readline.moveCursor(process.stdout, 0, -statusRows);
  readline.cursorTo(process.stdout, 0);
  readline.clearScreenDown(process.stdout);
  statusRows = 0;
}

function drawStatus() {
  if (!statusRenderer) return;
  const text = String(statusRenderer());
  process.stdout.write(text + '\n');
  statusRows = countRows(text);
}

function redrawStatus() {
  if (!statusRenderer) return;
  clearStatus();
  drawStatus();
}

function log(msg) {
  const line = `[${ts()}] ${msg}`;
  if (statusRenderer) {
    clearStatus();
    console.log(line);
    drawStatus();
  } else {
    console.log(line);
  }
}

function beginStatus(fn) {
  statusRenderer = fn;
  drawStatus();
}

function endStatus() {
  if (!statusRenderer) return;
  clearStatus();
  statusRenderer = null;
}

let cancelHandler = null;

function setCancelHandler(fn) {
  cancelHandler = fn;
}

/**
 * Cancel entry point reused by the raw keyboard mode (during downloads).
 *
 * When a job registered a cancel handler it runs that; otherwise the key is acknowledged and the
 * process is left alone (a stray Ctrl+C must never kill the app while nothing is running — the
 * app-level handler decides whether a second press should quit).
 *
 *
 * 供原始键盘模式（下载中）复用的取消入口。
 *
 * 有任务注册了取消回调就调用它；否则只提示一下，不动进程
 * （没有任务运行时按到 Ctrl+C 不应该直接退出程序，是否退出由应用层判断）。
 */
function triggerCancel() {
  if (cancelHandler) {
    cancelHandler();
    return;
  }
  console.log('');
  console.log(t('tui.view.nothingToCancel'));
}

/**
 * Put the terminal back into a usable state: cursor visible, alternate screen buffer left, raw mode
 * off. Safe to call any number of times, and also wired to process exit so that an abrupt
 * `process.exit()` (Ctrl+C during a long phase, an uncaught error) cannot strand the terminal in raw
 * mode — which looks exactly like "the TUI stopped responding".
 *
 * 把终端恢复成可用状态：显示光标、退出备用缓冲区、关闭原始模式。
 * 可重复调用，并且挂在进程退出上：意外的 `process.exit()`（长时间阶段里按 Ctrl+C、未捕获异常）
 * 不会把终端留在原始模式——那看起来就像「TUI 完全不反应」。
 */
function restoreTerminal() {
  if (!isTTY) return;
  try {
    process.stdout.write(`${glyphSet.ANSI_SHOW_CURSOR}${glyphSet.ANSI_ALT_SCREEN_OFF}`);
  } catch (e) {
    // The terminal may already be gone.
    // 终端可能已经没了。
  }
  if (process.stdin && typeof process.stdin.setRawMode === 'function' && process.stdin.isTTY) {
    try {
      process.stdin.setRawMode(false);
    } catch (e) {
      // Ignore failures when the terminal is gone.
      // 终端已消失时忽略。
    }
  }
}

// Registered once: every exit path (normal, Ctrl+C, uncaught error) restores the terminal.
// 只注册一次：所有退出路径（正常、Ctrl+C、未捕获异常）都会恢复终端。
process.once('exit', restoreTerminal);

/**
 * Progress bar text (filled / empty glyphs follow the console capability).
 * 进度条文本（实心/空心字符随控制台能力降级）。
 */
function progressBar(pct, width) {
  const w = Math.max(4, width);
  const clamped = Math.max(0, Math.min(100, Number.isFinite(pct) ? pct : 0));
  const filled = Math.round((clamped / 100) * w);
  const g = glyphs();
  const bar = g.barFull.repeat(filled) + g.barEmpty.repeat(w - filled);
  return useColor ? `\u001b[36m${bar}\u001b[0m` : bar;
}

/**
 * Cut text to a display width, appending an ellipsis when something was dropped.
 * Unlike util.truncate this counts CJK characters as two columns.
 *
 * 按显示宽度裁剪文本，被截断时补省略号。
 * 与 util.truncate 的区别：CJK 字符按 2 列计算。
 */
function truncateTo(text, width) {
  const s = String(text === undefined || text === null ? '' : text);
  const w = Math.floor(Number(width));
  if (!Number.isFinite(w) || w <= 0) return '';
  if (displayWidth(s) <= w) return s;
  if (w === 1) return '…';
  let out = '';
  let used = 0;
  for (const ch of s) {
    const cw = displayWidth(ch);
    if (used + cw > w - 1) break;
    out += ch;
    used += cw;
  }
  return `${out}…`;
}

/**
 * Pad text to a display width (never truncates).
 * 把文本补齐到指定显示宽度（不截断）。
 */
function padTo(text, width) {
  const s = String(text === undefined || text === null ? '' : text);
  const w = displayWidth(s);
  return w >= width ? s : s + ' '.repeat(width - w);
}

/**
 * Screen width used by the panels (clamped to a readable range).
 * 面板使用的屏幕宽度（夹在可读区间内）。
 */
function screenColumns() {
  return Math.max(60, Math.min(process.stdout.columns || 100, 200));
}

/**
 * Screen height used by the panels.
 * 面板使用的屏幕高度。
 */
function screenRows() {
  return Math.max(glyphSet.MIN_ROWS, process.stdout.rows || 30);
}

/**
 * Erase the current line (used by transient "working…" indicators).
 * 擦除当前行（临时「正在处理…」提示用）。
 */
function clearLine() {
  if (!isTTY) return;
  try {
    readline.clearLine(process.stdout, 0);
    readline.cursorTo(process.stdout, 0);
  } catch (e) {
    // Ignore failures when the terminal is gone.
    // 终端已消失时忽略。
  }
}

/**
 * Ring the bell when finished (disable with NO_BELL=1).
 * 完成后响铃提醒（可用 NO_BELL=1 关闭）
 */
function bell() {
  if (process.env.NO_BELL) return;
  try {
    process.stdout.write('\u0007');
  } catch (e) {
    // Ignore write failures.
    // 写入失败时忽略。
  }
}

function openDir(dir) {
  const cmd = process.platform === 'win32' ? 'explorer.exe' : process.platform === 'darwin' ? 'open' : 'xdg-open';
  try {
    spawn(cmd, [dir], { detached: true, stdio: 'ignore' }).unref();
    return true;
  } catch (e) {
    return false;
  }
}

module.exports = {
  log,
  beginStatus,
  endStatus,
  redrawStatus,
  progressBar,
  truncate,
  truncateTo,
  padTo,
  formatDuration,
  displayWidth,
  screenColumns,
  screenRows,
  glyphs,
  cursorMark,
  checkbox,
  separator,
  clearLine,
  decision,
  beginFullScreen,
  endFullScreen,
  openDir,
  bell,
  setCancelHandler,
  triggerCancel,
  restoreTerminal,
  colors,
  isTTY,
};
