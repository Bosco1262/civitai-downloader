'use strict';

/**
 * Download plan workspace: an input region, a result line, the selected rows and a next action.
 *
 * `Tab` moves focus between the regions; `Enter` runs the focused region. The caller supplies the
 * network side (`resolveInput`, `openRow`), so the workspace stays free of download details.
 *
 *
 * 下载计划工作台：输入区域、结果行、已选行与下一步动作。
 *
 * `Tab` 在区域间切换焦点；`Enter` 执行当前焦点区域。网络部分由调用方提供
 * （`resolveInput`、`openRow`），因此本组件不关心下载细节。
 */

const { t } = require('../../i18n');
const layout = require('../layout');
const tokens = require('../tokens');
const view = require('../view');
const screen = require('../screen');
const list = require('./list');
const { isTextInput } = require('../keys');

const { color, glyph } = tokens;
const { truncateTo, displayWidth } = layout;

/**
 * One line of a boxed input field, mirroring the text field's look.
 * 与文本输入框一致的一行带框输入。
 */
function inputLine(state) {
  const shown = state.input || '';
  const cursor = state.region === 'input' ? color.selection(' ') : ' ';
  return `${color.muted(t('tui.workspace.search'))} ${shown}${cursor}`;
}

/**
 * One selected-row line.
 * 一行已选行。
 */
function rowLine(row, cursor, focused, width) {
  const mark = focused && cursor ? color.cursor(layout.glyphs().cursor) : ' ';
  const box = view.checkbox(!!row.selected);
  const label = truncateTo(String(row.name || row.modelId || ''), Math.max(12, Math.floor(width / 3)));
  const detail = row.detail ? color.muted(truncateTo(String(row.detail), Math.max(8, width - displayWidth(label) - 12))) : '';
  return `${mark} ${box} ${label}${detail ? `  ${detail}` : ''}`;
}

/**
 * Show the workspace and settle with the selected rows, or null when cancelled.
 * 显示工作台，结束时返回选中的行；取消时返回 null。
 *
 * @param {object} opts
 * @returns {Promise<any>}
 */
async function showPlanWorkspace(opts = {}) {
  const state = {
    region: 'input',
    input: '',
    error: '',
    busy: false,
    cursor: 0,
    rows: Array.isArray(opts.rows) ? opts.rows.slice() : [],
    selected: opts.selected instanceof Set ? new Set(opts.selected) : new Set(opts.selected || []),
  };
  const width = 100;

  return screen.prompt({
    title: opts.title || '',
    crumbPath: opts.crumbPath,
    steps: opts.steps,
    handlesHelp: true,
    hints: () => [t('tui.hint.workspace')],
    render(_promptState, ctx) {
      const lines = [];
      const room = Math.max(3, Math.floor(ctx.rows) || 3);
      if (state.busy) lines.push(color.muted(t('tui.workspace.busy')));
      if (opts.inputLabel) lines.push(color.emphasis(opts.inputLabel));
      if (opts.resolveInput) lines.push(inputLine(state));
      if (state.error) lines.push(color.danger(`  ${state.error}`));
      if (state.result) lines.push(color.muted(`  ${truncateTo(state.result, Math.max(8, ctx.width - 4))}`));
      if (state.rows.length) {
        lines.push(color.muted(t('tui.workspace.selected', { count: state.rows.filter((row) => state.selected.has(String(opts.idOf(row)))).length, total: state.rows.length })));
        const roomRows = Math.max(1, room - lines.length - 2);
        const win = list.windowOf(state.rows.length, state.cursor, roomRows, state.windowStart || 0);
        state.windowStart = win.start;
        for (let index = win.start; index < win.end; index++) {
          const row = state.rows[index];
          const decorated = { ...row, selected: state.selected.has(String(opts.idOf(row))) };
          lines.push(rowLine(decorated, index === state.cursor, state.region === 'selected', ctx.width));
        }
        if (win.end - win.start < state.rows.length) {
          lines.push(color.muted(t('tui.pages.listPosition', { index: state.cursor + 1, total: state.rows.length })));
        }
      } else {
        lines.push(color.muted(opts.emptyText || t('tui.workspace.empty')));
      }
      lines.push('');
      lines.push(
        state.region === 'next'
          ? color.accent(`▸ ${opts.nextLabel || t('tui.workspace.next')}`)
          : color.muted(`  ${opts.nextLabel || t('tui.workspace.next')}`)
      );
      return lines.slice(0, room);
    },
    async onKey(text, key, entry) {
      const name = key && key.name;
      const typed = String(text === undefined || text === null ? '' : text);
      const ctrl = !!key.ctrl;

      if (name === 'escape') {
        entry.settle(null);
        return;
      }
      if (name === 'tab' || typed === '\t') {
        const regions = opts.resolveInput ? ['input', 'selected', 'next'] : ['selected', 'next'];
        const index = regions.indexOf(state.region);
        state.region = regions[(index + 1 + regions.length) % regions.length] || regions[0];
        entry.state = state;
        return;
      }
      if (typed === '?' && state.region !== 'input') {
        require('../pages').showHelp({});
        return;
      }
      if (name === 'up' && state.region === 'selected') {
        state.cursor = list.moveCursor(state.cursor, -1, state.rows.length, 'form');
        entry.state = state;
        return;
      }
      if (name === 'down' && state.region === 'selected') {
        state.cursor = list.moveCursor(state.cursor, 1, state.rows.length, 'form');
        entry.state = state;
        return;
      }
      if (state.region === 'selected' && (typed === ' ' || name === 'space')) {
        const row = state.rows[state.cursor];
        if (row) {
          const id = String(opts.idOf(row));
          if (state.selected.has(id)) state.selected.delete(id);
          else state.selected.add(id);
        }
        entry.state = state;
        return;
      }
      if (state.region === 'input' && opts.resolveInput && !ctrl && isTextInput(typed, key)) {
        state.input += typed;
        state.error = '';
        state.result = '';
        entry.state = state;
        return;
      }
      if (state.region === 'input' && name === 'backspace') {
        state.input = state.input.slice(0, -1);
        state.error = '';
        entry.state = state;
        return;
      }
      if (name !== 'return') return;

      if (state.region === 'input' && typeof opts.resolveInput === 'function') {
        if (!String(state.input).trim()) {
          state.error = t('tui.workspace.emptyInput');
          entry.state = state;
          return;
        }
        state.busy = true;
        entry.state = state;
        screen.refresh();
        try {
          const rows = (await opts.resolveInput(state.input)) || [];
          const usable = rows.filter((row) => row && !row.error);
          if (!usable.length) {
            state.result = t('tui.workspace.noResult');
          } else {
            for (const row of usable) {
              const id = String(opts.idOf(row));
              if (!state.rows.some((existing) => String(opts.idOf(existing)) === id)) state.rows.push(row);
              state.selected.add(id);
            }
            /*
             * Adding results must not leave the cursor on the last row: when focus moves to the
             * list, the first selectable row is the predictable starting point.
             *
             * 添加结果后不能把光标留在最后一行：焦点切到列表时，第一行才是可预期的起点。
             */
            state.cursor = 0;
            state.result = usable.map((row) => row.name || row.modelId).join(glyph.separator);
            state.input = '';
            state.error = '';
          }
        } catch (e) {
          state.error = String((e && e.message) || e);
        } finally {
          state.busy = false;
        }
        entry.state = state;
        screen.refresh();
        return;
      }
      if (state.region === 'selected' && typeof opts.openRow === 'function') {
        const row = state.rows[state.cursor];
        if (!row) return;
        state.busy = true;
        entry.state = state;
        screen.refresh();
        try {
          const rows = await opts.openRow(row, state);
          if (Array.isArray(rows)) {
            const id = String(opts.idOf(row));
            const index = state.rows.findIndex((existing) => String(opts.idOf(existing)) === id);
            if (index >= 0) {
              state.rows.splice(index, 1, ...rows);
              for (const next of rows) state.selected.add(String(opts.idOf(next)));
            }
          }
        } catch (e) {
          state.error = String((e && e.message) || e);
        } finally {
          state.busy = false;
        }
        entry.state = state;
        screen.refresh();
        return;
      }
      if (state.region === 'next') {
        const selected = state.rows.filter((row) => state.selected.has(String(opts.idOf(row))));
        entry.settle(selected.length ? { rows: selected, selected: state.selected } : null);
      }
    },
  });
}

module.exports = {
  showPlanWorkspace,
};
