'use strict';

/**
 * Small HTTP helpers shared by the web UI server: JSON responses, request-body parsing, static files
 * and server-sent events.
 *
 * Everything here is deliberately dependency-free (node:http only), because the project ships
 * without a bundler and the web UI must start with `node web.js` on a machine that only ran
 * `npm install`.
 *
 *
 * Web UI 服务器共用的小工具：JSON 响应、请求体解析、静态文件与 SSE。
 *
 * 这里刻意零依赖（只用 node:http）：项目不带打包器，Web UI 必须在只跑过 `npm install` 的机器上
 * 用 `node web.js` 直接启动。
 */

const fs = require('fs');
const path = require('path');

/**
 * Content types the UI needs; everything else is served as a generic binary.
 * UI 需要的 MIME 类型；其余按通用二进制返回。
 */
const MIME = {
  '.html': 'text/html; charset=utf-8',
  '.js': 'text/javascript; charset=utf-8',
  '.css': 'text/css; charset=utf-8',
  '.json': 'application/json; charset=utf-8',
  '.svg': 'image/svg+xml',
  '.png': 'image/png',
  '.ico': 'image/x-icon',
  '.woff2': 'font/woff2',
  '.txt': 'text/plain; charset=utf-8',
};

/**
 * Maximum accepted request body (JSON payloads here are small: ids, filters, options).
 * 允许的请求体上限（这里的 JSON 都很小：id、过滤条件、选项）。
 */
const BODY_LIMIT = 4 * 1024 * 1024;

/**
 * Send a JSON response.
 * 返回 JSON 响应。
 */
function sendJson(res, status, data) {
  const body = JSON.stringify(data === undefined ? null : data);
  res.writeHead(status, {
    'Content-Type': 'application/json; charset=utf-8',
    'Content-Length': Buffer.byteLength(body),
    'Cache-Control': 'no-store',
    'X-Frame-Options': 'DENY',
    'X-Content-Type-Options': 'nosniff',
  });
  res.end(body);
}

/**
 * Send a plain-text response (errors of the static file layer).
 * 返回纯文本响应（静态文件层的错误）。
 */
function sendText(res, status, text) {
  const body = String(text);
  res.writeHead(status, {
    'Content-Type': 'text/plain; charset=utf-8',
    'Content-Length': Buffer.byteLength(body),
    'Cache-Control': 'no-store',
  });
  res.end(body);
}

/**
 * Read and parse a JSON request body.
 *
 * Resolves `{}` for an empty body (a POST without payload is common here). Rejects with a `status`
 * property so the router can answer 400/413 without guessing.
 *
 *
 * 读取并解析 JSON 请求体。
 *
 * 空请求体解析为 `{}`（这里的 POST 常常不带负载）。reject 的对象带 `status`，
 * 路由层可以直接回 400/413，不必猜。
 *
 * @param {import('http').IncomingMessage} req
 * @param {{limit?:number}} [opts]
 * @returns {Promise<any>}
 */
function readJsonBody(req, opts = {}) {
  const limit = Math.max(1, Number(opts.limit) || BODY_LIMIT);
  return new Promise((resolve, reject) => {
    let size = 0;
    const chunks = [];
    req.on('data', (chunk) => {
      size += chunk.length;
      if (size > limit) {
        const error = new Error('request body too large');
        error.status = 413;
        reject(error);
        req.destroy();
        return;
      }
      chunks.push(chunk);
    });
    req.on('error', (error) => {
      if (!error.status) error.status = 400;
      reject(error);
    });
    req.on('end', () => {
      const raw = Buffer.concat(chunks).toString('utf8').trim();
      if (!raw) {
        resolve({});
        return;
      }
      try {
        const parsed = JSON.parse(raw);
        resolve(parsed && typeof parsed === 'object' ? parsed : {});
      } catch (e) {
        const error = new Error('invalid JSON body');
        error.status = 400;
        reject(error);
      }
    });
  });
}

/**
 * Resolve a URL path to a file inside `rootDir`, or null when it would escape the directory.
 *
 * `path.resolve` alone is not enough: `..%2f` and Windows drive letters must be rejected too, which
 * is why the candidate has to stay inside `root` after resolution.
 *
 *
 * 把 URL 路径解析成 `rootDir` 内的文件；越界时返回 null。
 *
 * 只做 `path.resolve` 不够：`..%2f` 与 Windows 盘符都要拒绝，因此解析后必须仍在 `root` 之内。
 *
 * @param {string} rootDir
 * @param {string} urlPath
 * @returns {string|null}
 */
function resolveStaticPath(rootDir, urlPath) {
  let decoded = '/';
  try {
    decoded = decodeURIComponent(String(urlPath || '/'));
  } catch (e) {
    return null;
  }
  if (decoded.includes('\u0000')) return null;
  const root = path.resolve(rootDir);
  const relative = decoded.replace(/^\/+/, '');
  const candidate = path.resolve(root, relative);
  const rootWithSep = root.endsWith(path.sep) ? root : root + path.sep;
  if (candidate !== root && !candidate.startsWith(rootWithSep)) return null;
  return candidate;
}

/**
 * Serve one file from the static directory.
 *
 * Returns true when the request was handled. Missing files fall through to `false` so the router can
 * answer with its own 404 (or the SPA shell).
 *
 *
 * 提供一个静态文件。
 *
 * 已处理返回 true。文件不存在返回 false，交给路由层决定 404 还是回 SPA 外壳。
 *
 * @param {import('http').ClientRequest} req
 * @param {import('http').ServerResponse} res
 * @param {string} rootDir
 * @param {string} urlPath
 * @param {{immutable?:boolean}} [opts]
 * @returns {boolean}
 */
function serveStatic(req, res, rootDir, urlPath, opts = {}) {
  const file = resolveStaticPath(rootDir, urlPath);
  if (!file) {
    sendText(res, 403, 'forbidden');
    return true;
  }
  let stat;
  try {
    stat = fs.statSync(file);
  } catch (e) {
    return false;
  }
  if (!stat.isFile()) return false;

  const ext = path.extname(file).toLowerCase();
  res.writeHead(200, {
    'Content-Type': MIME[ext] || 'application/octet-stream',
    'Content-Length': stat.size,
    // No build step: the browser must revalidate after an edit, so assets are not cached long.
    // 没有构建步骤：改动后浏览器必须重新校验，因此资源不做长缓存。
    'Cache-Control': opts.immutable ? 'public, max-age=31536000, immutable' : 'no-cache',
    'X-Content-Type-Options': 'nosniff',
  });
  if (String(req.method || 'GET').toUpperCase() === 'HEAD') {
    res.end();
    return true;
  }
  fs.createReadStream(file)
    .on('error', () => res.destroy())
    .pipe(res);
  return true;
}

/**
 * Write one server-sent event.
 * 写一条 SSE 事件。
 */
function sseWrite(res, event) {
  res.write(`data: ${JSON.stringify(event)}\n\n`);
}

module.exports = {
  MIME,
  BODY_LIMIT,
  sendJson,
  sendText,
  readJsonBody,
  resolveStaticPath,
  serveStatic,
  sseWrite,
};
