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

const { t } = require('../i18n');
const { buildPageLayout, normalizeReport } = require('./ui/page');
const layout = require('./layout');
const view = require('./view');
const pages = require('./pages');
const screen = require('./screen');

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
  const state = { cursor: 0, windowStart: 0, placed: false };

  for (;;) {
    const answer = await screen.prompt({
      title: current.title,
      handlesHelp: true,
      hints: () => [current.hint],
      render(_promptState, ctx) {
        const width = Math.max(20, Math.floor(ctx.width) || 80);
        const room = Math.max(1, Math.floor(ctx.rows) || 3);
        const data = reportLayout(current, width);
        if (!data.entries.length) return data.lines.slice(0, room);

        if (!state.placed) {
          state.placed = true;
          const wanted = sectionCursor(data.entries, current.initialSection);
          if (wanted >= 0) state.cursor = wanted;
        }
        state.cursor = Math.max(0, Math.min(data.entries.length - 1, state.cursor));
        const entry = data.entries[state.cursor];
        const win = pages.scrollToSection(
          pages.windowOf(data.lines.length, entry.line, room, state.windowStart),
          data.lines,
          room,
          entry.line,
          data.headingOfLine,
          data.headingLines
        );
        state.windowStart = win.start;
        const shown = data.lines.slice(win.start, win.end);
        const row = entry.line - win.start;
        if (row >= 0 && row < shown.length) shown[row] = withCursor(shown[row]);
        return shown;
      },
      async onKey(text, key, entry) {
        if (text === '?' && !key.ctrl) {
          await pages.showHelp({});
          return;
        }
        const data = reportLayout(current, view.screenColumns());
        const count = data.entries.length;
        if (!count) return;
        if (key.name === 'up') {
          state.cursor = state.cursor <= 0 ? count - 1 : state.cursor - 1;
        } else if (key.name === 'down') {
          state.cursor = state.cursor >= count - 1 ? 0 : state.cursor + 1;
        } else if (key.name === 'home') {
          state.cursor = 0;
        } else if (key.name === 'end') {
          state.cursor = count - 1;
        } else if (key.name === 'pageup') {
          state.cursor = Math.max(0, state.cursor - 10);
        } else if (key.name === 'pagedown') {
          state.cursor = Math.min(count - 1, state.cursor + 10);
        } else if (key.name === 'return') {
          entry.settle(data.entries[state.cursor]);
        } else {
          return;
        }
        entry.state = state;
      },
    });
    if (!answer) return null;

    const outcome =
      answer.kind === 'action'
        ? await answer.action.run({ config, model: current })
        : await answer.section.onEnter(answer.row.raw, { config, model: current });
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
