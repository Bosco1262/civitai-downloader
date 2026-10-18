'use strict';

/**
 * Full-screen interactive item picker.
 *
 * Two layers: the pure logic has no terminal side effects and is unit-testable (filterItems,
 * sortItems, scrollWindow, toggleSelection, selectAll, invertSelection, clampCursor, layoutColumns,
 * buildRowText, renderListLines, buildHeaderLines, hintLines …), and the interactive layer
 * selectItems() drives raw keyboard mode plus the ANSI full-screen redraw and returns null outside a
 * TTY so the caller can fall back to the plain prompt path.
 *
 * 全屏交互式条目选择器。
 *
 * 分两层：纯逻辑层没有终端副作用、可直接单测（filterItems、sortItems、scrollWindow、
 * toggleSelection、selectAll、invertSelection、clampCursor、layoutColumns、buildRowText、
 * renderListLines、buildHeaderLines、hintLines 等）；交互层 selectItems() 负责原始键盘模式与
 * ANSI 全屏重绘，非 TTY 直接返回 null，由调用方回退到 prompts 老路径。
 * 列表以「跟随光标的视窗」滚动（光标不会再跑到绘制区域之外），
 * 页脚只描述当前状态下真正可用的按键，`?` 打开界面内按键速查。 */

const { formatBytes } = require('../util');
const { t } = require('../i18n');
const view = require('./view');
const layout = require('./layout');
const { installRawKeys, debugLog, isTextInput, isBackspace } = require('./keys');

// ---------------------------------------------------------------------------
// Constants
// 常量
// ---------------------------------------------------------------------------

const NO_FILTER = '__all__';
const MIN_NAME_WIDTH = 6;
/**
 * Fixed rows besides the list: title + filter line + summary line + footer.
 * 除列表外的固定行数：标题 + 过滤行 + 汇总行 + 页脚。
 */
const CHROME_ROWS = 4;
/**
 * Key-hint lines drawn under the footer.
 * 页脚下方绘制的按键提示行数。
 */
const HINT_ROWS = 3;
/**
 * Treat the terminal as at least this many rows (so the list still has a few lines to show).
 * 终端最少按这么多行处理（保证列表至少还有几行可显示）。
 */
const MIN_ROWS = layout.MIN_ROWS;

/**
 * Sort labels. Lazily resolved (getters): the language may be switched by configureRuntime /
 * the settings menu after require, so a module-level constant must not freeze the text at load time.
 * The shape stays a plain object: Object.keys() and SORT_LABELS[mode] keep working as before.
 *
 * 排序标签。惰性取词（getter）：语言可能在 require 之后被 configureRuntime /
 * 设置菜单切换，模块级常量不能在加载时就把文案定死。
 * 形状仍是普通对象：Object.keys()、SORT_LABELS[mode] 的用法不变。
 */
const SORT_LABEL_KEYS = {
  default: 'tui.select.sortDefault',
  name: 'tui.select.sortName',
  size: 'tui.select.sortSizeDesc',
  'size-asc': 'tui.select.sortSizeAsc',
};
const SORT_LABELS = {};
for (const [mode, key] of Object.entries(SORT_LABEL_KEYS)) {
  Object.defineProperty(SORT_LABELS, mode, { get: () => t(key), enumerable: true });
}
const SORT_MODES = Object.keys(SORT_LABELS);

/**
 * Footer key hints, one line per group (CJK counts as two columns, so three lines fit an 80-column
 * terminal). Keys: ↑/↓ or k/j to move, Home/End for first/last, PgUp/PgDn or [ ] to page,
 * space to toggle, a to select/deselect all, i to invert, / to search, t for type, b for base model,
 * s to sort, Enter to confirm, Esc/q/Ctrl+C to cancel, ? for help.
 * Also lazily resolved (getters), so iteration and index access stay unchanged.
 *
 * 底部按键说明，每组一行（CJK 按 2 列算，三行即可在 80 列终端完整显示）。
 * 键位：↑/↓ 或 k/j 移动，Home/End 首尾，PgUp/PgDn 或 [ ] 翻页，
 *       空格勾选，a 全选/全不选，i 反选，/ 搜索，t 类型，b 基础模型，s 排序，
 *       回车确认，Esc/q/Ctrl+C 取消，? 帮助。
 * 同样是惰性取词（getter），遍历/下标访问方式不变。
 */
const KEY_HINT_KEYS = ['tui.select.keyHintMove', 'tui.select.keyHintSelect', 'tui.select.keyHintAction'];
const KEY_HINTS = KEY_HINT_KEYS.map(() => '');
KEY_HINT_KEYS.forEach((key, index) => {
  Object.defineProperty(KEY_HINTS, index, { get: () => t(KEY_HINT_KEYS[index]), enumerable: true });
});

/**
 * Hint lines shown while the search box is open.
 * 搜索输入状态下的按键提示行。
 */
const SEARCH_HINT_KEYS = ['tui.select.searchHintTyping', 'tui.select.searchHintKeys'];
const SEARCH_HINTS = SEARCH_HINT_KEYS.map(() => '');
SEARCH_HINT_KEYS.forEach((key, index) => {
  Object.defineProperty(SEARCH_HINTS, index, { get: () => t(SEARCH_HINT_KEYS[index]), enumerable: true });
});

/**
 * Hint lines shown while the help overlay (`?`) is open.
 * 帮助浮层（`?`）打开时的按键提示行。
 */
const HELP_HINT_KEYS = ['tui.select.helpClose', 'tui.select.helpPage', 'tui.select.helpCancel'];
const HELP_HINTS = HELP_HINT_KEYS.map(() => '');
HELP_HINT_KEYS.forEach((key, index) => {
  Object.defineProperty(HELP_HINTS, index, { get: () => t(key), enumerable: true });
});

/**
 * Key reference of the in-screen help overlay (`?`).
 * 界面内帮助浮层（`?`）的按键速查。
 */
const HELP_KEYS = [
  'tui.select.helpMove',
  'tui.select.helpPage',
  'tui.select.helpToggle',
  'tui.select.helpAll',
  'tui.select.helpSearch',
  'tui.select.helpFilter',
  'tui.select.helpSort',
  'tui.select.helpQuick',
  'tui.select.helpConfirm',
  'tui.select.helpCancel',
];
const HELP_ITEMS = HELP_KEYS.map(() => '');
HELP_KEYS.forEach((key, index) => {
  Object.defineProperty(HELP_ITEMS, index, { get: () => t(HELP_KEYS[index]), enumerable: true });
});

// ---------------------------------------------------------------------------
// Small helpers (pure functions)
// 小工具（纯函数）
// ---------------------------------------------------------------------------

function str(value) {
  return value === undefined || value === null ? '' : String(value);
}

/**
 * Row identity: `modelId` when the item has one, otherwise `id`.
 * `opts.idOf` overrides both (used by pickers whose rows are not model records).
 *
 * 行的标识：条目有 `modelId` 就用它，否则用 `id`。
 * `opts.idOf` 可覆盖两者（供并非模型记录的列表使用）。
 */
function idOf(item, opts = {}) {
  if (typeof opts.idOf === 'function') return String(opts.idOf(item));
  if (item && item.modelId !== undefined && item.modelId !== null) return String(item.modelId);
  return String(item && item.id);
}

/**
 * Row label: `name`, otherwise `title`, otherwise `opts.label(item)`.
 * 行的名称：优先 `name`，其次 `title`，最后 `opts.label(item)`。
 */
function nameOf(item, opts = {}) {
  if (!item) return '';
  if (item.name !== undefined && item.name !== null && String(item.name) !== '') return String(item.name);
  if (item.title !== undefined && item.title !== null && String(item.title) !== '') return String(item.title);
  if (typeof opts.label === 'function') return str(opts.label(item));
  return '';
}

/**
 * The last resort label of a row (its id), used when the item carries neither name nor title.
 * 行的兜底名称（用 ID），条目既没有 name 也没有 title 时使用。
 */
function fallbackLabel(item, opts = {}) {
  return `#${idOf(item, opts)}`;
}

/**
 * Item size; missing / null / invalid values all count as 0 (used by sorting and totals).
 * 条目体积；缺失 / null / 非法值一律按 0（排序与合计用）
 */
function bytesOf(item) {
  const raw = item ? item.totalBytes : undefined;
  if (raw === undefined || raw === null || raw === '') return 0;
  const n = Number(raw);
  return Number.isFinite(n) && n > 0 ? n : 0;
}

function isAll(value) {
  return value === undefined || value === null || value === '' || value === NO_FILTER;
}

/**
 * Index of a number key (1-9 → 0-8), or null when the key is not a digit shortcut.
 * 数字快捷键的下标（1-9 → 0-8）；不是数字键时返回 null。
 */
function quickIndex(text) {
  const char = str(text);
  if (char.length !== 1) return null;
  const code = char.charCodeAt(0);
  if (code < 0x31 || code > 0x39) return null;
  return code - 0x31;
}

/**
 * For stable sorting: carry the original index into the comparator so equal items keep their order.
 * 稳定排序用：把原始下标带进比较函数，保证同值项相对顺序不变
 */
function withIndex(items) {
  return items.map((item, index) => ({ item, index }));
}

/**
 * Take the head by display width (CJK counts as 2 columns; never split a wide char); append "…" when too wide.
 * 按显示宽度取开头（CJK 算 2 列；放不下就不塞半个宽字符），超宽时以“…”收尾
 */
function clipToWidth(text, width) {
  const s = str(text);
  const w = Math.floor(Number(width));
  if (!Number.isFinite(w) || w <= 0) return '';
  if (displayWidth(s) <= w) return s;
  const body = clipPiece(s, w - 1);
  return `${body}${body.length < s.length ? '…' : ''}`;
}

/**
 * Clip from the start by display width (no ellipsis).
 * 从开头按显示宽度截取（不加省略号）
 */
function clipPiece(s, width) {
  if (width <= 0) return '';
  let out = '';
  let used = 0;
  for (const ch of str(s)) {
    const w = displayWidth(ch);
    if (used + w > width) break;
    out += ch;
    used += w;
  }
  return out;
}

/**
 * Take the tail by display width (keep the end and prepend an ellipsis when too wide).
 * 按显示宽度取结尾（超宽时保留尾部，前面加省略号）
 */
function clipTailToWidth(text, width) {
  const s = str(text);
  if (width <= 0) return '';
  if (displayWidth(s) <= width) return s;
  return `…${clipEnd(s, width - 1)}`;
}

/**
 * Truncate by display width (CJK counts as 2 columns), ending with "…" when cut; the result never exceeds width.
 * util.truncate cannot be used directly: it counts code points, so CJK names overflow the available columns and wrap.
 *
 * 按显示宽度截断（CJK 算 2 列），截断时以“…”收尾，结果宽度一定不超过 width。
 * 不能直接用 util.truncate：那个按码点计数，中文名会超出可用列数导致折行错位。
 */
function clipDisplay(text, width) {
  const s = str(text);
  const w = Math.floor(Number(width));
  if (!Number.isFinite(w) || w <= 0) return '';
  if (displayWidth(s) <= w) return s;
  if (w === 1) return '…';
  return `${clipPiece(s, w - 1)}…`;
}

function clipEnd(s, width) {
  if (width <= 0) return '';
  const chars = Array.from(str(s));
  let out = '';
  let used = 0;
  for (let i = chars.length - 1; i >= 0; i--) {
    const w = displayWidth(chars[i]);
    if (used + w > width) break;
    out = chars[i] + out;
    used += w;
  }
  return out;
}

function padToWidth(text, width) {
  const s = str(text);
  const w = displayWidth(s);
  return w >= width ? s : s + ' '.repeat(width - w);
}

/**
 * Display width of one cell: ANSI escapes are not counted and CJK characters count as 2 columns.
 * 单元格显示宽度：不计 ANSI 转义，CJK 字符算 2 列。
 */
function displayWidth(s) {
  return view.displayWidth(s);
}

// ---------------------------------------------------------------------------
// Pure logic: filtering / sorting / scrolling / selection set / cursor
// 纯逻辑层：过滤 / 排序 / 滚动 / 选择集合 / 光标
// ---------------------------------------------------------------------------

/**
 * Keyword / type / base-model filtering.
 * keyword matches both name (case-insensitive) and String(modelId);
 * type / baseModel being null / undefined / '' / '__all__' means no filtering.
 *
 * 关键字 / 类型 / 基础模型过滤。
 * keyword 同时匹配 name（不区分大小写）与 String(modelId)；
 * type / baseModel 为 null / undefined / '' / '__all__' 表示不过滤。
 * @param {Array<{name?:string, modelId?:string|number, type?:string, baseModel?:string}>} items
 * @param {{keyword?:string, type?:string|null, baseModel?:string|null}} [filter]
 * @returns {Array} 新数组（元素仍是原对象）
 */
function filterItems(items, filter = {}) {
  const list = Array.isArray(items) ? items : [];
  const keyword = str(filter.keyword).trim().toLowerCase();
  const type = filter.type;
  const baseModel = filter.baseModel;

  return list.filter((item) => {
    if (!item) return false;
    if (keyword) {
      const haystack = `${nameOf(item, filter)}\u0000${idOf(item, filter)}`.toLowerCase();
      if (!haystack.includes(keyword)) return false;
    }
    if (!isAll(type) && str(item.type) !== str(type)) return false;
    if (!isAll(baseModel) && str(item.baseModel) !== str(baseModel)) return false;
    return true;
  });
}

/**
 * Stable sort. 'size' is largest first, 'size-asc' smallest first, by totalBytes (missing counts as 0).
 * 排序（稳定）。'size' 从大到小，'size-asc' 从小到大，按 totalBytes（缺失按 0）。
 * @param {Array} items
 * @param {'default'|'name'|'size'|'size-asc'} [mode]
 * @returns {Array} 新数组
 */
function sortItems(items, mode = 'default', opts = {}) {
  const list = Array.isArray(items) ? items.slice() : [];
  if (mode === 'name') {
    return withIndex(list)
      .sort(
        (a, b) =>
          nameOf(a.item, opts).localeCompare(nameOf(b.item, opts), 'zh-Hans-CN') || a.index - b.index
      )
      .map((entry) => entry.item);
  }
  if (mode === 'size' || mode === 'size-asc') {
    const dir = mode === 'size' ? -1 : 1;
    return withIndex(list)
      .sort((a, b) => {
        const diff = bytesOf(a.item) - bytesOf(b.item);
        return diff !== 0 ? diff * dir : a.index - b.index;
      })
      .map((entry) => entry.item);
  }
  return list;
}

/**
 * Paging (page is 0-based and clamped when out of range).
 * Kept for callers that still page explicitly; the interactive layer scrolls a window instead.
 *
 * 分页（page 从 0 开始，越界夹紧）。
 * 仍显式分页的调用方继续可用；交互层已改为「视窗滚动」。
 * @returns {{pageItems:Array, pageCount:number, page:number}}
 */
function paginate(items, page = 0, pageSize = 15) {
  const list = Array.isArray(items) ? items : [];
  const total = list.length;
  const size = Math.max(1, Math.floor(Number(pageSize)) || 1);
  const pageCount = Math.max(1, Math.ceil(total / size));
  const n = Number(page);
  const wanted = Number.isFinite(n) ? Math.floor(n) : 0;
  const current = Math.min(Math.max(0, wanted), pageCount - 1);
  const start = current * size;
  return { pageItems: list.slice(start, start + size), pageCount, page: current };
}

/**
 * Compute the visible slice that keeps `cursor` on screen.
 *
 * Only scrolls when the cursor leaves the window, so the list stays still while the cursor moves
 * inside it instead of jumping a whole page. `size <= 0` means "fit everything".
 *
 *
 * 计算能让 `cursor` 保持在屏幕内的可见区间。
 *
 * 只有光标移出视窗时才滚动，因此光标在视窗内移动时列表不动，不会整页跳动。
 * `size <= 0` 表示「全部显示」。
 *
 *
 * @param {number} total number of rows
 * @param {number} cursor current row
 * @param {number} size how many rows fit
 * @param {number} [start] previously painted first row (keeps the window still when possible)
 * @returns {{start:number, end:number, size:number, cursor:number}}
 */
function scrollWindow(total, cursor, size, start = 0) {
  const count = Math.max(0, Math.floor(Number(total) || 0));
  if (count === 0) return { start: 0, end: 0, size: 0, cursor: 0 };
  const want = Math.floor(Number(size) || 0);
  const height = want > 0 ? Math.min(want, count) : count;
  const index = clampCursor(cursor, count);
  const previous = Math.min(Math.max(0, Math.floor(Number(start) || 0)), Math.max(0, count - height));
  let begin = previous;
  if (index < begin) begin = index;
  else if (index >= begin + height) begin = index - height + 1;
  begin = Math.min(Math.max(0, begin), Math.max(0, count - height));
  return { start: begin, end: begin + height, size: height, cursor: index };
}

/**
 * Toggle one item on/off and return a new Set (the input is not mutated); ids are compared as strings.
 * 勾选/取消单项，返回新 Set（不修改入参）；id 按字符串比较
 */
function toggleSelection(selected, id) {
  const next = new Set(selected || []);
  const key = String(id);
  if (next.has(key)) next.delete(key);
  else next.add(key);
  return next;
}

/**
 * Select all / none (only the given items); returns a new Set (the input is not mutated).
 * 全选 / 全不选（只针对传入的 items），返回新 Set（不修改入参）
 */
function selectAll(selected, items, value, opts = {}) {
  const next = new Set(selected || []);
  const list = Array.isArray(items) ? items : [];
  if (value) {
    for (const item of list) if (item) next.add(idOf(item, opts));
  } else {
    for (const item of list) if (item) next.delete(idOf(item, opts));
  }
  return next;
}

/**
 * Invert the selection (only the given items); returns a new Set (the input is not mutated).
 * 反选（只针对传入的 items），返回新 Set（不修改入参）
 */
function invertSelection(selected, items, opts = {}) {
  const next = new Set(selected || []);
  const list = Array.isArray(items) ? items : [];
  for (const item of list) {
    if (!item) continue;
    const id = idOf(item, opts);
    if (next.has(id)) next.delete(id);
    else next.add(id);
  }
  return next;
}

/**
 * Add / remove a contiguous range of ids (Shift+↑/↓), returns a new Set.
 * 选中/取消一段连续区间（Shift+↑/↓），返回新 Set。
 */
function rangeSelection(selected, items, from, to, value = true, opts = {}) {
  const list = Array.isArray(items) ? items : [];
  const a = clampCursor(Math.min(from, to), list.length);
  const b = clampCursor(Math.max(from, to), list.length);
  const next = new Set(selected || []);
  for (let i = a; i <= b; i++) {
    const item = list[i];
    if (!item) continue;
    const id = idOf(item, opts);
    if (value) next.add(id);
    else next.delete(id);
  }
  return next;
}

/**
 * Clamp the cursor into [0, length-1]; an empty list returns 0.
 * 把光标夹到 [0, length-1]；空列表返回 0
 */
function clampCursor(cursor, length) {
  const len = Math.max(0, Math.floor(Number(length)) || 0);
  if (len <= 0) return 0;
  const n = Number(cursor);
  const wanted = Number.isFinite(n) ? Math.floor(n) : 0;
  return Math.min(Math.max(0, wanted), len - 1);
}

/**
 * Put the cursor on an index of list and return the page that holds it (page-based helper kept for
 * backward compatibility; the interactive layer uses scrollWindow instead).
 *
 * 把光标放到 list 的某个下标，并返回该行所在的页（按页滚动的旧助手，保留兼容；
 * 交互层已改用 scrollWindow）。
 */
function ensureVisible(list, cursor, pageSize) {
  const length = Array.isArray(list) ? list.length : 0;
  const size = Math.max(1, Math.floor(Number(pageSize)) || 1);
  const idx = clampCursor(cursor, length);
  return { cursor: idx, page: Math.floor(idx / size) };
}

// ---------------------------------------------------------------------------
// Pure logic: row rendering
// 纯逻辑层：行渲染
// ---------------------------------------------------------------------------

/**
 * Default status text: downloaded / update available / pinned version.
 * 默认状态文案：已下载 / 版本有更新 / 已固定版本
 */
function describeStatus(item, state) {
  const prev = state && item ? state[item.modelId] : null;
  if (!prev) return '';
  const versions = prev.versions && typeof prev.versions === 'object' ? prev.versions : {};
  const recorded =
    item.versionId === undefined || item.versionId === null ? null : versions[String(item.versionId)];
  const parts = [];
  if (!item.versionId || recorded) {
    parts.push(t('tui.select.statusDownloaded'));
  } else {
    parts.push(t('tui.select.statusUpdated'));
  }
  if (prev.pinnedVersionId && String(prev.pinnedVersionId) === String(item.versionId)) {
    parts.push(t('tui.select.statusPinned'));
  }
  return parts.join(' ');
}

/**
 * Right-hand info of a row: describe(item, state) wins, otherwise "type · base model · status".
 * 行右侧信息：describe(item, state) 优先，否则“类型 · 基础模型 · 状态”
 */
function buildInfoText(item, describe, state, opts = {}) {
  if (typeof describe === 'function') {
    const text = describe(item, state);
    return str(text).trim();
  }
  const parts = [];
  if (item.type) parts.push(str(item.type));
  if (item.baseModel) parts.push(str(item.baseModel));
  const status = describeStatus(item, state);
  if (status) parts.push(status);
  return parts.join(view.separator());
}

/**
 * Compute the column widths for one screen of the list (by display width, so no row wraps).
 * 计算一屏列表的列宽分配（按显示宽度，保证每行不换行）。
 * @returns {{columns:number, indexWidth:number, nameWidth:number, detailWidth:number, sizeWidth:number}}
 */
function layoutColumns(pageItems, columns, total, sizeFormatter = formatBytes) {
  const width = Math.max(20, Math.floor(Number(columns)) || 0);
  const items = Array.isArray(pageItems) ? pageItems.filter(Boolean) : [];
  const count = Math.max(items.length, Number(total) || 0, 1);
  const fmt = typeof sizeFormatter === 'function' ? sizeFormatter : formatBytes;

  let sizeWidth = 1;
  for (const item of items) sizeWidth = Math.max(sizeWidth, displayWidth(fmt(bytesOf(item))));
  sizeWidth = Math.min(sizeWidth, Math.max(1, Math.floor(width / 3)));

  const indexWidth = Math.max(2, String(count).length);
  const fixed = 2 + 3 + 1 + 2; // 光标 + 勾选框 + 空格 + 序号 + 空格 + 行尾间隙 / cursor + checkbox + space + index + space + trailing gap
  const tailBudget = Math.max(2, width - fixed - MIN_NAME_WIDTH);
  let detailWidth = Math.max(0, Math.min(tailBudget - sizeWidth - 1, 40));
  let nameWidth = Math.max(MIN_NAME_WIDTH, width - fixed - 1 - sizeWidth - (detailWidth ? detailWidth + 2 : 0));
  return { columns: width, indexWidth, nameWidth, detailWidth, sizeWidth };
}

/**
 * Render one list row (plain text, no ANSI; the display width stays within columns).
 *
 *
 * 生成一行列表文本（纯文本、无 ANSI，长度按显示宽度受 columns 约束）。
 *
 * @param {object} item
 * @param {{
 *   columns?:number, number?:number|string, indexWidth?:number, nameWidth?:number,
 *   detailWidth?:number, sizeWidth?:number, selected?:boolean, cursor?:boolean,
 *   describe?:(item:object, state:any)=>string, state?:any,
 *   sizeFormatter?:(n:number)=>string
 * }} [opts]
 * @returns {string}
 */function buildRowText(item, opts = {}) {
  const columns = Math.max(1, Math.floor(Number(opts.columns)) || 80);
  const fmt = typeof opts.sizeFormatter === 'function' ? opts.sizeFormatter : formatBytes;
  const indexText = String(opts.number === undefined ? '' : opts.number).padStart(
    Math.max(1, Number(opts.indexWidth) || 2),
    ' '
  );
  const nameWidth = Number.isFinite(opts.nameWidth) ? Math.max(1, opts.nameWidth) : 30;
  const detailWidth = Number.isFinite(opts.detailWidth) ? Math.max(0, opts.detailWidth) : 0;
  const sizeWidth = Number.isFinite(opts.sizeWidth) ? Math.max(1, opts.sizeWidth) : 1;

  const head = `${view.cursorMark(!!opts.cursor)} ${view.checkbox(!!opts.selected)} ${indexText} `;
  const headWidth = displayWidth(head);
  // Locate the "size" column first, then fit the right-hand info and the name into the remaining
  // width, so that the whole row never exceeds columns.
  //
  // 先给「大小」列定位，再按剩余宽度放右侧信息与名称，保证整行不超过 columns
  const afterHead = Math.max(1, columns - headWidth);
  const sizeText = clipTailToWidth(fmt(bytesOf(item)), Math.max(1, Math.min(sizeWidth, afterHead)));
  const sizeCell = ` ${sizeText}`;
  const remaining = afterHead - displayWidth(sizeCell);
  const detailText =
    detailWidth > 1 && remaining > 2
      ? clipTailToWidth(buildInfoText(item, opts.describe, opts.state, opts), Math.min(detailWidth, remaining - 2))
      : '';
  const tail = `${detailText ? `  ${detailText}` : ''}${sizeCell}`;
  // Clip the name column by display width: better to show a few characters less than to break the
  // column width and knock every row out of alignment.
  //
  // 名称列按显示宽度截断：宁可少显示几个字，也不能撑破列宽导致折行错位
  const nameBudget = columns - headWidth - displayWidth(tail);
  const name = clipDisplay(nameOf(item, opts) || fallbackLabel(item, opts), Math.min(nameWidth, nameBudget));
  return `${head}${name}${tail}`;
}

/**
 * Render one screen of the list (the cursor row is reversed). When there are fewer rows than
 * minRows, the rest is padded with blank lines to avoid ghosting from the previous frame.
 *
 * 渲染一屏列表（光标行反显）。行数不足 minRows 时补空行，避免残影。
 * @returns {string[]}
 */
function renderListLines(pageItems, opts = {}) {
  const items = Array.isArray(pageItems) ? pageItems : [];
  const selected = opts.selected instanceof Set ? opts.selected : new Set(opts.selected || []);
  const cursor = Number.isFinite(opts.cursor) ? opts.cursor : -1;
  const firstNumber = Number.isFinite(opts.firstNumber) ? opts.firstNumber : 1;
  const colorize = opts.colorize !== false;
  const style = opts.colors || view.colors;

  const lines = items.map((item, i) => {
    const isCursor = i === cursor;
    const text = buildRowText(item, {
      ...opts,
      number: firstNumber + i,
      cursor: isCursor, // 光标位置不受 colorize 影响 / the cursor position is not affected by colorize
      selected: selected.has(idOf(item, opts)),
    });
    return colorize && isCursor ? style.reverse(text) : text;
  });

  const blanks = Math.max(0, Math.floor(Number(opts.minRows)) || 0) - lines.length;
  for (let i = 0; i < blanks; i++) lines.push(' ');
  return lines;
}

/**
 * Header lines: title / filter and sort state + position / selection and totals.
 *
 * Exactly three lines (title, filters, summary) so the surrounding layout stays predictable; use
 * withNotice() to append a transient message to the summary line.
 *
 *
 * 顶部信息：标题 / 过滤与排序状态 + 位置 / 已选与合计。
 *
 * 固定三行（标题、过滤、汇总），保证外层布局可预测；临时消息用 withNotice() 追加到汇总行。
 */
function buildHeaderLines(opts = {}) {
  const fmt = typeof opts.sizeFormatter === 'function' ? opts.sizeFormatter : formatBytes;
  const filters = [
    opts.search
      ? t('tui.select.filterSearchQuoted', { value: opts.search })
      : t('tui.select.filterSearchOff'),
  ];
  if (!isAll(opts.type)) filters.push(t('tui.select.filterType', { value: opts.type }));
  if (!isAll(opts.baseModel)) filters.push(t('tui.select.filterBaseModel', { value: opts.baseModel }));
  filters.push(t('tui.select.filterSort', { value: SORT_LABELS[opts.sort] || SORT_LABELS.default }));
  if (opts.position && opts.position.size > 0) {
    filters.push(
      t('tui.select.filterRows', {
        from: opts.position.start + 1,
        to: opts.position.end,
        total: Number(opts.visibleCount) || 0,
      })
    );
  } else {
    const page = Number.isFinite(opts.page) ? opts.page : 0;
    const pageCount = Math.max(1, Number(opts.pageCount) || 1);
    filters.push(t('tui.select.filterPage', { page: page + 1, pageCount }));
  }
  const summary = t('tui.select.summary', {
    selected: Number(opts.selectedCount) || 0,
    total: Number(opts.itemCount) || 0,
    visible: Number(opts.visibleCount) || 0,
    selectedSize: fmt(Number(opts.selectedBytes) || 0),
    visibleSize: fmt(Number(opts.visibleBytes) || 0),
  });
  return [str(opts.title) || t('tui.select.defaultTitle'), filters.join(view.separator()), summary];
}

/**
 * Append a transient message to the last header line, trimming that line to fit.
 * 把临时消息追加到表头最后一行，并按可用宽度裁剪原行。
 */
function withNotice(lines, columns, message) {
  const list = Array.isArray(lines) ? lines.slice() : [];
  const note = str(message).trim();
  if (!note || !list.length) return list;
  const prefix = ` ${view.separator()}`;
  const noteWidth = displayWidth(note) + displayWidth(prefix);
  const index = list.length - 1;
  const room = Math.max(0, columns - noteWidth);
  list[index] = `${clipToWidth(list[index], room)}${prefix}${note}`;
  return list;
}

/**
 * Key-hint lines of the current state: typing > help overlay > normal.
 *
 * Typing wins because the keys of the other states would not do anything useful while the search
 * box has focus.
 *
 *
 * 当前状态的按键提示行：输入中 > 帮助浮层 > 普通。
 *
 * 输入态优先级最高：输入框获得焦点时，其它状态的按键都不会有预期效果。
 *
 *
 * @returns {string[]}
 */
function hintLines(state = {}) {
  if (state.searching) return SEARCH_HINTS.map((hintText) => hintText);
  if (state.help) return HELP_HINTS.map((hintText) => hintText);
  return KEY_HINTS.map((hintText) => hintText);
}

// ---------------------------------------------------------------------------
// Interactive layer
// 交互层
// ---------------------------------------------------------------------------

function isInteractive() {
  return !!(
    process.stdout &&
    process.stdout.isTTY &&
    process.stdin &&
    process.stdin.isTTY &&
    typeof process.stdin.setRawMode === 'function'
  );
}

/**
 * Cycle to the next value among the candidates.
 * When the current value is not in the list (e.g. the initial null / undefined), it counts as the one
 * after the first element ('__all__'), so the first press of t / b / s switches to a real filter value
 * instead of staying put.
 *
 * 在候选值里循环取下一个。
 * 当前值不在列表里（例如初始的 null / undefined）时，视作第一个元素（'__all__'）之后的一项，
 * 这样 t / b / s 第一次按下就能切到真正的过滤值，而不是原地不动。
 */
function cycle(values, current) {
  const list = Array.isArray(values) && values.length ? values : [NO_FILTER];
  const idx = list.indexOf(current);
  if (idx === -1) return list[Math.min(1, list.length - 1)];
  return list[(idx + 1) % list.length];
}

function toSet(value) {
  if (!value) return new Set();
  if (value instanceof Set) return new Set(Array.from(value, (v) => String(v)));
  if (typeof value[Symbol.iterator] === 'function') return new Set(Array.from(value, (v) => String(v)));
  return new Set();
}

/**
 * Full-screen interactive picker (multi-select or single-choice).
 *
 * Items need a modelId (or an id) plus a name; type, baseModel and totalBytes are optional. The
 * accepted options are mode (multi|single), pageSize, initialSelected, title, describe, state,
 * selected, search, type, baseModel, sort, columns, rows, colorize, minHeight, initialCursor, label,
 * idOf, sizeFormatter and onLog — the same fields the flows pass in.
 *
 * 全屏交互式选择器（多选 / 单选）。
 *
 * 条目需要 modelId（或 id）与名称，type、baseModel、totalBytes 可选。
 * 其余可用选项为：mode（multi 或 single）、pageSize、initialSelected、title、describe、state、
 * selected、search、type、baseModel、sort、columns、rows、colorize、minHeight、initialCursor、
 * label、idOf、sizeFormatter、onLog，与各流程传入的字段一致。 */
async function selectItems(items, opts = {}) {
  const list = Array.isArray(items) ? items.filter(Boolean) : [];
  const onLog = typeof opts.onLog === 'function' ? opts.onLog : () => {};
  if (!list.length) {
    onLog(t('tui.select.noItems'));
    return null;
  }
  if (!isInteractive()) return null; // 非 TTY：交给调用方的回退路径 / not a TTY: leave it to the caller's fallback path

  const stdin = process.stdin;
  const stdout = process.stdout;
  const fmt = typeof opts.sizeFormatter === 'function' ? opts.sizeFormatter : formatBytes;
  const describe = typeof opts.describe === 'function' ? opts.describe : null;
  const single = opts.mode === 'single';
  const requestedPageSize = Math.max(1, Math.floor(Number(opts.pageSize)) || 15);
  const minHeight = Math.max(1, Math.floor(Number(opts.minHeight)) || Math.max(3, Math.floor(requestedPageSize / 2)));

  // Row accessors: every helper (and the pure renderers) receive them through `rowOpts`, so custom
  // rows without a modelId still have a stable identity and a readable label.
  //
  // 行访问器：所有助手（以及纯渲染函数）都通过 `rowOpts` 拿到它们，
  // 这样没有 modelId 的自定义行也能有稳定标识与可读名称。
  const rowOpts = {};
  if (typeof opts.idOf === 'function') rowOpts.idOf = opts.idOf;
  if (typeof opts.label === 'function') rowOpts.label = opts.label;
  function rowKey(item) {
    return idOf(item, rowOpts);
  }
  function rowLabel(item) {
    return nameOf(item, rowOpts) || fallbackLabel(item, rowOpts);
  }

  /**
   * Types / base models selectable under the current search keyword (avoids switching to an empty result).
   * 当前搜索关键字下可选的类型 / 基础模型（避免切到空结果）
   */
  function eligibleValues(field) {
    const pick = (p) => (field === 'type' ? p.type : p.baseModel);
    const scoped = filterItems(list, { keyword: st.search });
    const pool = field === 'baseModel' && !isAll(st.type) ? scoped.filter((p) => str(p.type) === str(st.type)) : scoped;
    const values = [...new Set(pool.map(pick).filter(Boolean))].map(String);
    return values.length ? values : [...new Set(list.map(pick).filter(Boolean))].map(String);
  }
  const typeValues = () => eligibleValues('type');
  const baseModelValues = () => eligibleValues('baseModel');

  /**
   * Interactive state (derived fields are filled in on demand while rendering).
   * 交互状态（render 时按需补充派生字段）
   */
  const st = {
    cursor: clampCursor(opts.initialCursor, list.length),
    windowStart: 0,
    anchor: null,
    selected: toSet(opts.selected !== undefined ? opts.selected : opts.initialSelected),
    search: str(opts.search),
    type: opts.type === undefined ? null : opts.type,
    baseModel: opts.baseModel === undefined ? null : opts.baseModel,
    sort: SORT_MODES.includes(opts.sort) ? opts.sort : 'default',
    searching: false,
    help: false,
    message: '',
  };

  const dims = {
    columns: layout.terminalColumns(opts.columns),
    rows: layout.terminalRows(opts.rows),
  };

  let finish = () => {};
  let finished = false;
  let rendered = null; // 最近一次渲染的派生状态 / derived state of the latest render
  let screenTaken = false; // 是否已切到备用缓冲区 / whether the alternate screen buffer is active

  /**
   * Derive the visible set, the scrolling window and the totals from items + filter/sort state.
   * 由 items + 过滤/排序状态推导可见集合、滚动视窗与合计
   */
  function derive() {
    const visible = sortItems(
      filterItems(list, { keyword: st.search, type: st.type, baseModel: st.baseModel, ...rowOpts }),
      st.sort,
      rowOpts
    );
    const chrome = CHROME_ROWS + HINT_ROWS + (st.searching ? 1 : 0);
    const size = Math.max(minHeight, Math.min(requestedPageSize, dims.rows - chrome));
    let win = scrollWindow(visible.length, st.cursor, size, st.windowStart);
    // Leaving the last row half-visible looks like a bug: re-run with one row less.
    // 最后一行只露出半截会像渲染出错：少显示一行再算一次。
    if (visible.length > size && win.start + size <= visible.length && win.start + size > visible.length - 1) {
      win = scrollWindow(visible.length, st.cursor, Math.max(1, size - 1), st.windowStart);
    }
    st.cursor = win.cursor;
    st.windowStart = win.start;
    const items_ = visible.slice(win.start, win.end);
    const selectedItems = visible.filter((item) => st.selected.has(rowKey(item)));
    const cols = layoutColumns(items_, dims.columns, visible.length, fmt);
    return {
      visible,
      items: items_,
      window: win,
      pageSize: size,
      selectedItems,
      visibleBytes: visible.reduce((sum, item) => sum + bytesOf(item), 0),
      selectedBytes: selectedItems.reduce((sum, item) => sum + bytesOf(item), 0),
      cols,
    };
  }

  /**
   * Help overlay lines: a compact key reference that replaces the list while open.
   * 帮助浮层内容：打开时替代列表显示的按键速查。
   */
  function helpOverlayLines() {
    return HELP_ITEMS.map((text) => clipToWidth(`  ${text}`, dims.columns));
  }

  function screenText(state) {
    const cursorRow = state.window.cursor - state.window.start;
    // Repaint from the top-left corner: erase the display (keeping the cursor where it is) and draw
    // every line again, which keeps rows in sync after filtering or scrolling.
    //
    // 从左上角整屏重绘：擦除显示内容（光标位置不变）后重新画每一行，
    // 这样过滤或滚动之后各列仍然对齐。
    const lines = [layout.ansi().eraseDisplay];
    const header = withNotice(
      buildHeaderLines({
        title: opts.title,
        search: st.search,
        type: st.type,
        baseModel: st.baseModel,
        sort: st.sort,
        selectedCount: st.selected.size,
        itemCount: list.length,
        visibleCount: state.visible.length,
        selectedBytes: state.selectedBytes,
        visibleBytes: state.visibleBytes,
        position: state.window,
      }),
      dims.columns,
      st.searching
        ? t('tui.select.typing')
        : st.message
          ? st.message
          : single
            ? t('tui.select.singleHint')
            : ''
    );
    for (const line of header) lines.push(view.colors.bold(clipToWidth(line, dims.columns)));

    const { cols } = state;
    const columnHeader = `  ${padToWidth(t('tui.select.columnIndex'), cols.indexWidth)} ${padToWidth(
      t('tui.select.columnName'),
      cols.nameWidth
    )}${cols.detailWidth > 0 ? `  ${padToWidth(t('tui.select.columnDetail'), cols.detailWidth)}` : ''} ${padToWidth(
      t('tui.select.columnSize'),
      cols.sizeWidth
    )}`;
    lines.push(view.colors.dim(clipToWidth(columnHeader, dims.columns)));

    const bodyRows = Math.max(1, state.window.size);
    if (st.help) {
      const overlay = helpOverlayLines().slice(0, bodyRows);
      for (let i = 0; i < bodyRows; i++) lines.push(overlay[i] || ' ');
    } else {
      lines.push(
        ...renderListLines(state.items, {
          columns: cols.columns,
          indexWidth: cols.indexWidth,
          nameWidth: cols.nameWidth,
          detailWidth: cols.detailWidth,
          sizeWidth: cols.sizeWidth,
          sizeFormatter: fmt,
          describe,
          state: opts.state,
          selected: st.selected,
          cursor: cursorRow,
          firstNumber: state.window.start + 1,
          minRows: bodyRows,
          colorize: opts.colorize !== false,
          label: rowOpts.label,
          idOf: rowOpts.idOf,
        })
      );
    }

    const note = state.visible.length
      ? ''
      : ` ${view.separator()}${t('tui.select.noMatches')}`;
    lines.push(
      view.colors.dim(
        clipToWidth(
          `  ${t('tui.select.footer', {
            page: Math.floor(state.window.start / Math.max(1, state.window.size)) + 1,
            pageCount: Math.max(1, Math.ceil(state.visible.length / Math.max(1, state.window.size))),
            count: state.items.length,
            selected: st.selected.size,
            total: list.length,
          })}${note}`,
          dims.columns
        )
      )
    );
    for (const hintText of hintLines({ help: st.help, searching: st.searching })) {
      lines.push(view.colors.dim(clipToWidth(hintText, dims.columns)));
    }
    return lines.join('\n');
  }

  const write = (text) => {
    if (!stdout || stdout.destroyed) return;
    try {
      stdout.write(text);
    } catch (e) {
      // The terminal is closed: ignore.
      // 终端已关闭：忽略
    }
  };

  function render() {
    rendered = derive();
    write(screenText(rendered));
  }

  const visibleList = () => (rendered ? rendered.visible : []);
  const pageSize = () => (rendered ? rendered.pageSize : requestedPageSize);

  const moveCursor = (delta) => {
    const list_ = visibleList();
    st.cursor = clampCursor(st.cursor + delta, list_.length);
  };
  const gotoCursor = (index) => {
    st.cursor = clampCursor(index, visibleList().length);
  };
  const cycleSort = () => {
    st.sort = cycle(SORT_MODES, st.sort);
    st.message = t('tui.select.filterSort', { value: SORT_LABELS[st.sort] });
    gotoCursor(0);
  };
  const cycleType = () => {
    st.type = cycle([NO_FILTER, ...typeValues()], st.type);
    st.message = t('tui.select.filterType', {
      value: st.type === NO_FILTER ? t('tui.select.allValues') : st.type,
    });
    gotoCursor(0);
  };
  const cycleBaseModel = () => {
    st.baseModel = cycle([NO_FILTER, ...baseModelValues()], st.baseModel);
    st.message = t('tui.select.filterBaseModel', {
      value: st.baseModel === NO_FILTER ? t('tui.select.allValues') : st.baseModel,
    });
    gotoCursor(0);
  };
  const toggleCurrent = () => {
    const item = visibleList()[st.cursor];
    if (!item) return;
    const id = rowKey(item);
    st.selected = single ? new Set([id]) : toggleSelection(st.selected, id);
    st.message = st.selected.has(id) ? t('tui.select.toggledOn') : t('tui.select.toggledOff');
    st.anchor = null;
  };
  const toggleAll = () => {
    const list_ = visibleList();
    const all = list_.length > 0 && list_.every((item) => st.selected.has(rowKey(item)));
    st.selected = single
      ? new Set(list_.length && !all ? [rowKey(list_[0])] : [])
      : selectAll(st.selected, list_, !all, rowOpts);
    st.message = all ? t('tui.select.allCleared') : t('tui.select.allSelected', { count: list_.length });
  };
  const invert = () => {
    if (single) {
      st.message = t('tui.select.singleNoInvert');
      return;
    }
    st.selected = invertSelection(st.selected, visibleList(), rowOpts);
    st.message = t('tui.select.inverted');
  };
  /**
   * Shift+↑/↓: keep the anchor where the selection started and select everything up to the cursor.
   * The first shifted move stores the cursor as the anchor; moving back shrinks the range again.
   *
   * Shift+↑/↓：以按下时的光标位置为锚点，选中锚点到当前光标之间的所有行。
   * 第一次按住 Shift 移动时记下锚点，往回移动会收缩选区。
   */
  const extendSelection = () => {
    if (single) return;
    if (st.anchor === null) st.anchor = st.cursor;
    const first = Math.min(st.anchor, st.cursor);
    const last = Math.max(st.anchor, st.cursor);
    st.selected = rangeSelection(st.selected, visibleList(), first, last, true, rowOpts);
    st.message = t('tui.select.rangeSelected', { count: last - first + 1 });
  };
  const confirm = () => {
    if (st.selected.size > 0) {
      finish({ selected: new Set(st.selected) });
      return;
    }
    // In single mode Enter picks the row under the cursor, which is what users expect from a list.
    // 单选模式下回车直接选中光标所在行——列表里这符合直觉。
    const item = visibleList()[st.cursor];
    if (single && item) {
      finish({ selected: new Set([rowKey(item)]) });
      return;
    }
    st.message = t('tui.select.needSelection');
  };

  function onSearchKey(text, key) {
    if (key.name === 'escape') {
      st.search = '';
      st.searching = false;
      st.message = t('tui.select.searchExited');
    } else if (key.name === 'return' || key.name === 'enter') {
      st.searching = false;
      st.message = st.search
        ? t('tui.select.messageSearch', { value: st.search })
        : t('tui.select.searchCleared');
    } else if (isBackspace(text, key)) {
      st.search = st.search.slice(0, -1);
      st.message = t('tui.select.typing');
    } else if (isTextInput(text, key)) {
      st.search += text;
      st.message = t('tui.select.typing');
    }
    st.anchor = null;
    gotoCursor(0);
  }

  function onActionKey(text, key) {
    const shift = !!key.shift;
    // Any non-shifted key ends a Shift+↑/↓ range selection.
    // 任何不带 Shift 的按键都会结束「Shift+↑/↓ 连续勾选」。
    if (!shift && (key.name !== undefined || text)) st.anchor = null;
    switch (key.name) {
      case 'up':
      case 'k':
        moveCursor(-1);
        if (shift) extendSelection();
        return;
      case 'down':
      case 'j':
        moveCursor(1);
        if (shift) extendSelection();
        return;
      case 'home':
        gotoCursor(0);
        return;
      case 'end':
        gotoCursor(visibleList().length - 1);
        return;
      case 'pageup':
        moveCursor(-pageSize());
        return;
      case 'pagedown':
        moveCursor(pageSize());
        return;
      case 'return':
      case 'enter':
        confirm();
        return;
      case 'space':
        toggleCurrent();
        return;
      default:
        break;
    }
    if (text === '[') moveCursor(-pageSize());
    else if (text === ']') moveCursor(pageSize());
    else if (text === ' ') toggleCurrent();
    else if (text === 'a') toggleAll();
    else if (text === 'i') invert();
    else if (text === 's') cycleSort();
    else if (text === 't') cycleType();
    else if (text === 'b') cycleBaseModel();
    else if (text === '?') {
      st.help = !st.help;
      st.message = st.help ? t('tui.select.helpOpen') : '';
    } else if (text === '/') {
      st.searching = true;
      st.message = t('tui.select.searchHint');
    } else if (shift && quickIndex(text) !== null) {
      // Shift+digit toggles the nth visible row without moving the cursor.
      // Shift+数字：直接勾选/取消第 n 行，不必移动光标。
      const index = quickIndex(text);
      const item = visibleList()[index];
      if (item) {
        const id = rowKey(item);
        st.selected = single ? new Set([id]) : toggleSelection(st.selected, id);
        st.message = st.selected.has(id) ? t('tui.select.toggledOn') : t('tui.select.toggledOff');
      }
    } else if (quickIndex(text) !== null) {
      const index = quickIndex(text);
      if (index < visibleList().length) gotoCursor(index);
    }
  }

  function onKeypress(text, key) {
    const k = key || {};
    if (k.meta) return; // Alt+方向键等：忽略 / Alt+arrow keys etc.: ignore
    if (st.searching) {
      onSearchKey(text, k); // 输入态：Esc 退出输入、回车结束、退格可用 / typing mode: Esc exits, Enter ends, Backspace edits
      render();
      return;
    }
    if (st.help) {
      // Any key closes the overlay; Esc/q also cancels the picker.
      // 任意键关闭帮助浮层；Esc/q 则直接取消选择。
      if (k.name === 'escape' || (text === 'q' && !k.ctrl)) {
        finish(null);
        return;
      }
      st.help = false;
      st.message = '';
      render();
      return;
    }
    if (k.name === 'escape' || (text === 'q' && !k.ctrl)) {
      finish(null);
      return;
    }
    onActionKey(text, k);
    render();
  }

  /**
   * Take over the screen the first time: switch to the alternate buffer (the previous content comes
   * back on exit), clear it, hide the cursor and let the caller print its context lines.
   *
   * 第一次渲染时接管屏幕：切到备用缓冲区（退出时恢复原内容）、清屏、隐藏光标，
   * 并让调用方打印它自己的上下文行。
   */
  function prepareScreen() {
    if (screenTaken) return;
    screenTaken = true;
    debugLog(`screen-enter items=${list.length} mode=${single ? 'single' : 'multi'}`);
    if (typeof opts.onEnter === 'function') {
      try {
        opts.onEnter();
      } catch (e) {
        // Context lines are cosmetic: a failure there must not break the picker.
        // 上下文行只是锦上添花：打印失败不能拖垮选择器。
      }
    }
    write(layout.ansi().altScreenOn + layout.ansi().clear + layout.ansi().hideCursor);
  }

  function cleanup() {
    restoreKeys();
    if (resumeListener) process.removeListener('SIGCONT', resumeListener);
    process.removeListener('SIGINT', onSigint);
    if (stdout && typeof stdout.removeListener === 'function') stdout.removeListener('resize', onResize);
    if (!screenTaken) return;
    // Leave the alternate buffer: the menu / fetched list / logs are restored as they were, so the
    // only trace of the picker is the decision line the caller prints afterwards.
    //
    // 退出备用缓冲区：菜单 / 已拉取的列表 / 日志原样恢复，选择器留下的唯一痕迹是调用方之后打印的决定行。
    screenTaken = false;
    debugLog('screen-exit');
    write(layout.ansi().showCursor + layout.ansi().altScreenOff);
  }

  function onSigint() {
    finish(null);
  }

  function onResize() {
    if (!stdout) return;
    dims.columns = layout.terminalColumns(stdout.columns);
    dims.rows = layout.terminalRows(stdout.rows);
    if (!finished) render();
  }

  /**
   * Ctrl+Z keep-working path: the terminal is restored before suspending, so on resume the screen
   * has to be taken over again, the key listener re-installed and the SIGCONT listener re-armed.
   *
   * Ctrl+Z 后续可用的关键：挂起前已还原终端，因此恢复运行时要重新接管屏幕、
   * 重新安装按键监听，并把 SIGCONT 监听也重新挂上。
   */
  function onResume() {
    const installed = installKeys();
    if (installed) restoreKeys = installed;
    if (finished) return;
    process.on('SIGCONT', resumeListener);
    prepareScreen();
    render();
  }

  // Wait for the user's decision: confirm and cancel both go through finish(), which fires only once.
  // 等待用户决定：确认 / 取消都走 finish()，只会生效一次
  const answer = new Promise((resolve) => {
    finish = (value) => {
      if (finished) return;
      finished = true;
      resolve(value || null);
    };
  });

  // Enter raw keyboard mode; any failing step falls back to the caller. A screen that cannot get
  // keypresses must return immediately: waiting for a key that can never arrive is a hard hang.
  //
  // 进入原始键盘模式；任何一步失败都退回调用方。拿不到按键的界面必须立刻返回：
  // 等一个永远不会到来的按键就是彻底卡死。
  let restoreKeys = () => {};
  let resumeListener = null;
  function installKeys() {
    return installRawKeys({
      stream: stdin,
      onKey: onKeypress,
      onSignal: (intent) => {
        if (intent === 'cancel') {
          finish(null);
          return;
        }
        // Ctrl+Z: restore the terminal, suspend, then take the screen over again on resume. Only
        // POSIX shells can stop a process; on Windows the key is acknowledged and ignored.
        //
        // Ctrl+Z：先恢复终端再挂起，恢复运行时重新接管屏幕。只有 POSIX shell 能挂起进程，
        // Windows 上仅作提示后忽略。
        if (process.platform === 'win32') {
          st.message = t('tui.select.suspendUnsupported');
          return;
        }
        cleanup();
        process.kill(process.pid, 'SIGTSTP');
      },
    });
  }
  try {
    const installed = installKeys();
    if (!installed) throw new Error(t('tui.select.rawUnavailable'));
    restoreKeys = installed;
  } catch (e) {
    finish(null);
    onLog(t('tui.select.selectorUnavailable', { error: e.message }));
    cleanup();
    return null;
  }

  resumeListener = onResume;
  process.on('SIGCONT', resumeListener);
  process.on('SIGINT', onSigint);
  if (stdout && typeof stdout.on === 'function') stdout.on('resize', onResize);

  try {
    prepareScreen();
    render();
  } catch (e) {
    finish(null);
    onLog(t('tui.select.selectorRenderFailed', { error: e.message }));
    cleanup();
    return null;
  }

  try {
    return await answer;
  } finally {
    // Whether we confirm, cancel or throw, restore the cursor/keyboard mode and the screen.
    // 无论正常确认、取消还是异常，都要还原光标/键盘模式与屏幕。
    cleanup();
  }
}

module.exports = {
  // Pure logic
  // 纯逻辑
  filterItems,
  sortItems,
  paginate,
  scrollWindow,
  toggleSelection,
  selectAll,
  invertSelection,
  rangeSelection,
  clampCursor,
  ensureVisible,
  quickIndex,
  // Rendering helpers (no side effects, easy to test)
  // 渲染辅助（无副作用，便于测试）
  buildRowText,
  renderListLines,
  buildHeaderLines,
  withNotice,
  hintLines,
  layoutColumns,
  describeStatus,
  displayWidth,
  clipDisplay,
  // Interactive layer
  // 交互
  selectItems,
  isInteractive,
  // Metadata
  // 元数据
  NO_FILTER,
  SORT_MODES,
  SORT_LABELS,
  KEY_HINTS,
  SEARCH_HINTS,
  HELP_HINTS,
  HELP_ITEMS,
  CHROME_ROWS,
  HINT_ROWS,
  MIN_ROWS,
};
