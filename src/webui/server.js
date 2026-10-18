'use strict';

/**
 * The web UI server: one http.Server that serves the single-page app, the JSON API, the SSE event
 * stream and the static assets.
 *
 * Bound to 127.0.0.1 by default: this UI can download files, read the library and rewrite
 * config.json, so it is a local tool, not a hosted service.
 *
 *
 * Web UI 服务器：一个 http.Server 同时提供单页应用、JSON API、SSE 事件流与静态资源。
 *
 * 默认只监听 127.0.0.1：这个界面能下载文件、读取模型库、改写 config.json，
 * 它是本地工具，不是对外服务。
 */

const http = require('http');
const path = require('path');

const { loadConfig } = require('../config');
const { configureRuntime } = require('../runtime');
const { setLogSink } = require('../util');
const { t } = require('../i18n');
const { createJobs } = require('./jobs');
const { createActions } = require('./actions');
const { createApiHandler } = require('./api');
const { serveStatic, sendJson, sendText, sseWrite } = require('./http');

/**
 * Directory holding the frontend files.
 * 前端文件所在目录。
 */
const PUBLIC_DIR = path.join(__dirname, 'public');

/**
 * How often an SSE keep-alive comment is written (proxies and browsers close idle streams).
 * SSE 心跳间隔（代理与浏览器会关闭空闲连接）。
 */
const SSE_PING_MS = 20000;

/**
 * Default listen address and port.
 * 默认监听地址与端口。
 */
const DEFAULT_HOST = '127.0.0.1';
const DEFAULT_PORT = 4310;

/**
 * Hosts accepted in the Origin header (the server only listens on loopback).
 * Origin 头允许的主机（服务器只监听回环地址）。
 */
function isLoopbackHost(host) {
  const name = String(host || '').split(':')[0].replace(/^\[|\]$/g, '');
  return name === 'localhost' || name === '127.0.0.1' || name === '::1' || name === '0.0.0.0';
}

/**
 * Create the web UI server (not listening yet).
 * 创建 Web UI 服务器（尚未开始监听）。
 *
 * @param {{
 *   config?:object,
 *   host?:string,
 *   log?:(line:string)=>void,
 *   publicDir?:string,
 *   loadConfig?:() => object
 * }} [opts]
 * @returns {{server:import('http').Server, actions:object, jobs:object, start:(opts?:object)=>Promise<{url:string, port:number}>, stop:()=>Promise<void>}}
 */
function createWebServer(opts = {}) {
  const config = opts.config || loadConfig();
  configureRuntime(config);

  // Connected SSE clients.
  // 已连接的 SSE 客户端。
  const clients = new Set();
  const jobs = createJobs({
    emit: (event) => {
      for (const client of clients) {
        try {
          sseWrite(client.res, event);
        } catch (e) {
          clients.delete(client);
        }
      }
    },
  });

  const actions = createActions({
    config,
    jobs,
    loadConfig: typeof opts.loadConfig === 'function' ? opts.loadConfig : undefined,
  });
  const publicDir = opts.publicDir || PUBLIC_DIR;

  // Modules that log through the shared sink (browser startup, curl checks) land in the running
  // job's stream; with no job running the line goes to the server terminal.
  //
  // 通过共享日志出口输出的模块（浏览器启动、curl 检查）会进入正在运行任务的日志流；
  // 没有任务在跑时则输出到服务器终端。
  setLogSink((line) => {
    if (!jobs.note(line)) console.log(line);
  });

  const handleApi = createApiHandler({
    actions,
    jobs,
    onError: (error) => {
      if (opts.log) opts.log(`[web] ${error && error.stack ? error.stack : error}`);
    },
  });

  /**
   * Serve the SPA shell for unknown non-API paths (the client uses hash routing).
   * 未知的非 API 路径返回单页应用外壳（前端使用 hash 路由）。
   */
  function serveShell(req, res) {
    if (!serveStatic(req, res, publicDir, '/index.html')) {
      sendText(res, 500, 'index.html is missing from src/webui/public');
    }
  }

  /**
   * Guard mutating requests: same origin and a JSON content type.
   *
   * A cross-site HTML form can send a POST with a simple content type, but it cannot set
   * `application/json`, so requiring it (plus a matching Origin when one is present) closes the
   * CSRF hole of a localhost service without needing tokens.
   *
   *
   * 保护写请求：同源且内容类型为 JSON。
   *
   * 跨站 HTML 表单可以发简单类型的 POST，但设不了 `application/json`；
   * 因此要求该类型（并在带了 Origin 时校验同源）即可堵住 localhost 服务的 CSRF 口子，无需令牌。
   */
  function guardMutation(req, res) {
    const method = String(req.method || 'GET').toUpperCase();
    if (method === 'GET' || method === 'HEAD') return true;

    const origin = req.headers.origin;
    if (origin) {
      let originHost = '';
      try {
        originHost = new URL(origin).host;
      } catch (e) {
        originHost = '';
      }
      const hostHeader = String(req.headers.host || '');
      if (originHost !== hostHeader && !isLoopbackHost(originHost.split(':')[0])) {
        sendJson(res, 403, { error: t('web.error.crossOrigin') });
        return false;
      }
    }

    const type = String(req.headers['content-type'] || '');
    if (!/^application\/json\b/i.test(type)) {
      sendJson(res, 415, { error: t('web.error.contentType') });
      return false;
    }
    return true;
  }

  const server = http.createServer(async (req, res) => {
    const url = new URL(req.url || '/', 'http://localhost');

    // Server-sent events: one long-lived response per tab.
    // 服务端事件流：每个标签页一个长连接。
    if (url.pathname === '/api/events') {
      if (String(req.method || 'GET').toUpperCase() !== 'GET') {
        sendJson(res, 405, { error: 'method not allowed' });
        return;
      }
      res.writeHead(200, {
        'Content-Type': 'text/event-stream; charset=utf-8',
        'Cache-Control': 'no-store',
        Connection: 'keep-alive',
        'X-Accel-Buffering': 'no',
      });
      res.write(': connected\n\n');
      const client = { res };
      clients.add(client);
      // Send the current job state immediately so a reloaded tab does not miss a running job.
      // 立刻发送当前任务状态，刷新后的标签页不会漏掉正在跑的任务。
      const active = jobs.active();
      if (active) sseWrite(res, { type: 'job', job: active });
      for (const job of jobs.list()) {
        if (job.status === 'running' || job.id === (active && active.id)) continue;
        sseWrite(res, { type: 'job', job });
      }

      const ping = setInterval(() => {
        try {
          res.write(': ping\n\n');
        } catch (e) {
          clearInterval(ping);
        }
      }, SSE_PING_MS);
      if (typeof ping.unref === 'function') ping.unref();

      const close = () => {
        clearInterval(ping);
        clients.delete(client);
      };
      req.on('close', close);
      res.on('close', close);
      res.on('error', close);
      return;
    }

    if (url.pathname.startsWith('/api/')) {
      if (!guardMutation(req, res)) return;
      const handled = await handleApi(req, res);
      if (!handled) sendJson(res, 404, { error: 'not found' });
      return;
    }

    // Static assets, then the SPA shell.
    // 先找静态资源，再回落到单页应用外壳。
    if (url.pathname === '/' || url.pathname === '') {
      serveShell(req, res);
      return;
    }
    if (serveStatic(req, res, publicDir, url.pathname)) return;
    // A missing asset (has an extension) is a real 404; anything else is a client route.
    // 带扩展名的缺失资源是真正的 404；其余视为前端路由。
    if (path.extname(url.pathname)) {
      sendText(res, 404, `not found: ${url.pathname}`);
      return;
    }
    serveShell(req, res);
  });

  /**
   * Start listening. Resolves with the URL to open.
   * 开始监听，返回要打开的 URL。
   */
  function start(startOpts = {}) {
    const host = startOpts.host || opts.host || DEFAULT_HOST;
    const port = Number(startOpts.port === undefined ? DEFAULT_PORT : startOpts.port);
    return new Promise((resolve, reject) => {
      const onError = (error) => {
        server.removeListener('error', onError);
        reject(error);
      };
      server.once('error', onError);
      server.listen(port, host, () => {
        server.removeListener('error', onError);
        const address = server.address();
        const actualPort = address && typeof address === 'object' ? address.port : port;
        resolve({ url: `http://${host}:${actualPort}/`, port: actualPort, host });
      });
    });
  }

  /**
   * Stop listening and drop the event streams.
   * 停止监听并断开事件流。
   */
  function stop() {
    for (const client of clients) {
      try {
        client.res.end();
      } catch (e) {
        // ignore
        // 忽略
      }
    }
    clients.clear();
    return new Promise((resolve) => {
      if (!server.listening) {
        resolve();
        return;
      }
      server.close(() => resolve());
    });
  }

  // Errors thrown by the request handler itself (not by an action) must not kill the server.
  // 请求处理本身抛出的错误（不是业务动作抛的）不能让服务器退出。
  server.on('clientError', (error, socket) => {
    try {
      socket.destroy();
    } catch (e) {
      // ignore
      // 忽略
    }
  });

  return { server, actions, jobs, start, stop, publicDir };
}

module.exports = { createWebServer, PUBLIC_DIR, DEFAULT_HOST, DEFAULT_PORT, isLoopbackHost };
