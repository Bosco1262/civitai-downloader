'use strict';

const devalue = require('devalue');
const { log } = require('./util');

const TRPC_INPUT_BASE = {
  periodMode: 'published',
  sort: 'Newest',
  pending: false,
  browsingLevel: 31,
  excludedTagIds: [
    5161, 5162, 5188, 5249, 130818, 130820, 133182, 130401, 110980, 5351, 306619, 154326, 161829, 163032,
  ],
  disablePoi: true,
  disableMinor: true,
  direction: 'forward',
  authed: true,
};

function parseTrpcText(text) {
  const outer = JSON.parse(text);
  if (outer && outer.error) {
    const inner = outer.error.json || outer.error;
    throw new Error(`tRPC 错误: ${inner.message || JSON.stringify(outer.error).slice(0, 200)}`);
  }
  const data = outer && outer.result ? outer.result.data : undefined;
  if (typeof data === 'string') return devalue.parse(data);
  if (data && data.json !== undefined) return data.json;
  return data;
}

function isUnauthorized(status, text) {
  return (
    status === 401 ||
    status === 403 ||
    /UNAUTHORIZED/i.test(text) ||
    /Please use the public API/i.test(text)
  );
}

async function ensureSitePage(browser, site, collectionId) {
  const host = new URL(site).host;
  const pages = await browser.pages();
  let page = pages.find((p) => {
    try {
      return new URL(p.url()).host === host;
    } catch (e) {
      return false;
    }
  });
  if (page) return page;
  page = await browser.newPage();
  await page.goto(`${site}/collections/${collectionId}`, {
    waitUntil: 'domcontentloaded',
    timeout: 90000,
  });
  await new Promise((r) => setTimeout(r, 3000));
  return page;
}

async function fetchCollectionItems(browser, site, collectionId) {
  const page = await ensureSitePage(browser, site, collectionId);
  log(`使用页面: ${page.url()}`);
  const all = new Map();
  let cursor;
  for (let i = 0; i < 200; i++) {
    const input = { json: { ...TRPC_INPUT_BASE, collectionId: Number(collectionId) } };
    if (cursor !== undefined && cursor !== null) input.json.cursor = cursor;
    const result = await page.evaluate(async (url) => {
      const res = await fetch(url, { credentials: 'include' });
      return { status: res.status, text: await res.text() };
    }, '/api/trpc/model.getAll?input=' + encodeURIComponent(JSON.stringify(input)));

    const looksLikeError = /"error"\s*:/.test(result.text.slice(0, 3000));
    if (result.status !== 200 || looksLikeError) {
      if (isUnauthorized(result.status, result.text)) {
        throw new Error('未登录或登录已过期，请先运行: npm run login');
      }
      throw new Error(`tRPC 请求失败 HTTP ${result.status}: ${result.text.slice(0, 300)}`);
    }

    let data;
    try {
      data = parseTrpcText(result.text);
    } catch (e) {
      throw new Error(`响应解析失败: ${e.message}`);
    }
    if (!data || !data.items) {
      throw new Error(`响应结构异常: ${result.text.slice(0, 300)}`);
    }

    let added = 0;
    for (const m of data.items) {
      if (!all.has(m.id)) {
        all.set(m.id, {
          modelId: m.id,
          name: m.name,
          type: m.type,
          versionId: m.version ? m.version.id : null,
          versionName: m.version ? m.version.name : null,
          baseModel: m.version ? m.version.baseModel : null,
        });
        added++;
      }
    }
    cursor = data.nextCursor;
    log(`  第 ${i + 1} 页: 返回 ${data.items.length} 项，新增 ${added}，累计 ${all.size}`);
    if (cursor === undefined || cursor === null || added === 0) break;
  }
  return [...all.values()];
}

module.exports = { fetchCollectionItems, parseTrpcText, ensureSitePage };
