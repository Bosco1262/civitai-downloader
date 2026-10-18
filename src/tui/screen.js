'use strict';

// Full-screen app shell of the TUI.
//
// The shell owns the terminal for the whole session and paints one stable frame on every repaint:
//
//   header       project name + one line with the global key hint
//   info panel   boxed "already configured" facts + one line per running task
//   body         breadcrumb, the current screen or prompt, and the log pane
//   footer       key hints of whatever has focus right now
//
// Screens and prompts never touch the terminal themselves: they return text lines, and the shell
// clips, pads and paints them. That is what makes the header, the info panel and the task view
// available everywhere instead of only on the main menu.
//
// Key model (identical on every screen):
//   - up/down (or k/j) move, Home/End and PgUp/PgDn jump, Enter confirms;
//   - Esc cancels the current prompt or leaves the current screen without saving;
//   - Tab switches to the task view and back;
//   - Ctrl+C is the only way to leave the program from anywhere.
//
//
// TUI 的全屏应用外壳。
//
// 外壳在整个会话期间接管终端，每次重绘都画出同一个稳定框架：
//
//   页眉     项目名 + 一行全局按键提示
//   信息面板 框起来的「已设置信息」+ 每个运行中的任务一行
//   主体     面包屑、当前界面或提问，以及日志区
//   页脚     当前焦点所在处的按键提示
//
// 各界面与提问都不直接操作终端：它们只返回文本行，由外壳裁剪、补齐并绘制。
// 正因如此，页眉、信息面板与任务视图才能无处不在，而不是只在主菜单里出现。
//
// 按键模型（所有界面一致）：
//   - ↑/↓（或 k/j）移动，Home/End 与 PgUp/PgDn 跳转，回车确认；
//   - Esc 取消当前提问或直接离开当前界面且不保存；
//   - Tab 切到任务视图，再按一次返回；
//   - Ctrl+C 是唯一可以从任何位置退出程序的方式。

const layout = require('./layout');
const tasks = require('./tasks');
const { installRawKeys, isTextInput, isBackspace } = require('./keys');
const { formatBytes, formatDuration } = require('../util');
const { t } = require('../i18n');

const { colors, displayWidth, truncateTo, padTo } = layout;

/**
 * Height of the fixed header: project name + global key hint + one blank line.
 * 固定页眉的高度：项目名 + 全局按键提示 + 一行空行。
 */
const HEADER_ROWS = 3;
/**
 * Rows the info panel needs besides its content lines: two borders plus the blank separator.
 * 信息面板除内容行之外需要的行数：上下边框加一行分隔空行。
 */
const INFO_CHROME_ROWS = 3;
/**
 * Most task lines the info panel shows (the task view behind Tab shows them all).
 * 信息面板最多显示的任务行数（Tab 打开的任务视图会显示全部）。
 */
const INFO_TASK_ROWS = 3;
/**
 * Most log lines the body reserves; the pane shrinks on short terminals.
 * 主体最多预留的日志行数；终端较矮时日志区会自动缩小。
 */
const LOG_ROWS = 5;
/**
 * Body rows that must stay for the screen itself before the log pane gets any.
 * 屏幕内容至少保留的主体行数，之后才给日志区分配空间。
 */
const MIN_BODY_CONTENT_ROWS = 4;
/**
 * The log keeps this many lines in memory; older ones are only in the run log file.
 * 内存中保留的日志行数；更早的内容只在运行日志文件里。
 */
const LOG_KEEP = 400;

let active = false;
let started = false;
let restoreKeys = null;
let resumeListener = null;
let quitHandler = null;
let escapeHandler = null;
let keyHook = null;
let infoProvider = () => [];
let baseScreen = null;
let modalStack = [];
let crumbs = [];
let stage = '';
let logs = [];
let noticeText = '';
let noticeColor = null;
let noticeAt = 0;
let taskView = false;
let taskCursor = 0;
let dirty = true;
let scheduled = false;
let tickTimer = null;
let dims = { columns: 100, rows: 30 };
let lastPaint = '';

// ---------------------------------------------------------------------------
// Small helpers
// 小工具
// ---------------------------------------------------------------------------

/**
 * Current terminal size, clamped to a readable range.
 * 当前终端尺寸，夹在可读区间内。
 */
function measure() {
  dims = {
    columns: layout.terminalColumns(process.stdout.columns),
    rows: layout.terminalRows(process.stdout.rows),
  };
  return dims;
}

/**
 * Left margin of the frame (1 column on narrow terminals).
 * 框架的左边距（窄终端上为 1 列）。
 */
function margin() {
  return dims.columns >= layout.MIN_COLUMNS ? 2 : 1;
}

/**
 * Usable content width inside the margins.
 * 边距之内可用的内容宽度。
 */
function bodyWidth() {
  return Math.max(20, dims.columns - margin() * 2);
}

/**
 * Whether the decorative parts of the frame fit (borders, descriptions).
 * 框架的装饰部分（边框、说明文字）是否放得下。
 */
function roomy() {
  return dims.columns >= layout.MIN_COLUMNS;
}

function indent(text, pad = 0) {
  return `${' '.repeat(margin() + pad)}${text}`;
}

// ---------------------------------------------------------------------------
// Lifecycle
// 生命周期
// ---------------------------------------------------------------------------

/**
 * Whether the shell currently owns the terminal.
 * 外壳当前是否接管着终端。
 */
function isActive() {
  return active;
}

/**
 * Enter the alternate screen buffer, install the shared key loop and paint the first frame.
 *
 * Returns false when the terminal cannot host the shell (no TTY, CIVITAI_PLAIN set, raw mode
 * refused); every caller then keeps its plain fallback path.
 *
 *
 * 进入备用屏幕缓冲区，安装统一按键循环并绘制第一帧。
 *
 * 终端无法承载外壳（非 TTY、设置了 CIVITAI_PLAIN、原始模式被拒）时返回 false；
 * 调用方随后继续走各自的简易回退路径。
 *
 * @param {{onQuit?:() => void}} [opts]
 * @returns {boolean}
 */
function start(opts = {}) {
  if (active) return true;
  if (!process.stdout.isTTY || !process.stdin.isTTY) return false;
  if (process.env.CIVITAI_PLAIN) return false;
  if (typeof process.stdin.setRawMode !== 'function') return false;

  quitHandler = typeof opts.onQuit === 'function' ? opts.onQuit : null;
  // Restoring the terminal before the shell takes it over guarantees a clean start: whatever the
  // console printed before (warnings, a previous run) is gone, which is what "clear screen first"
  // means here.
  //
  // 接管前先清屏：控制台此前打印的内容（警告、上一次运行）都被清掉，这就是「先清屏再显示」。
  try {
    process.stdout.write(layout.ANSI_ALT_SCREEN_ON + layout.ANSI_CLEAR + layout.ANSI_HIDE_CURSOR);
  } catch (e) {
    return false;
  }

  const installed = installRawKeys({ onKey: onKey, onSignal: onSignal });
  if (!installed) {
    // No raw keys: leave the alternate buffer again and let the caller fall back.
    // 拿不到原始按键：退出备用缓冲区，让调用方回退。
    try {
      process.stdout.write(layout.ANSI_SHOW_CURSOR + layout.ANSI_ALT_SCREEN_OFF);
    } catch (e) {
      // Ignore: the terminal is unusable either way.
      // 忽略：终端本来就用不了。
    }
    return false;
  }
  restoreKeys = installed;
  resumeListener = () => {
    // Coming back from Ctrl+Z: the terminal must be taken over again before the next paint.
    // 从 Ctrl+Z 恢复：下一次绘制前必须重新接管终端。
    try {
      process.stdout.write(layout.ANSI_ALT_SCREEN_ON + layout.ANSI_CLEAR + layout.ANSI_HIDE_CURSOR);
    } catch (e) {
      // Ignore a dead terminal.
      // 终端已消失时忽略。
    }
    lastPaint = '';
    measure();
    render();
  };
  process.on('SIGCONT', resumeListener);
  process.stdout.on('resize', onResize);

  active = true;
  started = true;
  measure();
  // The next paint must not be skipped as "unchanged": the caller may repaint an already painted
  // frame after the terminal was cleared (resume from Ctrl+Z).
  //
  // 下一帧不能因为「内容没变」被跳过：终端被清空后（Ctrl+Z 恢复）调用方会重画同一帧。
  lastPaint = '';
  // A one-second heartbeat keeps the elapsed time and the speed display moving even when no flow
  // tick fires.
  //
  // 每秒一次的心跳让「已用」与速度在没有流程刷新时也在走动。
  tickTimer = setInterval(() => {
    if (tasks.runningTasks().length) refresh();
  }, 1000);
  if (typeof tickTimer.unref === 'function') tickTimer.unref();
  render();
  return true;
}

/**
 * Leave the alternate screen buffer and give the terminal back.
 * 退出备用屏幕缓冲区并把终端交还。
 */
function stop() {
  if (!active) return;
  active = false;
  if (restoreKeys) {
    try {
      restoreKeys();
    } catch (e) {
      // Ignore failures while restoring raw mode.
      // 恢复原始模式失败时忽略。
    }
    restoreKeys = null;
  }
  if (tickTimer) {
    clearInterval(tickTimer);
    tickTimer = null;
  }
  if (resumeListener) {
    process.removeListener('SIGCONT', resumeListener);
    resumeListener = null;
  }
  process.stdout.removeListener('resize', onResize);
  try {
    process.stdout.write(layout.ANSI_SHOW_CURSOR + layout.ANSI_CLEAR + layout.ANSI_ALT_SCREEN_OFF);
  } catch (e) {
    // The terminal may already be gone.
    // 终端可能已经没了。
  }
}

/**
 * Ask the app to leave (used by Esc on the main menu and by Ctrl+C everywhere).
 * 请求应用退出（主菜单的 Esc 与任意位置的 Ctrl+C 使用）。
 */
function requestQuit() {
  if (quitHandler) {
    quitHandler();
    return;
  }
  stop();
  process.exit(0);
}

function onResize() {
  measure();
  render();
}

// ---------------------------------------------------------------------------
// Input
// 输入
// ---------------------------------------------------------------------------

/**
 * Terminal key name of a keypress, with the few spellings terminals disagree about normalized.
 * 按键的终端名称，并把各终端写法不一致的少数按键归一化。
 */
function keyName(key) {
  const name = (key && key.name) || '';
  if (name === 'enter') return 'return';
  return name;
}

function onSignal(intent) {
  if (intent === 'cancel') {
    requestQuit();
    return;
  }
  // Ctrl+Z: give the terminal back, suspend, and take it over again on resume. Only POSIX shells can
  // stop a process; elsewhere the key is acknowledged and ignored.
  //
  // Ctrl+Z：先交还终端再挂起，恢复后重新接管。只有 POSIX shell 能挂起进程，其它平台只提示后忽略。
  if (process.platform === 'win32') {
    notice(t('tui.screen.suspendUnsupported'), colors.yellow);
    return;
  }
  stop();
  process.kill(process.pid, 'SIGTSTP');
}

function onKey(text, key) {
  const k = key || {};
  const name = keyName(k);
  const top = modalStack[modalStack.length - 1];
  if (top) {
    try {
      top.onKey(String(text === undefined || text === null ? '' : text), { ...k, name });
    } catch (e) {
      top.settle(null);
      logLine(colors.red(t('tui.screen.promptFailed', { error: (e && e.message) || e })));
    }
    refresh();
    return;
  }

  if (name === 'tab' || text === '\t') {
    toggleTaskView();
    return;
  }

  if (taskView) {
    if (name === 'escape' || (text === 'q' && !k.ctrl)) {
      toggleTaskView(false);
      return;
    }
    if (name === 'up' || text === 'k') return moveTaskCursor(-1);
    if (name === 'down' || text === 'j') return moveTaskCursor(1);
    if (text === 'c') return cancelSelectedTask();
    if (text === 'x') {
      tasks.clearFinished();
      taskCursor = 0;
      notice(t('tui.screen.tasksCleared'), colors.dim);
      return;
    }
    return;
  }

  if (name === 'escape' || (text === 'q' && !k.ctrl && !baseScreenAcceptsText())) {
    // A running task claims Esc first: "Esc cancels" is what users expect while a download is
    // going on.
    //
    // 正在运行的任务优先占用 Esc：下载进行中时「Esc 取消」才符合预期。
    if (typeof escapeHandler === 'function' && escapeHandler() !== false) {
      refresh();
      return;
    }
    // Esc leaves the current screen without saving. The main menu has nothing above it, so there it
    // means "quit".
    //
    // Esc 直接离开当前界面且不保存。主菜单之上没有别的界面，因此在那里表示退出。
    if (baseScreen && typeof baseScreen.onEscape === 'function' && baseScreen.onEscape() === false) {
      refresh();
      return;
    }
    requestQuit();
    return;
  }

  let handled = false;
  // A hook (the running download's "skip this model") sees the key before the screen does.
  // 钩子（下载中的「跳过当前模型」）先于界面看到按键。
  if (typeof keyHook === 'function' && keyHook(String(text || ''), { ...k, name }) === true) {
    refresh();
    return;
  }
  if (baseScreen && typeof baseScreen.onKey === 'function') {
    handled = baseScreen.onKey(String(text || ''), { ...k, name }) === true;
  }
  if (!handled && text === '?' && baseScreen && typeof baseScreen.help === 'function') {
    baseScreen.help();
  }
  refresh();
}

/**
 * Whether the current screen is a text field (then `q` must be typed, not treated as "back").
 * 当前界面是否是文本输入（此时 `q` 应被输入，而不是当成返回）。
 */
function baseScreenAcceptsText() {
  return !!(baseScreen && baseScreen.acceptsText);
}

// ---------------------------------------------------------------------------
// Screens, breadcrumbs and prompts
// 界面、面包屑与提问
// ---------------------------------------------------------------------------

/**
 * Install the persistent screen (usually the main menu).
 *
 * A screen is a plain object with four fields:
 *   `title` (breadcrumb), `render(ctx)` (body lines), `hints()` (footer lines) and
 *   `onKey(text, key)` (returns true when it used the key).
 * `onEscape` may return false to handle Esc itself instead of letting it quit.
 *
 *
 * 安装常驻界面（通常是主菜单）。
 *
 * 界面对象就四个字段：`title`（面包屑）、`render(ctx)`（主体行）、
 * `hints()`（页脚行）与 `onKey(text, key)`（消费了按键时返回 true）。
 * `onEscape` 返回 false 表示自己处理 Esc，而不是让它退出程序。
 *
 * @param {object} screen
 */
function setBase(screen) {
  baseScreen = screen || null;
  crumbs = baseScreen && baseScreen.title ? [String(baseScreen.title)] : [];
  refresh();
}

function getBase() {
  return baseScreen;
}

/**
 * Replace the last breadcrumb segment (used when a screen renames itself, e.g. after an edit).
 * 替换面包屑的最后一段（界面改名时使用，例如编辑之后）。
 */
function setCrumb(title) {
  const next = String(title || '');
  if (!next) return;
  if (crumbs.length) crumbs[crumbs.length - 1] = next;
  else crumbs = [next];
  refresh();
}

/**
 * Provide the "already configured" facts shown in the info panel. The provider runs on every paint,
 * so a login or a settings save is reflected immediately.
 *
 * 提供信息面板里的「已设置信息」。提供者在每次绘制时调用，因此登录或保存设置后会立即反映出来。
 *
 * @param {() => Array<{label:string, value:string, color?:Function}>} fn
 */
function setInfo(fn) {
  infoProvider = typeof fn === 'function' ? fn : () => [];
  refresh();
}

/**
 * Open a prompt (modal) that renders in the body area until it settles.
 *
 * The spec carries `title`, `render(state, ctx)`, `hints(state)` and `onKey(text, key, api)`; the
 * returned promise resolves with whatever the prompt passes to `api.settle(value)`. Esc always
 * settles with null, so a caller can tell "cancelled" from a real answer.
 *
 *
 * 打开一个在主体区域渲染、直到结束为止的提问（模态）。
 *
 * spec 提供 `title`、`render(state, ctx)`、`hints(state)` 与 `onKey(text, key, api)`；
 * 返回的 promise 由提问调用 `api.settle(value)` 时兑现。Esc 一律以 null 结束，
 * 调用方据此区分「取消」与「真实答案」。
 *
 * @param {object} spec
 * @returns {Promise<any>}
 */
function prompt(spec) {
  return new Promise((resolve) => {
    let settled = false;
    const entry = {
      spec,
      state: spec.initialState ? { ...spec.initialState } : {},
      settle(value) {
        if (settled) return;
        settled = true;
        const index = modalStack.indexOf(entry);
        if (index >= 0) modalStack.splice(index, 1);
        if (spec.crumb !== false) crumbs.pop();
        resolve(value === undefined ? null : value);
        refresh();
      },
      onKey(text, key) {
        if (key.name === 'escape') {
          // A prompt may want to react to Esc first (settings warns about unsaved edits before it
          // really leaves); returning true means "I handled it, stay open".
          //
          // 提问可以先对 Esc 做出反应（设置页会在真正离开前提醒未保存的改动）；
          // 返回 true 表示「我处理了，保持打开」。
          if (typeof spec.onEscape === 'function' && spec.onEscape(entry) === true) return;
          entry.settle(null);
          return;
        }
        spec.onKey(text, key, entry);
      },
      render(ctx) {
        return spec.render(entry.state, ctx);
      },
      hints() {
        return typeof spec.hints === 'function' ? spec.hints(entry.state) : [];
      },
    };
    if (spec.crumb !== false && spec.title) crumbs.push(String(spec.title));
    modalStack.push(entry);
    refresh();
  });
}

/**
 * Whether a prompt is currently open.
 * 当前是否有提问处于打开状态。
 */
function hasPrompt() {
  return modalStack.length > 0;
}

/**
 * Transient one-line message shown above the log pane (auto-clears after a few seconds).
 * 显示在日志区上方的临时单行消息（几秒后自动清除）。
 */
function notice(text, color) {
  const value = String(text === undefined || text === null ? '' : text).trim();
  if (!value) return;
  noticeText = value;
  noticeColor = typeof color === 'function' ? color : colors.dim;
  noticeAt = Date.now();
  refresh();
  const timer = setTimeout(() => {
    if (Date.now() - noticeAt >= NOTICE_MS - 50) {
      noticeText = '';
      refresh();
    }
  }, NOTICE_MS);
  if (typeof timer.unref === 'function') timer.unref();
}

/**
 * How long a notice stays on screen.
 * 提示消息停留的时间。
 */
const NOTICE_MS = 5000;

/**
 * Append one already-formatted line to the log pane.
 * 往日志区追加一行已排版好的文本。
 */
function logLine(text) {
  const line = String(text === undefined || text === null ? '' : text);
  for (const part of line.split('\n')) logs.push(part);
  if (logs.length > LOG_KEEP) logs.splice(0, logs.length - LOG_KEEP);
  refresh();
}

function clearLog() {
  logs = [];
  refresh();
}

function logCount() {
  return logs.length;
}

// ---------------------------------------------------------------------------
// Task view (Tab)
// 任务视图（Tab）
// ---------------------------------------------------------------------------

/**
 * Show or hide the task view; without an argument it toggles.
 * 显示或隐藏任务视图；不带参数时切换。
 */
function toggleTaskView(value) {
  taskView = value === undefined ? !taskView : !!value;
  if (!taskView) return refresh();
  const list = tasks.listTasks();
  const running = list.findIndex((task) => task.status === tasks.RUNNING);
  taskCursor = running >= 0 ? running : 0;
  return refresh();
}

function isTaskView() {
  return taskView;
}

function moveTaskCursor(delta) {
  const list = tasks.listTasks();
  if (!list.length) return;
  taskCursor = Math.max(0, Math.min(list.length - 1, taskCursor + delta));
  refresh();
}

function cancelSelectedTask() {
  const list = tasks.listTasks();
  const task = list[taskCursor];
  if (!task) return;
  if (task.status !== tasks.RUNNING) {
    notice(t('tui.screen.taskNotRunning'), colors.dim);
    return;
  }
  tasks.cancelTask(task.id);
  notice(t('tui.screen.taskCancelRequested', { name: task.name || task.id }), colors.yellow);
}

// ---------------------------------------------------------------------------
// Rendering
// 渲染
// ---------------------------------------------------------------------------

/**
 * Request a repaint; several calls inside one tick collapse into a single paint.
 * 请求重绘；同一轮内的多次调用会合并成一次绘制。
 */
function refresh() {
  dirty = true;
  if (scheduled || !active) return;
  scheduled = true;
  setImmediate(() => {
    scheduled = false;
    if (!dirty) return;
    render();
  });
}

/**
 * Paint the frame immediately.
 *
 * Every paint starts by moving home and erasing downwards. Without that the new frame would be
 * appended at the cursor position the previous one left behind — the first line of the new frame
 * would end up glued to the last line of the old one.
 *
 *
 * 立即绘制框架。
 *
 * 每次绘制都先回到左上角并向下擦除。少了这一步，新一帧会接在上一帧光标停留的位置继续写——
 * 新帧的第一行就会粘在旧帧的最后一行后面。
 */
function render() {
  if (!active) return;
  dirty = false;
  measure();
  const text = frame().join('\n');
  if (text === lastPaint) return;
  lastPaint = text;
  try {
    process.stdout.write(layout.ANSI_HOME_AND_CLEAR + text);
  } catch (e) {
    // A closed terminal must not crash the app.
    // 终端关闭不应让程序崩溃。
  }
}

/**
 * Compose the whole frame: header, info panel, body (or task view), log pane and footer hints.
 * 组装整个框架：页眉、信息面板、主体（或任务视图）、日志区与页脚提示。
 */
function frame() {
  measure();
  const lines = [];
  lines.push(clip(indent(colors.bold(t('tui.app.bannerTitle')))));
  lines.push(clip(indent(colors.dim(headerHint()))));
  lines.push('');

  const { info, bodyBudget } = frameBudget();
  lines.push(...info.lines, '');

  if (taskView) lines.push(...taskViewLines(bodyBudget));
  else lines.push(...bodyLines(bodyBudget));

  // The footer is pinned to the last rows so the hint line never moves around.
  // 页脚固定在最后几行，提示行不会到处跳。
  const hints = footerHints();
  for (let i = lines.length + hints.length; i < dims.rows; i++) lines.push('');
  lines.push(...hints.map((line) => clip(indent(colors.dim(line)))));

  return lines.map((line) => `${clip(line)}${layout.ANSI_ERASE_LINE_END}`);
}

/**
 * Global key hint of the header.
 *
 * Which spelling is used is decided by measuring, not by a column threshold: the English hint is
 * wider than the Chinese one, and a fixed threshold would truncate one of them.
 *
 *
 * 页眉里的全局按键提示。
 *
 * 用哪一种写法由「量出来放不放得下」决定，而不是固定列数阈值：
 * 英文提示比中文宽，写死阈值总会截断其中一种。
 */
function headerHint() {
  const full = t('tui.screen.headerHint');
  return displayWidth(full) <= dims.columns - margin() - 1 ? full : t('tui.screen.headerHintShort');
}

/**
 * Clip one frame row to the terminal width (never wrap, never scroll).
 * 把一帧中的某一行裁剪到终端宽度（不换行、不滚动）。
 */
function clip(line) {
  return truncateTo(line, dims.columns - 1);
}

/**
 * Footer hint lines of the current context.
 * 当前上下文的页脚提示行。
 */
function footerHints() {
  if (taskView) return [t('tui.screen.hintTaskView')];
  const top = modalStack[modalStack.length - 1];
  if (top) {
    const hints = top.hints();
    if (hints && hints.length) return hints.slice(0, 2);
  }
  if (baseScreen && typeof baseScreen.hints === 'function') {
    const hints = baseScreen.hints();
    if (hints && hints.length) return hints.slice(0, 2);
  }
  return [];
}

/**
 * Info panel ("dashboard"): the "already configured" facts and the live task progress, boxed.
 *
 * The panel is a two-section dashboard: the configured settings first (site, session, directory,
 * concurrency), then the tasks that are running right now. Both sections keep their heading, and the
 * panel gives up rows — extra task lines first, then facts from the bottom up, the site always last —
 * before the body starves on a short terminal, so the frame stays usable at 12 rows.
 *
 *
 * 信息面板（「仪表盘」）：把「已设置信息」与实时任务进度分两段，并用边框框起来。
 *
 * 面板是一块两段式仪表盘：先是已设置信息（站点、登录态、本地目录、并发），再是当前正在跑的任务。
 * 两段都保留标题；终端过矮时面板会先让出多余的任务行，再从下往上让出信息行（站点永远最后让），
 * 避免主体被挤没，12 行的终端也仍然可用。
 *
 * @returns {{lines:string[]}}
 */
function infoPanel(budget) {
  const facts = safeFacts();
  const running = tasks.runningTasks();
  const maxContent = Math.max(2, budget - INFO_CHROME_ROWS);
  const content = infoContent(facts, running, maxContent);

  const width = bodyWidth();
  if (!roomy()) return { lines: content.map((line) => clip(indent(line))) };
  return { lines: box(t('tui.screen.infoTitle'), content, width) };
}

/**
 * Content rows of the dashboard, degraded to fit `maxContent`.
 *
 * Degradation order: extra task lines, then the configured facts from the bottom up (the site is the
 * one fact that always stays), and only as a last resort the section headings. The panel therefore
 * never ends up showing half a fact line.
 *
 *
 * 仪表盘的内容行，按 `maxContent` 逐级降级。
 *
 * 降级顺序：先减多余的任务行，再从下往上减已设置信息（站点永远保留），
 * 最后才动两个小标题。因此面板永远不会只露出半行信息。
 */
function infoContent(facts, running, maxContent) {
  let keptFacts = facts.slice();
  let taskRows = Math.max(1, Math.min(INFO_TASK_ROWS, running.length));
  const build = () => [
    colors.dim(t('tui.screen.infoSettings')),
    ...keptFacts.map((fact) => factLine(fact, facts)),
    '',
    colors.dim(t('tui.screen.infoTasks')),
    ...taskLines(running, taskRows),
  ];

  let lines = build();
  while (lines.length > maxContent && taskRows > 1) {
    taskRows -= 1;
    lines = build();
  }
  while (lines.length > maxContent && keptFacts.length > 1) {
    keptFacts = keptFacts.slice(0, -1);
    lines = build();
  }
  // Still too tall: drop the headings and the separator, and show what fits.
  // 还是太高：去掉小标题与分隔空行，能显示多少显示多少。
  if (lines.length > maxContent) {
    lines = keptFacts.map((fact) => factLine(fact, facts)).slice(0, maxContent);
  }
  return lines;
}

/**
 * Facts of the info panel, with a broken provider downgraded to "no facts".
 * 信息面板的信息行；提供者出错时降级为「没有信息」。
 */
function safeFacts() {
  try {
    const facts = infoProvider();
    return Array.isArray(facts) ? facts.filter((fact) => fact && fact.label) : [];
  } catch (e) {
    return [];
  }
}

/**
 * One "label   value" line of the info panel, labels aligned in a shared column.
 * 信息面板的一行「标签   值」，标签列对齐。
 */
function factLine(fact, all) {
  const labelWidth = all.reduce((max, item) => Math.max(max, displayWidth(item.label)), 0);
  const paint = typeof fact.color === 'function' ? fact.color : (s) => s;
  return `${colors.dim(padTo(fact.label, labelWidth))}  ${paint(String(fact.value))}`;
}

/**
 * Task lines of the dashboard: name + bar + percentage, one line per running task.
 *
 * The section heading above them says what they are, so the lines themselves carry no label.
 *
 *
 * 仪表盘的任务行：名称 + 进度条 + 百分比，每个运行中的任务一行。
 *
 * 上方的小标题已经说明了它们是什么，因此这些行本身不再带标签。
 */
function taskLines(running, maxRows) {
  if (!running.length) return [colors.dim(t('tui.screen.infoIdle'))];
  return running.slice(0, Math.max(1, maxRows)).map((task) => {
    const pct = tasks.percentOf(task);
    const head = taskHead(task);
    const barWidth = Math.max(8, Math.min(20, bodyWidth() - displayWidth(head) - 16));
    return `${head}  ${progressBar(pct, barWidth)} ${pct.toFixed(1)}%`;
  });
}

/**
 * Display name of a task: the collection, plus the model currently being fetched.
 * 任务的显示名：收藏集，外加当前正在下载的模型。
 */
function taskHead(task) {
  const parts = [task.name, task.scope].filter(Boolean);
  return parts.join(colors.dim(` ${t('tui.screen.nameSeparator')} `));
}

/**
 * Progress bar text of the info panel and the task view.
 * 信息面板与任务视图使用的进度条文本。
 */
function progressBar(pct, width) {
  const w = Math.max(4, Math.floor(width));
  const clamped = Math.max(0, Math.min(100, Number.isFinite(pct) ? pct : 0));
  const filled = Math.round((clamped / 100) * w);
  const gl = layout.glyphs();
  const bar = gl.barFull.repeat(filled) + gl.barEmpty.repeat(Math.max(0, w - filled));
  return colors.cyan(bar);
}

/**
 * Body lines: the open prompt wins, then the task view, then the current screen.
 * 主体行：打开的提问优先，其次是任务视图，最后是当前界面。
 */
function bodyLines(budget) {
  const crumbLine = renderCrumbs();
  // The log pane and the notice line are reserved before the screen renders, so a screen can rely on
  // the row count it is handed instead of discovering afterwards that it lost rows to the log.
  //
  // 日志区与提示行在界面渲染之前就预留好，界面因此可以信赖拿到的行数，
  // 而不是渲染完才发现被日志挤掉了几行。
  const split = bodySplit(budget);
  const room = split.room;

  const lines = [];
  if (crumbLine) lines.push(clip(indent(crumbLine)), '');

  const top = modalStack[modalStack.length - 1];
  let content = [];
  const ctx = { width: bodyWidth(), columns: dims.columns, rows: room };
  try {
    if (top) content = top.render(ctx);
    else if (baseScreen && typeof baseScreen.render === 'function') content = baseScreen.render(ctx);
  } catch (e) {
    content = [colors.red(t('tui.screen.promptFailed', { error: (e && e.message) || e }))];
  }
  if (!Array.isArray(content)) content = [String(content)];
  if (content.length > room) content = content.slice(0, room);

  lines.push(...content.map((line) => clip(indent(line))));
  if (split.noticeActive) lines.push(clip(indent(noticeColor(` ${noticeText}`))));
  if (split.logRows > 0) lines.push(...logPane(split.logRows));
  return lines;
}

/**
 * Log pane: a titled rule followed by the newest log lines.
 * 日志区：一条带标题的分隔线，其后是最新的日志行。
 */
function logPane(rows) {
  const width = bodyWidth();
  const title = ` ${t('tui.screen.logTitle')} `;
  const used = logs.slice(-Math.max(1, rows - 1));
  const more = logs.length > used.length ? t('tui.screen.logMore', { count: logs.length - used.length }) : '';
  const head = colors.dim(
    `${layout.glyphs().boxH.repeat(2)}${title}${layout.glyphs().boxH.repeat(
      Math.max(0, width - displayWidth(title) - 4)
    )}${more ? ` ${more}` : ''}`
  );
  const lines = [clip(indent(head))];
  for (const line of used) lines.push(clip(indent(line)));
  return lines;
}

/**
 * Breadcrumb line ("main menu › settings"), the visual answer to "where am I".
 * 面包屑行（「主菜单 › 设置」），直观回答「我在哪一层」。
 */
function renderCrumbs() {
  const parts = crumbs.filter(Boolean);
  const tail = stage ? ` ${colors.dim(layout.glyphs().arrow)} ${colors.cyan(stage)}` : '';
  if (!parts.length) return tail.trim();
  const sep = ` ${colors.dim(layout.glyphs().arrow)} `;
  return (
    parts
      .map((part, index) => (index === parts.length - 1 ? colors.bold(part) : colors.dim(part)))
      .join(sep) + tail
  );
}

/**
 * Long-running step shown next to the breadcrumb ("what is happening right now").
 * 显示在面包屑旁边的耗时步骤（「现在正在做什么」）。
 *
 * @param {string} text empty clears it
 */
function setStage(text) {
  stage = String(text === undefined || text === null ? '' : text).trim();
  refresh();
}

/**
 * Task view content: one block per task (state line + progress line).
 * 任务视图内容：每个任务一块（状态行 + 进度行）。
 */
function taskViewLines(budget) {
  const lines = [clip(indent(colors.bold(t('tui.screen.taskTitle')))), ''];
  const list = tasks.listTasks();
  if (!list.length) {
    lines.push(clip(indent(colors.dim(t('tui.screen.taskNone')))));
    return lines;
  }
  const perTask = 2;
  const room = Math.max(1, Math.floor((budget - 2) / perTask));
  const start = Math.max(0, Math.min(taskCursor - room + 1, list.length - room));
  const window = list.slice(Math.max(0, start), Math.max(0, start) + room);
  window.forEach((task, index) => {
    const cursor = Math.max(0, start) + index === taskCursor;
    lines.push(clip(indent(`${cursor ? colors.cyan(layout.glyphs().cursor) : ' '} ${taskTitleLine(task)}`)));
    lines.push(clip(indent(`  ${taskDetailLine(task)}`, 2)));
  });
  if (list.length > window.length) {
    lines.push(clip(indent(colors.dim(t('tui.screen.taskMore', { count: list.length - window.length })))));
  }
  return lines;
}

/**
 * First line of a task block: name, status and elapsed time.
 * 任务块的第一行：名称、状态与已用时间。
 */
function taskTitleLine(task) {
  const kind = task.kind ? `${colors.dim(`[${task.kind}]`)} ` : '';
  return `${kind}${taskHead(task) || task.id}  ${statusText(task)}  ${colors.dim(
    t('tui.screen.taskElapsed', { elapsed: tasks.elapsedText(task) })
  )}`;
}

/**
 * Status text of a task, colored by outcome.
 * 任务状态文本，按结果着色。
 */
function statusText(task) {
  if (task.status === tasks.RUNNING) return colors.green(t('tui.screen.statusRunning'));
  if (task.status === tasks.DONE) return colors.cyan(t('tui.screen.statusDone'));
  if (task.status === tasks.CANCELLED) return colors.yellow(t('tui.screen.statusCancelled'));
  return colors.red(t('tui.screen.statusFailed'));
}

/**
 * Second line of a task block: progress bar, counts, speed and ETA.
 * 任务块的第二行：进度条、计数、速度与剩余时间。
 */
function taskDetailLine(task) {
  const pct = tasks.percentOf(task);
  const parts = [
    `${progressBar(pct, 16)} ${pct.toFixed(1)}%`,
    t('tui.screen.taskCounts', {
      done: task.done,
      skipped: task.skipped,
      failed: task.failed,
      total: task.total,
    }),
    `${formatBytes(task.bytes)}/${formatBytes(task.totalBytes)}`,
  ];
  if (task.status === tasks.RUNNING && task.speed > 0) parts.push(`${formatBytes(task.speed)}/s`);
  if (task.status === tasks.RUNNING && task.eta) parts.push(t('tui.run.remaining', { eta: task.eta }));
  if (task.detail) parts.push(task.detail);
  if (task.attempts && task.attempts.attempt > 1) {
    parts.push(
      colors.yellow(
        t('tui.run.retry', {
          attempt: task.attempts.attempt,
          max: task.attempts.max,
          code: task.attempts.httpCode || '-',
        })
      )
    );
  }
  return parts.join(colors.dim(` ${layout.glyphs().bullet} `));
}

/**
 * Draw a boxed block: a titled top border, the content rows and a bottom border.
 * 画一个带边框的区块：带标题的上边框、内容行与下边框。
 */
function box(title, content, width) {
  const gl = layout.glyphs();
  const inner = Math.max(4, width - 2);
  const head = `${gl.boxH.repeat(2)} ${title} `;
  const lines = [indent(`${gl.boxTL}${truncateTo(head, inner)}${gl.boxH.repeat(Math.max(0, inner - displayWidth(head)))}${gl.boxTR}`)];
  for (const line of content) {
    lines.push(indent(`${gl.boxV} ${padTo(truncateTo(line, inner - 2), inner - 2)} ${gl.boxV}`));
  }
  lines.push(indent(`${gl.boxBL}${gl.boxH.repeat(inner)}${gl.boxBR}`));
  return lines;
}

/**
 * Rows left for the body after the header, the info panel and the footer.
 * 扣掉页眉、信息面板与页脚之后留给主体的行数。
 */
function frameBudget() {
  const hints = footerHints().length;
  const budget = Math.max(6, dims.rows - HEADER_ROWS - hints);
  const info = infoPanel(budget);
  return { budget, info, bodyBudget: Math.max(3, budget - info.lines.length - 1) };
}

/**
 * Rows the log pane and the notice line take away from the body, and what is left for the screen.
 * 日志区与提示行占用的主体行数，以及留给界面的行数。
 */
function bodySplit(bodyBudget) {
  const crumbRows = renderCrumbs() ? 2 : 0;
  const noticeActive = !!noticeText && Date.now() - noticeAt < NOTICE_MS;
  const logRows = logs.length
    ? Math.min(LOG_ROWS, Math.max(0, bodyBudget - crumbRows - MIN_BODY_CONTENT_ROWS - (noticeActive ? 1 : 0) - 1))
    : 0;
  return {
    crumbRows,
    noticeActive,
    logRows,
    room: Math.max(1, bodyBudget - crumbRows - logRows - (noticeActive ? 1 : 0)),
  };
}

/**
 * Body geometry, exposed so screens can size their own lists.
 * 主体几何信息，供各界面计算自己的列表行数。
 */
function bodyGeometry() {
  measure();
  const split = bodySplit(frameBudget().bodyBudget);
  return {
    columns: dims.columns,
    rows: dims.rows,
    width: bodyWidth(),
    bodyRows: split.room,
  };
}

/**
 * Register the handler that Esc uses before falling back to "leave the screen".
 *
 * The download flow claims it while a job runs: pressing Esc there must cancel the job instead of
 * throwing the user out of the program.
 *
 *
 * 登记「Esc 在回退到离开界面之前」先调用的回调。
 *
 * 下载流程在任务运行期间占用它：那时按 Esc 必须取消任务，而不是把用户踢出程序。
 *
 * @param {(() => boolean)|null} fn
 */
function setEscapeHandler(fn) {
  escapeHandler = typeof fn === 'function' ? fn : null;
}

/**
 * Register a hook that runs before the current screen for every key; returning true consumes it.
 *
 * A running download uses it for its "s skips the current model" key without installing a second
 * raw-mode listener (which would fight the shell for the same keypresses).
 *
 *
 * 登记一个先于当前界面处理按键的钩子；返回 true 表示该按键已被消费。
 *
 * 运行中的下载用它处理「s 跳过当前模型」，从而不必再装一个原始模式监听
 * （那会与外壳抢同一批按键）。
 *
 * @param {((text:string, key:object) => boolean)|null} fn
 */
function setKeyHook(fn) {
  keyHook = typeof fn === 'function' ? fn : null;
}

module.exports = {
  isActive,
  start,
  stop,
  requestQuit,
  setEscapeHandler,
  setKeyHook,
  setBase,
  getBase,
  setCrumb,
  setStage,
  setInfo,
  prompt,
  hasPrompt,
  notice,
  logLine,
  clearLog,
  logCount,
  refresh,
  render,
  toggleTaskView,
  isTaskView,
  bodyGeometry,
  bodyWidth,
  progressBar,
  box,
  keyName,
  // Re-exported so tests can build frames without a terminal.
  // 重新导出，便于测试在没有终端时组装框架。
  infoPanel,
  taskViewLines,
};
