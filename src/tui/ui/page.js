'use strict';

/**
 * Shared page layout: summary facts, sections and an action list. Report pages and form pages use
 * the same line builder, so they clip, align and scroll the same way.
 *
 * 共享页面布局：摘要事实、分区与操作列表。报告页与表单页共用同一行构建器，
 * 因此它们的裁剪、对齐与滚动行为一致。
 */

const { t } = require('../../i18n');
const layout = require('../layout');

const { colors, displayWidth, truncateTo, padTo } = layout;

/**
 * Default action result: repaint the same page.
 * 默认动作结果：重画同一页。
 */
const REFRESH = 'refresh';

/**
 * Below this width the secondary column (paths, dates) is dropped.
 * 低于该宽度时丢掉次要列（路径、日期）。
 */
const NARROW_WIDTH = 64;

/**
 * Normalize one section row. A plain string is a label-only row; the `raw` field keeps the object
 * the caller passed, so `onEnter` receives exactly what it handed in.
 *
 * 归一化一行分区块。纯字符串表示只有标签的行；`raw` 保留调用方传入的对象，
 * 因此 `onEnter` 拿到的正是它自己交来的那一项。
 */
function normalizeRow(row) {
  if (row === undefined || row === null) return null;
  if (typeof row === 'string') {
    return { label: row, detail: '', extra: '', sub: '', color: null, raw: row };
  }
  const label = row.label === undefined || row.label === null ? '' : String(row.label);
  const detail = row.detail === undefined || row.detail === null ? '' : String(row.detail);
  const extra = row.extra === undefined || row.extra === null ? '' : String(row.extra);
  const sub = row.sub === undefined || row.sub === null ? '' : String(row.sub);
  return {
    label,
    detail,
    extra,
    sub,
    color: typeof row.color === 'function' ? row.color : null,
    raw: row.raw === undefined ? row : row.raw,
  };
}

/**
 * Normalize a whole report model so the renderer never has to defend against half-filled objects.
 * 归一化整个报告模型，渲染时不必再防守半成品对象。
 */
function normalizeReport(model) {
  const src = model || {};
  const summary = (Array.isArray(src.summary) ? src.summary : [])
    .filter((fact) => fact && fact.label !== undefined && fact.value !== undefined && fact.value !== null)
    .filter((fact) => String(fact.value).trim() !== '')
    .map((fact) => ({
      label: String(fact.label),
      value: String(fact.value),
      color: typeof fact.color === 'function' ? fact.color : null,
    }));
  const sections = (Array.isArray(src.sections) ? src.sections : []).map((section) => {
    const source = section || {};
    return {
      title: source.title === undefined || source.title === null ? '' : String(source.title),
      rows: (Array.isArray(source.rows) ? source.rows : []).map(normalizeRow).filter(Boolean),
      emptyText:
        source.emptyText === undefined || source.emptyText === null
          ? t('tui.report.empty')
          : String(source.emptyText),
      emptyColor: typeof source.emptyColor === 'function' ? source.emptyColor : null,
      onEnter: typeof source.onEnter === 'function' ? source.onEnter : null,
    };
  });
  const actions = (Array.isArray(src.actions) ? src.actions : [])
    .filter((action) => action && action.label)
    .map((action) => ({
      label: String(action.label),
      description:
        action.description === undefined || action.description === null ? '' : String(action.description),
      danger: !!action.danger,
      run: typeof action.run === 'function' ? action.run : () => REFRESH,
    }));
  return {
    title: src.title === undefined || src.title === null ? '' : String(src.title),
    summary,
    sections,
    actions,
    hint: src.hint === undefined || src.hint === null ? t('tui.hint.report') : String(src.hint),
    initialSection: src.initialSection,
    status: src.status === undefined || src.status === null ? '' : String(src.status),
  };
}

/**
 * Section heading with a rule that fills the remaining width: `── versions ─────`.
 * 分区标题加一条填满剩余宽度的横线：`── 版本 ─────`。
 */
function sectionHeading(title, width) {
  const glyph = layout.glyphs().boxH;
  const label = ` ${title} `;
  const room = Math.max(0, Math.floor(width) - displayWidth(label) - 2);
  return colors.dim(`${glyph.repeat(2)}${label}${glyph.repeat(room)}`);
}

/**
 * Fit one label/detail/extra row into the width. The extra column disappears on narrow terminals,
 * which is what keeps a name, a state and a size readable on 60 columns.
 *
 * 把「标签 + 说明 + 次要列」放进可用宽度。窄终端会去掉次要列，
 * 这样 60 列宽时名称、状态与大小仍然读得出来。
 */
function rowText(row, width, labelWidth, narrow) {
  const paint = row.color || ((text) => text);
  const label = paint(padTo(truncateTo(row.label, labelWidth), labelWidth));
  const extra = narrow ? '' : row.extra;
  const description = [row.detail, extra].filter(Boolean).join(` ${layout.glyphs().bullet} `);
  const room = Math.max(0, Math.floor(width) - labelWidth - 4);
  if (!description || room < 6) return `  ${label}`;
  return `  ${label}  ${colors.dim(truncateTo(description, room))}`;
}

/**
 * Build every line of the page plus the navigation metadata the scroll window needs.
 *
 * Selectable entries are rows of sections that provide `onEnter`, followed by the action rows. A
 * read-only section (facts, the "no changes" notice) is still rendered, it just cannot be selected.
 *
 *
 * 生成整页文本行，以及滚动视窗需要的导航信息。
 *
 * 可选中项 = 提供 `onEnter` 的分区的行 + 操作行。只读分区（说明、无变化提示）照常渲染，
 * 只是不能选中。
 *
 * @param {object} model report model (normalized here)
 * @param {number} width available display width
 * @returns {{
 *   lines: string[], entries: Array<object>, headingLines: Set<number>,
 *   headingOfLine: Map<number, number>
 * }}
 */
function buildPageLayout(model, width) {
  const report = normalizeReport(model);
  const limit = Math.max(20, Math.floor(width) || 80);
  const narrow = limit < NARROW_WIDTH;
  const lines = [];
  const entries = [];
  const headingLines = new Set();
  const headingOfLine = new Map();

  // Summary facts: one aligned column, clipped by display width so CJK paths never wrap.
  // 摘要信息：标签列对齐，按显示宽度裁剪，中文路径不会折行。
  if (report.summary.length) {
    const labelWidth = report.summary.reduce((max, fact) => Math.max(max, displayWidth(fact.label)), 0);
    const valueWidth = Math.max(8, limit - labelWidth - 4);
    for (const fact of report.summary) {
      const paint = fact.color || ((text) => text);
      lines.push(
        `  ${colors.dim(padTo(fact.label, labelWidth))}  ${paint(truncateTo(fact.value, valueWidth))}`
      );
    }
    lines.push('');
  }

  for (let index = 0; index < report.sections.length; index++) {
    const section = report.sections[index];
    const headingLine = lines.length;
    headingLines.add(headingLine);
    headingOfLine.set(headingLine, headingLine);
    lines.push(sectionHeading(section.title, limit));

    if (section.rows.length) {
      const labelCap = Math.max(10, Math.floor(limit * 0.45));
      const labelWidth = Math.min(
        labelCap,
        section.rows.reduce((max, row) => Math.max(max, displayWidth(row.label)), 0)
      );
      for (const row of section.rows) {
        const line = lines.length;
        headingOfLine.set(line, headingLine);
        if (section.onEnter) entries.push({ kind: 'row', line, section, sectionIndex: index, row });
        lines.push(rowText(row, limit, labelWidth, narrow));
        if (row.sub) {
          // A detail that must stay readable (a folder, a URL) gets its own indented line, full width.
          // 必须完整可读的细节（目录、URL）单独占一行，用整行宽度。
          headingOfLine.set(lines.length, headingLine);
          lines.push(colors.dim(`    ${truncateTo(row.sub, Math.max(4, limit - 4))}`));
        }
      }
    } else if (section.emptyText) {
      const paint = section.emptyColor || colors.dim;
      headingOfLine.set(lines.length, headingLine);
      lines.push(paint(`  ${truncateTo(section.emptyText, Math.max(4, limit - 4))}`));
    }
    lines.push('');
  }

  // Actions: always the last section, always selectable.
  // 操作区：永远在最后，永远可选中。
  if (report.actions.length) {
    const headingLine = lines.length;
    headingLines.add(headingLine);
    headingOfLine.set(headingLine, headingLine);
    lines.push(sectionHeading(t('tui.report.actions'), limit));
    const labelWidth = report.actions.reduce((max, action) => Math.max(max, displayWidth(action.label)), 0);
    for (const action of report.actions) {
      const line = lines.length;
      headingOfLine.set(line, headingLine);
      entries.push({ kind: 'action', line, action });
      const paint = action.danger ? colors.yellow : (text) => text;
      const label = paint(padTo(truncateTo(action.label, labelWidth), labelWidth));
      const room = Math.max(0, limit - labelWidth - 4);
      const description = action.description ? truncateTo(action.description, room) : '';
      lines.push(`  ${label}${description && room >= 6 ? `  ${colors.dim(description)}` : ''}`);
    }
  }

  if (report.status) {
    lines.push('');
    lines.push(colors.dim(truncateTo(report.status, Math.max(4, limit - 2))));
  }

  return { lines, entries, headingLines, headingOfLine };
}


module.exports = {
  NARROW_WIDTH,
  normalizeRow,
  normalizeReport,
  sectionHeading,
  rowText,
  buildPageLayout,
};
