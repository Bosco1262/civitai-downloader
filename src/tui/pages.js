'use strict';

/**
 * Shared interaction primitives of the TUI: menus, confirmations, text fields, the help page and the
 * list pickers.
 *
 * Two rendering paths live here, and both answer the same way:
 *
 *  - with the app shell active (a real terminal) every primitive renders *inside* the frame, so the
 *    header, the configured-settings panel and the task view stay visible while the user answers;
 *  - without one (no TTY, CI, CIVITAI_PLAIN) they fall back to the `prompts` library, which keeps
 *    scripted runs, tests and redirected output working exactly as before.
 *
 * One cancel rule everywhere: Esc returns null, so a caller can tell "cancelled" from a real answer.
 *
 *
 * TUI 的公共交互基元：菜单、确认框、文本输入、帮助页与列表选择器。
 *
 * 这里存在两条渲染路径，但答案完全一致：
 *
 *  - 应用外壳接管时（真实终端），所有基元都渲染在框架「内部」，
 *    用户作答时页眉、已设置信息面板与任务视图始终可见；
 *  - 没有外壳时（非 TTY、CI、CIVITAI_PLAIN）回退到 `prompts` 库，
 *    脚本化运行、测试与重定向输出与以前完全一致。
 *
 * 取消规则全局统一：Esc 返回 null，调用方据此区分「取消」与「真实答案」。
 */

const fs = require('fs');
const { t } = require('../i18n');
const layout = require('./layout');
const view = require('./view');
const screen = require('./screen');
const { isTextInput, installRawKeys } = require('./keys');
const { pickDirectory, pickerCommand } = require('./fspicker');
const { selectItems, isInteractive } = require('./select');

const { colors, displayWidth, truncateTo, padTo } = layout;

/**
 * Resolve the prompts module on first use instead of at load time.
 *
 * The flows of this module are the only place where the TUI asks questions, so keeping the lookup
 * late means a test (or an embedder) can replace `prompts` with a scripted stub without caring about
 * module load order.
 *
 *
 * 第一次使用时才解析 prompts 模块，而不是在加载时解析。
 *
 * 本模块的流程是 TUI 里唯一提问的地方，延迟解析意味着测试（或嵌入方）可以
 * 用脚本化替身替换 `prompts`，而不必关心模块加载顺序。
 */
function promptLib() {
  return require('prompts');
}

/**
 * Global key hint of the plain (non-shell) path; the shell prints the page's own line at the bottom.
 * 简易（无外壳）路径的按键提示；启用外壳时由页脚显示当前页自己那一行。
 */
function hintLines() {
  return [t('tui.hint.menu')];
}

/**
 * One-line key hint appended to every plain prompt message.
 * 追加在每个简易提问提示语后面的按键说明行。
 */
function hint() {
  return colors.dim(`\n${hintLines().join(view.separator())}`);
}

/**
 * Version of the package, read once (shown on the help page).
 * 包版本，只读一次（帮助页显示用）。
 */
let cachedVersion = null;
function packageVersion() {
  if (cachedVersion !== null) return cachedVersion;
  try {
    const pkg = JSON.parse(fs.readFileSync(require('path').join(__dirname, '..', '..', 'package.json'), 'utf8'));
    cachedVersion = String(pkg.version || '');
  } catch (e) {
    cachedVersion = '';
  }
  return cachedVersion;
}

// ---------------------------------------------------------------------------
// Shared body pieces
// 主体公共片段
// ---------------------------------------------------------------------------

/**
 * Heading of a body: the message in bold plus a rule as long as the text (capped to the width).
 * 主体的标题：加粗的消息，加一条与文字等长（不超过宽度）的分隔线。
 */
function heading(text) {
  const value = String(text === undefined || text === null ? '' : text);
  return [colors.bold(value)];
}

/**
 * Scroll window of a list: which slice to draw and where the cursor sits inside it.
 *
 * The window only moves when the cursor would leave it: stepping through the visible rows keeps the
 * text still, and the "page" scrolls one row at a time at the top and bottom edges.
 *
 *
 * 列表的滚动视窗：画哪一段，以及光标在段内的位置。
 *
 * 只有光标将要离开视窗时视窗才移动：在可见范围内上下移动时文字不动，
 * 到顶/到底后再走一格，内容才会一行一行地滚。
 *
 * @param {number} count total rows
 * @param {number} cursor current row
 * @param {number} size rows that fit
 * @param {number} [previousStart] start of the previous window (0 when there is none yet)
 * @returns {{start:number, end:number, cursor:number}}
 */
function windowOf(count, cursor, size, previousStart = 0) {
  const total = Math.max(0, count);
  const room = Math.max(1, Math.floor(size));
  const clamped = Math.max(0, Math.min(Math.max(0, total - 1), Number(cursor) || 0));
  const maxStart = Math.max(0, total - room);
  // Stay where we were (as long as that is still a valid window)…
  // 尽量待在原来的位置（只要它还是合法视窗）……
  let start = Math.max(0, Math.min(Math.floor(Number(previousStart)) || 0, maxStart));
  // …and only scroll when the cursor would fall outside it.
  // ……只有光标要跑出去时才滚动。
  if (clamped < start) start = clamped;
  else if (clamped >= start + room) start = clamped - room + 1;
  start = Math.max(0, Math.min(start, maxStart));
  return { start, end: Math.min(total, start + room), cursor: clamped };
}

/**
 * Adjust a scroll window so a section heading is never separated from its rows.
 *
 * A heading is part of the section, not a free-standing line: the window may not start *inside* a
 * section (its heading would be scrolled off, so the first visible row would look orphaned), and it
 * may not end on a heading either (a header with nothing under it is just noise). Both adjustments
 * respect the one hard rule — the cursor always stays visible.
 *
 *
 * 调整滚动视窗，避免分组标题与它的行被拆开。
 *
 * 标题属于分组，不是独立的一行：视窗不能在分组「中间」开始（标题被滚出去后，第一行看起来就没有归属），
 * 也不能停在标题上（下面什么都没有的标题只是噪音）。两个调整都遵守唯一的硬约束——光标始终可见。
 *
 * @param {{start:number, end:number, cursor:number}} win window from `windowOf`
 * @param {string[]} lines all rendered lines
 * @param {number} body how many lines fit
 * @param {number} cursorLine line of the cursor
 * @param {Map<number, number>} headingOfLine line → its section heading line
 * @param {Set<number>} headingLines the heading lines themselves
 * @returns {{start:number, end:number, cursor:number}}
 */
function scrollToSection(win, lines, body, cursorLine, headingOfLine, headingLines) {
  let start = win.start;
  let end = win.end;

  // The section heading must be on screen when the cursor sits on that section's *first row*: coming
  // back to that row should not leave the user without the section name. It is deliberately NOT
  // applied to every row of the section: the window starts where the user scrolled to, so stepping
  // inside a long section must not yank the view back to its heading.
  //
  // 光标停在本组「第一行」时，标题必须在视窗内：回到这一行时不能丢掉分组名。
  // 这条规则刻意不适用于组内的其它行：视窗应停在用户滚到的位置，
  // 在长分组内部上下移动时不能把视图拽回分组开头。
  const heading = headingOfLine.get(cursorLine);
  if (heading !== undefined && heading === cursorLine - 1 && heading < start) {
    start = heading;
    end = Math.min(lines.length, start + body);
  }

  // Drop a heading (and the blank line above it) that ended up as the last visible line.
  // 丢掉被挤到最后一行的标题（连同它上面的空行）。
  while (end > start + 1 && (headingLines.has(end - 1) || lines[end - 1] === '')) end -= 1;

  // Whatever happened above, the cursor must stay on screen.
  // 无论上面怎么调整，光标都必须留在屏幕内。
  if (cursorLine < start) start = cursorLine;
  if (cursorLine >= end) end = Math.min(lines.length, cursorLine + 1);
  return { start, end, cursor: win.cursor };
}

/**
 * One "cursor + title + description" row, used by every in-body list.
 * 一行「光标 + 标题 + 说明」，供所有主体列表共用。
 */
function rowLine(label, description, opts = {}) {
  const width = Math.max(20, Math.floor(opts.width) || 80);
  const cursor = opts.cursor ? colors.cyan(layout.glyphs().cursor) : ' ';
  const title = opts.cursor ? colors.bold(label) : label;
  const desc = opts.description === false || !description ? '' : String(description);
  if (!desc) return `${cursor} ${title}`;
  const labelWidth = Math.min(Math.max(12, Math.floor(opts.labelWidth) || displayWidth(label)), Math.floor(width * 0.55));
  const room = width - 2 - labelWidth - 3;
  if (room < 8) return `${cursor} ${title}`;
  return `${cursor} ${padTo(truncateTo(title, labelWidth), labelWidth)}   ${colors.dim(truncateTo(desc, room))}`;
}

// ---------------------------------------------------------------------------
// Prompts (shell path)
// 提问（外壳路径）
// ---------------------------------------------------------------------------

/**
 * Single-choice menu rendered inside the shell body.
 * 渲染在外壳主体里的单选菜单。
 */
function shellMenu(message, choices, options) {
  const items = choices.map((choice) => ({
    label: String(choice.title),
    value: choice.value,
    description: choice.description === undefined ? '' : String(choice.description),
  }));
  const initial = Number.isFinite(options.initial) ? Math.max(0, Math.min(items.length - 1, options.initial)) : 0;
  const labelWidth = items.reduce((max, item) => Math.max(max, displayWidth(item.label)), 0);

  return screen.prompt({
    title: options.stage || '',
    crumb: !!options.stage,
    initialState: { cursor: initial, windowStart: 0 },
    // No footer of its own: this list only uses the keys the page's line already names.
    // 不设自己的页脚：这个列表只用页脚那一行已经写出的键。
    hints: () => [t('tui.hint.menu')],
    render(state, ctx) {
      const lines = heading(message, ctx.width);
      lines.push('');
      const room = Math.max(1, ctx.rows - lines.length);
      const win = windowOf(items.length, state.cursor, room, state.windowStart);
      state.windowStart = win.start;
      state.cursor = win.cursor;
      items.slice(win.start, win.end).forEach((item, index) => {
        lines.push(
          rowLine(item.label, item.description, {
            cursor: win.start + index === win.cursor,
            labelWidth,
            width: ctx.width,
          })
        );
      });
      if (win.end - win.start < items.length) {
        lines.push(colors.dim(t('tui.pages.listPosition', { index: win.cursor + 1, total: items.length })));
      }
      return lines;
    },
    onKey(text, key, entry) {
      const state = entry.state;
      // The cursor wraps around at both ends: pressing ↑ on the first entry jumps to the last one.
      // 光标在两端循环：在第一项按 ↑ 会跳到末项。
      if (key.name === 'up') state.cursor = state.cursor <= 0 ? items.length - 1 : state.cursor - 1;
      else if (key.name === 'down') state.cursor = state.cursor >= items.length - 1 ? 0 : state.cursor + 1;
      else if (key.name === 'home') state.cursor = 0;
      else if (key.name === 'end') state.cursor = items.length - 1;
      else if (key.name === 'pageup') state.cursor = Math.max(0, state.cursor - 10);
      else if (key.name === 'pagedown') state.cursor = Math.min(items.length - 1, state.cursor + 10);
      else if (key.name === 'return') entry.settle(items[state.cursor] ? items[state.cursor].value : null);
      else if (/^[1-9]$/.test(text) && Number(text) <= items.length) entry.settle(items[Number(text) - 1].value);
      else return;
      entry.state = state;
    },
  });
}

/**
 * Yes/no confirmation rendered inside the shell body.
 * 渲染在外壳主体里的确认框。
 */
function shellConfirm(message, options) {
  const initial = options.initial === undefined ? !options.danger : !!options.initial;
  const items = [
    { label: t('common.yes'), value: true },
    { label: t('common.no'), value: false },
  ];
  return screen.prompt({
    title: options.stage || '',
    crumb: !!options.stage,
    initialState: { cursor: initial ? 0 : 1 },
    // Only the keys that work here: ←→ and y/n answer directly, plus the shared ones.
    // 只列这里能用的键：←→ 与 y / n 直接作答，外加共用的那几个。
    hints: () => [t('tui.hint.confirm')],
    render(state, ctx) {
      const lines = heading(options.danger ? colors.yellow(message) : message, ctx.width);
      lines.push('');
      items.forEach((item, index) => {
        lines.push(rowLine(item.label, '', { cursor: index === state.cursor, width: ctx.width }));
      });
      return lines;
    },
    onKey(text, key, entry) {
      const state = entry.state;
      if (key.name === 'left' || key.name === 'right' || text === 'h' || text === 'l') {
        state.cursor = state.cursor === 0 ? 1 : 0;
      } else if (key.name === 'up') state.cursor = 0;
      else if (key.name === 'down') state.cursor = 1;
      else if (text === 'y' || text === 'Y') entry.settle(true);
      else if (text === 'n' || text === 'N') entry.settle(false);
      else if (key.name === 'return') entry.settle(state.cursor === 0);
      else return;
      entry.state = state;
    },
  });
}

/**
 * Single-line text field rendered inside the shell body.
 * 渲染在外壳主体里的单行文本输入框。
 */
function shellText(message, options) {
  const initial = options.initial === undefined || options.initial === null ? '' : String(options.initial);
  // Ctrl+R restores the caller's default for this field (settings passes the config default), and the
  // hint line only mentions the keys the field actually supports.
  //
  // Ctrl+R 恢复调用方给这个字段的默认值（设置页传的是配置默认值）；
  // 提示行只列出这个字段真正支持的键。
  const hasReset = options.resetValue !== undefined && options.resetValue !== null;
  const hintKey = options.pick
    ? hasReset
      ? 'tui.hint.textPickReset'
      : 'tui.hint.textPick'
    : hasReset
      ? 'tui.hint.textReset'
      : 'tui.hint.text';
  return screen.prompt({
    title: options.stage || '',
    crumb: !!options.stage,
    acceptsText: true,
    initialState: { value: initial, cursor: initial.length, error: '' },
    // Enter submits this one field rather than moving on, so the line says "submit".
    // 这里的 Enter 是「提交这一个字段」而不是进入下一屏，所以写成「提交」。
    hints: () => [t(hintKey)],
    render(state, ctx) {
      const lines = heading(message, ctx.width);
      lines.push('');
      // The field is as wide as the answer needs and never wider than the frame: a path or a URL is
      // readable without the box stretching across the whole terminal.
      //
      // 输入框宽度跟随答案长度，且不超过框架：路径或 URL 读起来舒服，框也不会横跨整个终端。
      const wanted = Math.max(displayWidth(state.value) + 6, 36);
      const inner = Math.max(10, Math.min(ctx.width - 4, wanted));
      const gl = layout.glyphs();
      // The cursor is drawn as reverse video on the character it sits on (a space at the end), which
      // every terminal renders and which survives a hidden hardware cursor.
      //
      // 光标以反显画在它所在的那个字符上（在末尾时是一个空格），所有终端都支持，
      // 并且在硬件光标被隐藏时依然可见。
      const before = state.value.slice(0, state.cursor);
      const at = state.value.slice(state.cursor, state.cursor + 1) || ' ';
      const after = state.value.slice(state.cursor + 1);
      const visible = before.slice(-inner);
      const shown = `${visible}${colors.reverse(at)}${after}`;
      lines.push(colors.dim(`${gl.boxTL}${gl.boxH.repeat(inner + 2)}${gl.boxTR}`));
      lines.push(`${gl.boxV} ${padTo(truncateTo(shown, inner), inner)} ${gl.boxV}`);
      lines.push(colors.dim(`${gl.boxBL}${gl.boxH.repeat(inner + 2)}${gl.boxBR}`));
      if (state.error) lines.push('', colors.red(` ${state.error}`));
      return lines;
    },
    onKey(text, key, entry) {
      const state = entry.state;
      const value = state.value;
      // Ctrl+O opens the platform's folder picker when the field allows it; the picked path is put
      // into the field (never submitted directly), so a device where the dialog cannot open still
      // works by typing.
      //
      // 字段允许时 Ctrl+O 打开系统的目录选择框；选中的路径只写回输入框（不会直接提交），
      // 因此弹不出对话框的设备仍然可以手打。
      if (key.ctrl && key.name === 'o' && options.pick === 'directory') {
        fillFromDirectoryPicker(state, entry);
        return;
      }
      // Ctrl+R fills the field with its default value (still editable, still needs Enter to submit).
      // Ctrl+R 把默认值填进输入框（仍可继续编辑，仍需 Enter 提交）。
      if (key.ctrl && key.name === 'r' && hasReset) {
        state.value = String(options.resetValue);
        state.cursor = state.value.length;
        state.error = '';
        entry.state = state;
        return;
      }
      if (key.name === 'return') {
        const answer = options.trim === false ? value : value.trim();
        if (typeof options.validate === 'function') {
          const result = options.validate(answer);
          if (result !== true) {
            state.error = String(result === false || result === undefined ? t('tui.pages.invalidValue') : result);
            entry.state = state;
            return;
          }
        }
        entry.settle(answer);
        return;
      }
      if (key.name === 'left') state.cursor = Math.max(0, state.cursor - 1);
      else if (key.name === 'right') state.cursor = Math.min(value.length, state.cursor + 1);
      else if (key.name === 'home') state.cursor = 0;
      else if (key.name === 'end') state.cursor = value.length;
      else if (key.ctrl && key.name === 'u') {
        state.value = '';
        state.cursor = 0;
      } else if (key.name === 'backspace') {
        if (state.cursor > 0) {
          state.value = value.slice(0, state.cursor - 1) + value.slice(state.cursor);
          state.cursor -= 1;
        }
      } else if (key.name === 'delete') {
        state.value = value.slice(0, state.cursor) + value.slice(state.cursor + 1);
      } else if (isTextInput(text, key)) {
        state.value = value.slice(0, state.cursor) + text + value.slice(state.cursor);
        state.cursor += text.length;
      } else {
        return;
      }
      state.error = '';
      entry.state = state;
    },
  });
}

/**
 * Open the platform folder dialog and write the chosen path into the field.
 *
 * The value is only placed in the input line — the user still edits and submits it with Enter. Cancel
 * leaves the field untouched; a platform without any dialog gets a short notice instead of silence.
 *
 *
 * 打开系统目录选择框，并把选中的路径写进输入框。
 *
 * 选中的值只是填进输入行——用户仍可修改后再按 Enter 提交。取消时输入框保持原样；
 * 平台没有可用对话框时给一句提示，而不是毫无反应。
 */
async function fillFromDirectoryPicker(state, entry) {
  if (!pickerCommand(process.platform, '')) {
    screen.notice(t('tui.pages.pickUnavailable'), colors.dim);
    return;
  }
  const picked = await pickDirectory(state.value || '');
  if (!picked) return;
  state.value = picked;
  state.cursor = picked.length;
  state.error = '';
  entry.state = state;
  screen.refresh();
}

/**
 * Information page: a screen with a message and nothing to choose.
 *
 * Section entries use it when there is nothing to list yet (no collection snapshot, empty library).
 * Returning to the menu with only a log line looks like the key press did nothing; a page makes the
 * answer visible where the user is looking.
 *
 * Nothing happens on Enter: there is nothing to open here, and Esc (the global "back") is the only
 * way out, so the key cannot be mistaken for "go on".
 *
 *
 * 信息页：只有一段说明、没有可选项的界面。
 *
 * 分区入口在没有可列出的内容时（还没有收藏集快照、模型库为空）用它。
 * 只在日志里留一行会让人以为按键没生效；用一页把答案显示在用户正看着的地方。
 *
 * Enter 在这里不做任何事：没有可进入的东西，唯一的出口是 Esc（全局的「返回」），
 * 这样按键不会被误解成「继续」。
 *
 * @param {string} title breadcrumb segment
 * @param {string[]} lines message lines (already translated)
 */
async function promptMessage(title, lines) {
  const body = (Array.isArray(lines) ? lines : [lines]).map((line) => String(line));
  if (!screen.isActive()) {
    for (const line of body) view.note(line);
    return null;
  }
  return screen.prompt({
    title,
    // Only Esc works here: there is nothing to choose, so the line says exactly that.
    // 这里只有 Esc 有效：没有可选项，因此也只写这一句。
    hints: () => [t('tui.hint.message')],
    render(_state, ctx) {
      const width = Math.max(20, Math.floor(ctx.width) || 80);
      const out = [''];
      for (const line of body) out.push(...wrapText(line, width));
      return out;
    },
  });
}

/**
 * Hard-wrap text to a display width (CJK characters count as two columns), so long explanatory lines
 * stay readable instead of being cut off with an ellipsis.
 *
 * 按显示宽度硬换行（CJK 字符算两列），较长的说明文字因此能读完，而不是被省略号截断。
 *
 * @returns {string[]}
 */
function wrapText(text, width) {
  const limit = Math.max(4, Math.floor(Number(width)) || 4);
  const value = String(text === undefined || text === null ? '' : text);
  if (!value) return [''];
  const lines = [];
  let line = '';
  let used = 0;
  for (const ch of value) {
    const w = displayWidth(ch);
    if (used + w > limit) {
      lines.push(line);
      line = '';
      used = 0;
    }
    line += ch;
    used += w;
  }
  if (line) lines.push(line);
  return lines;
}

// ---------------------------------------------------------------------------
// Prompts (public API)
// 提问（对外接口）
// ---------------------------------------------------------------------------

/**
 * Read the answer of a plain (non-shell) prompt.
 *
 * Normally the answer object only carries the requested field (`value` for a menu, `ok` for a
 * confirmation). The extra field names keep scripted/legacy answers working, where the caller
 * supplied a flow-specific key such as `action` or `modelId`.
 *
 *
 * 读取一次简易（无外壳）提问的答案。
 *
 * 正常情况下答案对象只有一个字段（菜单是 `value`，确认是 `ok`）。
 * 额外接受若干个旧字段名，便于脚本化/历史答案继续可用（例如 `action`、`modelId`）。
 *
 * @returns {{found:boolean, value:any}}
 */
function answerValue(ans, names) {
  if (!ans || typeof ans !== 'object') return { found: false, value: undefined };
  for (const name of names) {
    if (Object.prototype.hasOwnProperty.call(ans, name)) return { found: true, value: ans[name] };
  }
  return { found: false, value: undefined };
}

/**
 * Normalize the answer of a list prompt into a plain id.
 *
 * A real prompt answers with the short id; scripted or legacy answers sometimes hand back the whole
 * row (`{modelId: …}`), which callers should not have to unwrap themselves.
 *
 *
 * 把列表提问的答案归一化成裸 ID。
 *
 * 真实提问返回的是短 ID；脚本化或历史答案有时会直接给出整行（`{modelId: …}`），
 * 调用方不应该自己拆包。
 */
function answerId(value) {
  if (value && typeof value === 'object') {
    for (const key of ['modelId', 'id', 'versionId', 'value', 'key']) {
      if (value[key] !== undefined && value[key] !== null) return String(value[key]);
    }
    return '';
  }
  return value === undefined || value === null ? '' : String(value);
}

/**
 * Single-choice menu.
 *
 * Returns the chosen value, or null when the user cancelled (Esc) — never the initial value, so an
 * accidental Esc can no longer be mistaken for a choice.
 *
 *
 * 单选菜单。
 *
 * 返回选中的值；用户取消（Esc）时返回 null，绝不会返回初始值，
 * 因此误按 Esc 不会再被当成一次选择。
 *
 * @param {string} message
 * @param {Array<{title:string, value:any, description?:string}>} choices
 * @param {{initial?:number, hint?:boolean, name?:string, stage?:string}} [options]
 * @returns {Promise<any|null>}
 */
async function promptMenu(message, choices, options = {}) {
  const list = Array.isArray(choices) ? choices.filter(Boolean) : [];
  if (!list.length) return null;
  if (screen.isActive()) return shellMenu(message, list, options);

  const name = options.name || 'value';
  const ans = await promptLib()({
    type: 'select',
    name,
    message: options.hint === false ? message : `${message}${hint()}`,
    choices: list,
    initial: Number.isFinite(options.initial) ? options.initial : 0,
  });
  const answer = answerValue(
    ans,
    [name].concat(['value', 'action', 'id', 'mode', 'scope', 'modelId', 'versionId', 'deep', 'type', 'base'])
  );
  return answer.found ? answer.value : null;
}

/**
 * Yes/no confirmation. Returns true / false, or null when the user cancelled.
 *
 * `danger` marks a destructive default: the highlighted answer becomes "no" so that a bare Enter
 * cannot delete files.
 *
 *
 * 是/否确认。返回 true / false；用户取消时返回 null。
 *
 * `danger` 用于有破坏性的默认值：高亮项变成「否」，避免直接回车就删文件。
 *
 * @param {string} message
 * @param {{initial?:boolean, danger?:boolean, stage?:string}} [options]
 * @returns {Promise<boolean|null>}
 */
async function promptConfirm(message, options = {}) {
  if (screen.isActive()) return shellConfirm(message, options);

  const initial = options.initial === undefined ? !options.danger : !!options.initial;
  const ans = await promptLib()({
    type: 'confirm',
    name: 'ok',
    message: `${options.danger ? colors.yellow(message) : message}${hint()}`,
    initial,
  });
  const answer = answerValue(ans, ['ok', 'value', 'confirm', 'go', 'force', 'deep', 'files', 'open', 'pin']);
  return answer.found ? !!answer.value : null;
}

/**
 * Text input with a validator. Returns the trimmed string, or null when cancelled.
 * 文本输入（带校验）。返回去掉首尾空白后的字符串；取消时返回 null。
 */
async function promptText(message, options = {}) {
  if (screen.isActive()) return shellText(message, options);

  const ans = await promptLib()({
    type: 'text',
    name: 'text',
    message: options.hint === false ? message : `${message}${hint()}`,
    initial: options.initial,
    validate: options.validate,
  });
  const answer = answerValue(ans, ['text', 'value', 'kw', 'dir', 'id', 'refs', 'ids']);
  if (!answer.found) return null;
  const value = String(answer.value);
  return options.trim === false ? value : value.trim();
}

/**
 * Output directory prompt, shared by every download flow.
 * 输出目录提示，各下载流程共用。
 *
 * @returns {Promise<string|null>} raw text (the caller resolves it against config.root)
 */
async function promptOutDir(config, current) {
  return promptText(t('tui.download.outDirPrompt', { root: config.root }), {
    initial: current || config.outDir,
    validate: (v) => (String(v).trim() ? true : t('tui.download.notEmpty')),
  });
}

// ---------------------------------------------------------------------------
// List pickers
// 列表选择器
// ---------------------------------------------------------------------------

/**
 * Whether the interactive picker can be used (TTY + an explicit opt-out via CIVITAI_PLAIN=1).
 * 是否可以使用交互式选择器（需要 TTY；可用 CIVITAI_PLAIN=1 显式关闭）。
 */
function canPick() {
  return !process.env.CIVITAI_PLAIN && isInteractive();
}

/**
 * Run a slow task while telling the user it is still running.
 *
 * Launcher or network phases can take tens of seconds with nothing to print, which looks exactly
 * like a frozen TUI. Inside the shell the phase is written to the breadcrumb ("what is happening
 * now") and refreshed every interval; without a shell a line is printed instead.
 *
 *
 * 执行耗时任务时告诉用户「还在动」。
 *
 * 启动浏览器、等网络这类阶段可能几十秒没有任何输出，看起来就像界面卡死。
 * 外壳接管时把阶段写进面包屑（「现在正在做什么」）并按间隔刷新；没有外壳时照旧打印一行。
 *
 * @param {string} message already translated phase description
 * @param {() => Promise<any>} fn
 * @param {{intervalMs?:number, onTick?:(seconds:number)=>void}} [opts]
 */
async function withSpinner(message, fn, opts = {}) {
  const started = Date.now();
  const intervalMs = Math.max(1000, Number(opts.intervalMs) || 15000);

  if (screen.isActive()) {
    const previous = screen.getStage();
    screen.setStage(message);
    const timer = setInterval(() => {
      try {
        screen.setStage(`${message} · ${elapsedSeconds(started)}s`);
      } catch (e) {
        // A broken progress hint must never break the task itself.
        // 进度提示出错不能影响任务本身。
      }
    }, intervalMs);
    if (typeof timer.unref === 'function') timer.unref();
    try {
      return await fn();
    } finally {
      clearInterval(timer);
      screen.setStage(previous);
    }
  }

  const tick =
    typeof opts.onTick === 'function'
      ? opts.onTick
      : () => view.note(colors.dim(`  ${t('tui.pages.stillWorking', { seconds: elapsedSeconds(started) })}`));

  view.note(colors.dim(`  ${message}`));
  const timer = setInterval(() => {
    try {
      tick();
    } catch (e) {
      // A broken progress hint must never break the task itself.
      // 进度提示出错不能影响任务本身。
    }
  }, intervalMs);
  if (typeof timer.unref === 'function') timer.unref();
  try {
    return await fn();
  } finally {
    clearInterval(timer);
  }
}

/**
 * Whole seconds elapsed since `startedAt`.
 * 自 `startedAt` 起经过的整秒数。
 */
function elapsedSeconds(startedAt) {
  return Math.max(0, Math.round((Date.now() - Number(startedAt || 0)) / 1000));
}

/**
 * Identifier of one picker row: `modelId` when present, otherwise the row index as a string.
 * Custom rows (they carry `idOf`) win over both.
 *
 * 选择器某一行的标识：优先 `modelId`，没有就用行下标（字符串）。
 * 自带 `idOf` 的自定义行优先。
 */
function rowId(item, index, opts = {}) {
  if (typeof opts.idOf === 'function') return String(opts.idOf(item, index));
  if (item && item.modelId !== undefined && item.modelId !== null) return String(item.modelId);
  return String(index);
}

/**
 * Pick exactly one item from a list. The full-screen picker is used under a TTY; otherwise the plain
 * prompts list keeps CI and redirected runs working. Both paths answer with the item itself, so
 * callers never see a half-answered state.
 *
 * 从列表中单选一项。TTY 下使用全屏选择器；否则用 prompts 列表，保证 CI 与重定向场景仍可用。
 * 两条路径都返回条目本身，调用方不会拿到半成品答案。
 *
 * @param {Array<object>} items
 * @param {{
 *   message:string, title?:string, describe?:(item:object, state:any)=>string, state?:any,
 *   label?:(item:object)=>string, idOf?:(item:object, index:number)=>string,
 *   initialCursor?:number, onLog?:(msg:string)=>void, onEnter?:() => void,
 *   decidedMessage?:string, decidedParams?:(item:object)=>Record<string, any>
 * }} opts
 * @returns {Promise<object|null>} the chosen item, or null when cancelled
 */
async function pickOne(items, opts = {}) {
  const list = Array.isArray(items) ? items.filter(Boolean) : [];
  if (!list.length) return null;
  const onLog = typeof opts.onLog === 'function' ? opts.onLog : view.log;
  const label = typeof opts.label === 'function' ? opts.label : (item) => String(item.name || '');
  const ids = list.map((item, index) => rowId(item, index, opts));

  if (canPick()) {
    const answer = await selectItems(list, {
      mode: 'single',
      title: opts.title || opts.message,
      describe: opts.describe,
      state: opts.state,
      label,
      initialCursor: Number.isFinite(opts.initialCursor) ? opts.initialCursor : 0,
      onLog,
      onEnter: opts.onEnter,
      minHeight: 6,
    });
    if (!answer || !answer.selected.size) {
      view.decision('tui.view.decisionCancelled');
      return null;
    }
    const wanted = String([...answer.selected][0]);
    const chosen = list[ids.indexOf(wanted)] || null;
    const decidedParams = typeof opts.decidedParams === 'function' ? opts.decidedParams(chosen) : null;
    view.decision(opts.decidedMessage || 'tui.view.decisionSelected', {
      name: chosen ? label(chosen) : wanted,
      ...(decidedParams || {}),
    });
    return chosen;
  }

  const ans = await promptLib()({
    type: 'select',
    name: 'value',
    message: `${opts.message}${hint()}`,
    choices: list.map((item, index) => ({
      title: label(item),
      value: ids[index],
      description: typeof opts.describe === 'function' ? opts.describe(item, opts.state) : undefined,
    })),
    initial: Number.isFinite(opts.initialCursor) ? opts.initialCursor : 0,
  });
  const answer = answerValue(ans, ['value', 'modelId', 'id', 'versionId', 'action', 'mode']);
  if (!answer.found) return null;
  return list[ids.indexOf(answerId(answer.value))] || null;
}

/**
 * Pick any number of items from a list (an empty selection is allowed).
 * 从列表中多选若干项（允许一个都不选）。
 *
 * @param {Array<object>} items
 * @param {{
 *   message:string, title?:string, describe?:(item:object, state:any)=>string, state?:any,
 *   label?:(item:object)=>string, initialSelected?:Iterable<string|number>,
 *   onLog?:(msg:string)=>void, onEnter?:() => void
 * }} opts
 * @returns {Promise<Array<object>|null>} the chosen items (possibly empty), or null when cancelled
 */
async function pickMany(items, opts = {}) {
  const list = Array.isArray(items) ? items.filter(Boolean) : [];
  if (!list.length) return [];
  const onLog = typeof opts.onLog === 'function' ? opts.onLog : view.log;
  const label = typeof opts.label === 'function' ? opts.label : (item) => String(item.name || '');
  const ids = list.map((item, index) => rowId(item, index, opts));
  const initial = new Set(Array.from(opts.initialSelected || [], (v) => String(v)));

  if (canPick()) {
    const answer = await selectItems(list, {
      mode: 'multi',
      title: opts.title || opts.message,
      describe: opts.describe,
      state: opts.state,
      label,
      idOf: opts.idOf,
      initialSelected: initial,
      onLog,
      onEnter: opts.onEnter,
      minHeight: 6,
    });
    if (!answer) {
      view.decision('tui.view.decisionCancelled');
      return null;
    }
    const chosen = new Set([...answer.selected].map(String));
    const picked = list.filter((item, index) => chosen.has(ids[index]));
    view.decision('tui.view.decisionPicked', { count: picked.length });
    return picked;
  }

  const ans = await promptLib()({
    type: 'multiselect',
    name: 'ids',
    message: `${opts.message}${hint()}`,
    instructions: t('tui.pages.multiselectInstructions'),
    choices: list.map((item, index) => ({
      title: label(item),
      value: ids[index],
      selected: initial.has(ids[index]),
      description: typeof opts.describe === 'function' ? opts.describe(item, opts.state) : undefined,
    })),
  });
  const answer = answerValue(ans, ['ids', 'value', 'selected']);
  if (!answer.found) return null;
  const chosen = new Set((Array.isArray(answer.value) ? answer.value : []).map((v) => answerId(v)));
  return list.filter((item, index) => chosen.has(ids[index]));
}

// ---------------------------------------------------------------------------
// Fact blocks (detail pages)
// 信息区块（详情页）
// ---------------------------------------------------------------------------

/**
 * Render "field: value" lines with a common label column.
 * 渲染「字段: 值」行，标签列对齐。
 *
 * @param {Array<{label:string, value:string, color?:(s:string)=>string}>} facts
 * @returns {string[]}
 */
function describeFacts(facts) {
  const rows = (Array.isArray(facts) ? facts : []).filter(
    (f) => f && f.value !== undefined && f.value !== null && String(f.value).trim() !== ''
  );
  if (!rows.length) return [];
  const width = rows.reduce((max, f) => Math.max(max, displayWidth(String(f.label))), 0);
  return rows.map((f) => {
    const label = padTo(String(f.label), width);
    const value = String(f.value);
    const paint = typeof f.color === 'function' ? f.color : (s) => s;
    return `  ${colors.dim(label)}  ${paint(value)}`;
  });
}

/**
 * Print a titled block: a heading line followed by indented body lines.
 * 打印带标题的信息块：标题行 + 缩进正文。
 */
function printBlock(title, lines) {
  view.note('');
  view.note(colors.bold(`  ${title}`));
  for (const line of lines) view.note(`  ${line}`);
}

// ---------------------------------------------------------------------------
// Help page
// 帮助页
// ---------------------------------------------------------------------------

/**
 * Shortcut sections shown on the help page.
 * 帮助页展示的快捷键分组。
 */
const HELP_SECTIONS = [
  {
    titleKey: 'tui.help.sectionGeneral',
    items: [
      ['↑/↓', 'tui.help.generalMove'],
      ['Home/End', 'tui.help.generalFirstLast'],
      ['PgUp/PgDn', 'tui.help.generalPage'],
      ['Enter', 'tui.help.generalConfirm'],
      ['Esc', 'tui.help.generalBack'],
      ['Ctrl+M', 'tui.help.generalTasks'],
      ['Ctrl+L', 'tui.help.generalLog'],
      ['Ctrl+C', 'tui.help.generalQuit'],
      ['?', 'tui.help.generalHelp'],
    ],
  },
  {
    titleKey: 'tui.help.sectionList',
    items: [
      ['/', 'tui.help.generalSearch'],
      ['t / b', 'tui.help.generalFilter'],
      ['s', 'tui.help.generalSort'],
      ['Space', 'tui.help.generalToggle'],
      ['a / i', 'tui.help.generalAllInvert'],
      ['1-9', 'tui.help.generalQuickSelect'],
    ],
  },
  {
    titleKey: 'tui.help.sectionDownload',
    items: [
      ['s', 'tui.help.runSkip'],
      ['Esc', 'tui.help.runCancel'],
      ['c', 'tui.help.generalCancelTask'],
    ],
  },
];

/**
 * Help page lines (pure, unit-testable): a boxed key reference.
 * 帮助页内容行（纯函数，可单测）：带边框的按键速查。
 *
 * @param {{columns?:number, version?:string}} [opts]
 * @returns {string[]}
 */
function helpLines(opts = {}) {
  const columns = view.screenColumns();
  const width = Math.max(48, Math.min(Number(opts.columns) || columns, columns) - 2);
  const g = view.glyphs();
  const keyWidth = HELP_SECTIONS.reduce(
    (max, section) => Math.max(max, ...section.items.map(([keys]) => displayWidth(keys))),
    0
  );
  const lines = [];
  const top = `${g.boxH.repeat(2)} ${t('tui.help.title')} `;
  lines.push(`  ${truncateTo(top + g.boxH.repeat(Math.max(0, width - displayWidth(top))), width)}`);

  const version = opts.version === undefined ? packageVersion() : opts.version;
  const subtitle = version ? t('tui.help.version', { version }) : '';
  if (subtitle) lines.push(`  ${colors.dim(truncateTo(`  ${subtitle}`, width))}`);

  for (const section of HELP_SECTIONS) {
    lines.push(`  ${colors.bold(truncateTo(`  ${t(section.titleKey)}`, width))}`);
    for (const [keys, descKey] of section.items) {
      const key = padTo(keys, keyWidth);
      lines.push(`  ${truncateTo(`    ${colors.cyan(key)}  ${t(descKey)}`, width)}`);
    }
  }

  const footer = `  ${t('tui.help.footer')}`;
  lines.push(`  ${colors.dim(truncateTo(footer, width))}`);
  // Keep the visual frame balanced: one blank line above and below the body.
  // 让视觉边框上下对称：正文前后各留一个空行。
  return ['', ...lines, ''];
}

/**
 * Show the help page.
 *
 * With the shell active it is a modal inside the frame, so the menu comes back untouched; without
 * one it takes over the alternate buffer, and without a TTY it is simply printed.
 *
 *
 * 显示帮助页。
 *
 * 外壳接管时它是框架内的模态，关闭后菜单原样回来；没有外壳时接管备用缓冲区；
 * 非 TTY 下则直接打印。
 *
 * @param {{onQuit?:() => void, stream?:NodeJS.ReadStream, out?:NodeJS.WriteStream}} [opts]
 */
async function showHelp(opts = {}) {
  if (screen.isActive()) {
    await screen.prompt({
      title: t('tui.help.shortTitle'),
      handlesHelp: true,
      hints: () => [t('tui.help.footer')],
      render(state, ctx) {
        return helpLines({ columns: ctx.width }).map((line) => line.replace(/^ {2}/, ''));
      },
      onKey(text, key, entry) {
        entry.settle(null);
      },
    });
    return;
  }

  const out = opts.out || process.stdout;
  const stdin = opts.stream || process.stdin;
  const interactive = !!(stdin && stdin.isTTY) && !process.env.CIVITAI_PLAIN;

  if (interactive) view.beginFullScreen();
  try {
    out.write(`${helpLines({ columns: out.columns }).join('\n')}\n`);
    if (!interactive) return;

    await new Promise((resolve) => {
      let release = () => {};
      const restore = installRawKeys({
        stream: stdin,
        onSignal: (intent) => {
          release();
          if (intent === 'cancel') {
            if (typeof opts.onQuit === 'function') opts.onQuit();
            else view.triggerCancel();
          }
          resolve();
        },
        onKey: () => {
          release();
          resolve();
          return false;
        },
      });
      // No raw keys on this terminal: do not wait for a key that can never arrive, just say so.
      // 这个终端拿不到原始按键：不要等一个永远不会到来的按键，直接说明。
      if (!restore) {
        out.write(`${t('tui.view.helpNoWait')}\n`);
        resolve();
        return;
      }
      release = restore;
    });
  } finally {
    // Leaving the alternate buffer restores the screen exactly as it was before the help page.
    // 退出备用缓冲区后，屏幕恢复到打开帮助页之前的样子。
    if (interactive) view.endFullScreen();
  }
}

// ---------------------------------------------------------------------------
// Small confirm helpers used by several flows
// 多个流程共用的确认辅助
// ---------------------------------------------------------------------------

/**
 * Ask before re-downloading already completed items; returns 'force' | 'skip' | null (cancelled).
 * 询问如何处理已完成项；返回 'force' | 'skip' | null（取消）。
 */
async function askRedownload(count) {
  const choice = await promptMenu(t('tui.pages.redownloadTitle', { count }), [
    { title: t('tui.pages.redownloadSkip'), value: 'skip', description: t('tui.pages.redownloadSkipDesc') },
    { title: t('tui.pages.redownloadForce'), value: 'force', description: t('tui.pages.redownloadForceDesc') },
  ]);
  return choice;
}

module.exports = {
  hint,
  hintLines,
  heading,
  windowOf,
  scrollToSection,
  rowLine,
  packageVersion,
  promptMenu,
  promptConfirm,
  promptText,
  promptMessage,
  wrapText,
  promptOutDir,
  pickOne,
  pickMany,
  canPick,
  withSpinner,
  elapsedSeconds,
  describeFacts,
  printBlock,
  HELP_SECTIONS,
  helpLines,
  showHelp,
  askRedownload,
};
