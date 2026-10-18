'use strict';

const fs = require('fs');
const { execSync } = require('child_process');
const prompts = require('prompts');
const { loadConfig } = require('../config');
const { setLogSink } = require('../util');
const { configureRuntime, printConfigWarnings } = require('../runtime');
const { t } = require('../i18n');
const view = require('./view');
const { loginFlow } = require('./login');
const { settingsFlow } = require('./settings');
const { manageFlow } = require('./manage');
const { downloadFlow } = require('./download');
const { modelsFlow, verifyFlow } = require('./models');
const { checkFlow } = require('./check');

function banner() {
  console.log('');
  console.log(view.colors.bold(`  ${t('tui.app.bannerTitle')}`));
  console.log(view.colors.dim(`  ${t('tui.app.bannerHint')}`));
  console.log('');
}

function contextLine(config) {
  const logged = fs.existsSync(config.cookiesFile) ? t('tui.app.loggedIn') : t('tui.app.notLoggedIn');
  console.log(
    view.colors.dim(
      `  ${t('tui.app.contextLine', {
        site: config.site,
        outDir: config.outDir,
        jobs: config.jobs,
        logged,
      })}`
    )
  );
  console.log('');
}

async function main() {
  if (process.platform === 'win32' && process.stdout.isTTY) {
    try {
      execSync('chcp 65001', { stdio: 'ignore' });
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

  for (;;) {
    contextLine(config);
    const ans = await prompts({
      type: 'select',
      name: 'action',
      message: t('tui.app.menuTitle'),
      choices: [
        { title: t('tui.app.menuDownload'), value: 'download', description: t('tui.app.menuDownloadDesc') },
        { title: t('tui.app.menuModels'), value: 'models', description: t('tui.app.menuModelsDesc') },
        { title: t('tui.app.menuCheck'), value: 'check', description: t('tui.app.menuCheckDesc') },
        { title: t('tui.app.menuVerify'), value: 'verify', description: t('tui.app.menuVerifyDesc') },
        { title: t('tui.app.menuLogin'), value: 'login', description: t('tui.app.menuLoginDesc') },
        { title: t('tui.app.menuManage'), value: 'manage', description: t('tui.app.menuManageDesc') },
        { title: t('tui.app.menuSettings'), value: 'settings', description: t('tui.app.menuSettingsDesc') },
        { title: t('tui.app.menuDoctor'), value: 'doctor', description: t('tui.app.menuDoctorDesc') },
        { title: t('tui.app.menuOpen'), value: 'open', description: t('tui.app.menuOpenDesc') },
        { title: t('tui.app.menuExit'), value: 'exit' },
      ],
    });
    const action = ans && ans.action;

    if (action === undefined || action === 'exit') break;

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
      }
    } catch (e) {
      const { describeError } = require('../runtime');
      view.log(view.colors.red(t('tui.app.operationFailed', { error: describeError(e) })));
      if (process.env.DEBUG) console.error(e);
    }
    console.log('');
  }

  console.log(t('tui.app.goodbye'));
}

module.exports = { main };
