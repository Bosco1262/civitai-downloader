'use strict';

/**
 * TUI entry point: banner, status line, main menu and the dispatch to every flow.
 *
 * Interaction rules (same everywhere in the TUI):
 *  - Esc in a sub-menu returns to the main menu instead of leaving the program;
 *  - Ctrl+C cancels the *current* operation; a second Ctrl+C inside the main menu quits;
 *  - every menu line shows a one-line description, so the menu explains itself;
 *  - `?` (or the "Help / shortcuts" entry) opens the key reference at any time.
 *
 *
 * TUI 入口：横幅、状态行、主菜单，以及到各流程的分发。
 *
 * 交互约定（整个 TUI 一致）：
 *  - 子菜单里按 Esc 返回主菜单，而不是直接退出程序；
 *  - Ctrl+C 先取消「当前操作」，在主菜单里再按一次才退出；
 *  - 每个菜单项都带一行说明，菜单本身即可自解释；
 *  - 随时可按 `?`（或选择「帮助 / 快捷键」）打开按键速查。
 */

const fs = require('fs');
const { execSync } = require('child_process');
const { loadConfig } = require('../config');
const { setLogSink } = require('../util');
const { configureRuntime, printConfigWarnings } = require('../runtime');
const { t } = require('../i18n');
const view = require('./view');
const pages = require('./pages');
const { installRawKeys } = require('./keys');
const { loginFlow } = require('./login');
const { settingsFlow } = require('./settings');
const { manageFlow } = require('./manage');
const { downloadFlow } = require('./download');
const { modelsFlow, verifyFlow } = require('./models');
const { checkFlow } = require('./check');

/**
 * Two Ctrl+C presses inside this window quit the program.
 * 在此时间窗内连按两次 Ctrl+C 才会退出程序。
 */
const QUIT_WINDOW_MS = 3000;

/**
 * Banner: name + one-line hint. Drawn once at start-up.
 * 横幅：程序名 + 一行提示。启动时绘制一次。
 */
function banner() {
  console.log('');
  console.log(`  ${view.colors.bold(t('tui.app.bannerTitle'))}`);
  console.log(view.colors.dim(`  ${t('tui.app.bannerHint')}`));
}

/**
 * Status line: where files go, how many downloads run at once, whether a session is stored.
 *
 * The session state is the one fact users most often need before picking a menu entry, so it is
 * re-read on every render (it changes after a login). The compact single-line form
 * (`tui.app.contextLine`) is kept for terminals that are too narrow for the aligned block.
 *
 *
 * 状态行：文件下到哪、同时下载几个、是否已保存登录态。
 *
 * 登录态是选择菜单项前最常需要确认的信息，因此每次渲染都重新读取（登录后会变化）。
 * 终端过窄放不下对齐信息块时，回退到单行形式（`tui.app.contextLine`）。
 */
function statusFacts(config) {
  const logged = fs.existsSync(config.cookiesFile) ? t('tui.app.loggedIn') : t('tui.app.notLoggedIn');
  const params = { site: config.site, outDir: config.outDir, jobs: config.jobs, logged };
  return {
    compact: t('tui.app.contextLine', params),
    facts: [
      { label: t('tui.app.factSite'), value: config.site },
      { label: t('tui.app.factOutDir'), value: config.outDir },
      { label: t('tui.app.factJobs'), value: String(config.jobs) },
      { label: t('tui.app.factSession'), value: logged },
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
    console.log(view.colors.dim(`  ${status.compact}`));
  } else {
    for (const line of pages.describeFacts(status.facts)) console.log(line);
  }
  console.log('');
}

/**
 * Handle Ctrl+C while a prompt is on screen: first press cancels the current operation, a second
 * press within QUIT_WINDOW_MS exits the program.
 *
 * 菜单等待输入时处理 Ctrl+C：首次按下取消当前操作，QUIT_WINDOW_MS 内再按一次则退出程序。
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
 * Run the main menu once. Returns the chosen action key or null when cancelled.
 * 运行一次主菜单。返回所选动作键；用户取消时返回 null。
 */
async function mainMenu(config) {
  const choices = [
    { title: t('tui.app.menuDownload'), value: 'download', description: t('tui.app.menuDownloadDesc') },
    { title: t('tui.app.menuModels'), value: 'models', description: t('tui.app.menuModelsDesc') },
    { title: t('tui.app.menuCheck'), value: 'check', description: t('tui.app.menuCheckDesc') },
    { title: t('tui.app.menuVerify'), value: 'verify', description: t('tui.app.menuVerifyDesc') },
    { title: t('tui.app.menuManage'), value: 'manage', description: t('tui.app.menuManageDesc') },
    { title: t('tui.app.menuLogin'), value: 'login', description: t('tui.app.menuLoginDesc') },
    { title: t('tui.app.menuSettings'), value: 'settings', description: t('tui.app.menuSettingsDesc') },
    { title: t('tui.app.menuDoctor'), value: 'doctor', description: t('tui.app.menuDoctorDesc') },
    { title: t('tui.app.menuOpen'), value: 'open', description: t('tui.app.menuOpenDesc') },
    { title: t('tui.app.menuHelp'), value: 'help', description: t('tui.app.menuHelpDesc') },
    { title: t('tui.app.menuExit'), value: 'exit' },
  ];
  return pages.promptMenu(t('tui.app.menuTitle'), choices, { hint: false });
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
  if (!process.stdin.isTTY || process.env.CIVITAI_PLAIN) return Promise.resolve();
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
  banner();

  let config = loadConfig();
  printConfigWarnings(config, view.log);
  configureRuntime(config);

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
      // Esc / Ctrl+C in the main menu means "quit" — the program has nothing above it.
      // 主菜单里的 Esc / Ctrl+C 表示退出——它已经是最外层。
      if (action === null || action === 'exit') break;

      try {
        if (action === 'download') {
          await downloadFlow(config);
        } else if (action === 'models') {
          await modelsFlow(config);
        } else if (action === 'check') {
          await checkFlow(config);
        } else if (action === 'verify') {
          await verifyFlow(config);
        } else if (action === 'login') {
          await loginFlow(config);
        } else if (action === 'manage') {
          await manageFlow(config);
        } else if (action === 'settings') {
          if (await settingsFlow(config)) {
            config = loadConfig();
            printConfigWarnings(config, view.log);
            configureRuntime(config);
          }
        } else if (action === 'doctor') {
          await require('../commands/doctor').main(config, { positionals: [], flags: {} });
        } else if (action === 'open') {
          if (view.openDir(config.outDir)) view.log(t('tui.app.opened', { dir: config.outDir }));
          else view.log(t('tui.app.openFailed'));
        } else if (action === 'help') {
          await pages.showHelp({
            onQuit: () => {
              console.log(t('tui.app.byeAbort'));
              process.exit(130);
            },
          });
        }
      } catch (e) {
        const { describeError } = require('../runtime');
        view.log(view.colors.red(t('tui.app.operationFailed', { error: describeError(e) })));
        if (process.env.DEBUG) console.error(e);
      }
    }
  } finally {
    process.removeListener('SIGINT', onSigint);
  }

  console.log(t('tui.app.goodbye'));
}

module.exports = { main, mainMenu, statusFacts, printStatus, banner, makeInterruptGuard, waitForKey };
