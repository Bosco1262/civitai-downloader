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
const { AuthError, ChallengeError, NetworkError, SiteInterfaceError } = require('./errors');
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
 * Default deadline of one page request, in milliseconds. A request that never settles would freeze
 * the whole TUI with no output at all, so every page call is bounded twice: inside the page (the
 * fetch is aborted) and outside it (the caller stops waiting even if the tab is wedged).
 *
 * 单页请求的默认时限（毫秒）。请求永不返回会让整个 TUI 毫无输出地卡死，因此每次都设两道时限：
 * 页面内（中止 fetch）与页面外（即使标签页卡住，调用方也会停止等待）。
 */
const DEFAULT_REQUEST_TIMEOUT_MS = 30000;

/**
 * Single page request: fetch with the login state inside the page context.
 *
 * The fetch is aborted after `timeoutMs` and a status of 0 is returned, so a hanging connection or
 * a page that is stuck in a long script cannot block the caller forever.
 *
 *
 * 单页请求：在页面上下文里带登录态 fetch。
 *
 * 超过 `timeoutMs` 会中止 fetch 并返回 status 0，因此连接挂起或页面卡在长脚本里都不会让调用方永久阻塞。
 */
async function requestPage(page, url, opts = {}) {
  const timeoutMs = Math.max(1000, Number(opts.timeoutMs) || DEFAULT_REQUEST_TIMEOUT_MS);
  // Grace beyond the in-page deadline: if the tab stopped answering entirely, the caller gives up a
  // little later instead of waiting forever. Overridable for tests.
  //
  // 页面内时限之外的宽限：如果标签页完全不响应，调用方晚一点放弃，而不是永远等下去。测试可覆盖。
  const graceMs = Math.max(0, Number(opts.graceMs === undefined ? 5000 : opts.graceMs) || 0);
  const work = page.evaluate(
    async (target, limitMs) => {
      const controller = new AbortController();
      const timer = setTimeout(() => controller.abort(), limitMs);
      try {
        const res = await fetch(target, { credentials: 'include', signal: controller.signal });
        const text = await res.text();
        return { status: res.status, text };
      } catch (e) {
        // Distinguish "the request never finished" from an HTTP error: the caller reports both.
        // 区分「请求没跑完」与「HTTP 错误」：调用方分别处理。
        return { status: 0, text: '', error: String((e && e.message) || e) };
      } finally {
        clearTimeout(timer);
      }
    },
    url,
    timeoutMs
  );

  // Outside guard: a wedged tab (or a debugger connection that stopped answering) would otherwise
  // keep the promise pending forever. The abandoned evaluate is told to stay quiet.
  //
  // 外层保护：标签页卡死（或调试连接不再响应）时这个 promise 会永远 pending。被放弃的 evaluate 结果直接丢弃。
  const guarded = await withDeadline(work, timeoutMs + graceMs);
  if (guarded.timedOut) return { status: 0, text: '', error: t('collection.requestTimeout', { ms: timeoutMs }) };
  return guarded.value;
}

/**
 * Resolve `promise` or give up after `ms`; never rejects.
 * 在 `ms` 内等待 `promise`，超时则放弃；不会 reject。
 *
 * @param {Promise<any>} promise
 * @param {number} ms
 * @returns {Promise<{timedOut:boolean, value?:any}>}
 */
async function withDeadline(promise, ms) {
  const limit = Math.max(1, Number(ms) || 1);
  let timer = null;
  const guard = new Promise((resolve) => {
    timer = setTimeout(() => resolve({ timedOut: true }), limit);
    if (typeof timer.unref === 'function') timer.unref();
  });
  try {
    const value = await Promise.race([
      Promise.resolve(promise).then(
        (result) => ({ timedOut: false, value: result }),
        (error) => ({ timedOut: false, value: { status: 0, text: '', error: String((error && error.message) || error) } })
      ),
      guard,
    ]);
    return value;
  } finally {
    clearTimeout(timer);
  }
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
  const result = await requestPage(page, url, { timeoutMs: opts.requestTimeoutMs || opts.timeoutMs });

  if (result.status === 0) {
    return { ok: false, reason: result.error || t('collection.timeoutShort'), status: 0 };
  }
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
    const result = await requestPage(page, url, { timeoutMs: opts.requestTimeoutMs || opts.timeoutMs });

    // status 0 means the request never produced an HTTP response (connection stalled, tab wedged,
    // or the page-level deadline fired): report it as a network problem instead of "HTTP 0".
    //
    // status 0 表示请求没有拿到任何 HTTP 响应（连接挂起、标签页卡死、或页面内时限已到）：
    // 按网络问题上报，而不是说成「HTTP 0」。
    if (result.status === 0) {
      throw new NetworkError(result.error || t('collection.timeoutShort'));
    }

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
  DEFAULT_REQUEST_TIMEOUT_MS,
  fetchCollectionItems,
  parseTrpcText,
  probeLogin,
  requestPage,
  withDeadline,
  isUnauthorized,
  looksLikeChallenge,
  ensureSitePage,
};
