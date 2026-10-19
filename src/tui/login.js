'use strict';

/**
 * TUI flow for the login: open a browser and store the session, or just validate the stored one.
 * 登录流程的 TUI 界面：打开浏览器登录并保存会话，或只校验已保存的会话。
 */

const { performLogin, checkLogin } = require('../loginFlow');
const { t } = require('../i18n');
const view = require('./view');
const pages = require('./pages');
const downloadTask = require('./downloadTask');
const { color } = require('./tokens');

async function loginFlow(config) {
  const mode = await pages.promptMenu(t('tui.login.title', { site: config.site }), [
    { title: t('tui.login.modeLogin'), value: 'login', description: t('tui.login.modeLoginDesc') },
    { title: t('tui.login.modeCheck'), value: 'check', description: t('tui.login.modeCheckDesc') },
    { title: t('tui.manage.back'), value: 'back' },
  ]);
  if (mode === null || mode === 'back') return;

  if (mode === 'check') {
    await checkLogin(config, { log: view.log });
    return;
  }

  const go = await pages.promptConfirm(t('tui.login.startConfirm', { site: config.site }));
  if (!go) return;

  // Opening the visible window may replace a background headless browser; ask before disturbing a
  // running download (its metadata requests use that browser).
  //
  // 打开可见窗口可能会替换后台的无头浏览器；正在下载时先确认，避免打断它的元数据请求。
  if (downloadTask.hasActiveDownload()) {
    const proceed = await pages.promptConfirm(t('tui.login.activeDownloadConfirm'), { initial: false });
    if (!proceed) return;
  }

  await performLogin(config, {
    log: view.log,
    waitConfirm: async () => {
      const done = await pages.promptConfirm(t('tui.login.waitConfirm'), { initial: true });
      return !!done;
    },
  });
  view.notice(t('tui.login.done'), color.success);
}

module.exports = { loginFlow };
