'use strict';

// Shared terminal layout metrics of the TUI: terminal size, glyph set, ANSI escapes and the height
// of a "frame" (title + column header + footer + key-hint lines), so every full-screen screen can
// tell how many list rows are left.
//
// Why a module: the picker, the library browser and the help page all compute the same numbers;
// keeping them in one place avoids off-by-one layouts whenever a hint line is added.
//
//
// TUI 的公共布局参数：终端尺寸、字符集、ANSI 转义，以及「框架高度」
// （标题 + 列头 + 页脚 + 按键提示行），供各全屏界面推算还剩多少列表行。
//
// 独立成模块的原因：选择器、模型库浏览页、帮助页用的是同一套数字；
// 集中在一处，新增一行提示时不会各算各的导致错位。

const ANSI_CLEAR = '\u001b[2J\u001b[H';
/**
 * Switches to the alternate screen buffer (what less / vim / fzf use) and back: everything the
 * full-screen screens paint lands there and the terminal restores the previous content on exit, so
 * the menu, the fetched list and the log lines are still exactly where the user left them.
 *
 * 切换到备用屏幕缓冲区（less / vim / fzf 用的那套）并切回：全屏界面画的内容都落在备用缓冲区里，
 * 退出时终端会恢复之前的内容，因此菜单、已拉取的列表与日志行仍停留在用户离开时的位置。
 */
const ANSI_ALT_SCREEN_ON = '\u001b[?1049h';
const ANSI_ALT_SCREEN_OFF = '\u001b[?1049l';
/**
 * Erase the display only (no cursor move, no scrollback): used when restoring the alternate screen.
 * 只擦除显示内容（不移动光标、不动回滚缓冲）：恢复备用屏幕时使用。
 */
const ANSI_ERASE_DISPLAY = '\u001b[2J';
const ANSI_HIDE_CURSOR = '\u001b[?25l';
const ANSI_SHOW_CURSOR = '\u001b[?25h';

/**
 * Glyphs of the Unicode variant (default on modern terminals).
 * Unicode 变体的字符（现代终端的默认选择）。
 */
const GLYPHS_UNICODE = {
  cursor: '▸',
  checked: '[×]',
  unchecked: '[ ]',
  barFull: '█',
  barEmpty: '░',
  separator: ' · ',
  pipe: '｜',
  boxH: '─',
  boxV: '│',
};

/**
 * ASCII fallback for consoles that cannot render the glyphs above.
 * 无法显示上述字符的控制台使用的 ASCII 变体。
 */
const GLYPHS_ASCII = {
  cursor: '>',
  checked: '[x]',
  unchecked: '[ ]',
  barFull: '#',
  barEmpty: '-',
  separator: ' | ',
  pipe: '|',
  boxH: '-',
  boxV: '|',
};

/**
 * Code pages that can render CJK and box-drawing glyphs.
 * 能正常显示中日韩文字与制表字符的代码页。
 */
const UTF8_CODE_PAGES = new Set([65001, 936, 54936, 950, 932, 949]);

/**
 * Whether to fall back to ASCII: non-TTY output, an explicit opt-in (CIVITAI_ASCII), and Windows
 * consoles whose code page is not in the list above.
 *
 * 是否退回 ASCII：非 TTY 输出、显式开关（CIVITAI_ASCII），以及 Windows 上代码页不在上表中的控制台。
 */
function asciiGlyphs(env = process.env, platform = process.platform, isTTY = !!process.stdout.isTTY) {
  if (env.CIVITAI_ASCII) return true;
  if (!isTTY) return true;
  if (platform !== 'win32') return false;
  const page = Number(env.CIVITAI_CONSOLE_CP || 0);
  if (Number.isFinite(page) && page > 0) return !UTF8_CODE_PAGES.has(page);
  // Unknown code page: prefer the safe ASCII variant, a readable layout matters more than the symbols
  // 代码页未知：优先用安全的 ASCII，排版可读比字符好看更重要
  return true;
}

/**
 * Glyph set for the current process.
 * 当前进程使用的字符集。
 */
function glyphs() {
  return asciiGlyphs() ? GLYPHS_ASCII : GLYPHS_UNICODE;
}

/**
 * Terminal width in columns (at least 20; 100 when unknown).
 * 终端列数（至少 20；未知时按 100）。
 */
function terminalColumns(columns) {
  const value = Number.isFinite(columns) ? columns : process.stdout.columns || 100;
  return Math.max(20, Math.floor(value) || 0);
}

/**
 * The terminal is treated as at least this many rows tall, so the list keeps a few visible lines.
 * 终端最少按这么多行处理，保证列表始终有几行可见。
 */
const MIN_ROWS = 12;

/**
 * Terminal height in rows (at least MIN_ROWS; 30 when unknown).
 * 终端行数（至少 MIN_ROWS；未知时按 30）。
 */
function terminalRows(rows) {
  const value = Number.isFinite(rows) ? rows : process.stdout.rows || 30;
  return Math.max(MIN_ROWS, Math.floor(value) || 0);
}

/**
 * Rows occupied by the surrounding frame: title + subtitle + column header + footer, plus the
 * key-hint lines. `extra` covers one-off lines such as a warning banner.
 *
 * 框架占用的行数：标题 + 副标题 + 列头 + 页脚，外加按键提示行。
 * `extra` 用于警告横幅之类临时多出来的一行。
 */
function chromeRows({ hintLines = 3, extra = 0 } = {}) {
  const hints = Math.max(0, Math.floor(Number(hintLines) || 0));
  return 4 + hints + Math.max(0, Math.floor(Number(extra) || 0));
}

/**
 * Number of list rows that fit on screen.
 * 屏幕能容纳的列表行数。
 */
function listRows(opts = {}) {
  return Math.max(1, terminalRows(opts.rows) - chromeRows(opts));
}

/**
 * ANSI sequences available to the full-screen screens.
 * 全屏界面可用的 ANSI 序列。
 */
function ansi() {
  return {
    clear: ANSI_CLEAR,
    eraseDisplay: ANSI_ERASE_DISPLAY,
    altScreenOn: ANSI_ALT_SCREEN_ON,
    altScreenOff: ANSI_ALT_SCREEN_OFF,
    hideCursor: ANSI_HIDE_CURSOR,
    showCursor: ANSI_SHOW_CURSOR,
  };
}

module.exports = {
  ANSI_CLEAR,
  ANSI_ERASE_DISPLAY,
  ANSI_ALT_SCREEN_ON,
  ANSI_ALT_SCREEN_OFF,
  ANSI_HIDE_CURSOR,
  ANSI_SHOW_CURSOR,
  ansi,
  GLYPHS_UNICODE,
  GLYPHS_ASCII,
  MIN_ROWS,
  UTF8_CODE_PAGES,
  asciiGlyphs,
  glyphs,
  terminalColumns,
  terminalRows,
  chromeRows,
  listRows,
};
