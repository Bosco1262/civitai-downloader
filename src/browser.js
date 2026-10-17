'use strict';

const fs = require('fs');
const path = require('path');
const { spawn } = require('child_process');
const puppeteer = require('puppeteer-core');
const { log, sleep, ensureDir } = require('./util');

const BROWSER_CANDIDATES = [
  'C:\\Program Files\\Google\\Chrome\\Application\\chrome.exe',
  'C:\\Program Files (x86)\\Google\\Chrome\\Application\\chrome.exe',
  path.join(process.env.LOCALAPPDATA || '', 'Google', 'Chrome', 'Application', 'chrome.exe'),
  'C:\\Program Files (x86)\\Microsoft\\Edge\\Application\\msedge.exe',
  'C:\\Program Files\\Microsoft\\Edge\\Application\\msedge.exe',
];

function findBrowserPath(config) {
  if (config.chromePath && fs.existsSync(config.chromePath)) return config.chromePath;
  for (const candidate of BROWSER_CANDIDATES) {
    if (candidate && fs.existsSync(candidate)) return candidate;
  }
  throw new Error('未找到 Chrome/Edge，请在 config.json 中设置 chromePath');
}

async function fetchDebugInfo(port) {
  try {
    const res = await fetch(`http://127.0.0.1:${port}/json/version`, {
      signal: AbortSignal.timeout(3000),
    });
    if (!res.ok) return null;
    return await res.json();
  } catch (e) {
    return null;
  }
}

async function connectBrowser(port) {
  const info = await fetchDebugInfo(port);
  if (!info || !info.webSocketDebuggerUrl) return null;
  return puppeteer.connect({
    browserWSEndpoint: info.webSocketDebuggerUrl,
    defaultViewport: null,
  });
}

async function launchBrowser(config) {
  const exe = findBrowserPath(config);
  ensureDir(config.profileDir);
  log(`启动浏览器: ${exe}`);
  log(`  profile: ${config.profileDir}`);
  log(`  调试端口: ${config.debugPort}`);
  const args = [
    `--remote-debugging-port=${config.debugPort}`,
    `--user-data-dir=${config.profileDir}`,
    '--no-first-run',
    '--no-default-browser-check',
    '--disable-session-crashed-bubble',
    '--hide-crash-restore-bubble',
    'about:blank',
  ];
  const child = spawn(exe, args, { detached: true, stdio: 'ignore' });
  child.unref();
  const deadline = Date.now() + 30000;
  while (Date.now() < deadline) {
    await sleep(800);
    const info = await fetchDebugInfo(config.debugPort);
    if (info && info.webSocketDebuggerUrl) {
      return puppeteer.connect({
        browserWSEndpoint: info.webSocketDebuggerUrl,
        defaultViewport: null,
      });
    }
  }
  throw new Error(
    `浏览器启动超时（30 秒）。若浏览器已用同一 profile 打开但调试端口无响应，请先完全关闭它再重试，或修改 config.json 中的 debugPort`
  );
}

async function ensureBrowser(config) {
  let browser = await connectBrowser(config.debugPort);
  if (browser) {
    log(`已连接到运行中的浏览器（端口 ${config.debugPort}）`);
    return browser;
  }
  log(`端口 ${config.debugPort} 无响应，尝试启动新浏览器…`);
  browser = await launchBrowser(config);
  log('浏览器已启动');
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

module.exports = {
  findBrowserPath,
  fetchDebugInfo,
  connectBrowser,
  launchBrowser,
  ensureBrowser,
  findSitePage,
  openUrl,
  siteHost,
};
