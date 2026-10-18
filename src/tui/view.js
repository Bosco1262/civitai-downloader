'use strict';

const readline = require('readline');
const { spawn } = require('child_process');
const { ts, formatDuration, truncate } = require('../util');
const { t } = require('../i18n');

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
};

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
 * 供原始键盘模式（下载中）复用的取消入口
 */
function triggerCancel() {
  if (cancelHandler) {
    cancelHandler();
    return;
  }
  console.log('');
  console.log(t('tui.view.goodbye'));
  process.exit(130);
}

function onSigint() {
  triggerCancel();
}

process.on('SIGINT', onSigint);

function progressBar(pct, width) {
  const w = Math.max(4, width);
  const clamped = Math.max(0, Math.min(100, Number.isFinite(pct) ? pct : 0));
  const filled = Math.round((clamped / 100) * w);
  const bar = '█'.repeat(filled) + '░'.repeat(w - filled);
  return useColor ? `\u001b[36m${bar}\u001b[0m` : bar;
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
  formatDuration,
  displayWidth,
  openDir,
  bell,
  setCancelHandler,
  triggerCancel,
  colors,
  isTTY,
};
