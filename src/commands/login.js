'use strict';

const { performLogin, checkLogin } = require('../loginFlow');
const { t } = require('../i18n');

function usage() {
  console.error(t('login.usage'));
  process.exitCode = 1;
}

async function main(config, args) {
  if (args.flags.check) {
    const probe = await checkLogin(config);
    if (!probe.ok) process.exitCode = 1;
    return;
  }
  const ok = await performLogin(config);
  if (!ok) process.exitCode = 1;
}

module.exports = { main, usage };
