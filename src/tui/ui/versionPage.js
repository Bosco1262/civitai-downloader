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
const layout = require('../layout');
const view = require('../view');
const screen = require('../screen');
const list = require('./list');
const { color } = require('../tokens');

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
  const state = {
    cursor: initialCursor,
    windowStart: 0,
    selected: new Set(Array.from(options.selected || [], String)),
  };
  if (multi && !state.selected.size && rows[initialCursor]) {
    state.selected.add(String(rows[initialCursor].modelId));
  }
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
      lines.push(
        color.muted(
          multi
            ? t('tui.models.pageVersionsSelected', {
                selected: state.selected.size,
                total: rows.length,
              })
            : t('tui.models.pageVersions', { count: rows.length })
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
        const rest = truncateTo(describe(row), Math.max(8, width - nameWidth - 4));
        lines.push(`${marker} ${checked}${active ? color.emphasis(label) : label}  ${color.muted(rest)}`);
      }
      if (rows.length > win.end - win.start) {
        lines.push(color.muted(t('tui.pages.listPosition', { index: state.cursor + 1, total: rows.length })));
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
          const id = String(row.modelId);
          if (state.selected.has(id)) state.selected.delete(id);
          else state.selected.add(id);
        }
      } else if (name_ === 'return') {
        if (!multi) {
          entry.settle(rows[state.cursor] && rows[state.cursor].modelId);
        } else if (state.selected.size) {
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
