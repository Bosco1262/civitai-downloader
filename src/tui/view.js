'use strict';

// Output helpers of the TUI.
//
// Every line the flows print goes through here, which is what makes the app shell possible: while the
// shell owns the terminal these helpers append to its log pane instead of writing to the console, so
// a stray `console.log` can never break the frame. Outside the shell (no TTY, CI, CIVITAI_PLAIN) they
// keep printing plainly, which is what the tests and redirected runs expect.
//
//
// TUI 的输出辅助。
//
// 各流程打印的每一行都经过这里，这正是应用外壳得以成立的原因：外壳接管终端时，
// 这些辅助会把内容追加到外壳的日志区，而不是直接写控制台，因此一句漏网的 `console.log`
// 也不会破坏界面。外壳未启用时（非 TTY、CI、CIVITAI_PLAIN）它们照旧直接打印，
// 这也是测试与重定向运行所期望的行为。

const readline = require('readline');
const { spawn } = require('child_process');
const { ts, formatDuration, truncate } = require('../util');
const { t } = require('../i18n');
const layout = require('./layout');
const screen = require('./screen');

const isTTY = !!process.stdout.isTTY;

const colors = layout.colors;

/**
 * Glyph set of the current console (ASCII when it cannot render the box/cursor characters).
 * 当前控制台使用的字符集（画不出光标/制表字符时退回 ASCII）。
 */
function glyphs() {
  return layout.glyphs();
}

/**
 * Enter the alternate screen buffer (the full-screen screens paint there, so the menu, the fetched
 * list and the log lines are restored untouched when they exit). No-op without a TTY.
 *
 * 进入备用屏幕缓冲区（全屏界面画在里面，退出时菜单、已拉取的列表与日志行原样恢复）。
 * 非 TTY 时不做任何事。
 */
function beginFullScreen() {
  if (!isTTY || process.env.CIVITAI_PLAIN || screen.isActive()) return false;
  try {
    process.stdout.write(`${layout.ANSI_ALT_SCREEN_ON}${layout.ANSI_CLEAR}`);
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
  if (!isTTY || process.env.CIVITAI_PLAIN || screen.isActive()) return;
  try {
    process.stdout.write(layout.ANSI_ALT_SCREEN_OFF);
  } catch (e) {
    // Ignore failures when the terminal is gone.
    // 终端已消失时忽略。
  }
}

/**
 * Decision line printed after a full-screen screen closes.
 *
 * Under the shell it becomes a transient notice inside the frame; without one it is echoed to the
 * console (the plain prompt path prints its own answer there).
 *
 *
 * 全屏界面关闭后打印的决定回显行。
 *
 * 外壳接管时它变成框架内的临时提示；没有外壳时回显到控制台（简易提问路径自己会打印答案）。
 *
 * @param {string} messageKey e.g. `tui.view.decisionPicked`
 * @param {Record<string, any>} [params]
 */
function decision(messageKey, params) {
  const text = t(messageKey, params);
  if (screen.isActive()) {
    screen.notice(text, colors.cyan);
    return;
  }
  if (!isTTY || process.env.CIVITAI_PLAIN) return;
  console.log(`${colors.cyan(cursorMark(true))} ${text}`);
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

const displayWidth = layout.displayWidth;
const truncateTo = layout.truncateTo;
const padTo = layout.padTo;

let statusRenderer = null;
let statusRows = 0;

/**
 * Number of rows a block of text occupies on screen.
 * 一段文本在屏幕上占用的行数。
 */
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

/**
 * Repaint the live status block. With the shell active the block lives in the info panel, so this
 * only asks for a repaint.
 *
 * 重绘实时状态块。外壳接管时该内容由信息面板承担，这里只请求一次重绘。
 */
function redrawStatus() {
  if (screen.isActive()) {
    screen.refresh();
    return;
  }
  if (!statusRenderer) return;
  clearStatus();
  drawStatus();
}

/**
 * Append one timestamped line to the session log (the shell's log pane when active).
 * 往会话日志追加一行带时间戳的文本（外壳接管时写入其日志区）。
 */
function log(msg) {
  const text = String(msg);
  if (screen.isActive()) {
    for (const line of text.split('\n')) screen.logLine(`[${ts()}] ${line}`);
    return;
  }
  const line = `[${ts()}] ${text}`;
  if (statusRenderer) {
    clearStatus();
    console.log(line);
    drawStatus();
  } else {
    console.log(line);
  }
}

/**
 * Append one line without a timestamp: used for pre-formatted blocks (tables, reports) that are
 * already laid out.
 *
 * 追加一行不带时间戳的文本：用于已经排版好的区块（表格、报告）。
 */
function note(msg) {
  const text = String(msg);
  if (screen.isActive()) {
    for (const line of text.split('\n')) screen.logLine(line);
    return;
  }
  if (statusRenderer) {
    clearStatus();
    console.log(text);
    drawStatus();
  } else {
    console.log(text);
  }
}

/**
 * Live status block of the legacy (non-shell) full-screen path.
 * 传统（无外壳）全屏路径的实时状态块。
 */
function beginStatus(fn) {
  if (screen.isActive()) return;
  statusRenderer = fn;
  drawStatus();
}

function endStatus() {
  if (!statusRenderer) return;
  clearStatus();
  statusRenderer = null;
}

let cancelHandler = null;

/**
 * Register the handler that cancels the running task; Esc uses it while a task is running.
 * 登记取消当前任务的回调；有任务运行时 Esc 会调用它。
 */
function setCancelHandler(fn) {
  cancelHandler = typeof fn === 'function' ? fn : null;
  // The shell asks this handler first when Esc is pressed, so a running job wins over "leave screen".
  // 按下 Esc 时外壳先问这个回调，因此运行中的任务优先于「离开界面」。
  screen.setEscapeHandler(
    cancelHandler
      ? () => {
          cancelHandler();
          return true;
        }
      : null
  );
}

function hasCancelHandler() {
  return typeof cancelHandler === 'function';
}

/**
 * Cancel entry point shared by Esc and the task view.
 *
 * When a job registered a cancel handler it runs that; otherwise the key is acknowledged and the
 * process is left alone.
 *
 *
 * Esc 与任务视图共用的取消入口。
 *
 * 有任务注册了取消回调就调用它；否则只提示一下，不动进程。
 */
function triggerCancel() {
  if (cancelHandler) {
    cancelHandler();
    return;
  }
  note(t('tui.view.nothingToCancel'));
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
    process.stdout.write(`${layout.ANSI_SHOW_CURSOR}${layout.ANSI_ALT_SCREEN_OFF}`);
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
  return screen.progressBar(pct, width);
}

/**
 * Screen width used by the panels (clamped to a readable range). With the shell active this is the
 * width available *inside* the frame, so nested screens line up with the frame.
 *
 * 面板使用的屏幕宽度（夹在可读区间内）。外壳接管时返回框架内部的可用宽度，
 * 使嵌套界面与框架对齐。
 */
function screenColumns() {
  if (screen.isActive()) return screen.bodyGeometry().width;
  return Math.max(60, Math.min(process.stdout.columns || 100, 200));
}

/**
 * Screen height used by the panels (body rows when the shell is active).
 * 面板使用的屏幕高度（外壳接管时为框架主体的行数）。
 */
function screenRows() {
  if (screen.isActive()) return screen.bodyGeometry().bodyRows;
  return Math.max(layout.MIN_ROWS, process.stdout.rows || 30);
}

/**
 * Erase the current line (used by transient "working…" indicators).
 * 擦除当前行（临时「正在处理…」提示用）。
 */
function clearLine() {
  if (!isTTY || screen.isActive()) return;
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

/**
 * Run something that prints with `console.log` while the shell owns the screen.
 *
 * Command modules (the environment check, for example) were written for the CLI and print directly;
 * under the shell those lines would land on top of the frame. This routes them into the log pane for
 * the duration of the call and restores `console.log` afterwards.
 *
 *
 * 在外壳接管屏幕时运行「用 `console.log` 打印」的代码。
 *
 * 命令模块（例如环境体检）是为命令行写的，会直接打印；在外壳里这些行会盖在框架上。
 * 这里在调用期间把它们导入日志区，结束后恢复 `console.log`。
 *
 * @template T
 * @param {() => T|Promise<T>} fn
 * @returns {Promise<T>}
 */
async function captureOutput(fn) {
  if (!screen.isActive()) return fn();
  const original = console.log;
  console.log = (...args) => note(args.map((arg) => String(arg)).join(' '));
  try {
    return await fn();
  } finally {
    console.log = original;
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
  note,
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
  captureOutput,
  openDir,
  bell,
  setCancelHandler,
  hasCancelHandler,
  triggerCancel,
  restoreTerminal,
  colors,
  isTTY,
};
