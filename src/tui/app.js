'use strict';

/**
 * TUI entry point: the app shell, the fixed header, the configured-settings panel, the main menu and
 * the dispatch to every flow.
 *
 * Structure of the interface (see screen.js for the renderer):
 *
 *   - a fixed header with the project name and the global key hint;
 *   - a boxed panel showing the configured settings (site, session, directory, concurrency) and the
 *     live progress of every running task;
 *   - the body: breadcrumb, the current menu and the log pane;
 *   - a footer with the key hints of whatever has focus.
 *
 * Interaction rules (the same everywhere in the TUI):
 *  - the arrow keys move, Enter selects/confirms and always moves on to the next screen;
 *  - Esc goes back one level without saving, and quits from the main menu;
 *  - Tab switches to the task view (and back) from anywhere;
 *  - Ctrl+C quits the program from anywhere.
 *
 *
 * TUI 入口：应用外壳、固定页眉、已设置信息面板、主菜单，以及到各流程的分发。
 *
 * 界面结构（渲染器见 screen.js）：
 *
 *   - 固定页眉：项目名与全局按键提示；
 *   - 信息面板：已设置信息（站点、登录态、本地目录、并发）与每个运行中任务的实时进度；
 *   - 主体：面包屑、当前菜单与日志区；
 *   - 页脚：当前焦点所在处的按键提示。
 *
 * 交互约定（整个 TUI 一致）：
 *  - ↑/↓ 移动，回车选中/确认，并且一定进入下一个界面；
 *  - Esc 返回上一级且不保存，在主菜单里表示退出；
 *  - 任意位置按 Tab 切换任务视图（再按一次返回）；
 *  - 任意位置按 Ctrl+C 退出程序。
 */

const fs = require('fs');
const { execSync } = require('child_process');
const { loadConfig } = require('../config');
const { setLogSink } = require('../util');
const { configureRuntime, printConfigWarnings } = require('../runtime');
const { t } = require('../i18n');
const layout = require('./layout');
const view = require('./view');
const pages = require('./pages');
const screen = require('./screen');
const tasks = require('./tasks');
const { settingsFlow } = require('./settings');
const { collectionsFlow } = require('./manage');
const { downloadFlow } = require('./download');
const { modelsFlow } = require('./models');

const { colors } = layout;

/**
 * Two Ctrl+C presses inside this window quit the program in the plain (non-shell) path.
 * 在简易（无外壳）路径中，此时间窗内连按两次 Ctrl+C 才会退出程序。
 */
const QUIT_WINDOW_MS = 3000;

/**
 * Shared app state: the config is replaced after a settings save or a login.
 * 应用共享状态：保存设置或登录之后配置对象会被替换。
 */
const state = {
  config: null,
  busy: false,
  quitting: false,
  quitArmed: false,
  quitArmedIds: null,
};

/**
 * Main menu entries: the whole tool hangs off these five items.
 * 主菜单条目：整个工具挂在这五项之下。
 */
const MAIN_MENU = [
  { key: 'download', titleKey: 'tui.app.menuDownload', descKey: 'tui.app.menuDownloadDesc' },
  { key: 'models', titleKey: 'tui.app.menuModels', descKey: 'tui.app.menuModelsDesc' },
  { key: 'collections', titleKey: 'tui.app.menuCollections', descKey: 'tui.app.menuCollectionsDesc' },
  { key: 'settings', titleKey: 'tui.app.menuSettings', descKey: 'tui.app.menuSettingsDesc' },
  { key: 'exit', titleKey: 'tui.app.menuExit' },
];

/**
 * Banner: name + one-line hint. Used by the plain (non-shell) path.
 * 横幅：程序名 + 一行提示。简易（无外壳）路径使用。
 */
function banner() {
  console.log('');
  console.log(`  ${colors.bold(t('tui.app.bannerTitle'))}`);
  console.log(colors.dim(`  ${t('tui.hint.menu')}`));
}

/**
 * Status facts of the info panel: where files go, how many downloads run at once, whether a session
 * is stored. The session state is the fact users most often need before picking a menu entry, so it
 * is re-read on every paint (it changes after a login).
 *
 * 信息面板的状态信息：文件下到哪、同时下载几个、是否已保存登录态。
 * 登录态是选择菜单项前最常需要确认的信息，因此每次绘制都重新读取（登录后会变化）。
 */
function statusFacts(config) {
  const logged = fs.existsSync(config.cookiesFile) ? t('tui.app.loggedIn') : t('tui.app.notLoggedIn');
  const params = { site: config.site, outDir: config.outDir, jobs: config.jobs, logged };
  return {
    compact: t('tui.app.contextLine', params),
    facts: [
      { label: t('tui.app.factSite'), value: config.site },
      { label: t('tui.app.factSession'), value: logged, color: logged === t('tui.app.loggedIn') ? colors.green : colors.yellow },
      { label: t('tui.app.factOutDir'), value: config.outDir },
      { label: t('tui.app.factJobs'), value: String(config.jobs) },
    ],
  };
}

/**
 * Print the status block; narrow terminals get the compact single line instead.
 * 打印状态块；终端过窄时改用紧凑单行。
 */
function printStatus(config) {
  const status = statusFacts(config);
  console.log('');
  if ((process.stdout.columns || 100) < 72) {
    console.log(colors.dim(`  ${status.compact}`));
  } else {
    for (const line of pages.describeFacts(status.facts)) console.log(line);
  }
  console.log('');
}

/**
 * Handle Ctrl+C while a plain prompt is on screen: first press cancels the current operation, a
 * second press within QUIT_WINDOW_MS exits the program.
 *
 * 简易提问等待输入时处理 Ctrl+C：首次按下取消当前操作，QUIT_WINDOW_MS 内再按一次则退出程序。
 */
function makeInterruptGuard() {
  let lastPress = 0;
  return function guard() {
    const now = Date.now();
    const repeated = now - lastPress < QUIT_WINDOW_MS;
    lastPress = now;
    if (repeated) {
      console.log('');
      console.log(t('tui.app.byeAbort'));
      return { quit: true };
    }
    return { quit: false };
  };
}

/**
 * Wait for one keypress (used after a message that must not be missed).
 * Returns immediately without a TTY or when the plain mode is requested.
 *
 * 等待一次按键（用于不希望被忽略的提示）。
 * 非 TTY 或开启简易模式时立即返回。
 *
 * @param {() => boolean} [onQuit] called on Ctrl+C; return true to quit the app
 */
function waitForKey(onQuit) {
  if (!process.stdin.isTTY || process.env.CIVITAI_PLAIN || screen.isActive()) return Promise.resolve();
  const { installRawKeys } = require('./keys');
  return new Promise((resolve) => {
    let release = () => {};
    const restore = installRawKeys({
      onSignal: (intent) => {
        release();
        if (intent === 'cancel' && typeof onQuit === 'function' && onQuit()) process.exit(130);
        resolve();
      },
      onKey: () => {
        release();
        resolve();
        return false;
      },
    });
    if (!restore) {
      resolve();
      return;
    }
    release = restore;
  });
}

// ---------------------------------------------------------------------------
// Quitting
// 退出
// ---------------------------------------------------------------------------

/**
 * Leave the program: give the terminal back and print the farewell line.
 *
 * While a task is running the first Ctrl+C only asks it to stop, so the flow can release the global
 * lock and finish its output; a second press leaves immediately.
 *
 *
 * 离开程序：交还终端并打印告别语。
 *
 * 有任务在跑时，第一次 Ctrl+C 只是请求它停止，让流程有机会释放全局锁并收尾；再按一次才立即退出。
 */
function quit(code = 0) {
  if (state.quitting) return;
  const active = tasks.activeTasks().map((task) => task.id).sort();
  const sameSet =
    Array.isArray(state.quitArmedIds) &&
    state.quitArmedIds.length === active.length &&
    state.quitArmedIds.every((id, index) => id === active[index]);
  // First press on a task set asks it to cancel; a second press on the same set exits. A new task
  // that appeared in between is a new set, so it is cancelled first instead of being killed abruptly.
  //
  // 对同一组任务第一次按 Ctrl+C 请求取消；再按一次退出。中途新出现的任务属于新的一组，
  // 因此先取消它，而不是被直接杀掉。
  if (active.length && (!state.quitArmed || !sameSet)) {
    state.quitArmed = true;
    state.quitArmedIds = active;
    tasks.cancelAll();
    screen.notice(t('tui.app.quitAfterCancel'), colors.yellow);
    return;
  }
  state.quitting = true;
  screen.stop();
  console.log(t('tui.app.goodbye'));
  process.exit(code);
}

// ---------------------------------------------------------------------------
// Main menu (shell path)
// 主菜单（外壳路径）
// ---------------------------------------------------------------------------

/**
 * The persistent main-menu screen: the menu rows, their descriptions and the key handling.
 * 常驻的主菜单界面：菜单行、说明文字与按键处理。
 */
function mainScreen() {
  const cursor = { index: 0, windowStart: 0 };
  const labelWidth = MAIN_MENU.reduce((max, item) => Math.max(max, layout.displayWidth(t(item.titleKey))), 0);

  return {
    title: t('tui.app.menuTitle'),
    help: () => {
      runExclusive(() => pages.showHelp({ onQuit: () => quit() }), t('tui.app.menuHelp'));
    },
    // Esc does nothing here: the menu is the root, and a repeated Esc on the way back must not quit
    // the program by accident. Ctrl+C and the "exit" entry are the ways out.
    //
    // 这里 Esc 不做任何事：主菜单就是根，返回途中连按 Esc 不应误退出程序。
    // 退出用 Ctrl+C 或「退出」这一项。
    onEscape: () => {},
    render(ctx) {
      const lines = [];
      // On a very short terminal the five entries do not all fit: the window follows the cursor and a
      // position line says how many there are, so nothing looks missing.
      //
      // 终端特别矮时五项放不下：视窗跟随光标滚动，并用一行位置提示说明总数，不会显得缺项。
      const room = Math.max(1, ctx.rows - (state.busy ? 2 : 0));
      const win = pages.windowOf(MAIN_MENU.length, cursor.index, room, cursor.windowStart);
      cursor.windowStart = win.start;
      cursor.index = win.cursor;
      MAIN_MENU.slice(win.start, win.end).forEach((item, index) => {
        lines.push(
          pages.rowLine(t(item.titleKey), item.descKey ? t(item.descKey) : '', {
            cursor: win.start + index === cursor.index,
            labelWidth,
            width: ctx.width,
          })
        );
      });
      if (win.end - win.start < MAIN_MENU.length) {
        lines.push(colors.dim(t('tui.pages.listPosition', { index: win.cursor + 1, total: MAIN_MENU.length })));
      }
      if (state.busy) lines.push('', colors.dim(t('tui.app.busyHint')));
      return lines;
    },
    // The menu can be left with Ctrl+C only: its line says so and does not advertise Esc.
    // 主菜单只能用 Ctrl+C 退出：这一行只写它，不宣传 Esc。
    hints: () => [t('tui.hint.main')],
    onKey(text, key) {
      // While a flow is running the menu is only a backdrop: prompts own the keys.
      // 流程运行期间菜单只是背景：按键归提问所有。
      if (state.busy) return true;
      // ↑ on the first entry jumps to the last one and vice versa, like every other list here.
      // 在第一项按 ↑ 跳到末项，反之亦然：与其它列表保持一致。
      if (key.name === 'up') {
        cursor.index = cursor.index <= 0 ? MAIN_MENU.length - 1 : cursor.index - 1;
      } else if (key.name === 'down') {
        cursor.index = cursor.index >= MAIN_MENU.length - 1 ? 0 : cursor.index + 1;
      } else if (key.name === 'home') cursor.index = 0;
      else if (key.name === 'end') cursor.index = MAIN_MENU.length - 1;
      else if (/^[1-9]$/.test(text) && Number(text) <= MAIN_MENU.length) {
        cursor.index = Number(text) - 1;
        runAction(MAIN_MENU[cursor.index].key);
      } else if (key.name === 'return') runAction(MAIN_MENU[cursor.index].key);
      else return false;
      return true;
    },
  };
}

/**
 * Run one menu action exactly once, keeping the menu inert until it finishes.
 * 运行一个菜单动作且只运行一个，动作结束前菜单不响应按键。
 */
function runExclusive(fn, stageLabel) {
  if (state.busy) return;
  state.busy = true;
  if (stageLabel) screen.setStage(stageLabel);
  screen.refresh();
  Promise.resolve()
    .then(fn)
    .catch((e) => {
      const { describeError } = require('../runtime');
      // The failure is the one thing the user must see: show it as a toast (it also lands in the log,
      // reachable with L, and in the run log file).
      //
      // 失败是用户必须看到的一件事：用 toast 显示（同时进入日志页 `L` 与运行日志文件）。
      view.notice(t('tui.app.operationFailed', { error: describeError(e) }), colors.red);
      if (process.env.DEBUG) console.error(e);
    })
    .finally(() => {
      state.busy = false;
      screen.setStage('');
      // A flow may have changed the config (settings, login): reload it for the info panel.
      // 流程可能改了配置（设置、登录）：重新加载，供信息面板使用。
      try {
        state.config = loadConfig();
        configureRuntime(state.config);
      } catch (e) {
        // Keep the previous config when the new one cannot be read.
        // 新配置读不出来时保留旧配置。
      }
      screen.refresh();
    });
}

function runAction(action) {
  runExclusive(() => dispatch(action), t(menuTitleKey(action)));
}

function menuTitleKey(action) {
  const item = MAIN_MENU.find((entry) => entry.key === action);
  return item ? item.titleKey : 'tui.app.menuTitle';
}

/**
 * Dispatch one main-menu action. Every branch returns when the user leaves that flow, so the menu is
 * always restored with Esc.
 *
 * 分发一个主菜单动作。每个分支在用户离开该流程后返回，因此按 Esc 总能回到菜单。
 */
async function dispatch(action) {
  const config = state.config;
  if (action === 'exit') {
    quit();
    return;
  }
  if (action === 'download') return downloadMenu(config);
  if (action === 'models') return modelsFlow(config);
  if (action === 'collections') return collectionsFlow(config);
  if (action === 'settings') return settingsFlow(config);
  if (action === 'help') {
    return pages.showHelp({ onQuit: () => quit() });
  }
  if (action === 'doctor') {
    // The environment check is a CLI module: its printing has to be routed into the frame.
    // 环境体检是命令行模块：它的打印需要被导入框架内。
    return view.captureOutput(() => require('../commands/doctor').main(config, { positionals: [], flags: {} }));
  }
  if (action === 'open') {
    if (view.openDir(config.outDir)) view.log(t('tui.app.opened', { dir: config.outDir }));
    else view.log(t('tui.app.openFailed'));
    return;
  }
}

/**
 * Download submenu: models and collections share one entry point.
 *
 * The menu stays open after a flow returns, so Esc on the plan / receipt page comes back here (the
 * page the user entered the download from) instead of jumping all the way to the main menu. Leaving
 * the submenu with Esc is still what returns to the main menu.
 *
 *
 * 「下载」子菜单：模型与收藏集共用一个入口。
 *
 * 流程返回后菜单保持打开，因此计划页/回执页按 Esc 会回到这里（用户进入下载前的页面），
 * 而不是一路跳回主菜单；在子菜单再按 Esc 才回主菜单。
 */
async function downloadMenu(config) {
  for (;;) {
    const kind = await pages.promptMenu(
      t('tui.app.downloadTitle'),
      [
        { title: t('tui.app.downloadModel'), value: 'model', description: t('tui.app.downloadModelDesc') },
        {
          title: t('tui.app.downloadCollection'),
          value: 'collection',
          description: t('tui.app.downloadCollectionDesc'),
        },
      ],
      { stage: t('tui.app.menuDownload') }
    );
    if (kind === null) return;
    if (kind === 'model') await require('./models').downloadFlow(config);
    else await downloadFlow(config);
  }
}

/**
 * Plain (non-shell) main menu: the same five entries through the `prompts` library.
 * 简易（无外壳）主菜单：同样的五项，通过 `prompts` 库实现。
 */
async function mainMenu(config) {
  return pages.promptMenu(
    t('tui.app.menuTitle'),
    MAIN_MENU.map((item) => ({
      title: t(item.titleKey),
      value: item.key,
      description: item.descKey ? t(item.descKey) : undefined,
    })),
    { hint: false }
  );
}

// ---------------------------------------------------------------------------
// Entry point
// 入口
// ---------------------------------------------------------------------------

/**
 * Plain main loop, used when the terminal cannot host the shell (no TTY, CI, CIVITAI_PLAIN).
 * 简易主循环，终端无法承载外壳时使用（非 TTY、CI、CIVITAI_PLAIN）。
 */
async function plainMain(config) {
  const guard = makeInterruptGuard();
  const onSigint = () => {
    if (guard().quit) {
      console.log(t('tui.app.byeAbort'));
      process.exit(130);
    }
    console.log('');
    console.log(t('tui.app.interruptNotice'));
  };
  process.on('SIGINT', onSigint);

  try {
    for (;;) {
      printStatus(config);
      const action = await mainMenu(config);
      // Esc in the main menu means "quit" — the program has nothing above it.
      // 主菜单里的 Esc 表示退出——它已经是最外层。
      if (action === null || action === 'exit') break;
      try {
        state.config = config;
        await dispatch(action);
        config = loadConfig();
        state.config = config;
        printConfigWarnings(config, view.log);
        configureRuntime(config);
      } catch (e) {
        const { describeError } = require('../runtime');
        view.log(colors.red(t('tui.app.operationFailed', { error: describeError(e) })));
        if (process.env.DEBUG) console.error(e);
      }
    }
  } finally {
    process.removeListener('SIGINT', onSigint);
  }
  console.log(t('tui.app.goodbye'));
}

/**
 * Main loop.
 * 主循环。
 */
async function main() {
  if (process.platform === 'win32' && process.stdout.isTTY) {
    try {
      execSync('chcp 65001', { stdio: 'ignore' });
      // Tell the layout layer the console is UTF-8 now, so the nicer glyphs can be used.
      // 告诉布局层控制台已切到 UTF-8，从而可以使用更好看的字符。
      process.env.CIVITAI_CONSOLE_CP = '65001';
    } catch (e) {
      // Ignore failures when switching the console code page.
      // 切换控制台代码页失败时忽略。
    }
  }
  setLogSink(view.log);
  state.config = loadConfig();

  // The shell always starts with a clean screen and keeps it until the program exits.
  // 外壳总是先清屏再显示，并一直保持到程序退出。
  const shellReady = screen.start({ onQuit: () => quit() });
  if (!shellReady) banner();

  printConfigWarnings(state.config, view.log);
  configureRuntime(state.config);

  if (shellReady) {
    screen.setInfo(() => statusFacts(state.config).facts);
    screen.setBase(mainScreen());
    screen.setStage('');
    await new Promise(() => {});
    return;
  }

  await plainMain(state.config);
}

module.exports = {
  main,
  mainMenu,
  statusFacts,
  printStatus,
  banner,
  makeInterruptGuard,
  waitForKey,
  MAIN_MENU,
  dispatch,
  quit,
};
