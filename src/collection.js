'use strict';

/**
 * Collection item enumeration.
 *
 * Civitai's public REST API cannot enumerate a collection, so we call the site's own tRPC
 * endpoint from within a site page context, carrying the login state.
 *
 * Compared with the old implementation:
 *  - the tRPC procedure name and request body template are configurable (a site redesign can be
 *    handled in config instead of code);
 *  - Cloudflare challenge pages are recognized and reported with an actionable hint;
 *  - an unexpected response shape is reported as an "interface change" instead of a generic
 *    parse failure.
 *
 *
 * 收藏集条目枚举。
 *
 * Civitai 公开 REST API 不支持枚举收藏集，所以这里在站点页面的上下文里
 * 携带登录态调用站点自身的 tRPC 接口。
 *
 * 相比旧实现：
 *  - tRPC 过程名与请求体模板可配置（站点改版时可改配置而不是改代码）；
 *  - 识别 Cloudflare 人机验证页并给出可操作提示；
 *  - 响应结构不符合预期时区分为「接口变更」而不是笼统的解析失败。
 */

const devalue = require('devalue');
const { log } = require('./util');
const { AuthError, ChallengeError, SiteInterfaceError } = require('./errors');
const { ensureSitePage } = require('./browser');
const { t } = require('./i18n');

const DEFAULT_TRPC_PATH = 'model.getAll';

/**
 * Default request body template for the site's own endpoint (overridable via trpcInput in config.json).
 * 站点自身请求体的默认模板（可在 config.json 的 trpcInput 中覆盖）。
 */
const DEFAULT_TRPC_INPUT = {
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

const CHALLENGE_MARKERS = [
  /just a moment/i,
  /cf-chl/i,
  /cf_chl_opt/i,
  /challenge-platform/i,
  /enable javascript and cookies to continue/i,
  /<title>\s*attention required/i,
];

function looksLikeChallenge(status, text) {
  if (status !== 403 && status !== 503 && status !== 200) return false;
  const sample = String(text || '').slice(0, 4000);
  return CHALLENGE_MARKERS.some((re) => re.test(sample));
}

/**
 * Parse a tRPC response text (supports both devalue serialization and plain JSON).
 * 解析 tRPC 响应文本（兼容 devalue 序列化与普通 JSON 两种形态）。
 * @param {string} text
 */
function parseTrpcText(text) {
  let outer;
  try {
    outer = JSON.parse(text);
  } catch (e) {
    throw new SiteInterfaceError(
      t('collection.trpcBadJson', { sample: String(text).slice(0, 200) })
    );
  }
  if (outer && outer.error) {
    const inner = outer.error.json || outer.error;
    throw new SiteInterfaceError(
      t('collection.trpcError', { message: inner.message || JSON.stringify(outer.error).slice(0, 200) })
    );
  }
  const data = outer && outer.result ? outer.result.data : undefined;
  if (typeof data === 'string') {
    try {
      return devalue.parse(data);
    } catch (e) {
      throw new SiteInterfaceError(t('collection.trpcDevalueFailed', { message: e.message }));
    }
  }
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

/**
 * Single page request: fetch with the login state inside the page context.
 * 单页请求：在页面上下文里带登录态 fetch。
 */
async function requestPage(page, url) {
  return page.evaluate(async (target) => {
    const res = await fetch(target, { credentials: 'include' });
    return { status: res.status, text: await res.text() };
  }, url);
}

/**
 * Probe whether the login state is valid (send a minimal tRPC request, only caring about rejection).
 * 探测登录态是否有效（发一个最小的 tRPC 请求，只关心有没有被拒）。
 * @returns {Promise<{ok:boolean, reason:string, status?:number}>}
 */
async function probeLogin(browser, site, opts = {}) {
  const page = opts.page || (await ensureSitePage(browser, site));
  const trpcPath = opts.trpcPath || DEFAULT_TRPC_PATH;
  const input = {
    json: { ...DEFAULT_TRPC_INPUT, ...(opts.trpcInput || {}), collectionId: Number(opts.collectionId) || 1 },
  };
  const url = `/api/trpc/${trpcPath}?input=${encodeURIComponent(JSON.stringify(input))}`;
  const result = await requestPage(page, url);

  if (looksLikeChallenge(result.status, result.text)) {
    return { ok: false, reason: t('collection.challengeProbe'), status: result.status };
  }
  if (isUnauthorized(result.status, result.text)) {
    return { ok: false, reason: t('collection.unauthorized'), status: result.status };
  }
  if (result.status !== 200) {
    return { ok: false, reason: `HTTP ${result.status}`, status: result.status };
  }
  return { ok: true, reason: 'ok', status: result.status };
}

/**
 * Enumerate every item of a collection (cursor pagination + deduplication).
 * 枚举收藏集全部条目（游标分页 + 去重）。
 * @param {import('puppeteer-core').Browser} browser
 * @param {string} site
 * @param {string|number} collectionId
 * @param {{trpcPath?:string, trpcInput?:object, page?:object, maxPages?:number, onLog?:Function, limit?:object}} [opts]
 * @returns {Promise<Array<object>>}
 */
async function fetchCollectionItems(browser, site, collectionId, opts = {}) {
  const emit = opts.onLog || log;
  const trpcPath = opts.trpcPath || DEFAULT_TRPC_PATH;
  const baseInput = { ...DEFAULT_TRPC_INPUT, ...(opts.trpcInput || {}) };
  const maxPages = Math.max(1, Number(opts.maxPages) || 200);
  const limit = opts.limit;

  const page = opts.page || (await ensureSitePage(browser, site));
  if (!opts.page) emit(t('collection.usingPage', { url: page.url() }));

  const all = new Map();
  let cursor;
  for (let i = 0; i < maxPages; i++) {
    const input = { json: { ...baseInput, collectionId: Number(collectionId) } };
    if (cursor !== undefined && cursor !== null) input.json.cursor = cursor;

    if (limit && limit.enabled) await limit.acquire();
    const url = `/api/trpc/${trpcPath}?input=${encodeURIComponent(JSON.stringify(input))}`;
    const result = await requestPage(page, url);

    if (looksLikeChallenge(result.status, result.text)) {
      throw new ChallengeError(t('collection.challenge'));
    }

    const looksLikeError = /"error"\s*:/.test(result.text.slice(0, 3000));
    if (result.status !== 200 || looksLikeError) {
      if (isUnauthorized(result.status, result.text)) {
        throw new AuthError(t('collection.authRequired'));
      }
      throw new SiteInterfaceError(
        t('collection.trpcRequestFailed', { status: result.status, sample: result.text.slice(0, 300) })
      );
    }

    const data = parseTrpcText(result.text);
    if (!data || !Array.isArray(data.items)) {
      throw new SiteInterfaceError(
        t('collection.unexpectedShape', {
          actual: JSON.stringify(
            data && typeof data === 'object' ? Object.keys(data).slice(0, 10) : typeof data
          ),
          sample: String(result.text).slice(0, 200),
        })
      );
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
    emit(
      t('collection.pageProgress', {
        page: i + 1,
        count: data.items.length,
        added,
        total: all.size,
      })
    );
    if (cursor === undefined || cursor === null || added === 0) break;
  }
  return [...all.values()];
}

module.exports = {
  DEFAULT_TRPC_PATH,
  DEFAULT_TRPC_INPUT,
  fetchCollectionItems,
  parseTrpcText,
  probeLogin,
  isUnauthorized,
  looksLikeChallenge,
  ensureSitePage,
};
