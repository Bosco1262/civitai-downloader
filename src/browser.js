'use strict';

const fs = require('fs');
const os = require('os');
const path = require('path');
const { spawn, spawnSync } = require('child_process');
const puppeteer = require('puppeteer-core');
const { log, sleep, ensureDir } = require('./util');
const { ConfigError } = require('./errors');
const { t } = require('./i18n');

const HOME = os.homedir();

/**
 * Common browser install locations per platform.
 * 各平台常见浏览器安装位置。
 */
function browserCandidates() {
  const list = [];
  if (process.platform === 'win32') {
    const local = process.env.LOCALAPPDATA || path.join(HOME, 'AppData', 'Local');
    list.push(
      'C:\\Program Files\\Google\\Chrome\\Application\\chrome.exe',
      'C:\\Program Files (x86)\\Google\\Chrome\\Application\\chrome.exe',
      path.join(local, 'Google', 'Chrome', 'Application', 'chrome.exe'),
      'C:\\Program Files (x86)\\Microsoft\\Edge\\Application\\msedge.exe',
      'C:\\Program Files\\Microsoft\\Edge\\Application\\msedge.exe'
    );
  } else if (process.platform === 'darwin') {
    list.push(
      '/Applications/Google Chrome.app/Contents/MacOS/Google Chrome',
      '/Applications/Chromium.app/Contents/MacOS/Chromium',
      '/Applications/Microsoft Edge.app/Contents/MacOS/Microsoft Edge',
      path.join(HOME, 'Applications/Google Chrome.app/Contents/MacOS/Google Chrome')
    );
  } else {
    list.push(
      '/usr/bin/google-chrome',
      '/usr/bin/google-chrome-stable',
      '/usr/bin/chromium',
      '/usr/bin/chromium-browser',
      '/snap/bin/chromium',
      '/usr/bin/microsoft-edge',
      '/usr/bin/microsoft-edge-stable'
    );
  }
  return list;
}

/**
 * Look up an executable on PATH.
 * 在 PATH 中查找可执行文件。
 */
function lookupOnPath(names) {
  const finder = process.platform === 'win32' ? 'where' : 'which';
  for (const name of names) {
    try {
      const r = spawnSync(finder, [name], { encoding: 'utf8', windowsHide: true });
      if (!r.error && r.status === 0) {
        const first = String(r.stdout || '')
          .split(/\r?\n/)
          .map((s) => s.trim())
          .filter(Boolean)[0];
        if (first && fs.existsSync(first)) return first;
      }
    } catch (e) {
      // Try the next one.
      // 继续尝试下一个。
    }
  }
  return null;
}

/**
 * Find the browser executable.
 * 找到浏览器可执行文件。
 * @param {object} config
 * @returns {string}
 */
function findBrowserPath(config) {
  if (config.chromePath) {
    if (fs.existsSync(config.chromePath)) return config.chromePath;
    throw new ConfigError(t('browser.chromePathMissing', { path: config.chromePath }));
  }
  for (const candidate of browserCandidates()) {
    if (candidate && fs.existsSync(candidate)) return candidate;
  }
  const fromPath = lookupOnPath([
    'chrome',
    'google-chrome',
    'google-chrome-stable',
    'chromium',
    'chromium-browser',
    'msedge',
    'microsoft-edge',
  ]);
  if (fromPath) return fromPath;
  throw new ConfigError(t('browser.notFound', { platform: process.platform }));
}

/**
 * Probe the debug port.
 * 探测调试端口。
 * @returns {Promise<{info:object|null, reason:string, status?:number}>}
 */
async function probeDebugPort(port) {
  try {
    const res = await fetch(`http://127.0.0.1:${port}/json/version`, {
      signal: AbortSignal.timeout(3000),
    });
    if (!res.ok) return { info: null, reason: `HTTP ${res.status}`, status: res.status };
    const text = await res.text();
    let info = null;
    try {
      info = JSON.parse(text);
    } catch (e) {
      return { info: null, reason: t('browser.portNotDebug') };
    }
    if (!info || !info.webSocketDebuggerUrl) {
      return { info: null, reason: t('browser.portNoWsUrl') };
    }
    return { info, reason: 'ok' };
  } catch (e) {
    return {
      info: null,
      reason: e && e.name === 'TimeoutError' ? t('browser.connectTimeout') : t('browser.portNoResponse'),
    };
  }
}

async function fetchDebugInfo(port) {
  const { info } = await probeDebugPort(port);
  return info;
}

async function connectBrowser(port) {
  const info = await fetchDebugInfo(port);
  if (!info || !info.webSocketDebuggerUrl) return null;
  return puppeteer.connect({
    browserWSEndpoint: info.webSocketDebuggerUrl,
    defaultViewport: null,
  });
}

/**
 * Decide whether this launch should be headless.
 * Priority: explicit `opts.headless` → `opts.mode` / `config.headless` → auto (headless once a login exists).
 *
 * 决定这次启动是否使用无头模式。
 * 优先级：显式 `opts.headless` → `opts.mode` / `config.headless` → auto（已有登录态就无头）。
 *
 * @param {object} config
 * @param {{headless?: boolean, mode?: string}} [opts]
 */
function wantsHeadless(config, opts = {}) {
  if (opts.headless === false) return false;
  if (opts.headless === true) return true;
  const mode = String(opts.mode || config.headless || 'auto').toLowerCase();
  if (mode === 'always') return true;
  if (mode === 'never') return false;
  // auto: an exported cookie file means the user has logged in, so the window is not needed anymore.
  // auto：已导出 Cookie 说明登录过，之后不需要窗口。
  return !!config.cookiesFile && fs.existsSync(config.cookiesFile);
}

function browserArgs(config, opts = {}) {
  const args = [
    `--remote-debugging-port=${config.debugPort}`,
    `--user-data-dir=${config.profileDir}`,
    '--no-first-run',
    '--no-default-browser-check',
    '--disable-session-crashed-bubble',
    '--hide-crash-restore-bubble',
    '--disable-background-networking',
  ];
  if (opts.headless) args.push('--headless=new', '--disable-gpu', '--no-startup-window');
  if (config.proxy) args.push(`--proxy-server=${config.proxy}`);
  args.push('about:blank');
  return args;
}

async function launchBrowser(config, opts = {}) {
  const exe = findBrowserPath(config);
  ensureDir(config.profileDir);
  const headless = !!opts.headless;
  log(headless ? t('browser.launchingHeadless', { exe }) : t('browser.launching', { exe }));
  // Pure format line: only the key name plus a path, so it stays inline instead of a catalog entry.
  // 纯格式行：只有键名和路径，直接内联而不登记文案键。
  log(`  profile: ${config.profileDir}`);
  log(t('browser.debugPortLine', { port: config.debugPort }));
  if (config.proxy) log(t('browser.proxyLine', { proxy: config.proxy }));

  const child = spawn(exe, browserArgs(config, { headless }), { detached: true, stdio: 'ignore' });
  child.unref();

  const deadline = Date.now() + 30000;
  let lastReason = '';
  while (Date.now() < deadline) {
    await sleep(800);
    const { info, reason } = await probeDebugPort(config.debugPort);
    if (info && info.webSocketDebuggerUrl) {
      return puppeteer.connect({
        browserWSEndpoint: info.webSocketDebuggerUrl,
        defaultViewport: null,
      });
    }
    lastReason = reason;
  }
  throw new ConfigError(
    t('browser.launchTimeout', {
      port: config.debugPort,
      reason: lastReason || t('browser.noResponse'),
      profileDir: config.profileDir,
    })
  );
}

/**
 * Ensure a usable browser connection: connect to one that already exposes the debug port,
 * otherwise launch a fresh one (headless when a login already exists).
 *
 * 确保有可用的浏览器连接：优先连接已开启调试端口的浏览器，否则启动一个（已有登录态时用无头模式）。
 *
 * @param {object} config
 * @param {{headless?: boolean, mode?: string}} [opts]
 */
async function ensureBrowser(config, opts = {}) {
  const { info, reason, status } = await probeDebugPort(config.debugPort);
  if (info && info.webSocketDebuggerUrl) {
    log(t('browser.connected', { port: config.debugPort }));
    return puppeteer.connect({ browserWSEndpoint: info.webSocketDebuggerUrl, defaultViewport: null });
  }
  if (status && !info) {
    log(t('browser.portOccupied', { port: config.debugPort, reason }));
  } else {
    log(t('browser.portNotReady', { port: config.debugPort, reason }));
  }
  const headless = wantsHeadless(config, opts);
  const browser = await launchBrowser(config, { headless });
  log(headless ? t('browser.startedHeadless') : t('browser.started'));
  return browser;
}

function siteHost(site) {
  try {
    return new URL(site).host;
  } catch (e) {
    return '';
  }
}

async function findSitePage(browser, site) {
  const host = siteHost(site);
  const pages = await browser.pages();
  return (
    pages.find((page) => {
      try {
        return new URL(page.url()).host === host;
      } catch (e) {
        return false;
      }
    }) || null
  );
}

async function openUrl(browser, url) {
  const page = await browser.newPage();
  await page.goto(url, { waitUntil: 'domcontentloaded', timeout: 90000 });
  return page;
}

/**
 * Ensure a page exists under the site's origin (used to call site APIs with the login state).
 * Same origin is enough; we no longer force a jump to the specific collection page, which
 * saves one full page load and a fixed wait.
 *
 * 确保存在一个处于站点域下的页面（用于携带登录态调用站点接口）。
 * 只要同源即可，不再强制跳转到具体收藏集页面，省掉一次完整页面加载与固定等待。
 */
async function ensureSitePage(browser, site, { timeoutMs = 90000 } = {}) {
  const existing = await findSitePage(browser, site);
  if (existing) return existing;
  const page = await browser.newPage();
  await page.goto(site, { waitUntil: 'domcontentloaded', timeout: timeoutMs }).catch(() => {});
  try {
    await page.waitForFunction(() => typeof window.fetch === 'function', { timeout: 15000 });
  } catch (e) {
    await sleep(1000);
  }
  return page;
}

module.exports = {
  browserCandidates,
  findBrowserPath,
  lookupOnPath,
  probeDebugPort,
  fetchDebugInfo,
  connectBrowser,
  browserArgs,
  wantsHeadless,
  launchBrowser,
  ensureBrowser,
  ensureSitePage,
  findSitePage,
  openUrl,
  siteHost,
};
