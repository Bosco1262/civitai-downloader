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
const { accessLabel, accessColor } = require('./accessText');
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
  const badge = accessLabel(row.access);
  const badgeText = badge ? `[${badge}]` : '';
  const detailRoom = Math.max(8, width - displayWidth(label) - displayWidth(badgeText) - 12);
  const detail = [
    badgeText ? accessColor(row.access)(badgeText) : '',
    row.detail ? color.muted(truncateTo(String(row.detail), detailRoom)) : '',
  ].filter(Boolean).join(' ');
  return `${mark} ${box} ${label}${detail ? `  ${detail}` : ''}`;
}

/**
 * Cycle a filter through "all" and the supplied values.
 * 在「全部」和候选值之间循环切换过滤条件。
 */
function cycleFilter(values, current) {
  const options = [null, ...values];
  const index = options.findIndex((value) => value === current);
  return options[(index + 1 + options.length) % options.length];
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
    region: opts.resolveInput ? 'input' : 'selected',
    input: '',
    error: '',
    busy: false,
    busyText: '',
    cursor: 0,
    windowStart: 0,
    searching: false,
    query: '',
    type: null,
    baseModel: null,
    status: null,
    accessFilter: 'all',
    sort: 'default',
    rows: Array.isArray(opts.rows) ? opts.rows.slice() : [],
    selected: opts.selected instanceof Set ? new Set(opts.selected) : new Set(opts.selected || []),
  };

  /**
   * One row's base-model values: the deduplicated list when the caller supplies it.
   * 一行的基础模型取值：调用方给了去重列表就用它。
   */
  function baseModelsOf(row) {
    const values = Array.isArray(row.baseModels) ? row.baseModels : [row.baseModel];
    return values.filter(Boolean).map(String);
  }

  function valuesOf(field) {
    if (field === 'baseModel') {
      /*
       * Candidates come from every version of every row, not from the joined display string:
       * "MOSS Image / Krea 2" must offer two values, not one.
       *
       * 候选值来自每行的每个版本，而不是拼接后的展示字符串：
       * 「MOSS Image / Krea 2」要提供两个值，而不是一个。
       */
      return [...new Set(state.rows.flatMap((row) => baseModelsOf(row)))].sort();
    }
    return [...new Set(state.rows.map((row) => String(row[field] || '')).filter(Boolean))].sort();
  }

  function filteredRows() {
    const keyword = state.query.trim().toLowerCase();
    const visible = state.rows.filter((row) => {
      if (state.type && String(row.type || '') !== state.type) return false;
      // Contains-match: a row with versions on both base models shows up under either filter.
      // 包含匹配：同时含两个基础模型版本的行，在两种筛选下都会出现。
      if (state.baseModel && !baseModelsOf(row).includes(String(state.baseModel))) return false;
      if (state.status === 'downloaded' && !row.downloaded) return false;
      if (state.status === 'new' && row.downloaded) return false;
      const restricted = !!(row.access && row.access.requiresEntitlement);
      if (state.accessFilter === 'free' && restricted) return false;
      if (state.accessFilter === 'paid' && !restricted) return false;
      if (!keyword) return true;
      return [row.name, row.type, row.baseModel, row.detail, row.modelId]
        .filter(Boolean)
        .some((value) => String(value).toLowerCase().includes(keyword));
    });
    if (state.sort === 'name') {
      visible.sort((a, b) => String(a.name || '').localeCompare(String(b.name || ''), 'zh-Hans-CN'));
    } else if (state.sort === 'size') {
      visible.sort((a, b) => (Number(b.totalBytes) || 0) - (Number(a.totalBytes) || 0));
    }
    return visible;
  }

  function selectedIds(rows) {
    return rows.filter((row) => state.selected.has(String(opts.idOf(row))));
  }

  function summaryLine(visible) {
    const chosen = state.rows.filter((row) => state.selected.has(String(opts.idOf(row))));
    const bytes = chosen.reduce((sum, row) => sum + (Number(row.totalBytes) || 0), 0);
    const restricted = state.rows.filter((row) => row.access && row.access.requiresEntitlement);
    const selectedRestricted = chosen.filter((row) => row.access && row.access.requiresEntitlement);
    const filters = [
      state.query ? t('tui.workspace.filterSearch', { value: state.query }) : '',
      state.type || '',
      state.baseModel || '',
      state.status === 'downloaded'
        ? t('tui.workspace.filterDownloaded')
        : state.status === 'new'
          ? t('tui.workspace.filterNew')
          : '',
      state.accessFilter === 'free'
        ? t('tui.workspace.accessFree')
        : state.accessFilter === 'paid'
          ? t('tui.workspace.accessPaid')
          : '',
      state.sort === 'name'
        ? t('tui.workspace.sortName')
        : state.sort === 'size'
          ? t('tui.workspace.sortSize')
          : '',
    ].filter(Boolean);
    const access = restricted.length
      ? ` ${glyph.separator}${t('tui.workspace.accessStats', {
        selected: selectedRestricted.length,
        total: restricted.length,
      })}`
      : '';
    const position = visible.length
      ? ` ${glyph.separator}${t('tui.workspace.position', {
        index: Math.min(visible.length, state.cursor + 1),
        total: visible.length,
      })}`
      : '';
    return t('tui.workspace.selectionSummary', {
      selected: chosen.length,
      visible: visible.length,
      total: state.rows.length,
      size: tokens.format.bytes(bytes),
      filters: filters.length ? ` ${glyph.separator}${filters.join(` ${glyph.bullet} `)}` : '',
    }) + access + position;
  }

  function hintForRegion() {
    if (state.region === 'input') return t('tui.hint.workspaceInput');
    if (state.region === 'next') return t('tui.hint.workspaceNext');
    if (state.searching) return t('tui.hint.workspaceSearch');
    return t('tui.hint.workspace');
  }

  function compactHintForRegion() {
    if (state.region === 'input') return t('tui.hint.workspaceCompactInput');
    if (state.region === 'next') return t('tui.hint.workspaceCompactNext');
    if (state.searching) return t('tui.hint.workspaceCompactSearch');
    return t('tui.hint.workspaceCompactSelected');
  }

  return screen.prompt({
    title: opts.title || '',
    crumbPath: opts.crumbPath,
    steps: opts.steps,
    handlesHelp: true,
    hints: () => [hintForRegion()],
    compactHints: () => [compactHintForRegion()],
    status: () => (state.busy ? state.busyText || t('tui.workspace.busy') : null),
    render(_promptState, ctx) {
      const room = Math.max(3, Math.floor(ctx.rows) || 3);
      const head = [];
      if (opts.inputLabel) head.push(color.emphasis(opts.inputLabel));
      if (opts.resolveInput) head.push(inputLine(state));
      if (opts.resultLabel) {
        const value = state.result ? `  ${truncateTo(state.result, Math.max(8, ctx.width - displayWidth(opts.resultLabel) - 4))}` : '';
        head.push(`${color.muted(opts.resultLabel)}${value}`);
      } else if (state.result) {
        head.push(color.muted(`  ${truncateTo(state.result, Math.max(8, ctx.width - 4))}`));
      }
      if (state.error) head.push(color.danger(`  ${state.error}`));
      if (Array.isArray(opts.metaFailed) && opts.metaFailed.length) {
        head.push(
          color.warning(
            `  ${truncateTo(
              t('tui.workspace.metaFailed', {
                count: opts.metaFailed.length,
                names: opts.metaFailed.slice(0, 3).join(glyph.separator),
              }),
              Math.max(12, ctx.width)
            )}`
          )
        );
      }
      const restrictedCount = state.rows.filter(
        (row) => row.access && row.access.requiresEntitlement
      ).length;
      if (restrictedCount) {
        head.push(color.warning(`! ${t('tui.access.warning', { count: restrictedCount })}`));
      }
      const visible = filteredRows();
      state.cursor = Math.max(0, Math.min(visible.length - 1, state.cursor));

      // The action line owns the bottom of the page even when every row above it overflows.
      // Reserve its blank separator and the button first, then allocate the remaining lines.
      //
      // 操作行始终占据页面底部：即使上方列表溢出，也先为分隔空行和按钮预留空间，再分配正文。
      const footer = ['', state.region === 'next' && selectedIds(state.rows).length > 0
        ? color.accent(`▸ ${opts.nextLabel || t('tui.workspace.next')}`)
        : color.muted(`  ${opts.nextLabel || t('tui.workspace.next')}`)];
      const available = Math.max(1, room - footer.length);
      const headBudget = Math.max(0, available - 3);
      const shownHead = head.length > headBudget ? head.slice(head.length - headBudget) : head;
      const fixed = [
        ...shownHead,
        '',
        color.muted(truncateTo(summaryLine(visible), Math.max(12, ctx.width))),
      ];
      if (state.searching) fixed.push(color.accent(`/ ${state.query}`));

      // Keep at least one model row on very short terminals, even if that means dropping the summary.
      // 终端极矮时至少保留一行模型，必要时让摘要先让位。
      const lines = fixed.slice(0, Math.max(0, available - (visible.length ? 1 : 0)));
      const listRoom = Math.max(0, available - lines.length);
      if (visible.length && listRoom > 0) {
        const rowRoom = Math.max(1, listRoom);
        const win = list.windowOf(visible.length, state.cursor, rowRoom, state.windowStart || 0);
        state.windowStart = win.start;
        for (let index = win.start; index < win.end && lines.length < available; index++) {
          const row = visible[index];
          const decorated = { ...row, selected: state.selected.has(String(opts.idOf(row))) };
          lines.push(rowLine(decorated, index === state.cursor, state.region === 'selected', ctx.width));
        }
      } else if (!visible.length && lines.length < available) {
        lines.push(color.muted(state.rows.length ? t('tui.workspace.noMatches') : opts.emptyText || t('tui.workspace.empty')));
      }
      return [...lines.slice(0, available), ...footer];
    },
    async onKey(text, key, entry) {
      const name = key && key.name;
      const typed = String(text === undefined || text === null ? '' : text);
      const ctrl = !!key.ctrl;

      // Network work owns the screen until it settles: repeated Enter must not start it twice.
      // 网络操作占住屏幕直到结束：连续按 Enter 不能启动两次。
      if (state.busy) return;

      if (state.searching) {
        if (name === 'escape') {
          state.searching = false;
          state.query = '';
          state.cursor = 0;
          state.windowStart = 0;
          return;
        }
        if (name === 'return') {
          state.searching = false;
          return;
        }
        if (name === 'backspace') {
          state.query = state.query.slice(0, -1);
          state.cursor = 0;
          state.windowStart = 0;
          return;
        }
        if (isTextInput(typed, key)) {
          state.query += typed;
          state.cursor = 0;
          state.windowStart = 0;
        }
        return;
      }
      if (name === 'escape') {
        entry.settle(null);
        return;
      }
      if (name === 'tab' || typed === '\t') {
        const regions = opts.resolveInput ? ['input', 'selected', 'next'] : ['selected', 'next'];
        const index = regions.indexOf(state.region);
        state.region = regions[(index + 1 + regions.length) % regions.length] || regions[0];
        return;
      }
      if (typed === '?' && state.region !== 'input') {
        await require('../pages').showHelp({});
        return;
      }

      const visible = filteredRows();
      if (state.region === 'selected') {
        state.cursor = Math.max(0, Math.min(visible.length - 1, state.cursor));
        if (name === 'up') {
          state.cursor = list.moveCursor(state.cursor, -1, visible.length, 'form');
          return;
        }
        if (name === 'down') {
          state.cursor = list.moveCursor(state.cursor, 1, visible.length, 'form');
          return;
        }
        if (name === 'home') {
          state.cursor = 0;
          return;
        }
        if (name === 'end') {
          state.cursor = Math.max(0, visible.length - 1);
          return;
        }
        if (name === 'pageup' || name === 'pagedown') {
          const delta = name === 'pageup' ? -10 : 10;
          state.cursor = Math.max(0, Math.min(visible.length - 1, state.cursor + delta));
          return;
        }
        if (typed === ' ' || name === 'space') {
          const row = visible[state.cursor];
          if (row) {
            const id = String(opts.idOf(row));
            if (state.selected.has(id)) state.selected.delete(id);
            else state.selected.add(id);
          }
          return;
        }
        if (ctrl) return;
        if (typed === '/') {
          state.searching = true;
          state.error = '';
          return;
        }
        if (typed === 'a') {
          const ids = visible.map((row) => String(opts.idOf(row)));
          const all = ids.length > 0 && ids.every((id) => state.selected.has(id));
          for (const id of ids) {
            if (all) state.selected.delete(id);
            else state.selected.add(id);
          }
          state.error = '';
          return;
        }
        if (typed === 'i') {
          for (const row of visible) {
            const id = String(opts.idOf(row));
            if (state.selected.has(id)) state.selected.delete(id);
            else state.selected.add(id);
          }
          state.error = '';
          return;
        }
        if (typed === 'c') {
          state.selected.clear();
          state.error = '';
          return;
        }
        if (typed === 'n') {
          state.selected = new Set(
            visible
              .filter((row) => !row.downloaded && !(row.access && row.access.requiresEntitlement))
              .map((row) => String(opts.idOf(row)))
          );
          state.error = '';
          return;
        }
        if (typed === 'p') {
          state.accessFilter =
            state.accessFilter === 'all'
              ? 'paid'
              : state.accessFilter === 'paid'
                ? 'free'
                : 'all';
          state.cursor = 0;
          state.windowStart = 0;
          return;
        }
        if (typed === 'x') {
          const row = visible[state.cursor];
          if (row) {
            const id = String(opts.idOf(row));
            state.selected.delete(id);
            state.rows = state.rows.filter((item) => String(opts.idOf(item)) !== id);
            state.cursor = Math.max(0, Math.min(filteredRows().length - 1, state.cursor));
            state.windowStart = 0;
          }
          return;
        }
        if (typed === 't') {
          state.type = cycleFilter([...valuesOf('type')], state.type);
          state.cursor = 0;
          state.windowStart = 0;
          return;
        }
        if (typed === 'b') {
          state.baseModel = cycleFilter([...valuesOf('baseModel')], state.baseModel);
          state.cursor = 0;
          state.windowStart = 0;
          return;
        }
        if (typed === 's') {
          const next = state.sort === 'default' ? 'name' : state.sort === 'name' ? 'size' : 'default';
          state.sort = next;
          state.cursor = 0;
          state.windowStart = 0;
          return;
        }
        if (typed === 'd') {
          state.status = state.status === null ? 'new' : state.status === 'new' ? 'downloaded' : null;
          state.cursor = 0;
          state.windowStart = 0;
          return;
        }
      }

      if (state.region === 'input' && opts.resolveInput && !ctrl && isTextInput(typed, key)) {
        state.input += typed;
        state.error = '';
        state.result = '';
        return;
      }
      if (state.region === 'input' && name === 'backspace') {
        state.input = state.input.slice(0, -1);
        state.error = '';
        return;
      }
      if (name !== 'return') return;

      if (state.region === 'input' && typeof opts.resolveInput === 'function') {
        if (!String(state.input).trim()) {
          state.error = t('tui.workspace.emptyInput');
          return;
        }
        state.busy = true;
        state.busyText = t('tui.workspace.resolving');
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
              /*
               * New rows follow the same rule as the initial plan: a row whose default version
               * needs no entitlement is checked, everything else waits for an explicit Space.
               *
               * 新增行与初始计划同一条规则：默认版本不需要权限就勾选，其余等用户按空格。
               */
              const defaultSelected = !row.access || row.access.defaultSelected !== false;
              if (defaultSelected) state.selected.add(id);
            }
            /*
             * Adding results must not leave the cursor on the last row: when focus moves to the
             * list, the first selectable row is the predictable starting point.
             *
             * 添加结果后不能把光标留在最后一行：焦点切到列表时，第一行才是可预期的起点。
             */
            state.cursor = 0;
            state.windowStart = 0;
            state.result = usable.map((row) => row.name || row.modelId).join(glyph.separator);
            state.input = '';
            state.error = '';
          }
        } catch (e) {
          state.error = String((e && e.message) || e);
        } finally {
          state.busy = false;
        }
        screen.refresh();
        return;
      }
      if (state.region === 'selected' && typeof opts.openRow === 'function') {
        const visibleRows = filteredRows();
        const row = visibleRows[state.cursor];
        if (!row) return;
        state.busy = true;
        state.busyText = t('tui.workspace.loadingVersions');
        screen.refresh();
        try {
          const rows = await opts.openRow(row, state, {
            crumbPath: opts.crumbPath,
            steps: opts.steps,
          });
          if (Array.isArray(rows)) {
            const id = String(opts.idOf(row));
            const index = state.rows.findIndex((existing) => String(opts.idOf(existing)) === id);
            if (rows.length) {
              if (index >= 0) state.rows.splice(index, 1, ...rows);
              // A row with versions is checked: the workspace checkbox means "this model is in".
              // 有版本的行走勾选：工作台复选框表示「这个模型参不参与本次下载」。
              state.selected.add(id);
            } else {
              /*
               * "Apply nothing" removes the row from this download but never from the list: the
               * model stays visible (and reachable) with an unchecked box.
               *
               * 「全不勾」只是把它从本次下载里去掉，绝不把模型从列表中删掉：
               * 行保留、复选框变空，随时可以再进去重新勾。
               */
              state.selected.delete(id);
            }
            /*
             * Returning from version selection clears the old input result and returns focus to the
             * list, keeping the previous row selected. Tab is required to reach the confirmation button.
             *
             * 从版本页返回后清掉旧的输入结果，焦点回到列表并保留上一次的行位置；
             * 需要按 Tab 才会到确认按钮。
             */
            state.result = '';
            state.region = 'selected';
            state.windowStart = 0;
          }
        } catch (e) {
          state.error = String((e && e.message) || e);
        } finally {
          state.busy = false;
        }
        screen.refresh();
        return;
      }
      if (state.region === 'next') {
        const selected = state.rows.filter((row) => state.selected.has(String(opts.idOf(row))));
        if (!selected.length) {
          state.error = t('tui.workspace.noSelection');
          return;
        }
        entry.settle({ rows: selected, selected: state.selected });
      }
    },
  });
}

module.exports = {
  showPlanWorkspace,
};
