'use strict';

const prompts = require('prompts');
const { performLogin, checkLogin } = require('../loginFlow');
const { t } = require('../i18n');
const view = require('./view');

async function loginFlow(config) {
  const ans = await prompts({
    type: 'select',
    name: 'mode',
    message: t('tui.login.title', { site: config.site }),
    choices: [
      { title: t('tui.login.modeLogin'), value: 'login', description: t('tui.login.modeLoginDesc') },
      { title: t('tui.login.modeCheck'), value: 'check', description: t('tui.login.modeCheckDesc') },
    ],
  });
  if (!ans || ans.mode === undefined) return;

  if (ans.mode === 'check') {
    await checkLogin(config, { log: view.log });
    return;
  }

  const go = await prompts({
    type: 'confirm',
    name: 'go',
    message: t('tui.login.startConfirm', { site: config.site }),
    initial: true,
  });
  if (!go || !go.go) return;

  await performLogin(config, {
    log: view.log,
    waitConfirm: async () => {
      const done = await prompts({
        type: 'confirm',
        name: 'ok',
        message: t('tui.login.waitConfirm'),
        initial: true,
      });
      return !!(done && done.ok);
    },
  });
  view.log(t('tui.login.done'));
}

module.exports = { loginFlow };
