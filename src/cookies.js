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

async function exportCookies(page, cookieFile, domainKeyword = 'civitai') {
  const cookies = await getCookies(page);
  const relevant = cookies.filter((c) => c.domain.includes(domainKeyword));
  const lines = ['# Netscape HTTP Cookie File', `# generated ${new Date().toISOString()}`];
  for (const c of relevant) {
    const includeSub = c.domain.startsWith('.') ? 'TRUE' : 'FALSE';
    const secure = c.secure ? 'TRUE' : 'FALSE';
    const expiry = Math.floor(c.expires > 0 ? c.expires : Date.now() / 1000 + 86400 * 365);
    lines.push([c.domain, includeSub, c.path || '/', secure, expiry, c.name, c.value].join('\t'));
  }
  ensureDir(path.dirname(cookieFile));
  fs.writeFileSync(cookieFile, lines.join('\n') + '\n', 'utf8');
  return relevant;
}

function hasAuthCookie(cookies) {
  return cookies.some(
    (c) => c.value && (c.name === AUTH_COOKIE_NAME || (/civ/i.test(c.name) && /token/i.test(c.name)))
  );
}

module.exports = { getCookies, exportCookies, hasAuthCookie, AUTH_COOKIE_NAME };
