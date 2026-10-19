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
//   - up/down move, Home/End and PgUp/PgDn jump, Enter confirms;
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
//   - ↑/↓ 移动，Home/End 与 PgUp/PgDn 跳转，回车确认；
//   - Esc 取消当前提问或直接离开当前界面且不保存；
//   - Tab 切到任务视图，再按一次返回；
//   - Ctrl+C 是唯一可以从任何位置退出程序的方式。

const layout = require('./layout');
const tasks = require('./tasks');
const { installRawKeys, isTextInput, isBackspace } = require('./keys');
const { formatBytes, formatDuration } = require('../util');
const { t } = require('../i18n');

const { colors, displayWidth, truncateTo, padTo } = layout;
const taskViewUi = require('./ui/taskView');
const {
  progressBar,
  taskOverviewLine,
  taskHead,
  taskLine,
  taskDetailLines,
  taskCurrentLine,
  taskFailureLine,
  statusText,
} = taskViewUi;


/**
 * Height of the fixed header: the project name plus one blank line. The key hints all live in the
 * footer now, so the header stays a title.
 *
 * 固定页眉的高度：项目名加一行空行。按键说明统一放在页脚，页眉只做标题。
 */
const HEADER_ROWS = 2;
/**
 * Rows the info panel needs besides its content lines: two borders plus the blank separator.
 * 信息面板除内容行之外需要的行数：上下边框加一行分隔空行。
 */
const INFO_CHROME_ROWS = 3;
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
let logView = false;
let logScroll = 0;
let noticeText = '';
let noticeColor = null;
let noticeAt = 0;
let taskView = false;
let taskCursor = 0;
let taskListStart = 0;
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

let logReturnTaskView = false;

/**
 * Open the session log as a global overlay. If it was opened from the task view, closing it returns
 * there instead of the page underneath.
 *
 * 把会话日志作为全局覆盖层打开。若从任务视图进入，关闭时回到任务视图，而不是下层页面。
 */
function openLogView() {
  if (logView) return;
  logReturnTaskView = taskView;
  taskView = false;
  logView = true;
  logScroll = 0;
  refresh();
}

/**
 * Close the session log overlay and restore the view it covered.
 * 关闭会话日志覆盖层并恢复它盖住的视图。
 */
function closeLogView() {
  if (!logView) return;
  logView = false;
  if (logReturnTaskView) taskView = true;
  logReturnTaskView = false;
  refresh();
}

/**
 * Open help for the current page: the page's own help when it has one, otherwise the shared key map.
 * 打开当前页面的帮助：页面有自定义帮助就用它，否则使用共享按键速查。
 */
function openHelp() {
  const top = modalStack[modalStack.length - 1];
  if (top && typeof top.spec.help === 'function') {
    top.spec.help();
    refresh();
    return;
  }
  if (!top && baseScreen && typeof baseScreen.help === 'function') {
    baseScreen.help();
    refresh();
    return;
  }
  require('./pages').showHelp({});
  refresh();
}

function onKey(text, key) {
  const k = key || {};
  const name = keyName(k);
  const typed = String(text === undefined || text === null ? '' : text);
  const ctrl = !!k.ctrl;

  // Global overlays. They work from every page, including an open prompt.
  // 全局覆盖层。任何页面（包括打开的提问）都可以使用。
  if (ctrl && name === 'm') {
    toggleTaskView();
    return;
  }
  if (ctrl && name === 'l') {
    if (!logView) openLogView();
    return;
  }

  if (logView) {
    // The log overlay is closed only by Esc; Ctrl+L is deliberately ignored while it is open.
    // 日志覆盖层只用 Esc 关闭；打开期间故意忽略 Ctrl+L。
    if (name === 'escape') {
      closeLogView();
      return;
    }
    if (name === 'up') logScroll += 1;
    else if (name === 'down') logScroll = Math.max(0, logScroll - 1);
    else if (name === 'pageup') logScroll += 10;
    else if (name === 'pagedown') logScroll = Math.max(0, logScroll - 10);
    else if (name === 'home') logScroll = logs.length;
    else if (name === 'end') logScroll = 0;
    else if (typed === '?' && !ctrl) openHelp();
    refresh();
    return;
  }

  if (taskView) {
    if (name === 'escape') {
      toggleTaskView(false);
      return;
    }
    if (name === 'up') return moveTaskCursor(-1);
    if (name === 'down') return moveTaskCursor(1);
    if (name === 'home') {
      taskCursor = 0;
      refresh();
      return;
    }
    if (name === 'end') {
      taskCursor = Math.max(0, tasks.listTasks().length - 1);
      refresh();
      return;
    }
    if (typed === 'c') return cancelSelectedTask();
    if (typed === 's') return skipSelectedTask();
    if (typed === 'r') return retrySelectedTask();
    if (typed === 'd') return openSelectedTaskDir();
    if (typed === 'x') {
      tasks.clearFinished();
      taskCursor = 0;
      taskListStart = 0;
      notice(t('tui.screen.tasksCleared'), colors.dim);
      return;
    }
    if (typed === '?' && !ctrl) openHelp();
    return;
  }

  const top = modalStack[modalStack.length - 1];
  if (top) {
    // Pages that accept text own every character, including "?". Pages that already draw their own
    // help overlay declare handlesHelp and keep the key themselves.
    //
    // 文本输入页拥有每个字符（包括 ?）；自己绘制帮助浮层的页面声明 handlesHelp，自行处理该键。
    if (typed === '?' && !ctrl && !top.spec.acceptsText && !top.spec.handlesHelp) {
      openHelp();
      return;
    }
    try {
      top.onKey(typed, { ...k, name });
    } catch (e) {
      top.settle(null);
      logLine(colors.red(t('tui.screen.promptFailed', { error: (e && e.message) || e })));
    }
    refresh();
    return;
  }

  if (typed === '?' && !ctrl && !baseScreenAcceptsText()) {
    openHelp();
    return;
  }

  if (name === 'escape') {
    // A running task claims Esc first: "Esc cancels" is what users expect while a download is
    // going on.
    //
    // 正在运行的任务优先占用 Esc：下载进行中时「Esc 取消」才符合预期。
    if (typeof escapeHandler === 'function' && escapeHandler() !== false) {
      refresh();
      return;
    }
    // Esc leaves the current screen without saving. A screen with nothing above it (the main menu)
    // gets the key first and may simply swallow it, so a repeated Esc cannot quit the program by
    // accident; quitting is Ctrl+C's job.
    //
    // Esc 直接离开当前界面且不保存。上面没有别的界面时（主菜单），界面可以先拿到这个键并直接忽略，
    // 这样连按 Esc 不会误退出程序；退出交给 Ctrl+C。
    if (baseScreen && typeof baseScreen.onEscape === 'function') {
      baseScreen.onEscape();
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
        // A prompt may want to react to Esc first (settings warns about unsaved edits before it
        // really leaves); returning true means "I handled it, stay open".
        //
        // 提问可以先对 Esc 做出反应（设置页会在真正离开前提醒未保存的改动）；
        // 返回 true 表示「我处理了，保持打开」。
        if (typeof spec.onKey !== 'function') {
          if (key.name === 'escape') entry.settle(null);
          return;
        }
        if (key.name === 'escape') {
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
  logScroll = 0;
  refresh();
}

function logCount() {
  return logs.length;
}

// ---------------------------------------------------------------------------
// System views: tasks (Tab) and the log page (L)
// 系统视图：任务（Tab）与日志页（L）
// ---------------------------------------------------------------------------

/**
 * Show or hide the task view; without an argument it toggles. The two system views are exclusive.
 * 显示或隐藏任务视图；不带参数时切换。两个系统视图互斥。
 */
function toggleTaskView(value) {
  taskView = value === undefined ? !taskView : !!value;
  if (taskView) {
    logView = false;
    logReturnTaskView = false;
  }
  if (!taskView) return refresh();
  const list = tasks.listTasks();
  const running = list.findIndex((task) => task.status === tasks.RUNNING);
  const queued = list.findIndex((task) => task.status === tasks.QUEUED);
  taskCursor = running >= 0 ? running : queued >= 0 ? queued : 0;
  taskListStart = 0;
  return refresh();
}

/**
 * Show or hide the log page; without an argument it toggles. It always opens at the newest line.
 * 显示或隐藏日志页；不带参数时切换。打开时总是停在最新的那一行。
 */
function toggleLogView(value) {
  if (value === false) return closeLogView();
  if (value === true) return openLogView();
  if (logView) return closeLogView();
  return openLogView();
}

/**
 * Whether the log page is open (tests / embedders).
 * 日志页是否打开（测试 / 嵌入方使用）。
 */
function isLogView() {
  return logView;
}

function isTaskView() {
  return taskView;
}

function moveTaskCursor(delta) {
  const list = tasks.listTasks();
  if (!list.length) return;
  // Wrap around, like every other list in the TUI.
  // 与 TUI 里其它列表一致：两端循环。
  taskCursor = (((taskCursor + delta) % list.length) + list.length) % list.length;
  refresh();
}

/**
 * The task under the cursor (the task view's actions all apply to it).
 * 光标所在的任务（任务视图的操作都作用于它）。
 */
function selectedTask() {
  return tasks.listTasks()[taskCursor] || null;
}

function cancelSelectedTask() {
  const task = selectedTask();
  if (!task) return;
  if (task.status !== tasks.RUNNING && task.status !== tasks.QUEUED) {
    notice(t('tui.screen.taskNotRunning'), colors.dim);
    return;
  }
  const wasQueued = task.status === tasks.QUEUED;
  if (tasks.cancelTask(task.id)) {
    notice(
      wasQueued
        ? t('tui.screen.taskQueueCancelled', { name: task.name || task.id })
        : t('tui.screen.taskCancelRequested', { name: task.name || task.id }),
      colors.yellow
    );
  }
}

/**
 * Ask the running download to skip the model it is working on.
 * 请求运行中的下载跳过当前模型。
 */
function skipSelectedTask() {
  const task = selectedTask();
  if (!task) return;
  if (task.status !== tasks.RUNNING) {
    notice(t('tui.screen.taskSkipNotRunning'), colors.dim);
    return;
  }
  if (tasks.skipTask(task.id)) {
    notice(t('tui.screen.taskSkipRequested', { name: task.name || task.id }), colors.yellow);
  } else {
    notice(t('tui.screen.taskNoSkip'), colors.dim);
  }
}

/**
 * Retry the failed items of the selected finished download.
 * 重试选中已结束下载的失败项。
 */
function retrySelectedTask() {
  const task = selectedTask();
  if (!task) return;
  if (task.status === tasks.RUNNING || task.status === tasks.QUEUED) {
    notice(t('tui.screen.taskRetryRunning'), colors.dim);
    return;
  }
  if (tasks.retryTask(task.id)) {
    notice(t('tui.screen.taskRetryStarted', { name: task.name || task.id }), colors.green);
    return;
  }
  notice(t('tui.screen.taskNoRetry'), colors.dim);
}

/**
 * Open the output directory recorded by the selected task.
 * 打开选中任务记录的下载目录。
 */
function openSelectedTaskDir() {
  const task = selectedTask();
  if (!task) return;
  if (!task.outDir) {
    notice(t('tui.screen.taskNoDir'), colors.dim);
    return;
  }
  if (require('./view').openDir(task.outDir)) {
    notice(t('tui.app.opened', { dir: task.outDir }), colors.dim);
  } else {
    notice(t('tui.app.openFailed'), colors.yellow);
  }
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
 * Compose the whole frame: header, info panel, body (or a system view) and footer hints.
 * 组装整个框架：页眉、信息面板、主体（或系统视图）与页脚提示。
 */
function frame() {
  measure();
  const lines = [];
  lines.push(clip(indent(colors.bold(t('tui.app.bannerTitle')))));
  lines.push('');

  const { info, bodyBudget } = frameBudget();
  lines.push(...info.lines, '');

  // The system views are pages like any other: same heading, same rule, same footer treatment.
  // 系统视图也是普通页面：同样的标题、同样的横线、同样的页脚处理。
  if (logView) lines.push(...bodyLines(bodyBudget, (ctx) => logPageLines(ctx.rows)));
  else if (taskView) lines.push(...bodyLines(bodyBudget, (ctx) => taskViewLines(ctx.rows)));
  else lines.push(...bodyLines(bodyBudget));

  // The footer is pinned to the last rows: the page's own extra keys first, the global keys last, so
  // the constant line never moves around.
  //
  // 页脚固定在最后几行：先本页额外的键，最后是全局按键，固定那一行永远待在同一位置。
  const hints = footerHints();
  for (let i = lines.length + hints.length; i < dims.rows; i++) lines.push('');
  lines.push(...hints.map((line) => clip(indent(colors.dim(line)))));

  return lines.map((line) => `${clip(line)}${layout.ANSI_ERASE_LINE_END}`);
}

/**
 * Clip one frame row to the terminal width (never wrap, never scroll).
 * 把一帧中的某一行裁剪到终端宽度（不换行、不滚动）。
 */
function clip(line) {
  return truncateTo(line, dims.columns - 1);
}

/**
 * Footer of the current context: exactly one line, listing only the keys that work here.
 *
 * There is no "global" line any more: the page (or the open prompt, or the task view) owns the whole
 * line, which is why the main menu does not advertise Esc (it does nothing there) and a text field
 * does not advertise ↑↓. On a terminal too narrow for the page's own line, a compact universal line
 * takes over instead of clipping it mid-word.
 *
 *
 * 当前上下文的页脚：只有一行，且只列这一页能用的键。
 *
 * 不再有「全局行」：这一行由页面（或打开的提问、任务视图）完全拥有，因此主菜单不会宣传 Esc
 * （它在那里不起作用），输入框也不会宣传 ↑↓。终端窄到放不下这一页自己的说明时，
 * 换成一行的紧凑写法，而不是把它从词中间截断。
 */
function footerHints() {
  const hint = contextHint();
  if (!hint) return [];
  const room = dims.columns - margin() - 1;
  return [displayWidth(hint) <= room ? hint : t('tui.hint.compact')];
}

/**
 * The hint line of whatever has focus right now.
 * 当前焦点所在处的按键说明。
 */
function contextHint() {
  if (logView) return t('tui.hint.logView');
  if (taskView) return taskViewHint();
  const top = modalStack[modalStack.length - 1];
  if (top) {
    const hints = top.hints();
    if (hints && hints.length) return String(hints[0]);
    return '';
  }
  if (baseScreen && typeof baseScreen.hints === 'function') {
    const hints = baseScreen.hints();
    if (hints && hints.length) return String(hints[0]);
  }
  return '';
}

/**
 * Footer line of the task view: the keys depend on the selected task, because "cancel" only works on
 * a queued/running task, "skip" only on a running download, and "retry/open directory" only on a
 * finished one. Listing keys that do nothing is exactly what the footer is not allowed to do.
 *
 * 任务视图的页脚：按键取决于选中任务的状态——只有排队中/运行中能取消，只有运行中的下载能跳过，
 * 只有已结束的任务能重试/打开目录。页脚不允许列出按了没反应的键。
 */
function taskViewHint() {
  const task = selectedTask();
  if (!task) return t('tui.hint.taskView');
  if (task.status === tasks.QUEUED) return t('tui.hint.taskQueued');
  if (task.status === tasks.RUNNING) {
    return typeof task.skip === 'function' ? t('tui.hint.taskRunning') : t('tui.hint.taskRunningNoSkip');
  }
  const canRetry = typeof task.retry === 'function';
  const canOpen = !!task.outDir;
  if (canRetry && canOpen) return t('tui.hint.taskFinished');
  if (canRetry) return t('tui.hint.taskFinishedNoDir');
  if (canOpen) return t('tui.hint.taskFinishedNoRetry');
  return t('tui.hint.taskFinishedOnly');
}

/**
 * Info panel ("dashboard"): the "already configured" facts and the task overview, boxed.
 *
 * The panel is a two-section dashboard: the configured settings first (site, session, directory,
 * concurrency), then **the task overview** — one fixed aggregate progress line over every task in the
 * registry. Both sections keep their heading; when the terminal is too short, the configured facts are
 * dropped from the bottom up (the site always last) before the body starves.
 *
 *
 * 信息面板（「仪表盘」）：把「已设置信息」与任务总览分两段，并用边框框起来。
 *
 * 面板是一块两段式仪表盘：先是已设置信息（站点、登录态、本地目录、并发），
 * 再是**任务总览**——固定一行，对登记表里的全部任务合计出进度。两段都保留标题；
 * 终端过矮时从下往上减已设置信息（站点永远最后让），避免主体被挤没。
 *
 * @returns {{lines:string[]}}
 */
function infoPanel(budget) {
  const facts = safeFacts();
  const allTasks = tasks.listTasks();
  const maxContent = Math.max(2, budget - INFO_CHROME_ROWS);
  const content = infoContent(facts, allTasks, maxContent);

  const width = bodyWidth();
  if (!roomy()) return { lines: content.map((line) => clip(indent(line))) };
  return { lines: box(t('tui.screen.infoTitle'), content, width) };
}

/**
 * Content rows of the dashboard, degraded to fit `maxContent`.
 *
 * The task overview is exactly one line: the aggregate completion of every task in the registry.
 * When the terminal is too short for the configured facts, they are dropped from the bottom up (the
 * site always stays); the overview line stays as long as there is room for it.
 *
 *
 * 仪表盘的内容行，按 `maxContent` 逐级降级。
 *
 * 任务总览固定只有一行：登记表里全部任务的合计完成进度。终端过矮时从下往上减已设置信息
 * （站点永远保留）；只要还有一行，任务总览就保留。
 */
function infoContent(facts, allTasks, maxContent) {
  let keptFacts = facts.slice();
  const build = () => [
    colors.dim(t('tui.screen.infoSettings')),
    ...keptFacts.map((fact) => factLine(fact, facts)),
    '',
    colors.dim(t('tui.screen.infoTasks')),
    taskOverviewLine(allTasks),
  ];

  let lines = build();
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
 * The fixed one-line task overview: one aggregate bar and percentage across **all** tasks in the
 * registry, followed by the counts per state. Bytes weigh the bar when the tasks know their sizes
 * (a running task contributes its partial progress, a queued one contributes zero), and task counts
 * are the fallback for tasks without a known size.
 *
 * 固定一行的任务总览：对登记表里的**全部任务**合计出一条进度条与百分比，后面跟各状态数量。
 * 任务知道体积时按字节合计（运行中按已下载部分、排队中按 0 计入），
 * 没有体积信息时退回按任务数量计算。
 */
/**
 * Body lines: the open prompt wins, then the task view, then the current screen.
 * 主体行：打开的提问优先，其次是任务视图，最后是当前界面。
 *
 * @param {number} budget rows available for the body
 * @param {((ctx:object) => string[])|null} [override] content renderer that replaces the screen
 */
function bodyLines(budget, override) {
  // The task view is a screen of its own, not a sub-page of the menu: its heading is just its name.
  // 任务视图是独立界面，不是主菜单的下一层：它的标题就是它自己的名字。
  const crumbLine = logView
    ? colors.bold(t('tui.screen.logTitle'))
    : taskView
      ? colors.bold(t('tui.screen.taskTitle'))
      : renderCrumbs();
  // The log pane and the notice line are reserved before the screen renders, so a screen can rely on
  // the row count it is handed instead of discovering afterwards that it lost rows to the log.
  //
  // 日志区与提示行在界面渲染之前就预留好，界面因此可以信赖拿到的行数，
  // 而不是渲染完才发现被日志挤掉了几行。
  const split = bodySplit(budget);
  const room = split.room;

  const lines = [];
  if (crumbLine) lines.push(clip(indent(crumbLine)), clip(indent(crumbRule(bodyWidth()))), '');

  const top = modalStack[modalStack.length - 1];
  let content = [];
  const ctx = { width: bodyWidth(), columns: dims.columns, rows: room };
  try {
    if (typeof override === 'function') content = override(ctx);
    else if (top) content = top.render(ctx);
    else if (baseScreen && typeof baseScreen.render === 'function') content = baseScreen.render(ctx);
  } catch (e) {
    content = [colors.red(t('tui.screen.promptFailed', { error: (e && e.message) || e }))];
  }
  if (!Array.isArray(content)) content = [String(content)];
  if (content.length > room) content = content.slice(0, room);

  lines.push(...content.map((line) => clip(indent(line))));
  // The notice is feedback from the last action, not part of the page: a marker keeps it from being
  // read as a continuation of the page's own last line.
  //
  // 提示行是「上一步操作的结果」，不属于页面本身：加个标记，避免被当成页面最后一行的续行。
  if (split.noticeActive) lines.push(clip(indent(noticeColor(` ${layout.glyphs().notice} ${noticeText}`))));
  return lines;
}

/**
 * Breadcrumb line ("main menu › settings"), the visual answer to "where am I".
 *
 * The running step is only appended while no prompt is open: an open prompt already pushed its own
 * segment, and appending the same wording again produced "main menu › settings › settings".
 *
 *
 * 面包屑行（「主菜单 › 设置」），直观回答「我在哪一层」。
 *
 * 耗时步骤只在没有提问打开时追加：打开的提问本身就会往路径上放一段，
 * 再追加一次同样的文字就会出现「主菜单 › 设置 › 设置」。
 */
function renderCrumbs() {
  const parts = crumbs.filter(Boolean);
  const stageText = modalStack.length ? '' : stage;
  const tail = stageText ? ` ${colors.dim(layout.glyphs().bullet)} ${colors.cyan(stageText)}` : '';
  if (!parts.length) return tail.trim();
  const sep = ` ${colors.dim(layout.glyphs().arrow)} `;
  return (
    parts
      .map((part, index) => (index === parts.length - 1 ? colors.bold(part) : colors.dim(part)))
      .join(sep) + tail
  );
}

/**
 * Rule drawn under the breadcrumb, turning the path into the header of the page below it.
 * 面包屑下方的横线，把路径变成下方页面的一条页头。
 */
function crumbRule(width) {
  return colors.dim(layout.glyphs().boxH.repeat(Math.max(0, Math.floor(width))));
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
 * Current stage text (used to restore it after a temporary one).
 * 当前阶段文字（用于临时覆盖之后恢复）。
 */
function getStage() {
  return stage;
}

/**
 * Log page content: the newest lines of the session log, scrollable with ↑↓ / PgUp / PgDn. The page
 * replaces the old always-on log strip: the frame stays a UI, the raw log is one key (`L`) away, and
 * it keeps living in the run log file on disk.
 *
 * 日志页内容：会话日志最新的若干行，可用 ↑↓ / PgUp / PgDn 滚动。这一页取代了以前常驻的日志条：
 * 框架保持「界面」的样子，原始日志按一下 `L` 就能看到，同时它仍然写在磁盘上的运行日志里。
 */
function logPageLines(budget) {
  const room = Math.max(1, Math.floor(budget) || 1);
  if (!logs.length) return [colors.dim(t('tui.screen.logEmpty'))];
  const height = Math.max(1, room - 1);
  // logScroll counts lines from the newest one upwards; the renderer clamps it.
  // logScroll 是从最新一行往上数的行数；越界在这里夹紧。
  const total = logs.length;
  const maxScroll = Math.max(0, total - height);
  logScroll = Math.max(0, Math.min(logScroll, maxScroll));
  const end = total - logScroll;
  const start = Math.max(0, end - height);
  const lines = logs.slice(start, end).map((line) => line);
  lines.push(
    colors.dim(t('tui.screen.logPosition', { from: start + 1, to: end, total }))
  );
  return lines;
}

/**
 * Task view content: a list with one line per task, plus an expanded detail block for the selected
 * task. It is the only place where a task's live progress and final result live: the download flow
 * only submits the task and returns, so leaving the download pages must not lose anything.
 *
 * 任务视图内容：每个任务一行，选中任务在下方展开详情。它是任务实时进度与最终结果的唯一归属：
 * 下载流程只负责提交任务并返回，因此离开下载页面不会丢失任何信息。
 */
function taskViewLines(budget) {
  const list = tasks.listTasks();
  if (!list.length) return [colors.dim(t('tui.screen.taskNone'))];

  if (taskCursor >= list.length) taskCursor = list.length - 1;
  const selected = list[taskCursor];
  const room = Math.max(1, Math.floor(budget) || 1);
  const width = bodyWidth();
  // The detail gets priority; the list keeps at least one row. On a tall terminal the detail is
  // capped so long task histories stay visible.
  //
  // 详情优先，列表至少保留一行；终端很高时详情也设上限，避免长任务历史被挤没。
  const detailLines = taskDetailLines(selected, width, 8);
  const detailRoom = Math.min(detailLines.length, Math.max(1, room - 1));
  const listRoom = Math.max(1, room - detailRoom);

  const maxStart = Math.max(0, list.length - listRoom);
  let start = Math.max(0, Math.min(taskListStart, maxStart));
  if (taskCursor < start) start = taskCursor;
  else if (taskCursor >= start + listRoom) start = taskCursor - listRoom + 1;
  start = Math.max(0, Math.min(start, maxStart));
  taskListStart = start;

  const lines = [];
  const end = Math.min(list.length, start + listRoom);
  for (let index = start; index < end; index++) {
    lines.push(taskLine(list[index], index === taskCursor));
  }
  if (end - start < list.length && lines.length + 1 < room) {
    lines.push(colors.dim(t('tui.screen.taskMore', { count: list.length - (end - start) })));
  }
  const remaining = Math.max(0, room - lines.length);
  lines.push(...detailLines.slice(0, remaining));
  return lines;
}

/**
 * One line of the task list: kind, name, status (or queue position) and elapsed time.
 * 任务列表的一行：类型、名称、状态（或排队位置）与已用时间。
 */
/**
 * First line of a task block: name, status and elapsed time (legacy helper kept for callers/tests).
 * 任务块的第一行：名称、状态与已用时间（保留给调用方/测试的旧助手）。
 */
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
 * Rows the notice line takes away from the body, and what is left for the screen.
 * 提示行占用的主体行数，以及留给界面的行数。
 */
function bodySplit(bodyBudget) {
  // Breadcrumb + its rule + one blank line (the task view and the log page have headings of their own).
  // 面包屑 + 其下的横线 + 一行空行（任务视图与日志页有自己的标题）。
  const crumbRows = taskView || logView || renderCrumbs() ? 3 : 0;
  const noticeActive = !!noticeText && Date.now() - noticeAt < NOTICE_MS;
  return {
    crumbRows,
    noticeActive,
    room: Math.max(1, bodyBudget - crumbRows - (noticeActive ? 1 : 0)),
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

/**
 * Forget the UI state without touching the terminal: open prompts, breadcrumbs, the log pane and the
 * "last painted frame" cache. Used by tests (and embedders) that reuse the shell between scenarios.
 *
 * 不碰终端地清空界面状态：未结束的提问、面包屑、日志区与「上一帧」缓存。
 * 供复用外壳的测试（或嵌入方）在不同场景之间重置。
 */
function resetState() {
  modalStack = [];
  crumbs = [];
  stage = '';
  logs = [];
  logView = false;
  logScroll = 0;
  noticeText = '';
  taskView = false;
  taskCursor = 0;
  taskListStart = 0;
  lastPaint = '';
}

module.exports = {
  isActive,
  start,
  stop,
  resetState,
  requestQuit,
  setEscapeHandler,
  setKeyHook,
  setBase,
  getBase,
  setCrumb,
  setStage,
  getStage,
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
  toggleLogView,
  isLogView,
  bodyGeometry,
  bodyWidth,
  progressBar,
  box,
  keyName,
  // Re-exported so tests can build frames without a terminal.
  // 重新导出，便于测试在没有终端时组装框架。
  infoPanel,
  taskViewLines,
  taskDetailLines,
  taskLine,
  statusText,
  logPageLines,
};
