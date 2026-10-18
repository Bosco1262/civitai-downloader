'use strict';

const readline = require('readline');
const { log } = require('./util');
const { ensureBrowser, findSitePage, openUrl } = require('./browser');
const { exportCookies, hasAuthCookie } = require('./cookies');
const { probeLogin } = require('./collection');
const { t } = require('./i18n');

function waitEnter() {
  return new Promise((resolve) => {
    const rl = readline.createInterface({ input: process.stdin, output: process.stdout });
    rl.question('> ', () => {
      rl.close();
      resolve(true);
    });
  });
}

/**
 * Login flow: open the login page → log in manually → export cookies → verify the login state.
 * 登录流程：打开登录页 → 人工登录 → 导出 Cookie → 校验登录态。
 * @param {object} config
 * @param {{waitConfirm?:Function, log?:Function}} [hooks]
 * @returns {Promise<boolean>}
 */
async function performLogin(config, hooks = {}) {
  const waitConfirm = hooks.waitConfirm || waitEnter;
  const logFn = hooks.log || log;
  // The login flow always needs a visible window so the user can sign in and solve CAPTCHAs.
  // 登录流程必须使用可见窗口，用户才能手动登录并完成人机验证。
  const browser = await ensureBrowser(config, { headless: false });
  try {
    let page = await findSitePage(browser, config.site);
    if (!page) {
      logFn(t('loginFlow.openingPage', { url: `${config.site}/login` }));
      page = await openUrl(browser, `${config.site}/login`);
    } else {
      try {
        await page.goto(`${config.site}/login`, { waitUntil: 'domcontentloaded', timeout: 90000 });
      } catch (e) {
        logFn(t('loginFlow.gotoFailed', { message: e.message }));
      }
    }

    logFn(t('loginFlow.pleaseLogin'));
    logFn(t('loginFlow.captcha'));
    logFn(t('loginFlow.confirmHint'));

    const confirmed = await waitConfirm();
    if (!confirmed) {
      logFn(t('loginFlow.cancelled'));
      return false;
    }

    const cookies = await exportCookies(page, config.cookiesFile, { site: config.site });
    if (!hasAuthCookie(cookies)) {
      logFn(t('loginFlow.noAuthCookie', { count: cookies.length }));
      logFn(t('loginFlow.checkBrowser'));
      return false;
    }
    logFn(t('loginFlow.saved', { count: cookies.length, file: config.cookiesFile }));

    // Double-check: actually send a minimal request, so that "looks logged in but the session is
    // really invalid" cannot slip through.
    //
    // 二次确认：实际发一个最小请求，避免「看起来登录了但会话其实无效」
    const probe = await probeLogin(browser, config.site, {
      page,
      trpcPath: config.trpcPath,
      trpcInput: config.trpcInput,
    });
    if (!probe.ok) {
      logFn(t('loginFlow.probeFailed', { reason: probe.reason }));
      logFn(t('loginFlow.probeRetry'));
      return false;
    }

    logFn(t('loginFlow.probeOk'));
    logFn(t('loginFlow.nextStep'));
    return true;
  } finally {
    await browser.disconnect().catch(() => {});
  }
}

/**
 * Only verify that the saved login state is still valid (without opening the login page).
 * 仅校验已保存的登录态是否仍然有效（不打开登录页）。
 * @param {object} config
 * @param {{log?:Function}} [hooks]
 * @returns {Promise<{ok:boolean, reason:string}>}
 */
async function checkLogin(config, hooks = {}) {
  const logFn = hooks.log || log;
  const browser = await ensureBrowser(config);
  try {
    const probe = await probeLogin(browser, config.site, {
      trpcPath: config.trpcPath,
      trpcInput: config.trpcInput,
    });
    if (probe.ok) logFn(t('loginFlow.checkOk'));
    else logFn(t('loginFlow.checkFailed', { reason: probe.reason }));
    return probe;
  } finally {
    await browser.disconnect().catch(() => {});
  }
}

module.exports = { performLogin, checkLogin, waitEnter };
