'use strict';

/**
 * Civitai public API (/api/v1/*): fetch version file metadata.
 *
 * Compared with the old implementation, this adds request retries (exponential backoff +
 * 429 Retry-After), rate limiting, a configurable timeout, concurrent fetching (the old code
 * was serial with a fixed 300ms sleep per item), and response shape validation.
 *
 *
 * Civitai 公开 API（/api/v1/*）：获取版本文件元数据。
 *
 * 相比旧实现，这里补齐了：请求重试（指数退避 + 429 Retry-After）、限流、
 * 可配置超时、并发获取（原来串行且每项固定 sleep 300ms）、响应结构校验。
 */

const { log, formatBytes, mapPool, withRetry } = require('./util');
const { AuthError, NotFoundError, NetworkError, RateLimitError, SiteInterfaceError } = require('./errors');
const { createRateLimiter } = require('./rateLimit');
const { classifyVersionAccess, summarizeAccess, parseTime } = require('./access');
const { t } = require('./i18n');

const DEFAULT_FILE_TYPES = ['Model'];

const context = {
  limit: createRateLimiter(0),
  retries: 3,
  timeoutMs: 60000,
  onRetry: null,
  userAgent: '',
};

/**
 * Configure the API context from config; called by the upper layers (CLI/TUI).
 * 由上层（CLI/TUI）按 config 配置 API 上下文。
 * @param {{apiRateLimit?:number, retries?:number, requestTimeoutMs?:number, userAgent?:string, onRetry?:Function}} opts
 */
function configureApi(opts = {}) {
  if (opts.apiRateLimit !== undefined) context.limit = createRateLimiter(opts.apiRateLimit);
  if (opts.retries !== undefined) context.retries = Math.max(0, Number(opts.retries) || 0);
  if (opts.requestTimeoutMs !== undefined) context.timeoutMs = Math.max(1000, Number(opts.requestTimeoutMs) || 60000);
  if (opts.userAgent !== undefined) context.userAgent = String(opts.userAgent || '');
  if (opts.onRetry !== undefined) context.onRetry = opts.onRetry;
  return context;
}

function getApiContext() {
  return context;
}

/**
 * Parse the Retry-After header (seconds or an HTTP date).
 * 解析 Retry-After 头（秒数或 HTTP 日期）。
 */
function parseRetryAfter(header) {
  if (!header) return 0;
  const seconds = Number(header);
  if (Number.isFinite(seconds) && seconds >= 0) return seconds * 1000;
  const date = Date.parse(header);
  if (Number.isFinite(date)) return Math.max(0, date - Date.now());
  return 0;
}

/**
 * JSON request with retries and rate limiting.
 * 带重试/限流的 JSON 请求。
 * @param {string} url
 * @param {{userAgent?:string, retries?:number, timeoutMs?:number, limit?:object, onRetry?:Function, accept?:string}} [opts]
 */
async function fetchJson(url, opts = {}) {
  const userAgent = opts.userAgent || context.userAgent;
  const retries = opts.retries === undefined ? context.retries : Math.max(0, Number(opts.retries) || 0);
  const timeoutMs = opts.timeoutMs || context.timeoutMs;
  const limit = opts.limit || context.limit;
  const onRetry = opts.onRetry === undefined ? context.onRetry : opts.onRetry;

  const attemptOnce = async () => {
    if (limit && limit.enabled) await limit.acquire();
    let res;
    try {
      res = await fetch(url, {
        headers: { 'User-Agent': userAgent, Accept: opts.accept || 'application/json' },
        signal: AbortSignal.timeout(timeoutMs),
      });
    } catch (e) {
      throw new NetworkError(
        t('api.requestFailed', {
          reason: e && e.name === 'TimeoutError' ? t('api.timeout') : e.message,
          url,
        })
      );
    }

    if (res.status === 429) {
      throw new RateLimitError(t('api.rateLimited'), parseRetryAfter(res.headers.get('retry-after')));
    }
    if (res.status === 401 || res.status === 403) {
      throw new AuthError(t('api.authRequired', { status: res.status }));
    }
    if (res.status === 404) {
      throw new NotFoundError(t('api.notFound', { url }));
    }
    if (!res.ok) {
      throw new NetworkError(t('api.httpError', { status: res.status, url }));
    }
    try {
      return await res.json();
    } catch (e) {
      throw new SiteInterfaceError(t('api.badJson', { url }));
    }
  };

  return withRetry(attemptOnce, {
    attempts: retries + 1,
    shouldRetry: (e) => !(e instanceof AuthError) && !(e instanceof NotFoundError) && !(e instanceof SiteInterfaceError),
    onRetry:
      onRetry ||
      ((e, attempt, delay) => {
        log(
          t('api.retrying', {
            attempt,
            message: e.message,
            seconds: Math.round(delay / 1000),
          })
        );
      }),
  });
}

async function fetchVersionMeta(site, versionId, userAgent, opts = {}) {
  return fetchJson(`${site}/api/v1/model-versions/${versionId}`, { userAgent, ...opts });
}

/**
 * Session cache for model details.
 *
 * One workspace session asks for the same model repeatedly (adding the row, then opening its version
 * page, then the next member of a collection); a model detail is also the largest response the tool
 * fetches. A small LRU with a short TTL answers those repeats without holding stale data for long.
 *
 *
 * 模型详情的会话内缓存。
 *
 * 一次工作台会话会反复要同一个模型（添加行、进版本页、收藏集的下一个成员），模型详情又是
 * 工具里最大的响应。小容量 LRU 配短 TTL 正好覆盖这些重复请求，又不会长期缓存过期数据。
 */
const MODEL_DETAIL_CACHE_LIMIT = 300;
const MODEL_DETAIL_CACHE_TTL_MS = 10 * 60 * 1000;
const modelDetailCache = new Map();

/**
 * Cache key: one entry per site and model.
 * 缓存键：每个站点、每个模型一条。
 */
function modelDetailCacheKey(site, modelId) {
  return `${site}|${modelId}`;
}

/**
 * Drop every cached model detail (tests, or an explicit "reload" action).
 * 清空模型详情缓存（测试或显式「重新加载」时使用）。
 */
function clearModelDetailCache() {
  modelDetailCache.clear();
}

/**
 * Model detail with a session-level LRU cache (key `site|modelId`, 300 entries, 10 minute TTL).
 * 带会话级 LRU 缓存的模型详情（键 `site|modelId`，300 条，TTL 10 分钟）。
 */
async function fetchModelDetail(site, modelId, userAgent, opts = {}) {
  const key = modelDetailCacheKey(site, modelId);
  const cached = modelDetailCache.get(key);
  if (cached) {
    if (Date.now() - cached.storedAt <= MODEL_DETAIL_CACHE_TTL_MS) {
      // Re-insert to move this entry to the most-recently-used end of the Map.
      // 重新插入，把它移到 Map 的「最近使用」一端。
      modelDetailCache.delete(key);
      modelDetailCache.set(key, cached);
      return cached.value;
    }
    modelDetailCache.delete(key);
  }

  const detail = await fetchJson(`${site}/api/v1/models/${modelId}`, { userAgent, ...opts });
  modelDetailCache.set(key, { value: detail, storedAt: Date.now() });
  // Map iteration follows insertion order: the first key is the least recently used one.
  // Map 迭代顺序即插入顺序：第一个键就是最久未用的那条。
  while (modelDetailCache.size > MODEL_DETAIL_CACHE_LIMIT) {
    const oldest = modelDetailCache.keys().next().value;
    modelDetailCache.delete(oldest);
  }
  return detail;
}

function rebaseUrl(url, site) {
  if (!url) return url;
  try {
    const u = new URL(url);
    const s = new URL(site);
    if (u.origin === s.origin) return url;
    return s.origin + u.pathname + u.search;
  } catch (e) {
    return url;
  }
}

/**
 * Pick the downloadable files out of version metadata.
 * 从版本元数据中挑出可下载文件。
 * @param {object} meta 版本或模型版本对象
 * @param {string} site
 * @param {{fileTypes?:string[], primaryOnly?:boolean, includeRequired?:boolean}} [opts]
 */
function extractFiles(meta, site, opts = {}) {
  const types = opts.fileTypes && opts.fileTypes.length ? opts.fileTypes.map((ft) => ft.toLowerCase()) : DEFAULT_FILE_TYPES.map((ft) => ft.toLowerCase());
  const primaryOnly = opts.primaryOnly !== false;
  const includeRequired = opts.includeRequired !== false;
  const all = Array.isArray(meta && meta.files) ? meta.files : [];
  const matched = all.filter((f) => types.includes(String(f.type || '').toLowerCase()));
  const primary = matched.filter((f) => f.primary);
  const picked = primaryOnly && primary.length ? primary : matched;

  // Required components are files the model cannot run without. The site marks some as
  // metadata.isRequired (for example a text encoder); a linked VAE is marked only through vaeId.
  // They bypass fileTypes/primaryOnly so the default Model-only filter does not drop them.
  //
  // 必需组件是模型运行不可缺少的文件：站点用 metadata.isRequired 标记（例如文本编码器），
  // 关联的 VAE 只通过 vaeId 表示。它们不受 fileTypes/primaryOnly 过滤，避免默认只下 Model 时漏掉。
  const required = includeRequired
    ? all.filter(
        (f) =>
          (f.metadata && f.metadata.isRequired === true) ||
          (meta && meta.vaeId && String(f.type || '').toLowerCase() === 'vae')
      )
    : [];

  const result = [];
  const seen = new Set();
  for (const file of [...required, ...picked]) {
    const id = String(file.id === undefined || file.id === null ? file.name : file.id);
    if (seen.has(id)) continue;
    seen.add(id);
    result.push({
      fileId: file.id,
      name: file.name,
      sizeKB: file.sizeKB,
      bytes: Math.round((Number(file.sizeKB) || 0) * 1024),
      sha256: file.hashes && file.hashes.SHA256 ? String(file.hashes.SHA256).toUpperCase() : null,
      downloadUrl: site ? rebaseUrl(file.downloadUrl, site) : file.downloadUrl,
    });
  }
  return result;
}

/**
 * Newest-first comparison of two site versions: `publishedAt`, then `createdAt`, then the id.
 *
 * The array order of `modelVersions` is the site's ordering habit, not a contract (the free twin of
 * a paid version can be listed first although it is seven minutes older), so "newest" is computed
 * explicitly instead of trusting index 0.
 *
 *
 * 按「最新优先」比较两个线上版本：先 `publishedAt`，再 `createdAt`，最后比版本 id。
 *
 * `modelVersions` 的数组顺序是站点的排序习惯而非契约（免费孪生版可能比付费版早 7 分钟却排在
 * 前面），因此「最新」显式计算，不信任下标 0。
 *
 * @param {object} a
 * @param {object} b
 * @returns {number}
 */
function compareVersionRecency(a, b) {
  const timeOf = (version) =>
    (version && (parseTime(version.publishedAt) ?? parseTime(version.createdAt))) ??
    Number.NEGATIVE_INFINITY;
  const timeA = timeOf(a);
  const timeB = timeOf(b);
  if (timeA !== timeB) return timeB - timeA;
  const idA = String(a && a.id !== undefined ? a.id : '');
  const idB = String(b && b.id !== undefined ? b.id : '');
  return idB.localeCompare(idA, 'en', { numeric: true });
}

/**
 * The newest version of a list (the default download target when nothing is pinned or explicit).
 * 列表里最新的版本（没有固定版本或显式指定时，它就是默认下载目标）。
 *
 * @param {Array<object>} versions
 * @returns {object|null}
 */
function newestVersion(versions) {
  const list = Array.isArray(versions) ? versions.filter(Boolean) : [];
  if (!list.length) return null;
  return list.slice().sort(compareVersionRecency)[0];
}

function versionToItem(site, version, opts = {}) {
  const files = extractFiles(version, site, opts);
  const bytes = files.reduce((sum, f) => sum + f.bytes, 0);
  return {
    versionId: version.id,
    versionName: version.name,
    baseModel: version.baseModel,
    files,
    totalBytes: bytes,
    access: classifyVersionAccess(version, opts.model || null),
    // Raw site object: the download job mirrors it into the library ("record everything")
    // 站点原始对象：下载流程会把它镜像进模型库（「记录所有信息」）
    versionMeta: version,
  };
}

/**
 * Fetch file metadata in batches.
 * 批量获取文件元数据。
 * @param {string} site
 * @param {Array<object>} items 收藏集条目（含 modelId/name/versionId）
 * @param {string} userAgent
 * @param {{concurrency?:number, fileTypes?:string[], primaryOnly?:boolean, onProgress?:Function, onLog?:Function}} [opts]
 * @returns {Promise<{plan:Array<object>, totalBytes:number, failed:number}>}
 */
async function buildPlan(site, items, userAgent, opts = {}) {
  const concurrency = Math.max(1, Math.min(Number(opts.concurrency) || 4, 8));
  const emit = opts.onLog || log;
  const total = items.length;
  let done = 0;

  const results = await mapPool(items, concurrency, async (item) => {
    const finish = (entry) => {
      done++;
      if (opts.onProgress) opts.onProgress(done, total, entry);
      return entry;
    };

    if (!item.versionId) {
      emit(t('api.noLatestVersionLine', { index: done + 1, total, name: item.name }));
      return finish({ ...item, error: t('api.noLatestVersion') });
    }
    try {
      const meta = await fetchVersionMeta(site, item.versionId, userAgent);
      const files = extractFiles(meta, site, opts);
      if (!files.length) {
        throw new SiteInterfaceError(
          t('api.noFiles', { types: (opts.fileTypes || DEFAULT_FILE_TYPES).join('/') })
        );
      }
      const bytes = files.reduce((sum, f) => sum + f.bytes, 0);
      emit(
        t('api.itemFiles', {
          index: done + 1,
          total,
          name: item.name,
          count: files.length,
          size: formatBytes(bytes),
        })
      );
      return finish({
        ...item,
        files,
        totalBytes: bytes,
        versionMeta: meta,
        access: classifyVersionAccess(meta, null),
      });
    } catch (e) {
      emit(
        t('api.metaFailedLine', {
          index: done + 1,
          total,
          name: item.name,
          message: e.message,
        })
      );
      return finish({ ...item, error: String(e.message || e) });
    }
  });

  const plan = results;
  const totalBytes = plan.filter((p) => !p.error).reduce((sum, p) => sum + (p.totalBytes || 0), 0);
  const failed = plan.filter((p) => p.error).length;
  return { plan, totalBytes, failed };
}

/**
 * Build a plan from collection members by fetching each member's model detail.
 *
 * Same shape and same failure semantics as `buildPlan()`, but the version is chosen from the whole
 * model: the pinned version when the library fixed one, otherwise the newest version. The response
 * also carries every version's `paidAccess`, so each row gets a complete access summary for free.
 *
 * `buildPlan()` stays the CLI path (registered version semantics); only the TUI collection flow
 * calls this one.
 *
 *
 * 按收藏集成员逐个拉模型详情来生成计划。
 *
 * 返回结构与失败语义与 `buildPlan()` 一致，但版本是从整个模型里选的：模型库固定过就用固定版本，
 * 否则用最新版本。响应同时带回每个版本的 `paidAccess`，每一行因此免费得到完整的访问汇总。
 *
 * `buildPlan()` 仍是 CLI 的路径（登记版本语义），只有 TUI 的收藏集流程调用这个函数。
 *
 * @param {string} site
 * @param {Array<object>} items 收藏集条目（含 modelId/name/type/versionId）
 * @param {string} userAgent
 * @param {{concurrency?:number, fileTypes?:string[], primaryOnly?:boolean, entries?:object, onProgress?:Function, onLog?:Function}} [opts]
 * @returns {Promise<{plan:Array<object>, totalBytes:number, failed:number}>}
 */
async function buildPlanFromModels(site, items, userAgent, opts = {}) {
  const concurrency = Math.max(1, Math.min(Number(opts.concurrency) || 4, 8));
  const emit = opts.onLog || log;
  const entries = opts.entries || {};
  const total = items.length;
  let done = 0;

  const results = await mapPool(items, concurrency, async (item) => {
    const finish = (entry) => {
      done++;
      if (opts.onProgress) opts.onProgress(done, total, entry);
      return entry;
    };

    try {
      const detail = await fetchModelDetail(site, item.modelId, userAgent);
      const versions = Array.isArray(detail.modelVersions) ? detail.modelVersions : [];
      const newest = newestVersion(versions);
      if (!newest) {
        throw new SiteInterfaceError(t('api.noLatestVersion'));
      }
      const entry = entries[String(item.modelId)];
      const pinnedId = entry && entry.pinnedVersionId ? String(entry.pinnedVersionId) : null;
      const version = (pinnedId && versions.find((candidate) => String(candidate.id) === pinnedId)) || newest;
      const built = versionToItem(site, version, {
        fileTypes: opts.fileTypes,
        primaryOnly: opts.primaryOnly,
        model: detail,
      });
      if (!built.files.length) {
        throw new SiteInterfaceError(
          t('api.noFiles', { types: (opts.fileTypes || DEFAULT_FILE_TYPES).join('/') })
        );
      }
      emit(
        t('api.itemFiles', {
          index: done + 1,
          total,
          name: detail.name || item.name,
          count: built.files.length,
          size: formatBytes(built.totalBytes),
        })
      );
      return finish({
        ...built,
        modelId: item.modelId,
        name: detail.name || item.name,
        type: detail.type || item.type,
        baseModel: version.baseModel,
        modelMeta: detail,
        modelAccess: summarizeAccess(versions.map((candidate) => classifyVersionAccess(candidate, detail))),
      });
    } catch (e) {
      emit(
        t('api.metaFailedLine', {
          index: done + 1,
          total,
          name: item.name,
          message: e.message,
        })
      );
      return finish({ ...item, error: String(e.message || e) });
    }
  });

  const plan = results;
  const totalBytes = plan.filter((p) => !p.error).reduce((sum, p) => sum + (p.totalBytes || 0), 0);
  const failed = plan.filter((p) => p.error).length;
  return { plan, totalBytes, failed };
}

module.exports = {
  configureApi,
  getApiContext,
  parseRetryAfter,
  fetchJson,
  fetchVersionMeta,
  fetchModelDetail,
  clearModelDetailCache,
  extractFiles,
  versionToItem,
  compareVersionRecency,
  newestVersion,
  buildPlan,
  buildPlanFromModels,
  rebaseUrl,
  DEFAULT_FILE_TYPES,
};
