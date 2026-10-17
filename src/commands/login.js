'use strict';

const readline = require('readline');
const { log } = require('../util');
const { ensureBrowser, findSitePage, openUrl } = require('../browser');
const { exportCookies, hasAuthCookie } = require('../cookies');

function waitEnter() {
  return new Promise((resolve) => {
    const rl = readline.createInterface({ input: process.stdin, output: process.stdout });
    rl.question('> ', () => {
      rl.close();
      resolve();
    });
  });
}

async function main(config) {
  const browser = await ensureBrowser(config);
  let page = await findSitePage(browser, config.site);
  if (!page) {
    log(`打开登录页: ${config.site}/login`);
    page = await openUrl(browser, `${config.site}/login`);
  } else {
    try {
      await page.goto(`${config.site}/login`, { waitUntil: 'domcontentloaded', timeout: 90000 });
    } catch (e) {
      log(`跳转登录页失败（可手动在浏览器中导航）: ${e.message}`);
    }
  }

  console.log('');
  console.log('==================================================');
  console.log('  请在弹出的浏览器窗口中完成登录（已登录可忽略）');
  console.log('  如出现人机验证，请在浏览器中手动完成');
  console.log('  登录完成后回到本终端，按 Enter 继续…');
  console.log('==================================================');

  await waitEnter();

  const cookies = await exportCookies(page, config.cookiesFile);
  if (hasAuthCookie(cookies)) {
    log(`登录态已保存（${cookies.length} 条 Cookie）: ${config.cookiesFile}`);
    log('下一步: npm run list -- <收藏集ID>');
  } else {
    log(`未检测到登录凭证 Cookie（${cookies.length} 条 Cookie 已导出）。`);
    log('请确认浏览器中已登录成功，然后重新运行: npm run login');
    process.exitCode = 1;
  }
  await browser.disconnect().catch(() => {});
}

module.exports = { main };
