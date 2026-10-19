'use strict';

/**
 * Semantic design tokens of the TUI.
 *
 * Every flow should ask for a role ("danger", "muted", "cursor") instead of a raw color name. The
 * aliases below map to the existing palette, so the first migration changes no pixels while giving
 * later phases one place to adjust the design language.
 *
 *
 * TUI 的语义设计令牌。
 *
 * 每个流程应当请求角色（"danger"、"muted"、"cursor"），而不是原始颜色名。
 * 下面的别名映射到现有调色板，因此第一次迁移不改变任何像素，同时给后续阶段留下唯一的调整入口。
 */

const layout = require('./layout');
const { formatBytes, formatDuration } = require('../util');

const palette = layout.colors;

/**
 * Semantic colors. The status aliases preserve the current visual mapping: running is green, done is
 * cyan, queued/cancelled are yellow and failed is red.
 *
 * 语义颜色。状态别名保持当前视觉映射：运行中为绿、完成为青、排队/取消为黄、失败为红。
 */
const color = {
  text: (value) => String(value),
  muted: palette.dim,
  emphasis: palette.bold,
  accent: palette.cyan,
  success: palette.green,
  warning: palette.yellow,
  danger: palette.red,
  cursor: palette.cyan,
  selection: palette.reverse,
  progress: palette.cyan,
  border: palette.dim,
};

const status = {
  running: color.success,
  done: color.accent,
  queued: color.warning,
  cancelled: color.warning,
  failed: color.danger,
};

/**
 * Display glyphs resolved on every access, so CIVITAI_ASCII and console code pages keep working when
 * they change after this module was loaded.
 *
 * 每次访问时解析的展示字符，因此在本模块加载后切换 CIVITAI_ASCII 或控制台代码页仍然有效。
 */
const glyph = {};
for (const key of Object.keys(layout.GLYPHS_UNICODE)) {
  Object.defineProperty(glyph, key, {
    get: () => layout.glyphs()[key],
    enumerable: true,
  });
}

/**
 * Glyphs that are not part of the box-drawing set but still belong to the design language.
 * 不属于制表字符集、但仍属于设计语言的字符。
 */
Object.defineProperty(glyph, 'failure', { get: () => '!', enumerable: true });
Object.defineProperty(glyph, 'placeholder', { get: () => '--', enumerable: true });

/**
 * Normalize an optional timestamp-like value before formatting.
 * 格式化前归一化可选的类时间戳值。
 *
 * @param {any} value
 * @returns {string}
 */
function timestamp(value) {
  return value === undefined || value === null ? '' : String(value);
}

/**
 * Shared date and number formatting. The date helpers reproduce the slicing the flows used before, so
 * this phase is a pure refactor; Phase 5 can change the display format in one place.
 *
 * 共享的日期与数字格式化。日期助手复现各流程此前的截断行为，因此本阶段是纯重构；
 * Phase 5 可以在一处调整显示格式。
 */
const format = {
  date: (value) => timestamp(value).slice(0, 10),
  dateTime: (value) => timestamp(value).slice(0, 16).replace('T', ' '),
  dateTimeFull: (value) => timestamp(value).slice(0, 19).replace('T', ' '),
  bytes: formatBytes,
  duration: formatDuration,
  count: (value) => String(value),
};

/**
 * Spacing scale used by page and list primitives.
 * 页面与列表原语使用的间距刻度。
 */
const space = Object.freeze({
  page: 0,
  rowIndent: 2,
  sectionGap: 1,
  labelGap: 2,
});

/**
 * Responsive breakpoints: narrow drops decoration, compact trims secondary columns, wide is complete.
 * 响应式断点：narrow 去掉装饰，compact 裁剪次要列，wide 使用完整布局。
 */
const breakpoint = Object.freeze({
  narrow: 54,
  compact: 72,
  wide: 100,
});

module.exports = {
  color,
  status,
  glyph,
  format,
  space,
  breakpoint,
};
