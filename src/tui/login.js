'use strict';

/**
 * TUI flow for the login: open a browser and store the session, or just validate the stored one.
 * 登录流程的 TUI 界面：打开浏览器登录并保存会话，或只校验已保存的会话。
 */

const { performLogin, checkLogin } = require('../loginFlow');
const { t } = require('../i18n');
const view = require('./view');
const pages = require('./pages');

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

  await performLogin(config, {
    log: view.log,
    waitConfirm: async () => {
      const done = await pages.promptConfirm(t('tui.login.waitConfirm'), { initial: true });
      return !!done;
    },
  });
  view.notice(t('tui.login.done'), view.colors.green);
}

module.exports = { loginFlow };
