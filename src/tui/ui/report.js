'use strict';

/**
 * Shared report page: summary facts on top, scrollable sections underneath, one action list at the
 * bottom. Every "decide what to do next" screen of the TUI (model detail, collection snapshot,
 * check report, verify report, environment check) is built from this one primitive, so they all
 * scroll, clip and answer keys the same way.
 *
 * The page is deliberately data-only: a caller hands over a plain model
 * (`{title, summary, sections, actions, hint}`) and the page owns rendering, the cursor, Enter and
 * Esc. Section rows become selectable when the section provides `onEnter(row)`, which is how a
 * version list or a report list gets its own action menu.
 *
 *
 * 共享报告页：顶部是摘要信息，中间是可滚动的分区列表，底部是操作列表。
 * TUI 里所有「下一步做什么」的页面（模型详情、收藏集快照、检查报告、校验报告、环境体检）
 * 都由这一个原语搭出来，因此它们的滚动、裁剪与按键行为完全一致。
 *
 * 本页刻意只处理数据：调用方交来一个普通模型（`{title, summary, sections, actions, hint}`），
 * 页面负责渲染、光标、Enter 与 Esc。分区提供 `onEnter(row)` 时，它的行才可选中——
 * 版本列表与报告列表的小菜单就是这样接上的。
 */

const { t } = require('../../i18n');
const { buildPageLayout, normalizeReport } = require('./pageLayout');
const list = require('./list');
const layout = require('../core/layout');
const view = require('../adapters/view');
const pages = require('./prompts');
const screen = require('../shell/screen');

const { colors } = layout;

/**
 * Action result: repaint the same page and keep going.
 * 动作结果：重画同一页并继续。
 */
const REFRESH = 'refresh';
/**
 * Action result: leave the page (same as Esc).
 * 动作结果：离开本页（与 Esc 相同）。
 */
const BACK = 'back';

/**
 * Plain layout of a report page, kept as a thin compatibility wrapper around the shared page builder.
 * 报告页的纯文本布局，作为共享页面构建器的薄兼容包装保留。
 */
function reportLayout(model, width) {
  return buildPageLayout(model, width);
}

/**
 * Plain lines of a report, capped to `rows` (pure, unit-testable).
 * 报告的纯文本行，按 `rows` 截断（纯函数，便于单测）。
 *
 * @param {object} model
 * @param {number} width
 * @param {number} [rows]
 * @returns {string[]}
 */
function reportLines(model, width, rows) {
  const all = reportLayout(model, width).lines;
  const room = Number.isFinite(rows) ? Math.max(1, Math.floor(rows)) : all.length;
  return all.slice(0, room);
}

/**
 * Mark one rendered line as the cursor row. Every selectable line starts with exactly two plain
 * spaces, so the replacement is a plain string operation (the detail keeps its own colors).
 *
 * 把某一行标记为光标行。所有可选中行都以两个纯空格开头，因此这里只是字符串替换
 * （说明文字保留自己的颜色）。
 */
function withCursor(line) {
  return `${colors.cyan(layout.glyphs().cursor)} ${line.slice(2)}`;
}

/**
 * First entry of a section (used by `initialSection`), by title or by index.
 * 某个分区的第一个可选中项（供 `initialSection` 使用），按标题或下标查找。
 */
function sectionCursor(entries, wanted) {
  if (wanted === undefined || wanted === null) return -1;
  if (typeof wanted === 'number') {
    return entries.findIndex((entry) => entry.kind === 'row' && entry.sectionIndex === wanted);
  }
  const title = String(wanted);
  return entries.findIndex(
    (entry) => entry.kind === 'row' && entry.section !== undefined && entry.section.title === title
  );
}

/**
 * Show a report page.
 *
 * With the shell it is one modal that reopens after every action, so the user always lands back on
 * the same page (the facts are rebuilt when the caller provides `rebuild`). Without the shell the
 * same data is printed and the actions are offered through the plain menu.
 *
 *
 * 显示报告页。
 *
 * 外壳接管时它是一个模态：每个动作结束后重新打开，用户总是回到同一页
 * （调用方提供 `rebuild` 时会重建事实）。没有外壳时把同一份数据打印出来，
 * 操作改用简易菜单询问。
 *
 * @param {object} config resolved config
 * @param {object} model `{title, summary, sections, actions, hint, initialSection, rebuild}`
 * @returns {Promise<any>} Esc → null；动作返回的其他值 → 该值
 */
async function showReportPage(config, model) {
  if (!screen.isActive()) return printReport(model);

  const raw = model || {};
  let current = normalizeReport(raw);
  const state = {
    region: 'body',
    scroll: 0,
    rowCursor: 0,
    actionCursor: 0,
    placed: false,
    rowCount: 0,
    actionCount: 0,
  };

  const dataNow = () => reportLayout(current, screen.bodyWidth());
  const rowsOf = (data) => data.entries.filter((entry) => entry.kind === 'row');
  const actionsOf = (data) => data.entries.filter((entry) => entry.kind === 'action');
  const regions = () => (state.rowCount ? ['body', 'rows', 'actions'] : ['body', 'actions']);
  const hint = () => {
    if (state.region === 'rows') return t('tui.hint.reportRows');
    if (state.region === 'actions') return t('tui.hint.reportActions');
    return t('tui.hint.reportBody');
  };
  const compactHint = () => {
    if (state.region === 'rows') return t('tui.hint.reportRowsCompact');
    if (state.region === 'actions') return t('tui.hint.reportActionsCompact');
    return t('tui.hint.reportBodyCompact');
  };

  for (;;) {
    const answer = await screen.prompt({
      title: current.title,
      crumbPath: current.crumbPath,
      handlesHelp: true,
      hints: () => [hint()],
      compactHints: () => [compactHint()],
      render(_promptState, ctx) {
        const width = Math.max(20, Math.floor(ctx.width) || 80);
        const room = Math.max(1, Math.floor(ctx.rows) || 3);
        const data = reportLayout(current, width);
        const rowEntries = rowsOf(data);
        const actionEntries = actionsOf(data);
        state.rowCount = rowEntries.length;
        state.actionCount = actionEntries.length;

        if (!state.placed) {
          state.placed = true;
          const wanted = sectionCursor(data.entries, current.initialSection);
          if (wanted >= 0 && data.entries[wanted].kind === 'row') state.rowCursor = wanted;
          state.region = 'body';
          state.scroll = 0;
        }
        state.rowCursor = Math.max(0, Math.min(rowEntries.length - 1, state.rowCursor));
        state.actionCursor = Math.max(0, Math.min(actionEntries.length - 1, state.actionCursor));

        let focusLine = null;
        if (state.region === 'rows' && rowEntries[state.rowCursor]) focusLine = rowEntries[state.rowCursor].line;
        else if (state.region === 'actions' && actionEntries[state.actionCursor]) {
          focusLine = actionEntries[state.actionCursor].line;
        }
        const maxStart = Math.max(0, data.lines.length - room);
        if (focusLine !== null) {
          if (focusLine < state.scroll) state.scroll = focusLine;
          else if (focusLine >= state.scroll + room) state.scroll = focusLine - room + 1;
        }
        state.scroll = Math.max(0, Math.min(state.scroll, maxStart));
        const shown = data.lines.slice(state.scroll, state.scroll + room);
        if (focusLine !== null) {
          const row = focusLine - state.scroll;
          if (row >= 0 && row < shown.length) shown[row] = withCursor(shown[row]);
        }
        return shown;
      },
      async onKey(text, key, entry) {
        if (text === '?' && !key.ctrl) {
          await pages.showHelp({});
          return;
        }
        if (key.name === 'tab') {
          const order = regions();
          const index = order.indexOf(state.region);
          state.region = order[(index + 1) % order.length] || 'body';
          return;
        }

        const geometry = screen.bodyGeometry();
        const room = Math.max(1, geometry.bodyRows);
        const data = dataNow();
        const rowEntries = rowsOf(data);
        const actionEntries = actionsOf(data);
        state.rowCount = rowEntries.length;
        state.actionCount = actionEntries.length;
        const maxStart = Math.max(0, data.lines.length - room);

        if (state.region === 'body') {
          if (key.name === 'up') state.scroll -= 1;
          else if (key.name === 'down') state.scroll += 1;
          else if (key.name === 'pageup') state.scroll -= room;
          else if (key.name === 'pagedown') state.scroll += room;
          else if (key.name === 'home') state.scroll = 0;
          else if (key.name === 'end') state.scroll = maxStart;
          else return;
          state.scroll = Math.max(0, Math.min(state.scroll, maxStart));
          return;
        }

        if (state.region === 'rows') {
          if (!rowEntries.length) {
            state.region = 'body';
            return;
          }
          if (key.name === 'up') state.rowCursor = list.moveCursor(state.rowCursor, -1, rowEntries.length, 'form');
          else if (key.name === 'down') {
            state.rowCursor = list.moveCursor(state.rowCursor, 1, rowEntries.length, 'form');
          } else if (key.name === 'home') state.rowCursor = 0;
          else if (key.name === 'end') state.rowCursor = rowEntries.length - 1;
          else if (key.name === 'pageup') {
            state.rowCursor = list.pageCursor(state.rowCursor, -1, rowEntries.length, 10, 'form');
          } else if (key.name === 'pagedown') {
            state.rowCursor = list.pageCursor(state.rowCursor, 1, rowEntries.length, 10, 'form');
          } else if (key.name === 'return') {
            entry.settle(rowEntries[state.rowCursor]);
          } else return;
          return;
        }

        if (state.region === 'actions') {
          if (!actionEntries.length) {
            state.region = 'body';
            return;
          }
          if (key.name === 'up') {
            state.actionCursor = list.moveCursor(state.actionCursor, -1, actionEntries.length, 'form');
          } else if (key.name === 'down') {
            state.actionCursor = list.moveCursor(state.actionCursor, 1, actionEntries.length, 'form');
          } else if (key.name === 'home') state.actionCursor = 0;
          else if (key.name === 'end') state.actionCursor = actionEntries.length - 1;
          else if (key.name === 'pageup') {
            state.actionCursor = list.pageCursor(state.actionCursor, -1, actionEntries.length, 10, 'form');
          } else if (key.name === 'pagedown') {
            state.actionCursor = list.pageCursor(state.actionCursor, 1, actionEntries.length, 10, 'form');
          } else if (key.name === 'return') {
            entry.settle(actionEntries[state.actionCursor]);
          } else return;
        }
      },
    });
    if (!answer) return null;

    // The page prompt settled before the action runs, so its path must be re-applied for the action's
    // own prompts (menus, confirms, nested pages) to inherit it.
    //
    // 动作执行前页面提问已经结束，因此这里重新应用页面路径，
    // 让动作里的菜单、确认框与嵌套页面继续继承它。
    const outcome = await screen.withCrumbs(current.crumbPath, () =>
      answer.kind === 'action'
        ? answer.action.run({ config, model: current })
        : answer.section.onEnter(answer.row.raw, { config, model: current })
    );
    // Only the page's own signals control the flow: `BACK` closes it, another string is handed to
    // the caller (check → recheck, verify → deep). Anything else — a nested flow's true/false/null,
    // or no value at all — means "stay on this page".
    //
    // 只有页面自己的信号能控制流程：`BACK` 关闭本页，其它字符串交给调用方
    // （检查 → 重新检查、校验 → 深度）。其余返回值——嵌套流程的 true/false/null 或没有返回值——
    // 都表示「留在本页」。
    if (outcome === BACK) return null;
    if (typeof outcome === 'string' && outcome !== REFRESH) return outcome;

    // Rebuild the facts after the action (a pin or a download changes them), keeping the cursor.
    // A record that disappeared (deleted model, removed snapshot) closes the page.
    //
    // 动作之后重建事实（固定或下载会改变它们），并保留光标位置。
    // 记录已消失（模型被删除、快照被移除）时关闭本页。
    if (typeof raw.rebuild === 'function') {
      try {
        const next = raw.rebuild();
        if (!next) return null;
        current = normalizeReport(next);
      } catch (e) {
        // A stale rebuild must not trap the user inside the page.
        // 重建失败不能把用户困在这一页里。
        return null;
      }
    }
  }
}

/**
 * Plain (non-shell) rendering of the same report model, with a menu for its actions.
 * 报告模型在简易（无外壳）模式下的渲染，操作用菜单询问。
 *
 * @param {object} model
 * @returns {Promise<any>} null when cancelled / "back"
 */
async function printReport(model) {
  const raw = model || {};
  let current = normalizeReport(raw);
  for (;;) {
    const data = reportLayout(current, view.screenColumns());
    view.note('');
    if (current.title) view.note(colors.bold(`  ${current.title}`));
    for (const line of data.lines) view.note(line);

    if (!current.actions.length) return null;
    const choice = await pages.promptMenu(
      t('tui.report.actions'),
      current.actions.map((action, index) => ({
        title: action.label,
        value: index,
        description: action.description || undefined,
      }))
    );
    if (choice === null) return null;
    const action = current.actions[Number(choice)];
    if (!action) return null;

    const outcome = await action.run({ model: current });
    if (outcome === BACK) return null;
    if (typeof outcome === 'string' && outcome !== REFRESH) return outcome;
    if (typeof raw.rebuild === 'function') {
      try {
        const next = raw.rebuild();
        if (!next) return null;
        current = normalizeReport(next);
      } catch (e) {
        return null;
      }
    }
  }
}

module.exports = {
  showReportPage,
  printReport,
  reportLines,
  reportLayout,
  normalizeReport,
  REFRESH,
  BACK,
};
