'use strict';

/**
 * Full-screen interactive item picker.
 *
 * Two layers:
 *  1) pure logic (filterItems / sortItems / paginate / toggleSelection / selectAll /
 *     invertSelection / clampCursor / renderListLines …) — no terminal side effects, unit-testable;
 *  2) the interactive layer selectItems() — raw keyboard mode + ANSI full-screen redraw; it returns
 *     null outside a TTY, so the caller falls back to the legacy prompts path.
 *
 *
 * 全屏交互式条目选择器。
 *
 * 分两层：
 *  1) 纯逻辑层（filterItems / sortItems / paginate / toggleSelection / selectAll /
 *     invertSelection / clampCursor / renderListLines …）—— 无终端副作用，可直接单测；
 *  2) 交互层 selectItems() —— 原始键盘模式 + ANSI 全屏重绘；非 TTY 直接返回 null，
 *     由调用方回退到 prompts 老路径。
 */

const readline = require('readline');
const { formatBytes } = require('../util');
const { t } = require('../i18n');
const { displayWidth } = require('./view');

// ---------------------------------------------------------------------------
// Constants
// 常量
// ---------------------------------------------------------------------------

const NO_FILTER = '__all__';
const MIN_NAME_WIDTH = 6;
/**
 * Fixed rows besides the list: title + status line + summary line + column header + footer + three key-hint lines.
 * 除列表外的固定行数：标题 + 状态行 + 汇总行 + 列头 + 页脚 + 三行按键提示
 */
const CHROME_ROWS = 7;
/**
 * Treat the terminal as at least this many rows (so the list still has a few lines to show).
 * 终端最少按这么多行处理（保证列表至少还有几行可显示）
 */
const MIN_ROWS = 12;

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
 * Footer key hints (split into two lines so they fit even an 80-column terminal; CJK counts as 2 columns).
 * Keys: ↑/↓ or k/j to move, Home/End for first/last, PgUp/PgDn or [ ] to page,
 *       space to toggle, a to select/deselect all, i to invert, / to search, t for type, b for base model,
 *       s to sort, Enter to confirm (at least one item), Esc/q/Ctrl+C to cancel.
 * Also lazily resolved (getters), so iteration and index access stay unchanged.
 *
 * 底部按键说明（拆成两行，保证 80 列终端也能完整显示；CJK 按 2 列算）。
 * 键位：↑/↓ 或 k/j 移动，Home/End 首尾，PgUp/PgDn 或 [ ] 翻页，
 *       空格勾选，a 全选/全不选，i 反选，/ 搜索，t 类型，b 基础模型，s 排序，
 *       回车确认（至少 1 项），Esc/q/Ctrl+C 取消。
 * 同样是惰性取词（getter），遍历/下标访问方式不变。
 */
const KEY_HINT_KEYS = ['tui.select.keyHintMove', 'tui.select.keyHintSelect', 'tui.select.keyHintAction'];
const KEY_HINTS = KEY_HINT_KEYS.map(() => '');
KEY_HINT_KEYS.forEach((key, index) => {
  Object.defineProperty(KEY_HINTS, index, { get: () => t(key), enumerable: true });
});

const ANSI_CLEAR = '\u001b[2J\u001b[H';
const ANSI_HIDE_CURSOR = '\u001b[?25l';
const ANSI_SHOW_CURSOR = '\u001b[?25h';

function paint(code) {
  return (s) => `\u001b[${code}m${s}\u001b[0m`;
}

const C = {
  bold: paint('1'),
  dim: paint('2'),
  reverse: paint('7'),
};

// ---------------------------------------------------------------------------
// Small helpers (pure functions)
// 小工具（纯函数）
// ---------------------------------------------------------------------------

function str(value) {
  return value === undefined || value === null ? '' : String(value);
}

function idOf(item) {
  return String(item && item.modelId);
}

function nameOf(item) {
  return str(item && item.name);
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

// ---------------------------------------------------------------------------
// Pure logic: filtering / sorting / paging / selection set / cursor
// 纯逻辑层：过滤 / 排序 / 分页 / 选择集合 / 光标
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
      const haystack = `${nameOf(item)}\u0000${idOf(item)}`.toLowerCase();
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
function sortItems(items, mode = 'default') {
  const list = Array.isArray(items) ? items.slice() : [];
  if (mode === 'name') {
    return withIndex(list)
      .sort((a, b) => nameOf(a.item).localeCompare(nameOf(b.item), 'zh-Hans-CN') || a.index - b.index)
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
 * 分页（page 从 0 开始，越界夹紧）。
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
function selectAll(selected, items, value) {
  const next = new Set(selected || []);
  const list = Array.isArray(items) ? items : [];
  if (value) {
    for (const item of list) if (item) next.add(idOf(item));
  } else {
    for (const item of list) if (item) next.delete(idOf(item));
  }
  return next;
}

/**
 * Invert the selection (only the given items); returns a new Set (the input is not mutated).
 * 反选（只针对传入的 items），返回新 Set（不修改入参）
 */
function invertSelection(selected, items) {
  const next = new Set(selected || []);
  const list = Array.isArray(items) ? items : [];
  for (const item of list) {
    if (!item) continue;
    const id = idOf(item);
    if (next.has(id)) next.delete(id);
    else next.add(id);
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
 * Put the cursor on an index of list and return the page that holds it (so the row stays visible).
 * 把光标放到 list 的某个下标，并返回该行所在的页（保证可见）
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
function buildInfoText(item, describe, state) {
  if (typeof describe === 'function') {
    const text = describe(item, state);
    return str(text).trim();
  }
  const parts = [];
  if (item.type) parts.push(str(item.type));
  if (item.baseModel) parts.push(str(item.baseModel));
  const status = describeStatus(item, state);
  if (status) parts.push(status);
  return parts.join(' · ');
}

/**
 * Compute the column widths for one page of the list (by display width, so no row wraps).
 * 计算一页列表的列宽分配（按显示宽度，保证每行不换行）。
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
 * @param {object} item
 * Render one list row (plain text, no ANSI; the display width stays within columns).
 * @param {{
 *   columns?:number, number?:number|string, indexWidth?:number, nameWidth?:number,
 *   detailWidth?:number, sizeWidth?:number, selected?:boolean, cursor?:boolean,
 *   describe?:(item:object, state:any)=>string, state?:any,
 *   sizeFormatter?:(n:number)=>string
 * }} [opts]
 * @returns {string}
 *
 * 生成一行列表文本（纯文本、无 ANSI，长度按显示宽度受 columns 约束）。
 */
function buildRowText(item, opts = {}) {
  const columns = Math.max(1, Math.floor(Number(opts.columns)) || 80);
  const fmt = typeof opts.sizeFormatter === 'function' ? opts.sizeFormatter : formatBytes;
  const indexText = String(opts.number === undefined ? '' : opts.number).padStart(
    Math.max(1, Number(opts.indexWidth) || 2),
    ' '
  );
  const nameWidth = Number.isFinite(opts.nameWidth) ? Math.max(1, opts.nameWidth) : 30;
  const detailWidth = Number.isFinite(opts.detailWidth) ? Math.max(0, opts.detailWidth) : 0;
  const sizeWidth = Number.isFinite(opts.sizeWidth) ? Math.max(1, opts.sizeWidth) : 1;

  const head = `${opts.cursor ? '▸' : ' '} ${opts.selected ? '[×]' : '[ ]'} ${indexText} `;
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
      ? clipTailToWidth(buildInfoText(item, opts.describe, opts.state), Math.min(detailWidth, remaining - 2))
      : '';
  const tail = `${detailText ? `  ${detailText}` : ''}${sizeCell}`;
  // Clip the name column by display width: better to show a few characters less than to break the
  // column width and knock every row out of alignment.
  //
  // 名称列按显示宽度截断：宁可少显示几个字，也不能撑破列宽导致折行错位
  const nameBudget = columns - headWidth - displayWidth(tail);
  const name = clipDisplay(nameOf(item) || `#${idOf(item)}`, Math.min(nameWidth, nameBudget));
  return `${head}${name}${tail}`;
}

/**
 * Render one page of the list (the cursor row is reversed). When there are fewer rows than minRows,
 * the rest is padded with blank lines to avoid ghosting from the previous frame.
 *
 * 渲染一页列表（光标行反显）。行数不足 minRows 时补空行，避免残影。
 * @returns {string[]}
 */
function renderListLines(pageItems, opts = {}) {
  const items = Array.isArray(pageItems) ? pageItems : [];
  const selected = opts.selected instanceof Set ? opts.selected : new Set(opts.selected || []);
  const cursor = Number.isFinite(opts.cursor) ? opts.cursor : -1;
  const firstNumber = Number.isFinite(opts.firstNumber) ? opts.firstNumber : 1;
  const colorize = opts.colorize !== false;
  const style = opts.colors || C;

  const lines = items.map((item, i) => {
    const isCursor = i === cursor;
    const text = buildRowText(item, {
      ...opts,
      number: firstNumber + i,
      cursor: isCursor, // 光标位置不受 colorize 影响 / the cursor position is not affected by colorize
      selected: selected.has(idOf(item)),
    });
    return colorize && isCursor ? style.reverse(text) : text;
  });

  const blanks = Math.max(0, Math.floor(Number(opts.minRows)) || 0) - lines.length;
  for (let i = 0; i < blanks; i++) lines.push(' ');
  return lines;
}

/**
 * Header lines: title / filter and sort state + paging / selection and totals.
 * @param {{
 *   title?:string, search?:string, type?:string|null, baseModel?:string|null, sort?:string,
 *   selectedCount?:number, itemCount?:number, visibleCount?:number, selectedBytes?:number,
 *   visibleBytes?:number, page?:number, pageCount?:number, sizeFormatter?:(n:number)=>string
 * }} [opts]
 * @returns {string[]}
 *
 * 顶部信息：标题 / 过滤与排序状态 + 分页 / 已选与合计。
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
  const page = Number.isFinite(opts.page) ? opts.page : 0;
  const pageCount = Math.max(1, Number(opts.pageCount) || 1);
  filters.push(t('tui.select.filterPage', { page: page + 1, pageCount }));
  const summary = t('tui.select.summary', {
    selected: Number(opts.selectedCount) || 0,
    total: Number(opts.itemCount) || 0,
    visible: Number(opts.visibleCount) || 0,
    selectedSize: fmt(Number(opts.selectedBytes) || 0),
    visibleSize: fmt(Number(opts.visibleBytes) || 0),
  });
  return [str(opts.title) || t('tui.select.defaultTitle'), filters.join(' · '), summary];
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
 * @param {Array} items 候选条目（需含 modelId / name；可选 type / baseModel / totalBytes）
 * Full-screen interactive multi-select.
 * @param {{
 *   pageSize?:number, initialSelected?:Iterable<string|number>, title?:string,
 *   describe?:(item:object, state:any)=>string, state?:any,
 *   selected?:Iterable<string|number>, search?:string, type?:string|null,
 *   baseModel?:string|null, sort?:'default'|'name'|'size'|'size-asc',
 *   columns?:number, rows?:number, colorize?:boolean,
 *   sizeFormatter?:(n:number)=>string, onLog?:(msg:string)=>void
 * }} [opts]
 * @returns {Promise<{selected:Set<string>}|null>} 取消（Esc / q / Ctrl+C）返回 null
 *
 * 全屏交互式多选。
 */
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
  const requestedPageSize = Math.max(1, Math.floor(Number(opts.pageSize)) || 15);

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
    cursor: 0,
    page: 0,
    selected: toSet(opts.selected !== undefined ? opts.selected : opts.initialSelected),
    search: str(opts.search),
    type: opts.type === undefined ? null : opts.type,
    baseModel: opts.baseModel === undefined ? null : opts.baseModel,
    sort: SORT_MODES.includes(opts.sort) ? opts.sort : 'default',
    searching: false,
    message: '',
  };

  const dims = {
    columns: Math.max(20, Math.floor(Number(opts.columns) || stdout.columns || 100)),
    rows: Math.max(MIN_ROWS, Math.floor(Number(opts.rows) || stdout.rows || 30)),
  };

  let finish = () => {};
  let finished = false;
  let rendered = null; // 最近一次渲染的派生状态 / derived state of the latest render

  /**
   * Derive the currently visible set and the paging from items + the filter/sort state.
   * 由 items + 过滤/排序状态推导当前可见集合与分页
   */
  function derive() {
    const visible = sortItems(
      filterItems(list, { keyword: st.search, type: st.type, baseModel: st.baseModel }),
      st.sort
    );
    const pageSize = Math.max(1, Math.min(requestedPageSize, dims.rows - CHROME_ROWS - 1));
    const { pageItems, pageCount, page } = paginate(visible, st.page, pageSize);
    st.page = page; // 过滤后页数变少时回夹 / clamp back when filtering leaves fewer pages
    st.cursor = ensureVisible(visible, st.cursor, pageSize).cursor;
    const selectedItems = visible.filter((item) => st.selected.has(idOf(item)));
    const cols = layoutColumns(pageItems, dims.columns, visible.length, fmt);
    return {
      visible,
      pageItems,
      page,
      pageCount,
      pageSize,
      selectedItems,
      visibleBytes: visible.reduce((sum, item) => sum + bytesOf(item), 0),
      selectedBytes: selectedItems.reduce((sum, item) => sum + bytesOf(item), 0),
      cols,
    };
  }

  function screenText(state) {
    const cursorRow = st.cursor - state.page * state.pageSize;
    const lines = [ANSI_CLEAR];
    for (const line of buildHeaderLines({
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
      page: state.page,
      pageCount: state.pageCount,
      sizeFormatter: fmt,
    })) {
      lines.push(clipToWidth(C.bold(line), dims.columns));
    }
    const { cols } = state;
    lines.push(
      C.dim(
        clipToWidth(
          `  ${padToWidth(t('tui.select.columnIndex'), cols.indexWidth)} ${padToWidth(
            t('tui.select.columnName'),
            cols.nameWidth
          )}${
            cols.detailWidth > 0 ? `  ${padToWidth(t('tui.select.columnDetail'), cols.detailWidth)}` : ''
          } ${padToWidth(t('tui.select.columnSize'), cols.sizeWidth)}`,
          dims.columns
        )
      )
    );
    lines.push(
      ...renderListLines(state.pageItems, {
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
        firstNumber: state.page * state.pageSize + 1,
        minRows: Math.max(0, dims.rows - CHROME_ROWS - 1),
        colorize: opts.colorize !== false,
      })
    );
    const note = state.visible.length
      ? st.message
        ? ` · ${st.message}`
        : st.searching
          ? ` · ${t('tui.select.typing')}`
          : ''
      : ` · ${t('tui.select.noMatches')}`;
    lines.push(
      C.dim(
        clipToWidth(
          `  ${t('tui.select.footer', {
            page: state.page + 1,
            pageCount: state.pageCount,
            count: state.pageItems.length,
            selected: st.selected.size,
            total: list.length,
          })}${note}`,
          dims.columns
        )
      )
    );
    for (const hint of KEY_HINTS) lines.push(C.dim(clipToWidth(hint, dims.columns)));
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
    st.page = Math.floor(st.cursor / pageSize());
  };
  const gotoCursor = (index) => {
    st.cursor = clampCursor(index, visibleList().length);
    st.page = Math.floor(st.cursor / pageSize());
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
    const id = idOf(item);
    st.selected = toggleSelection(st.selected, id);
    st.message = st.selected.has(id) ? t('tui.select.toggledOn') : t('tui.select.toggledOff');
  };
  const toggleAll = () => {
    const list_ = visibleList();
    const all = list_.length > 0 && list_.every((item) => st.selected.has(idOf(item)));
    st.selected = selectAll(st.selected, list_, !all);
    st.message = all ? t('tui.select.allCleared') : t('tui.select.allSelected', { count: list_.length });
  };
  const invert = () => {
    st.selected = invertSelection(st.selected, visibleList());
    st.message = t('tui.select.inverted');
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
    } else if (key.name === 'backspace' || key.name === 'delete') {
      st.search = st.search.slice(0, -1);
      st.message = t('tui.select.typing');
    } else if (text && !key.ctrl && !key.meta && text.length >= 1 && text >= ' ') {
      st.search += text;
      st.message = t('tui.select.typing');
    }
    gotoCursor(0);
  }

  function onActionKey(text, key) {
    switch (key.name) {
      case 'up':
      case 'k':
        moveCursor(-1);
        return;
      case 'down':
      case 'j':
        moveCursor(1);
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
        if (st.selected.size > 0) finish({ selected: new Set(st.selected) });
        else st.message = t('tui.select.needSelection');
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
    else if (text === '/') {
      st.searching = true;
      st.message = t('tui.select.searchHint');
    }
  }

  function onKeypress(text, key) {
    const k = key || {};
    if (k.ctrl && (k.name === 'c' || k.name === 'C')) {
      finish(null); // Ctrl+C 取消 / Ctrl+C cancels
      return;
    }
    if (st.searching) {
      onSearchKey(text, k); // 输入态：Esc 退出输入、回车结束、退格可用 / typing mode: Esc exits, Enter ends, Backspace edits
      render();
      return;
    }
    if (k.name === 'escape' || (text === 'q' && !k.ctrl && !k.meta)) {
      finish(null);
      return;
    }
    if (k.meta) return; // Alt+方向键等：忽略 / Alt+arrow keys etc.: ignore
    onActionKey(text, k);
    render();
  }

  function cleanup() {
    if (process.stdin && typeof process.stdin.removeListener === 'function') {
      process.stdin.removeListener('keypress', onKeypress);
    }
    process.removeListener('SIGINT', onSigint);
    if (stdout && typeof stdout.removeListener === 'function') stdout.removeListener('resize', onResize);
    try {
      if (stdin.isTTY && typeof stdin.setRawMode === 'function') stdin.setRawMode(false);
    } catch (e) {
      // Ignore failures when turning raw mode off.
      // 关闭原始模式失败时忽略。
    }
    try {
      stdin.pause();
    } catch (e) {
      // Ignore failures when pausing stdin.
      // 暂停 stdin 失败时忽略。
    }
    write(ANSI_CLEAR + ANSI_SHOW_CURSOR);
  }

  function onSigint() {
    finish(null);
  }

  function onResize() {
    if (!stdout) return;
    dims.columns = Math.max(20, stdout.columns || dims.columns);
    dims.rows = Math.max(MIN_ROWS, stdout.rows || dims.rows);
    if (!finished) render();
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

  // Enter raw keyboard mode; any failing step falls back to the caller.
  // 进入原始键盘模式；任何一步失败都退回调用方
  try {
    readline.emitKeypressEvents(stdin);
    stdin.setRawMode(true);
    stdin.resume();
  } catch (e) {
    finish(null);
    onLog(t('tui.select.selectorUnavailable', { error: e.message }));
    cleanup();
    return null;
  }

  process.on('SIGINT', onSigint);
  if (stdout && typeof stdout.on === 'function') stdout.on('resize', onResize);
  stdin.on('keypress', onKeypress);

  try {
    write(ANSI_HIDE_CURSOR);
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
    // Whether we confirm, cancel or throw, restore the cursor/keyboard mode and clear the screen.
    // 无论正常确认、取消还是异常，都要还原光标/键盘模式并清屏
    cleanup();
  }
}

module.exports = {
  // Pure logic
  // 纯逻辑
  filterItems,
  sortItems,
  paginate,
  toggleSelection,
  selectAll,
  invertSelection,
  clampCursor,
  ensureVisible,
  // Rendering helpers (no side effects, easy to test)
  // 渲染辅助（无副作用，便于测试）
  buildRowText,
  renderListLines,
  buildHeaderLines,
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
};
