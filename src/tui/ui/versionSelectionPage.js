'use strict';

/**
 * Desired-state version selector: checked means "keep this version on disk".
 *
 * Used by model management (and reachable from collection members through the model page). Pinned
 * versions are locked on; unchecking an installed version asks the caller to delete it.
 *
 *
 * 期望状态版本选择器：勾选表示“本地保留这个版本”。
 *
 * 模型管理使用；收藏集成员通过模型页复用。固定版本锁定为勾选；
 * 取消已安装版本会由调用方执行删除。
 */

const { t } = require('../../i18n');
const layout = require('../layout');
const view = require('../view');
const screen = require('../screen');
const list = require('./list');
const { color } = require('../tokens');

const { displayWidth, truncateTo } = layout;

/**
 * Show the selector and settle with a Set of version ids to keep, or null when cancelled.
 * 显示选择器，返回要保留的版本 ID 集合；取消时返回 null。
 *
 * @param {object} opts
 * @returns {Promise<Set<string>|null>}
 */
async function showVersionSelectionPage(opts = {}) {
  const rows = Array.isArray(opts.versions) ? opts.versions : [];
  const state = {
    cursor: 0,
    windowStart: 0,
    selected: new Set(Array.from(opts.selected || [], String)),
  };
  const describe = typeof opts.describe === 'function' ? opts.describe : () => '';
  const nameWidth = Math.min(
    30,
    rows.reduce((max, row) => Math.max(max, displayWidth(String(row.name || row.versionId))), 0)
  );

  return screen.prompt({
    title: opts.title || '',
    crumbPath: opts.crumbPath,
    steps: opts.steps,
    handlesHelp: true,
    hints: () => [t('tui.hint.versionSelection')],
    render(_state, ctx) {
      const width = Math.max(20, Math.floor(ctx.width) || 80);
      const room = Math.max(3, Math.floor(ctx.rows) || 3);
      const lines = [
        color.muted(
          t('tui.versionSelection.selected', {
            count: state.selected.size,
            total: rows.length,
          })
        ),
        '',
      ];
      const listRoom = Math.max(1, room - lines.length);
      const win = list.windowOf(rows.length, state.cursor, listRoom, state.windowStart);
      state.windowStart = win.start;
      for (let index = win.start; index < win.end; index++) {
        const row = rows[index];
        const id = String(row.versionId);
        const active = index === state.cursor;
        const marker = active ? color.cursor(layout.glyphs().cursor) : ' ';
        const box = view.checkbox(state.selected.has(id));
        const label = view.padTo(String(row.name || id), nameWidth);
        const rest = describe(row);
        const lock = row.pinned ? ` ${color.warning(t('tui.versionSelection.pinned'))}` : '';
        lines.push(
          `${marker} ${box} ${active ? color.emphasis(label) : label}  ${color.muted(
            truncateTo(rest, Math.max(8, width - nameWidth - 4))
          )}${lock}`
        );
      }
      if (rows.length > win.end - win.start) {
        lines.push(color.muted(t('tui.pages.listPosition', { index: state.cursor + 1, total: rows.length })));
      }
      return lines;
    },
    onKey(text, key, entry) {
      const name = key && key.name;
      if (name === 'escape') {
        entry.settle(null);
        return;
      }
      if (name === 'up') state.cursor = list.moveCursor(state.cursor, -1, rows.length, 'table');
      else if (name === 'down') state.cursor = list.moveCursor(state.cursor, 1, rows.length, 'table');
      else if (name === 'pageup') state.cursor = list.pageCursor(state.cursor, -1, rows.length, 8, 'table');
      else if (name === 'pagedown') state.cursor = list.pageCursor(state.cursor, 1, rows.length, 8, 'table');
      else if (name === 'home') state.cursor = list.homeCursor();
      else if (name === 'end') state.cursor = list.endCursor(rows.length);
      else if (name === 'return') entry.settle(new Set(state.selected));
      else if (name === 'space' || text === ' ') {
        const row = rows[state.cursor];
        if (!row || row.pinned) return;
        const id = String(row.versionId);
        if (state.selected.has(id)) state.selected.delete(id);
        else state.selected.add(id);
      } else return;
      entry.state = state;
    },
  });
}

module.exports = {
  showVersionSelectionPage,
};
