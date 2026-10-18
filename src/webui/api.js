'use strict';

/**
 * HTTP routing for the web UI.
 *
 * The router is a small ordered table of `[method, pattern, handler]`: patterns are anchored
 * regular expressions, handlers receive `{params, query, body, actions, jobs}` and return plain data.
 * Keeping routing separate from the actions means the whole API surface can be read in one place.
 *
 *
 * Web UI 的 HTTP 路由。
 *
 * 路由是一张有序的 `[方法, 正则, 处理器]` 表：正则是锚定的，处理器收到
 * `{params, query, body, actions, jobs}` 并返回普通数据。
 * 路由与业务动作分离，因此整个 API 面可以在一处读完。
 */

const { sendJson, readJsonBody } = require('./http');

/**
 * Decode a path segment (`%2F` inside an id is not expected, but be tolerant).
 * 解码路径片段（id 里不该出现 `%2F`，但也要容错）。
 */
function decodeSegment(value) {
  try {
    return decodeURIComponent(String(value));
  } catch (e) {
    return String(value);
  }
}

/**
 * Build the route table for one actions instance.
 * 为某个 actions 实例生成路由表。
 *
 * @param {object} actions
 * @param {object} jobs
 * @returns {Array<{method:string, pattern:RegExp, handler:(ctx:object)=>any}>}
 */
function buildRoutes(actions, jobs) {
  return [
    // Read-only endpoints
    // 只读接口
    { method: 'GET', pattern: /^\/api\/state$/, handler: () => actions.state() },
    { method: 'GET', pattern: /^\/api\/i18n$/, handler: () => actions.i18n() },
    {
      method: 'GET',
      pattern: /^\/api\/library$/,
      handler: ({ query }) =>
        actions.library({
          q: query.get('q') || '',
          sort: query.get('sort') || 'recent',
          collectionId: query.get('collectionId') || null,
        }),
    },
    {
      method: 'GET',
      pattern: /^\/api\/library\/([^/]+)$/,
      handler: ({ params }) => actions.modelDetail(decodeSegment(params[0])),
    },
    {
      method: 'GET',
      pattern: /^\/api\/collections\/([^/]+)$/,
      handler: ({ params }) => actions.collectionDetail(decodeSegment(params[0])),
    },
    { method: 'GET', pattern: /^\/api\/settings$/, handler: () => actions.settings() },
    { method: 'GET', pattern: /^\/api\/disk$/, handler: ({ query }) => actions.disk(query.get('dir') || undefined) },

    // Library mutations
    // 模型库的写操作
    {
      method: 'POST',
      pattern: /^\/api\/library\/([^/]+)\/pin$/,
      handler: ({ params, body }) => actions.pinModel(decodeSegment(params[0]), body.versionId),
    },
    {
      method: 'POST',
      pattern: /^\/api\/library\/([^/]+)\/forget$/,
      handler: ({ params, body }) => actions.forget(decodeSegment(params[0]), { deleteFiles: body.deleteFiles }),
    },
    {
      method: 'POST',
      pattern: /^\/api\/models\/versions$/,
      handler: ({ body }) => actions.versions({ modelIds: body.modelIds }),
    },
    {
      method: 'POST',
      pattern: /^\/api\/models\/reset$/,
      handler: ({ body }) => actions.resetRecords({ items: body.items }),
    },

    // Long-running jobs
    // 耗时任务
    {
      method: 'POST',
      pattern: /^\/api\/collections\/plan$/,
      handler: ({ body }) => actions.startPlan({ collectionId: body.collectionId }),
    },
    { method: 'POST', pattern: /^\/api\/download$/, handler: ({ body }) => actions.startDownload(body) },
    { method: 'POST', pattern: /^\/api\/check$/, handler: ({ body }) => actions.startCheck(body) },
    { method: 'POST', pattern: /^\/api\/verify$/, handler: ({ body }) => actions.startVerify(body) },
    { method: 'POST', pattern: /^\/api\/login\/start$/, handler: () => actions.startLogin() },
    { method: 'POST', pattern: /^\/api\/login\/confirm$/, handler: () => actions.confirmLogin() },
    { method: 'POST', pattern: /^\/api\/login\/check$/, handler: () => actions.sessionCheck() },
    { method: 'POST', pattern: /^\/api\/doctor$/, handler: ({ body }) => actions.doctorReport({ deep: body.deep }) },
    { method: 'POST', pattern: /^\/api\/settings$/, handler: ({ body }) => actions.saveSettings(body) },
    { method: 'POST', pattern: /^\/api\/open$/, handler: ({ body }) => actions.openDirectory(body.dir) },

    // Job inspection
    // 任务查询
    { method: 'GET', pattern: /^\/api\/jobs$/, handler: () => ({ jobs: jobs.list() }) },
    {
      method: 'GET',
      pattern: /^\/api\/jobs\/([^/]+)$/,
      handler: ({ params }) => jobs.get(decodeSegment(params[0])),
    },
    {
      method: 'POST',
      pattern: /^\/api\/jobs\/([^/]+)\/cancel$/,
      handler: ({ params }) => {
        const id = decodeSegment(params[0]);
        const ok = jobs.cancel(id);
        if (!ok) {
          const error = new Error('job not running');
          error.status = 409;
          throw error;
        }
        return { cancelled: true };
      },
    },
  ];
}

/**
 * Create the request handler.
 * 创建请求处理器。
 *
 * @param {{
 *   actions:object,
 *   jobs:object,
 *   onError?:(error:Error, req:object) => void
 * }} opts
 * @returns {(req:object, res:object) => Promise<boolean>} true when the request was an API call
 */
function createApiHandler(opts = {}) {
  const { actions, jobs } = opts;
  const onError = typeof opts.onError === 'function' ? opts.onError : () => {};
  const routes = buildRoutes(actions, jobs);

  return async function handleApi(req, res) {
    const url = new URL(req.url, 'http://localhost');
    if (!url.pathname.startsWith('/api/')) return false;

    const method = String(req.method || 'GET').toUpperCase();
    const match = routes.find((route) => route.method === method && route.pattern.test(url.pathname));
    if (!match) {
      sendJson(res, 404, { error: `no route for ${method} ${url.pathname}` });
      return true;
    }

    const params = match.pattern.exec(url.pathname).slice(1);
    let body = {};
    if (method !== 'GET' && method !== 'HEAD') {
      try {
        body = await readJsonBody(req);
      } catch (error) {
        sendJson(res, error.status || 400, { error: error.message });
        return true;
      }
    }

    try {
      const result = await match.handler({ params, query: url.searchParams, body, actions, jobs });
      if (res.writableEnded) return true;
      sendJson(res, 200, result === undefined ? { ok: true } : result);
    } catch (error) {
      const status = Number(error && error.status) || 500;
      onError(error, req);
      sendJson(res, status, { error: (error && error.message) || String(error) });
    }
    return true;
  };
}

module.exports = { createApiHandler, buildRoutes, decodeSegment };
