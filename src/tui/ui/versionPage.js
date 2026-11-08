'use strict';

/**
 * Model version page: model facts on top, a selectable version list below.
 *
 * The page is a thin renderer; the caller supplies version rows and the description function.
 *
 *
 * 模型版本页：顶部是模型信息，下方是可选择的版本列表。
 *
 * 本页只负责渲染；版本行与描述函数由调用方提供。
 */

const { t } = require('../../i18n');
const { formatBytes } = require('../../util');
const layout = require('../layout');
const view = require('../view');
const screen = require('../screen');
const list = require('./list');
const { color } = require('../tokens');
const { accessLabel, accessColor } = require('./accessText');

const { displayWidth, truncateTo } = layout;

/**
 * Show the version page and settle with the selected version id, or null when cancelled.
 * In multi mode it also supports Space toggling and settles with an array of version ids.
 *
 * 显示版本页，返回选中的版本 ID；取消时返回 null。
 * 多选模式额外支持空格勾选，并以版本 ID 数组结束。
 *
 * @param {object} detail
 * @param {Array<object>} rows
 * @param {number} initialCursor
 * @param {(row:object)=>string} describe
 * @param {{multi?:boolean, selected?:Array<string|number>, steps?:object}} [options]
 * @returns {Promise<string|string[]|null>}
 */
async function showVersionPage(detail, rows, initialCursor, describe, options = {}) {
  const multi = !!options.multi;
  // The caller owns the selection: an empty `selected` means "nothing is checked", never "guess one".
  // 勾选状态由调用方决定：空的 `selected` 就是「一个都没勾」，页面不再自行补勾。
  const state = {
    cursor: initialCursor,
    windowStart: 0,
    selected: new Set(Array.from(options.selected || [], String)),
  };
  const name = String(detail.name || detail.id || '');
  const baseModels = [...new Set(rows.map((row) => row.baseModel).filter(Boolean))];
  const facts = [];
  if (detail.type) facts.push(String(detail.type));
  if (baseModels.length) facts.push(baseModels.join(' / '));
  const author = detail.creator && detail.creator.username ? String(detail.creator.username) : '';
  if (author) facts.push(t('tui.models.pageAuthor', { author }));
  const downloads = detail.stats && Number(detail.stats.downloadCount);
  if (Number.isFinite(downloads) && downloads > 0) {
    facts.push(t('tui.models.pageDownloads', { count: String(downloads) }));
  }
  const downloaded = rows.filter((row) => row.downloaded).length;
  if (downloaded) facts.push(t('tui.models.pageDownloaded', { count: downloaded }));

  const nameWidth = Math.min(30, rows.reduce((max, row) => Math.max(max, displayWidth(row.name)), 0));

  return screen.prompt({
    title: t('tui.app.downloadModel'),
    /*
     * This is a modal sub-page of the download workspace: keep the existing path and steps.
     * 这是下载工作台的模态子页：保留已有路径与步骤。
     */
    crumb: false,
    steps: options.steps,
    hints: () => [t(multi ? 'tui.hint.downloadVersionMulti' : 'tui.hint.modelVersion')],
    render(_state, ctx) {
      const width = Math.max(20, Math.floor(ctx.width) || 80);
      const room = Math.max(3, Math.floor(ctx.rows) || 3);
      const lines = [color.emphasis(truncateTo(name, width))];
      if (facts.length) {
        lines.push(color.muted(truncateTo(facts.join(` ${layout.glyphs().bullet} `), width)));
      }
      lines.push('');
      const selectedBytes = rows
        .filter((row) => state.selected.has(String(row.modelId)))
        .reduce((sum, row) => sum + (Number(row.totalBytes) || 0), 0);
      const versionMeta = multi
        ? t('tui.models.pageVersionsSelected', {
          selected: state.selected.size,
          total: rows.length,
          size: formatBytes(selectedBytes),
        })
        : t('tui.models.pageVersions', { count: rows.length });
      lines.push(
        color.muted(
          `${versionMeta} ${layout.glyphs().separator} ${t('tui.pages.listPosition', {
            index: Math.min(rows.length, state.cursor + 1),
            total: rows.length,
          })}`
        )
      );

      const listRoom = Math.max(1, room - lines.length - 1);
      const win = list.windowOf(rows.length, state.cursor, listRoom, state.windowStart);
      state.windowStart = win.start;
      for (let index = win.start; index < win.end; index++) {
        const row = rows[index];
        const active = index === state.cursor;
        const marker = active ? color.cursor(layout.glyphs().cursor) : ' ';
        const checked = multi ? `${view.checkbox(state.selected.has(String(row.modelId)))} ` : '';
        const label = view.padTo(row.name, nameWidth);
        const badge = accessLabel(row.access);
        const badgeText = badge ? ` [${badge}]` : '';
        const described = String(describe(row) || '');
        /*
         * `describe` may already append the access label (`describeVersion` does): never print the
         * same badge twice on one row.
         *
         * `describe` 可能已经把访问标签拼进描述（`describeVersion` 就是如此）：同一行不重复显示徽标。
         */
        const text = badge && !described.includes(badge) ? `${described}${badgeText}` : described;
        const rest = truncateTo(text, Math.max(8, width - nameWidth - 4));
        const paintBadge = badge ? accessColor(row.access) : (paint) => paint;
        const description = badge && rest.endsWith(badgeText)
          ? `${color.muted(rest.slice(0, -badgeText.length))}${paintBadge(badgeText)}`
          : color.muted(rest);
        lines.push(`${marker} ${checked}${active ? color.emphasis(label) : label}  ${description}`);
      }
      return lines;
    },
    onKey(text, key, entry) {
      const name_ = key && key.name;
      if (name_ === 'up') state.cursor = list.moveCursor(state.cursor, -1, rows.length, 'table');
      else if (name_ === 'down') state.cursor = list.moveCursor(state.cursor, 1, rows.length, 'table');
      else if (name_ === 'pageup') state.cursor = list.pageCursor(state.cursor, -1, rows.length, 8, 'table');
      else if (name_ === 'pagedown') state.cursor = list.pageCursor(state.cursor, 1, rows.length, 8, 'table');
      else if (name_ === 'home') state.cursor = list.homeCursor();
      else if (name_ === 'end') state.cursor = list.endCursor(rows.length);
      else if (multi && (name_ === 'space' || text === ' ')) {
        const row = rows[state.cursor];
        if (row) {
          if (row.access && row.access.kind === 'unavailable') {
            view.notice(t('tui.access.unavailable'), color.danger);
            return;
          }
          const id = String(row.modelId);
          if (state.selected.has(id)) state.selected.delete(id);
          else state.selected.add(id);
        }
      } else if (name_ === 'return') {
        if (!multi) {
          const row = rows[state.cursor];
          if (row && row.access && row.access.kind === 'unavailable') {
            view.notice(t('tui.access.unavailable'), color.danger);
            return;
          }
          entry.settle(row && row.modelId);
        } else {
          /*
           * Applying an empty selection is meaningful: it means "do not download this model this
           * time". `Esc` stays the "discard my edits" path.
           *
           * 应用空勾选是有意义的：表示「这次不下载这个模型」。`Esc` 仍然是「放弃本次修改」。
           */
          const picked = [];
          for (const row of rows) {
            if (state.selected.has(String(row.modelId))) picked.push(String(row.modelId));
          }
          entry.settle(picked);
        }
      } else return;
      entry.state = state;
    },
    onEscape(entry) {
      entry.settle(null);
      return true;
    },
  });
}

module.exports = {
  showVersionPage,
};
