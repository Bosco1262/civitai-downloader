'use strict';

const fs = require('fs');
const path = require('path');
const { ensureDir } = require('./util');

const AUTH_COOKIE_NAME = '__Secure-civ-token';

async function getCookies(page) {
  const session = await page.createCDPSession();
  const { cookies } = await session.send('Network.getAllCookies');
  return cookies;
}

/**
 * Decide whether a Cookie domain belongs to the target site.
 * The old code hardcoded includes('civitai'), which exported nothing when using a self-hosted
 * mirror or another domain.
 *
 * 判断 Cookie 域是否属于目标站点。
 * 之前硬编码 includes('civitai')，换成自建镜像或其它域名时会一条都导不出来。
 */
function domainMatches(cookieDomain, host) {
  const cd = String(cookieDomain || '')
    .replace(/^\./, '')
    .toLowerCase();
  const h = String(host || '').toLowerCase();
  if (!cd || !h) return false;
  return h === cd || h.endsWith(`.${cd}`) || cd.endsWith(`.${h}`);
}

/**
 * Export browser cookies in Netscape format (for curl).
 * 导出浏览器 Cookie 为 Netscape 格式（供 curl 使用）。
 * @param {import('puppeteer-core').Page} page
 * @param {string} cookieFile
 * @param {{site?:string, host?:string, domainKeyword?:string}|string} [options] 传字符串时视为 domainKeyword（兼容旧调用）
 */
async function exportCookies(page, cookieFile, options = {}) {
  const opts = typeof options === 'string' ? { domainKeyword: options } : options || {};
  const host = opts.host || (opts.site ? safeHost(opts.site) : '');
  const cookies = await getCookies(page);

  const relevant = cookies.filter((c) => {
    if (opts.domainKeyword) return String(c.domain || '').includes(opts.domainKeyword);
    if (host) return domainMatches(c.domain, host);
    return true;
  });

  const lines = ['# Netscape HTTP Cookie File', `# generated ${new Date().toISOString()}`];
  for (const c of relevant) {
    const includeSub = c.domain.startsWith('.') ? 'TRUE' : 'FALSE';
    const secure = c.secure ? 'TRUE' : 'FALSE';
    const expiry = Math.floor(c.expires > 0 ? c.expires : Date.now() / 1000 + 86400 * 365);
    lines.push([c.domain, includeSub, c.path || '/', secure, expiry, c.name, c.value].join('\t'));
  }

  ensureDir(path.dirname(cookieFile));
  fs.writeFileSync(cookieFile, lines.join('\n') + '\n', 'utf8');
  // Treat cookies as login credentials and tighten permissions as much as possible
  // (chmod semantics are limited on Windows, so failures are ignored).
  //
  // Cookie 等同于登录凭证，尽量收紧权限（Windows 上 chmod 语义有限，失败忽略）
  try {
    fs.chmodSync(cookieFile, 0o600);
  } catch (e) {
    // Ignore failures.
    // 忽略失败。
  }
  return relevant;
}

function safeHost(site) {
  try {
    return new URL(site).host;
  } catch (e) {
    return '';
  }
}

function hasAuthCookie(cookies) {
  return cookies.some(
    (c) => c.value && (c.name === AUTH_COOKIE_NAME || (/civ/i.test(c.name) && /token/i.test(c.name)))
  );
}

module.exports = { getCookies, exportCookies, hasAuthCookie, domainMatches, safeHost, AUTH_COOKIE_NAME };
