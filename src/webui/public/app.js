'use strict';

/**
 * civitai-downloader web UI (vanilla JavaScript, no build step).
 *
 * A small hash-routed single-page app: each tab renders one screen, the server exposes a JSON API,
 * and long actions are followed through `/api/events` so progress and logs stay live without
 * polling. The browser also downloads its own `web.*` dictionary from `/api/i18n`.
 *
 *
 * civitai-downloader Web UI（原生 JavaScript，无需构建）。
 *
 * 一个小的 hash 路由单页应用：每个标签页渲染一屏，服务器提供 JSON API，
 * 耗时操作通过 `/api/events` 跟踪，进度与日志无需轮询即可实时更新；
 * 文案表由浏览器从 `/api/i18n` 取用。
 */

// ---------------------------------------------------------------------------
// i18n + formatting
// 文案与格式化
// ---------------------------------------------------------------------------

// Active dictionary (only `web.*` keys, fetched from the server).
// 当前文案表（只有 `web.*` 键）。
let DICT = {};

// Active language tag.
// 当前语言标识。
let LANG = 'zh-CN';

// Translate one key, interpolating `{name}` placeholders.
// 取一条文案并插值 `{name}` 占位符。
function t(key, params) {
  const template = DICT[key] === undefined ? key : DICT[key];
  if (!params) return template;
  return String(template).replace(/\{(\w+)\}/g, (match, name) =>
    params[name] === undefined || params[name] === null ? match : String(params[name])
  );
}

// Translate the static markup marked with `data-i18n` / `data-i18n-title`.
// 翻译带 `data-i18n` / `data-i18n-title` 的静态标记。
function applyStaticI18n() {
  for (const node of document.querySelectorAll('[data-i18n]')) {
    node.textContent = t(node.getAttribute('data-i18n'));
  }
  for (const node of document.querySelectorAll('[data-i18n-title]')) {
    node.title = t(node.getAttribute('data-i18n-title'));
  }
  document.documentElement.lang = LANG;
}

// Bytes → human readable (KiB/MiB/GiB, matching the CLI).
// 字节数转可读大小（与命令行一致）。
function fmtBytes(bytes) {
  const n = Number(bytes);
  if (!Number.isFinite(n) || n <= 0) return '0 B';
  const units = ['B', 'KiB', 'MiB', 'GiB', 'TiB'];
  let value = n;
  let unit = 0;
  while (value >= 1024 && unit < units.length - 1) {
    value /= 1024;
    unit++;
  }
  const digits = unit === 0 ? 0 : value >= 100 ? 0 : value >= 10 ? 1 : 2;
  return `${value.toFixed(digits)} ${units[unit]}`;
}

// Milliseconds → `m:ss` or `h:mm:ss`.
// 毫秒转时长。
function fmtDuration(ms) {
  const total = Math.max(0, Math.round((Number(ms) || 0) / 1000));
  const hours = Math.floor(total / 3600);
  const minutes = Math.floor((total % 3600) / 60);
  const seconds = total % 60;
  const pad = (n) => String(n).padStart(2, '0');
  return hours > 0 ? `${hours}:${pad(minutes)}:${pad(seconds)}` : `${minutes}:${pad(seconds)}`;
}

// ISO date → local `YYYY-MM-DD HH:mm`, or a dash.
// ISO 时间转本地短格式，缺失时显示破折号。
function fmtDate(iso) {
  if (!iso) return '—';
  const date = new Date(iso);
  if (Number.isNaN(date.getTime())) return String(iso);
  const pad = (n) => String(n).padStart(2, '0');
  return `${date.getFullYear()}-${pad(date.getMonth() + 1)}-${pad(date.getDate())} ${pad(date.getHours())}:${pad(
    date.getMinutes()
  )}`;
}

// Percentage with one decimal.
// 百分比（保留一位小数）。
function fmtPercent(part, whole) {
  if (!whole) return '0%';
  return `${Math.min(100, (part / whole) * 100).toFixed(1)}%`;
}

// ---------------------------------------------------------------------------
// API client + events
// API 客户端与事件流
// ---------------------------------------------------------------------------

// Call the JSON API; a non-2xx answer throws an Error carrying the server message.
// 调用 JSON API；非 2xx 时抛出带服务器消息的 Error。
async function api(path, options = {}) {
  const method = options.method || 'GET';
  const init = { method, headers: {} };
  if (method !== 'GET') {
    init.headers['Content-Type'] = 'application/json';
    init.body = JSON.stringify(options.body === undefined ? {} : options.body);
  }
  const response = await fetch(path, init);
  const text = await response.text();
  let data = null;
  if (text) {
    try {
      data = JSON.parse(text);
    } catch (e) {
      data = { error: text };
    }
  }
  if (!response.ok) {
    const error = new Error((data && data.error) || `HTTP ${response.status}`);
    error.status = response.status;
    throw error;
  }
  return data === null ? {} : data;
}

// Small client-side cache so tabs do not refetch everything on every visit.
// 前端小缓存：切标签页时不必每次全量重取。
const store = { state: null, library: null };

// Load `/api/state` (force = ignore the cache).
// 读取 `/api/state`（force 表示忽略缓存）。
async function loadState(force = false) {
  if (!force && store.state) return store.state;
  store.state = await api('/api/state');
  return store.state;
}

// Load the library list (cached).
// 读取模型库列表（带缓存）。
async function loadLibrary(force = false) {
  if (!force && store.library) return store.library;
  store.library = await api('/api/library?sort=name');
  return store.library;
}

// Invalidate caches after a mutation.
// 数据变更后清空缓存。
function invalidate() {
  store.state = null;
  store.library = null;
}

// Live event stream.
// 实时事件流。
let events = null;

// Connect `/api/events`, reconnecting with a backoff when the server restarts.
// 连接 `/api/events`，服务器重启后带退避自动重连。
function connectEvents() {
  if (events) events.close();
  let retry = 1000;
  const open = () => {
    events = new EventSource('/api/events');
    events.onopen = () => {
      retry = 1000;
    };
    events.onmessage = (message) => {
      let event = null;
      try {
        event = JSON.parse(message.data);
      } catch (e) {
        return;
      }
      handleEvent(event);
    };
    events.onerror = () => {
      events.close();
      setTimeout(open, retry);
      retry = Math.min(retry * 2, 15000);
    };
  };
  open();
}

// ---------------------------------------------------------------------------
// Shared UI pieces
// 公共界面部件
// ---------------------------------------------------------------------------

// Tiny element builder: `h('div', {class:'x'}, child, …)`.
// 极简元素构造器。
function h(tag, props, ...children) {
  const node = document.createElement(tag);
  for (const [key, value] of Object.entries(props || {})) {
    if (value === undefined || value === null || value === false) continue;
    if (key === 'class') node.className = value;
    else if (key === 'text') node.textContent = String(value);
    else if (key === 'dataset') Object.assign(node.dataset, value);
    else if (key === 'style') Object.assign(node.style, value);
    else if (key.startsWith('on') && typeof value === 'function') node.addEventListener(key.slice(2), value);
    else node.setAttribute(key, value === true ? '' : String(value));
  }
  for (const child of children.flat()) {
    if (child === undefined || child === null || child === false) continue;
    node.append(child instanceof Node ? child : document.createTextNode(String(child)));
  }
  return node;
}

// Remove every child of a node.
// 清空节点。
function clear(node) {
  while (node.firstChild) node.removeChild(node.firstChild);
}

// Toast notification.
// 提示条。
function toast(message, kind = 'info') {
  const host = document.getElementById('toasts');
  if (!host) return;
  const node = h('div', { class: `toast ${kind}`, text: message });
  host.append(node);
  setTimeout(() => node.remove(), kind === 'fail' ? 9000 : 4500);
}

// Badge element.
// 徽标元素。
function badge(text, kind = 'muted') {
  return h('span', { class: `badge ${kind}`, text });
}

// Progress bar.
// 进度条。
function progressBar(percent, indeterminate) {
  const bar = h('div', { class: `bar${indeterminate ? ' indeterminate' : ''}` });
  bar.append(h('span', { style: { width: `${Math.max(0, Math.min(100, percent || 0))}%` } }));
  return bar;
}

// Render one table cell: a Node, a `{text, class, node}` cell, or a plain value.
// 渲染一个单元格：Node、`{text, class, node}` 或普通值。
function cellNode(cell) {
  if (cell instanceof Node) return h('td', {}, cell);
  if (cell && typeof cell === 'object' && ('text' in cell || 'node' in cell || 'class' in cell)) {
    const td = h('td', { class: cell.class });
    if (cell.node) td.append(cell.node);
    else td.textContent = cell.text === undefined || cell.text === null ? '' : String(cell.text);
    return td;
  }
  return h('td', { text: cell === undefined || cell === null ? '' : String(cell) });
}

// Table from headers + rows (cells support Nodes); an empty list renders a placeholder.
// 由表头与行数组生成表格（单元格支持 Node）；空列表显示占位提示。
function table(headers, rows, emptyText) {
  if (!rows.length) return h('div', { class: 'empty', text: emptyText || t('web.common.empty') });
  const headRow = h('tr', {});
  for (const header of headers) {
    const th = cellNode(header);
    const node = h('th', { class: th.className });
    node.append(...th.childNodes);
    headRow.append(node);
  }
  const body = h('tbody', {});
  for (const row of rows) {
    const tr = h('tr', { class: row.class });
    for (const cell of row.cells) tr.append(cellNode(cell));
    body.append(tr);
  }
  return h('div', { class: 'table-wrap' }, h('table', {}, h('thead', {}, headRow), body));
}

// Key/value definition list.
// 键值列表。
function kvList(pairs) {
  const dl = h('dl', { class: 'kv' });
  for (const [label, value] of pairs) {
    if (value === undefined || value === null || value === '') continue;
    dl.append(h('dt', { text: label }), h('dd', {}, value instanceof Node ? value : String(value)));
  }
  return dl;
}

// Panel with a header and an optional action row.
// 带标题与可选操作行的卡片。
function panel(title, actions, ...body) {
  const head = h('div', { class: 'panel-head' }, h('h2', { text: title }));
  const list = [actions].flat().filter(Boolean);
  if (list.length) {
    const right = h('div', { class: 'spacer' });
    for (const action of list) right.append(action);
    head.append(right);
  }
  return h('section', { class: 'panel' }, head, h('div', { class: 'panel-body' }, ...body));
}

// Modal dialog; `actions` are `{label, kind, onClick(close)}`. Returns a close function.
// 模态弹窗；`actions` 形如 `{label, kind, onClick(close)}`。返回关闭函数。
function openModal({ title, body, actions, width }) {
  const root = document.getElementById('modal-root');
  const close = () => {
    clear(root);
    document.removeEventListener('keydown', onKey);
  };
  const onKey = (event) => {
    if (event.key === 'Escape') close();
  };
  const content = h('div', { class: 'modal-body' }, ...[body].flat().filter(Boolean));
  const modal = h(
    'div',
    { class: 'modal', style: width ? { width } : {}, role: 'dialog', 'aria-modal': 'true' },
    h(
      'div',
      { class: 'modal-head' },
      h('h2', { text: title }),
      h('button', { class: 'icon-btn', type: 'button', onclick: close, 'aria-label': t('web.common.close') }, '✕')
    ),
    content,
    (actions || []).length
      ? h(
          'div',
          { class: 'modal-foot' },
          ...actions.map((action) =>
            h(
              'button',
              {
                class: `btn ${action.kind || ''}`,
                type: 'button',
                onclick: () => {
                  if (action.onClick) action.onClick(close);
                  else close();
                },
              },
              action.label
            )
          )
        )
      : null
  );
  const backdrop = h(
    'div',
    {
      class: 'modal-backdrop',
      onclick: (event) => {
        if (event.target === event.currentTarget) close();
      },
    },
    modal
  );
  clear(root);
  root.append(backdrop);
  document.addEventListener('keydown', onKey);
  return close;
}

// Ask a yes/no question in a modal; resolves null when the user cancels.
// 用弹窗询问是/否；用户取消时返回 null。
function confirmDialog({ title, message, confirmLabel, danger }) {
  return new Promise((resolve) => {
    let settled = false;
    const finish = (value) => {
      if (settled) return;
      settled = true;
      resolve(value);
    };
    openModal({
      title,
      body: h('p', { text: message }),
      actions: [
        {
          label: t('web.common.cancel'),
          onClick: (done) => {
            done();
            finish(null);
          },
        },
        {
          label: confirmLabel || t('web.common.confirm'),
          kind: danger ? 'danger' : 'primary',
          onClick: (done) => {
            done();
            finish(true);
          },
        },
      ],
    });
  });
}

// ---------------------------------------------------------------------------
// Job drawer
// 任务抽屉
// ---------------------------------------------------------------------------

// Followed job id.
// 当前跟踪的任务 id。
let currentJobId = null;

// Last status seen for the followed job (used to detect the terminal transition).
// 当前任务最后看到的状态（用于识别「刚刚结束」）。
let lastJobStatus = null;

// Per-call completion callback of the followed job.
// 当前任务的结束回调。
let jobCallback = null;

// Follow one job: reset the drawer and show it.
// 跟踪一个任务：重置并显示抽屉。
function followJob(job, onDone) {
  currentJobId = job.id;
  lastJobStatus = job.status;
  jobCallback = typeof onDone === 'function' ? onDone : null;
  document.getElementById('job-drawer').hidden = false;
  const log = document.getElementById('job-log');
  log.textContent = '';
  log.hidden = true;
  renderJob(job);
}

// Render the drawer from a job view.
// 用任务视图渲染抽屉。
function renderJob(job) {
  if (!job || job.id !== currentJobId) return;
  const statusKey =
    job.status === 'running'
      ? 'web.job.running'
      : job.status === 'done'
        ? 'web.job.done'
        : job.status === 'cancelled'
          ? 'web.job.cancelled'
          : 'web.job.failed';
  document.getElementById('job-title').textContent = job.title || job.kind;
  const status = document.getElementById('job-status');
  status.textContent = t(statusKey);
  status.className = `job-status ${job.status}`;
  document.getElementById('job-elapsed').textContent = fmtDuration(job.elapsedMs);
  document.getElementById('job-cancel').disabled = job.status !== 'running';
  renderJobProgress(job.progress, job.status);
}

// Render progress numbers (shared by full updates and streamed progress events).
// 渲染进度数字（整体更新与流式进度事件共用）。
function renderJobProgress(progress, status) {
  const progressNode = document.getElementById('job-progress');
  const metaNode = document.getElementById('job-meta');
  if (!progressNode || !metaNode) return;
  clear(progressNode);
  clear(metaNode);
  if (!progress) {
    if (status === 'running') progressNode.append(progressBar(0, true));
    return;
  }
  if (progress.phase === 'download') {
    progressNode.append(progressBar(progress.expected > 0 ? progress.percent : 0, !progress.expected));
    metaNode.append(
      h('span', { text: t('web.job.items', { done: progress.done, total: progress.total }) }),
      h('span', { text: `${fmtBytes(progress.bytes)} / ${fmtBytes(progress.expected)}` }),
      h('span', { text: fmtPercent(progress.bytes, progress.expected) }),
      progress.speed ? h('span', { text: `${fmtBytes(progress.speed)}/s` }) : null,
      progress.etaMs ? h('span', { text: t('web.job.eta', { eta: fmtDuration(progress.etaMs) }) }) : null,
      progress.failed
        ? h('span', { class: 'small', style: { color: 'var(--danger)' }, text: t('web.job.failedCount', { count: progress.failed }) })
        : null,
      progress.skipped ? h('span', { text: t('web.job.skippedCount', { count: progress.skipped }) }) : null
    );
    for (const running of progress.running || []) {
      metaNode.append(h('span', { class: 'nowrap', text: `▸ ${running.name} ${fmtBytes(running.bytes)}` }));
    }
  } else if (progress.phase === 'verify') {
    progressNode.append(progressBar(((progress.index || 0) / Math.max(1, progress.total || 1)) * 100, false));
    metaNode.append(
      h('span', { text: `${progress.index || 0}/${progress.total || 0}` }),
      h('span', { text: progress.name || '' })
    );
  } else if (status === 'running') {
    progressNode.append(progressBar(0, true));
  }
}

// Append one streamed log line (only for the followed job).
// 追加一行流式日志（仅当前任务）。
function appendLog(event) {
  if (event.jobId !== currentJobId) return;
  const log = document.getElementById('job-log');
  log.textContent += `${event.line}\n`;
  log.scrollTop = log.scrollHeight;
}

// Handle the terminal transition of the followed job: toast, callback, refresh.
// 处理当前任务的结束：提示、回调、刷新。
function finishJob(job) {
  renderJob(job);
  const callback = jobCallback;
  jobCallback = null;
  if (job.status === 'failed') toast(`${t('web.job.failed')}: ${job.error || ''}`, 'fail');
  else if (job.status === 'cancelled') toast(t('web.job.cancelled'), 'warn');
  else if (job.result && job.result.done !== undefined) {
    toast(
      t('web.job.finishedSummary', {
        done: job.result.done || 0,
        skipped: job.result.skipped || 0,
        failed: job.result.failed || 0,
      }),
      job.result.failed ? 'warn' : 'ok'
    );
  } else {
    toast(t('web.job.finished'), 'ok');
  }
  if (callback) {
    try {
      callback(job);
    } catch (e) {
      toast(e.message, 'fail');
    }
  }
  invalidate();
  if (job.kind !== 'plan') route();
}

// Dispatch one SSE event.
// 分发一条 SSE 事件。
function handleEvent(event) {
  if (!event || !event.type) return;
  if (event.type === 'log') {
    appendLog(event);
    return;
  }
  if (event.type === 'progress') {
    if (event.jobId === currentJobId) renderJobProgress(event.progress, 'running');
    return;
  }
  if (event.type !== 'job' || !event.job) return;
  const job = event.job;
  if (job.id === currentJobId) {
    const wasRunning = lastJobStatus === 'running';
    lastJobStatus = job.status;
    if (job.status === 'running') renderJob(job);
    else if (wasRunning) finishJob(job);
    else renderJob(job);
    return;
  }
  // Another tab started a job: follow it so its progress is visible here too.
  // 别的标签页启动的任务：跟随它，让进度在这里也可见。
  if (job.status === 'running') followJob(job);
}

// Start a request that returns `{job}` and follow it.
// 发起返回 `{job}` 的请求并跟踪。
async function runJob(request, onDone) {
  try {
    const response = await request();
    const job = response && response.job;
    if (!job) {
      toast(t('web.error.noJob'), 'fail');
      return;
    }
    followJob(job, onDone);
  } catch (error) {
    toast(error.message, 'fail');
  }
}

// Cancel the followed job.
// 取消当前任务。
async function cancelJob() {
  if (!currentJobId) return;
  try {
    await api(`/api/jobs/${encodeURIComponent(currentJobId)}/cancel`, { method: 'POST', body: {} });
  } catch (error) {
    toast(error.message, 'warn');
  }
}

// ---------------------------------------------------------------------------
// Router
// 路由
// ---------------------------------------------------------------------------

// Tabs of the navigation.
// 导航标签。
const TABS = [
  { key: 'dashboard', hash: '#/', label: 'web.nav.dashboard', view: () => renderDashboard() },
  { key: 'download', hash: '#/download', label: 'web.nav.download', view: () => renderDownload() },
  { key: 'library', hash: '#/library', label: 'web.nav.library', view: () => renderLibrary() },
  { key: 'check', hash: '#/check', label: 'web.nav.check', view: () => renderCheck() },
  { key: 'verify', hash: '#/verify', label: 'web.nav.verify', view: () => renderVerify() },
  { key: 'settings', hash: '#/settings', label: 'web.nav.settings', view: () => renderSettings() },
  { key: 'login', hash: '#/login', label: 'web.nav.login', view: () => renderLogin() },
  { key: 'help', hash: '#/help', label: 'web.nav.help', view: () => renderHelp() },
];

// Render the navigation bar.
// 渲染导航栏。
function renderNav() {
  const nav = document.getElementById('nav');
  clear(nav);
  for (const tab of TABS) nav.append(h('a', { href: tab.hash, text: t(tab.label), dataset: { tab: tab.key } }));
  markActiveNav();
}

// Highlight the current tab.
// 高亮当前标签。
function markActiveNav() {
  const hash = location.hash || '#/';
  const clean = hash.split('?')[0];
  const active = TABS.find((tab) => tab.hash === clean) || TABS[0];
  for (const link of document.querySelectorAll('#nav a')) {
    link.classList.toggle('active', link.dataset.tab === active.key);
  }
}

// Render the current screen.
// 渲染当前界面。
async function route() {
  const hash = location.hash || '#/';
  const clean = hash.split('?')[0];
  const tab = TABS.find((item) => item.hash === clean) || TABS[0];
  markActiveNav();
  const view = document.getElementById('view');
  try {
    await tab.view();
  } catch (error) {
    clear(view);
    view.append(h('h1', { text: t('web.error.title') }), h('p', { class: 'subtitle', text: error.message }));
  }
}

// Replace the view with a title, an optional subtitle and the given content.
// 用标题、可选副标题与给定内容替换视图。
function showScreen(titleKey, subtitleKey, ...content) {
  const view = document.getElementById('view');
  clear(view);
  view.append(h('h1', { text: t(titleKey) }));
  if (subtitleKey) view.append(h('p', { class: 'subtitle', text: t(subtitleKey) }));
  for (const node of content.flat()) if (node) view.append(node);
  view.focus({ preventScroll: true });
}

// ---------------------------------------------------------------------------
// Dashboard
// 仪表盘
// ---------------------------------------------------------------------------

// Header pill + version.
// 顶栏状态与版本号。
function updateHeader(state) {
  const pill = document.getElementById('login-pill');
  if (pill && state) {
    pill.hidden = false;
    pill.textContent = state.loggedIn ? t('web.dash.loggedIn') : t('web.dash.notLoggedIn');
    pill.className = `pill ${state.loggedIn ? 'ok' : 'fail'}`;
  }
  const version = document.getElementById('app-version');
  if (version && state) version.textContent = state.appVersion ? `v${state.appVersion}` : '';
}

// One dashboard card.
// 仪表盘卡片。
function card(label, value, hint) {
  return h(
    'div',
    { class: 'card' },
    h('div', { class: 'label', text: label }),
    h('div', { class: 'value' }, value instanceof Node ? value : String(value)),
    hint ? h('div', { class: 'hint', text: hint }) : null
  );
}

// Dashboard: configuration, library, collection snapshots and environment tools.
// 仪表盘：配置、模型库、收藏集快照与环境工具。
async function renderDashboard() {
  const state = await loadState(true);
  updateHeader(state);
  const cards = h(
    'div',
    { class: 'cards' },
    card(t('web.dash.site'), state.site),
    card(
      t('web.dash.outDir'),
      state.outDir,
      state.disk && state.disk.free !== null ? t('web.dash.free', { size: fmtBytes(state.disk.free) }) : null
    ),
    card(
      t('web.dash.login'),
      badge(state.loggedIn ? t('web.dash.loggedIn') : t('web.dash.notLoggedIn'), state.loggedIn ? 'ok' : 'warn')
    ),
    card(
      t('web.dash.library'),
      t('web.dash.libraryValue', { models: state.library.models, versions: state.library.versions }),
      fmtBytes(state.library.bytes)
    ),
    card(t('web.dash.concurrency'), String(state.jobs), t('web.dash.engine', { engine: state.engine })),
    card(t('web.dash.runtime'), `Node ${state.node}`, state.platform)
  );

  const collections = state.collections || [];
  const collectionsTable = table(
    [
      t('web.dash.collectionId'),
      { text: t('web.dash.members'), class: 'num' },
      t('web.dash.fetchedAt'),
      t('web.dash.changes'),
      '',
    ],
    collections.map((collection) => ({
      cells: [
        { text: collection.id, class: 'mono' },
        { text: collection.members, class: 'num' },
        { text: fmtDate(collection.fetchedAt) },
        { text: t('web.dash.changesValue', collection.changes) },
        {
          node: h('button', {
            class: 'small',
            type: 'button',
            text: t('web.dash.openInDownload'),
            onclick: () => {
              location.hash = `#/download?collection=${encodeURIComponent(collection.id)}`;
            },
          }),
        },
      ],
    })),
    t('web.dash.noCollections')
  );
  // Clicking a row opens the snapshot detail (members + what changed).
  // 点击整行打开快照详情（成员 + 变化）。
  const collectionRows = collectionsTable.querySelectorAll('tbody tr');
  collections.forEach((collection, index) => {
    if (collectionRows[index]) collectionRows[index].addEventListener('click', () => showCollection(collection.id));
  });

  const doctorButton = h('button', {
    type: 'button',
    text: t('web.dash.doctor'),
    onclick: () => showDoctor(),
  });
  const sessionButton = h('button', {
    type: 'button',
    text: t('web.dash.checkSession'),
    onclick: async () => {
      try {
        const result = await api('/api/login/check', { method: 'POST', body: {} });
        toast(
          result.ok ? t('web.dash.sessionOk') : t('web.dash.sessionBad', { reason: result.reason }),
          result.ok ? 'ok' : 'warn'
        );
      } catch (error) {
        toast(error.message, 'fail');
      }
    },
  });
  const openButton = h('button', {
    type: 'button',
    text: t('web.dash.openDir'),
    onclick: async () => {
      try {
        await api('/api/open', { method: 'POST', body: {} });
      } catch (error) {
        toast(error.message, 'fail');
      }
    },
  });

  showScreen(
    'web.dash.title',
    'web.dash.subtitle',
    cards,
    state.library.corrupt
      ? h('p', { class: 'small', style: { color: 'var(--danger)' }, text: state.library.corrupt })
      : null,
    (state.warnings || []).length
      ? h('ul', { class: 'plain small' }, ...state.warnings.map((warning) => h('li', { text: warning })))
      : null,
    panel(
      t('web.dash.collections'),
      h('button', {
        class: 'small',
        type: 'button',
        text: t('web.common.refresh'),
        onclick: () => {
          invalidate();
          route();
        },
      }),
      collectionsTable
    ),
    panel(
      t('web.dash.tools'),
      null,
      h('div', { class: 'inline' }, doctorButton, sessionButton, openButton),
      h('div', { class: 'hr' }),
      kvList([
        [t('web.dash.configFile'), h('span', { class: 'mono', text: state.configFile || 'config.json' })],
        [t('web.dash.root'), h('span', { class: 'mono', text: state.root })],
        [t('web.dash.version'), state.appVersion || '—'],
      ])
    )
  );
}

// Environment check in a modal.
// 弹窗形式的环境体检。
async function showDoctor() {
  const loading = openModal({
    title: t('web.dash.doctor'),
    body: h('div', { class: 'loading', text: t('web.common.loading') }),
  });
  let report;
  try {
    report = await api('/api/doctor', { method: 'POST', body: { deep: true } });
  } catch (error) {
    loading();
    toast(error.message, 'fail');
    return;
  }
  loading();
  openModal({
    title: t('web.dash.doctor'),
    body: h(
      'div',
      { class: 'stack' },
      ...report.items.map((item) =>
        h(
          'div',
          { class: 'inline' },
          badge(
            item.status === 'ok' ? 'OK' : item.status === 'warn' ? 'WARN' : 'FAIL',
            item.status === 'ok' ? 'ok' : item.status === 'warn' ? 'warn' : 'fail'
          ),
          h('strong', { text: item.name }),
          h('span', { class: 'muted', text: item.detail }),
          item.hint ? h('span', { class: 'small muted', text: `— ${item.hint}` }) : null
        )
      )
    ),
  });
}

// Collection snapshot detail: members, what changed, and a reset for the changed records.
// 收藏集快照详情：成员、变化，以及重置变化项的记录。
async function showCollection(collectionId) {
  const loading = openModal({
    title: t('web.dash.collectionTitle', { id: collectionId }),
    body: h('div', { class: 'loading', text: t('web.common.loading') }),
  });
  let detail;
  try {
    detail = await api(`/api/collections/${encodeURIComponent(collectionId)}`);
  } catch (error) {
    loading();
    toast(error.message, 'fail');
    return;
  }
  loading();

  // Renders one "change kind" block: a title and its entries.
  // 渲染一块变化：标题 + 条目。
  const changeBlock = (title, entries) =>
    h(
      'div',
      { class: 'stack' },
      h('strong', { class: 'small', text: `${title} (${entries.length})` }),
      entries.length
        ? h('ul', { class: 'plain small' }, ...entries.map((item) => h('li', { text: `${item.name || `#${item.modelId}`}${item.versionId ? ` · v${item.versionId}` : ''}` })))
        : h('p', { class: 'small muted', text: t('web.common.empty') })
    );

  const changes = detail.changes;
  const changed = changes.added.concat(changes.versionChanged);
  const resetButton = changed.length
    ? h('button', {
        class: 'danger',
        type: 'button',
        text: t('web.dash.resetChanges'),
        onclick: async () => {
          try {
            const result = await api('/api/models/reset', {
              method: 'POST',
              body: { items: changed.map((item) => ({ modelId: item.modelId, versionId: item.versionId })) },
            });
            toast(t('web.dash.resetDone', { count: result.reset || 0 }), 'ok');
          } catch (error) {
            toast(error.message, 'fail');
          }
        },
      })
    : null;

  openModal({
    title: t('web.dash.collectionTitle', { id: detail.id }),
    body: [
      h(
        'p',
        { class: 'small' },
        [
          t('web.dash.snapshotAt', { time: fmtDate(detail.fetchedAt) }),
          detail.previousFetchedAt
            ? t('web.dash.previousAt', { time: fmtDate(detail.previousFetchedAt) })
            : t('web.dash.firstSnapshot'),
          `${t('web.dash.members')}: ${detail.count}`,
        ].join(' · ')
      ),
      h('div', { class: 'hr' }),
      detail.members.length
        ? changeBlock(t('web.dash.membersTitle'), detail.members)
        : h('p', { class: 'small muted', text: t('web.common.empty') }),
      h('div', { class: 'hr' }),
      h(
        'div',
        { class: 'stack' },
        changeBlock(t('web.dash.changeAdded'), changes.added),
        changeBlock(t('web.dash.changeVersion'), changes.versionChanged),
        changeBlock(t('web.dash.changeRemoved'), changes.removed)
      ),
      h('p', { class: 'small muted', text: changed.length ? '' : t('web.dash.noChanges') }),
    ],
    actions: [resetButton, { label: t('web.common.close') }].filter(Boolean),
  });
}

// ---------------------------------------------------------------------------
// Download
// 下载
// ---------------------------------------------------------------------------

// Persistent state of the download screen.
// 下载页的持久状态。
const dl = {
  collectionId: '',
  refs: '',
  plan: null,
  selected: new Set(),
  overrides: new Map(),
  q: '',
  type: '',
  base: '',
  sort: 'name',
  outDir: null,
  jobs: null,
  force: false,
};

// Filter + sort the current plan.
// 过滤与排序当前计划。
function visiblePlan() {
  if (!dl.plan) return [];
  const q = String(dl.q || '').trim().toLowerCase();
  let list = dl.plan.items.filter((item) => {
    if (q && !`${item.name || ''} ${item.modelId}`.toLowerCase().includes(q)) return false;
    if (dl.type && item.type !== dl.type) return false;
    if (dl.base && item.baseModel !== dl.base) return false;
    return true;
  });
  if (dl.sort === 'size') list = list.slice().sort((a, b) => (b.totalBytes || 0) - (a.totalBytes || 0));
  else if (dl.sort === 'size-asc') list = list.slice().sort((a, b) => (a.totalBytes || 0) - (b.totalBytes || 0));
  else if (dl.sort === 'name') list = list.slice().sort((a, b) => String(a.name || '').localeCompare(String(b.name || '')));
  return list;
}

// Sort dropdown.
// 排序下拉框。
function sortSelect(current, onChange) {
  const options = [
    ['name', 'web.common.sortName'],
    ['size', 'web.common.sortSizeDesc'],
    ['size-asc', 'web.common.sortSizeAsc'],
    ['default', 'web.common.sortDefault'],
  ];
  return h(
    'select',
    {
      onchange: (event) => onChange(event.target.value),
    },
    ...options.map(([value, key]) => h('option', { value, selected: current === value, text: t(key) }))
  );
}

// Version picker modal for one plan item; `onPick` receives `{versionId, versionName}`.
// 单个计划项的版本选择；`onPick` 收到 `{versionId, versionName}`。
async function pickVersion(item, onPick) {
  const loading = openModal({
    title: t('web.dl.chooseVersionTitle', { name: item.name || item.modelId }),
    body: h('div', { class: 'loading', text: t('web.common.loading') }),
  });
  let data;
  try {
    data = await api('/api/models/versions', { method: 'POST', body: { modelIds: [item.modelId] } });
  } catch (error) {
    loading();
    toast(error.message, 'fail');
    return;
  }
  loading();
  const model = (data.models || [])[0];
  if (!model || !model.versions.length) {
    toast(t('web.dl.noVersions'), 'warn');
    return;
  }
  let picked = String(item.versionId || '');
  const list = h('div', { class: 'stack' });
  for (const version of model.versions) {
    list.append(
      h(
        'label',
        { class: 'checkbox' },
        h('input', {
          type: 'radio',
          name: 'version',
          checked: picked === version.versionId,
          onchange: () => {
            picked = version.versionId;
          },
        }),
        h('span', {}, h('strong', { text: version.versionName || version.versionId }), ' '),
        h('span', {
          class: 'small muted',
          text: `${version.baseModel || '—'} · ${t('web.dl.fileCount', { count: version.files })} · ${fmtBytes(
            version.bytes
          )} · ${fmtDate(version.publishedAt)}`,
        })
      )
    );
  }
  openModal({
    title: t('web.dl.chooseVersionTitle', { name: item.name || item.modelId }),
    body: list,
    actions: [
      { label: t('web.common.cancel') },
      {
        label: t('web.common.confirm'),
        kind: 'primary',
        onClick: (done) => {
          const version = model.versions.find((v) => v.versionId === picked);
          done();
          if (version) onPick({ versionId: version.versionId, versionName: version.versionName || version.versionId });
        },
      },
    ],
  });
}

// Ask the server to enumerate a collection and build the plan.
// 请求服务器枚举收藏集并生成计划。
async function loadPlan() {
  const match = String(dl.collectionId || '').match(/(\d{2,})/);
  if (!match) {
    toast(t('web.dl.badId'), 'warn');
    return;
  }
  dl.collectionId = match[1];
  await runJob(() => api('/api/collections/plan', { method: 'POST', body: { collectionId: dl.collectionId } }), (job) => {
    if (job.status !== 'done' || !job.result) return;
    dl.plan = job.result;
    dl.selected = new Set(job.result.items.filter((item) => !item.recorded && !item.error).map((item) => String(item.modelId)));
    dl.overrides = new Map();
    route();
  });
}

// Download screen.
// 下载界面。
async function renderDownload() {
  const state = await loadState();
  updateHeader(state);
  if (dl.outDir === null) dl.outDir = state.outDir;
  if (dl.jobs === null) dl.jobs = state.jobs;

  const params = new URLSearchParams(location.hash.split('?')[1] || '');
  const preset = params.get('collection');
  if (preset && preset !== dl.collectionId) {
    dl.collectionId = preset;
    dl.plan = null;
    dl.selected = new Set();
    dl.overrides = new Map();
  }

  const collectionInput = h('input', {
    type: 'text',
    value: dl.collectionId || '',
    placeholder: t('web.dl.collectionPlaceholder'),
    oninput: (event) => {
      dl.collectionId = event.target.value;
    },
  });

  const sourcePanel = panel(
    t('web.dl.source'),
    null,
    h(
      'div',
      { class: 'row' },
      h('label', { class: 'field grow' }, h('span', { text: t('web.dl.collectionId') }), collectionInput),
      h('button', { class: 'primary', type: 'button', text: t('web.dl.load'), onclick: loadPlan })
    ),
    h('p', { class: 'small muted', text: t('web.dl.sourceHint') })
  );

  // Single models: the same references the CLI and TUI accept, resolved server-side.
  // 单个模型：与 CLI / TUI 相同的引用语法，由服务端解析。
  const singlePanel = (() => {
    const area = h('textarea', { rows: '3', placeholder: t('web.dl.singlePlaceholder') });
    area.value = dl.refs;
    area.addEventListener('input', () => {
      dl.refs = area.value;
    });
    const button = h('button', {
      class: 'primary',
      type: 'button',
      text: t('web.dl.singleStart'),
      onclick: () => {
        const refs = dl.refs
          .split(/[\r\n,]+/)
          .map((piece) => piece.trim())
          .filter(Boolean);
        if (!refs.length) {
          toast(t('web.dl.singleEmpty'), 'warn');
          return;
        }
        runJob(
          () => api('/api/download', { method: 'POST', body: { refs, outDir: dl.outDir, jobs: dl.jobs } }),
          (job) => {
            if (job.status !== 'done') return;
            dl.refs = '';
            area.value = '';
          }
        );
      },
    });
    return panel(t('web.dl.singleTitle'), button, h('label', { class: 'field' }, area), h('p', { class: 'small muted', text: t('web.dl.singleHint') }));
  })();

  if (!dl.plan) {
    showScreen('web.dl.title', 'web.dl.subtitle', sourcePanel, singlePanel);
    // A link from the dashboard arrives with `?collection=<id>`: load it right away.
    // 从仪表盘跳过来会带 `?collection=<id>`：直接开始加载。
    if (preset) await loadPlan();
    return;
  }

  const plan = dl.plan;
  const tableHost = h('div');
  const summary = h('div', { class: 'small muted' });

  const refreshSummary = () => {
    const chosen = plan.items.filter((item) => dl.selected.has(String(item.modelId)));
    const bytes = chosen.reduce((sum, item) => sum + (item.totalBytes || 0), 0);
    summary.textContent = t('web.dl.summary', {
      selected: chosen.length,
      total: plan.items.length,
      size: fmtBytes(bytes),
    });
  };

  const refreshTable = () => {
    clear(tableHost);
    tableHost.append(
      table(
        [
          '',
          t('web.dl.columnName'),
          t('web.dl.columnType'),
          t('web.dl.columnBase'),
          t('web.dl.columnVersion'),
          { text: t('web.dl.columnFiles'), class: 'num' },
          { text: t('web.dl.columnSize'), class: 'num' },
          t('web.dl.columnState'),
          '',
        ],
        visiblePlan().map((item) => {
          const id = String(item.modelId);
          const override = dl.overrides.get(id);
          const tags = [];
          if (item.error) tags.push(badge(t('web.dl.metaFailed'), 'fail'));
          if (item.recorded) tags.push(badge(t('web.dl.recorded'), 'ok'));
          else if (item.hasRecord) tags.push(badge(t('web.dl.updateAvailable'), 'warn'));
          if (item.pinned) tags.push(badge(t('web.dl.pinned'), 'info'));
          return {
            cells: [
              {
                node: h('input', {
                  type: 'checkbox',
                  checked: dl.selected.has(id),
                  disabled: !!item.error,
                  onchange: (event) => {
                    if (event.target.checked) dl.selected.add(id);
                    else dl.selected.delete(id);
                    refreshSummary();
                  },
                }),
              },
              { text: item.name || `#${id}`, class: 'name' },
              { text: item.type || '—' },
              { text: item.baseModel || '—' },
              { text: override ? override.versionName : item.versionName || String(item.versionId || '—'), class: 'mono' },
              { text: item.error ? '—' : t('web.dl.fileCount', { count: (item.files || []).length }), class: 'num' },
              { text: item.error ? '—' : fmtBytes(item.totalBytes), class: 'num' },
              { node: h('div', { class: 'inline' }, ...tags) },
              {
                node: h('button', {
                  class: 'small ghost',
                  type: 'button',
                  text: t('web.dl.chooseVersion'),
                  onclick: () =>
                    pickVersion(item, (choice) => {
                      dl.overrides.set(id, choice);
                      dl.selected.add(id);
                      refreshTable();
                    }),
                }),
              },
            ],
          };
        }),
        t('web.dl.noItems')
      )
    );
    refreshSummary();
  };

  const selectAll = h('button', {
    class: 'small',
    type: 'button',
    text: t('web.common.selectAll'),
    onclick: () => {
      for (const item of visiblePlan()) if (!item.error) dl.selected.add(String(item.modelId));
      refreshTable();
    },
  });
  const selectNone = h('button', {
    class: 'small',
    type: 'button',
    text: t('web.common.selectNone'),
    onclick: () => {
      dl.selected.clear();
      refreshTable();
    },
  });
  const selectNew = h('button', {
    class: 'small',
    type: 'button',
    text: t('web.common.selectNew'),
    onclick: () => {
      dl.selected = new Set(plan.items.filter((item) => !item.recorded && !item.error).map((item) => String(item.modelId)));
      refreshTable();
    },
  });

  const typeOptions = [...new Set(plan.items.map((item) => item.type).filter(Boolean))].sort();
  const baseOptions = [...new Set(plan.items.map((item) => item.baseModel).filter(Boolean))].sort();

  const filters = h(
    'div',
    { class: 'row' },
    h(
      'label',
      { class: 'field grow' },
      h('span', { text: t('web.common.search') }),
      h('input', {
        type: 'text',
        value: dl.q,
        placeholder: t('web.dl.searchPlaceholder'),
        oninput: (event) => {
          dl.q = event.target.value;
          refreshTable();
        },
      })
    ),
    h(
      'label',
      { class: 'field' },
      h('span', { text: t('web.dl.type') }),
      h(
        'select',
        {
          onchange: (event) => {
            dl.type = event.target.value;
            refreshTable();
          },
        },
        h('option', { value: '', text: t('web.common.allTypes') }),
        ...typeOptions.map((value) => h('option', { value, selected: dl.type === value, text: value }))
      )
    ),
    h(
      'label',
      { class: 'field' },
      h('span', { text: t('web.dl.baseModel') }),
      h(
        'select',
        {
          onchange: (event) => {
            dl.base = event.target.value;
            refreshTable();
          },
        },
        h('option', { value: '', text: t('web.common.allBaseModels') }),
        ...baseOptions.map((value) => h('option', { value, selected: dl.base === value, text: value }))
      )
    ),
    h(
      'label',
      { class: 'field' },
      h('span', { text: t('web.common.sort') }),
      sortSelect(dl.sort, (value) => {
        dl.sort = value;
        refreshTable();
      })
    )
  );

  const outDirInput = h('input', {
    type: 'text',
    value: dl.outDir,
    oninput: (event) => {
      dl.outDir = event.target.value;
    },
  });
  const jobsSelect = h(
    'select',
    {
      onchange: (event) => {
        dl.jobs = Number(event.target.value);
      },
    },
    ...[1, 2, 3, 4].map((n) => h('option', { value: String(n), selected: Number(dl.jobs) === n, text: String(n) }))
  );
  const forceCheckbox = h('input', {
    type: 'checkbox',
    checked: !!dl.force,
    onchange: (event) => {
      dl.force = event.target.checked;
    },
  });

  const startButton = h('button', {
    class: 'primary',
    type: 'button',
    text: t('web.dl.start'),
    onclick: async () => {
      const chosen = plan.items.filter((item) => dl.selected.has(String(item.modelId)));
      if (!chosen.length) {
        toast(t('web.dl.noneSelected'), 'warn');
        return;
      }
      const items = chosen.map((item) => {
        const override = dl.overrides.get(String(item.modelId));
        return override ? { modelId: item.modelId, versionId: override.versionId } : item;
      });
      await runJob(
        () =>
          api('/api/download', {
            method: 'POST',
            body: {
              collectionId: plan.collectionId,
              items,
              outDir: dl.outDir,
              jobs: dl.jobs,
              force: !!dl.force,
            },
          }),
        (job) => {
          if (job.status === 'done') {
            dl.plan = null;
            dl.selected = new Set();
            dl.overrides = new Map();
          }
        }
      );
    },
  });

  refreshTable();

  showScreen(
    'web.dl.title',
    'web.dl.subtitle',
    sourcePanel,
    panel(
      t('web.dl.planTitle', { count: plan.items.length, size: fmtBytes(plan.totalBytes || 0) }),
      [selectAll, selectNone, selectNew],
      filters,
      tableHost,
      summary
    ),
    panel(
      t('web.dl.options'),
      null,
      h(
        'div',
        { class: 'row' },
        h('label', { class: 'field grow' }, h('span', { text: t('web.dl.outDir') }), outDirInput),
        h('label', { class: 'field' }, h('span', { text: t('web.dl.concurrency') }), jobsSelect),
        h('label', { class: 'checkbox' }, forceCheckbox, h('span', { text: t('web.dl.force') })),
        startButton
      ),
      h('p', { class: 'small muted', text: t('web.dl.optionsHint') })
    ),
    singlePanel
  );
}

// ---------------------------------------------------------------------------
// Library
// 模型库
// ---------------------------------------------------------------------------

// Persistent state of the library screen.
// 模型库页的持久状态。
const lib = { q: '', sort: 'recent', collectionId: '' };

// Library table with search, sort and collection filter.
// 带搜索、排序与收藏集筛选的模型库表格。
async function renderLibrary() {
  const state = await loadState();
  updateHeader(state);
  const host = h('div');

  let debounce = null;
  const reload = async () => {
    host.replaceChildren(h('div', { class: 'loading', text: t('web.common.loading') }));
    const params = new URLSearchParams();
    if (lib.q) params.set('q', lib.q);
    params.set('sort', lib.sort);
    if (lib.collectionId) params.set('collectionId', lib.collectionId);
    let data;
    try {
      data = await api(`/api/library?${params.toString()}`);
    } catch (error) {
      host.replaceChildren(h('div', { class: 'empty', text: error.message }));
      return;
    }
    host.replaceChildren(
      table(
        [
          t('web.lib.columnName'),
          t('web.lib.columnType'),
          t('web.lib.columnBase'),
          { text: t('web.lib.columnVersions'), class: 'num' },
          { text: t('web.lib.columnSize'), class: 'num' },
          t('web.lib.columnPinned'),
          t('web.lib.columnVerified'),
        ],
        data.items.map((model) => ({
          class: 'selectable',
          cells: [
            { text: model.name || `#${model.modelId}`, class: 'name' },
            { text: model.type || '—' },
            { text: model.baseModel || '—' },
            { text: model.versions, class: 'num' },
            { text: fmtBytes(model.totalBytes), class: 'num' },
            { node: model.pinnedVersionId ? badge(t('web.lib.pinned'), 'info') : document.createTextNode('') },
            { text: model.lastVerifiedAt ? fmtDate(model.lastVerifiedAt) : '—' },
          ],
        })),
        t('web.lib.empty')
      )
    );
    const rows = host.querySelectorAll('tbody tr');
    data.items.forEach((model, index) => {
      if (!rows[index]) return;
      rows[index].addEventListener('click', () => showModelDetail(model.modelId));
    });
    store.library = data;
  };

  showScreen(
    'web.lib.title',
    'web.lib.subtitle',
    panel(
      t('web.lib.title'),
      h('button', { class: 'small', type: 'button', text: t('web.common.refresh'), onclick: () => reload() }),
      h(
        'div',
        { class: 'row' },
        h(
          'label',
          { class: 'field grow' },
          h('span', { text: t('web.common.search') }),
          h('input', {
            type: 'text',
            value: lib.q,
            placeholder: t('web.lib.searchPlaceholder'),
            oninput: (event) => {
              lib.q = event.target.value;
              clearTimeout(debounce);
              debounce = setTimeout(reload, 250);
            },
          })
        ),
        h(
          'label',
          { class: 'field' },
          h('span', { text: t('web.common.sort') }),
          sortSelect(lib.sort, (value) => {
            lib.sort = value;
            reload();
          })
        ),
        h(
          'label',
          { class: 'field' },
          h('span', { text: t('web.lib.collection') }),
          h(
            'select',
            {
              onchange: (event) => {
                lib.collectionId = event.target.value;
                reload();
              },
            },
            h('option', { value: '', text: t('web.common.all') }),
            ...(state.collections || []).map((collection) =>
              h('option', {
                value: collection.id,
                selected: lib.collectionId === collection.id,
                text: t('web.lib.collectionOption', { id: collection.id, count: collection.members }),
              })
            )
          )
        )
      ),
      host
    )
  );
  await reload();
}

// Ask how a forget should treat the files; resolves null when cancelled.
// 询问删除记录时是否连文件一起删；取消时返回 null。
function promptForget(name) {
  return new Promise((resolve) => {
    let settled = false;
    const finish = (value) => {
      if (settled) return;
      settled = true;
      resolve(value);
    };
    openModal({
      title: t('web.lib.forget'),
      body: h(
        'div',
        { class: 'stack' },
        h('p', { text: t('web.lib.forgetConfirm', { name }) }),
        h('p', { class: 'small muted', text: t('web.lib.forgetFilesHint') })
      ),
      actions: [
        {
          label: t('web.common.cancel'),
          onClick: (done) => {
            done();
            finish(null);
          },
        },
        {
          label: t('web.lib.forgetRecordOnly'),
          onClick: (done) => {
            done();
            finish(false);
          },
        },
        {
          label: t('web.lib.forgetWithFiles'),
          kind: 'danger',
          onClick: (done) => {
            done();
            finish(true);
          },
        },
      ],
    });
  });
}

// Model detail modal: versions, pin, download, check, verify, forget.
// 模型详情弹窗：版本、固定、下载、检查、校验、删除。
async function showModelDetail(modelId) {
  const loading = openModal({
    title: t('web.lib.detailTitle', { modelId }),
    body: h('div', { class: 'loading', text: t('web.common.loading') }),
  });
  let detail;
  try {
    detail = await api(`/api/library/${encodeURIComponent(modelId)}`);
  } catch (error) {
    loading();
    toast(error.message, 'fail');
    return;
  }
  loading();

  const close = openModal({
    title: detail.name || `#${modelId}`,
    body: [
      kvList([
        [t('web.lib.modelId'), h('span', { class: 'mono', text: detail.modelId })],
        [t('web.lib.columnType'), detail.type || '—'],
        [t('web.lib.columnBase'), detail.baseModel || '—'],
        [t('web.lib.columnSize'), fmtBytes(detail.totalBytes)],
        [t('web.lib.dir'), h('span', { class: 'mono small', text: detail.dir || '—' })],
      ]),
      h('div', { class: 'hr' }),
      table(
        [
          t('web.dl.columnVersion'),
          t('web.lib.versionId'),
          { text: t('web.lib.columnSize'), class: 'num' },
          { text: t('web.dl.columnFiles'), class: 'num' },
          t('web.lib.columnVerified'),
          t('web.lib.columnPinned'),
          '',
        ],
        detail.versions.map((version) => ({
          cells: [
            { text: version.versionName || version.versionId, class: 'name' },
            { text: version.versionId, class: 'mono' },
            { text: fmtBytes(version.bytes), class: 'num' },
            { text: t('web.dl.fileCount', { count: version.files.length }), class: 'num' },
            { text: version.verifiedAt ? fmtDate(version.verifiedAt) : '—' },
            {
              node:
                detail.pinnedVersionId === version.versionId
                  ? badge(t('web.lib.pinned'), 'info')
                  : document.createTextNode(''),
            },
            {
              node: h(
                'div',
                { class: 'inline' },
                h('button', {
                  class: 'small ghost',
                  type: 'button',
                  text: detail.pinnedVersionId === version.versionId ? t('web.lib.unpin') : t('web.lib.pin'),
                  onclick: async () => {
                    try {
                      await api(`/api/library/${encodeURIComponent(modelId)}/pin`, {
                        method: 'POST',
                        body: { versionId: detail.pinnedVersionId === version.versionId ? null : version.versionId },
                      });
                      toast(t('web.lib.pinSaved'), 'ok');
                      invalidate();
                      close();
                      route();
                    } catch (error) {
                      toast(error.message, 'fail');
                    }
                  },
                }),
                h('button', {
                  class: 'small',
                  type: 'button',
                  text: t('web.lib.downloadVersion'),
                  onclick: () => {
                    close();
                    runJob(() =>
                      api('/api/download', {
                        method: 'POST',
                        body: { items: [{ modelId: detail.modelId, versionId: version.versionId }] },
                      })
                    );
                  },
                })
              ),
            },
          ],
        })),
        t('web.lib.noVersions')
      ),
    ],
    actions: [
      {
        label: t('web.lib.checkThis'),
        onClick: (done) => {
          done();
          runJob(() => api('/api/check', { method: 'POST', body: { models: [detail.modelId] } }));
        },
      },
      {
        label: t('web.lib.verifyThis'),
        onClick: (done) => {
          done();
          runJob(() => api('/api/verify', { method: 'POST', body: { modelIds: [detail.modelId], noHash: false } }));
        },
      },
      {
        label: t('web.lib.forget'),
        kind: 'danger',
        onClick: async (done) => {
          const deleteFiles = await promptForget(detail.name || detail.modelId);
          if (deleteFiles === null) return;
          done();
          try {
            await api(`/api/library/${encodeURIComponent(modelId)}/forget`, {
              method: 'POST',
              body: { deleteFiles },
            });
            toast(t('web.lib.forgotten'), 'ok');
            invalidate();
            route();
          } catch (error) {
            toast(error.message, 'fail');
          }
        },
      },
      { label: t('web.common.close') },
    ],
  });
}

// ---------------------------------------------------------------------------
// Check for updates
// 检查更新
// ---------------------------------------------------------------------------

// Persistent state of the check screen.
// 检查页的持久状态。
const chk = { collections: new Set(), models: new Set(), deep: false };

// Check screen: pick collections and/or models, run, render the reports.
// 检查界面：选择收藏集和/或模型，运行并渲染报告。
async function renderCheck() {
  const state = await loadState();
  updateHeader(state);
  const library = await loadLibrary();

  const collectionList = (state.collections || []).map((collection) =>
    h(
      'label',
      { class: 'checkbox' },
      h('input', {
        type: 'checkbox',
        checked: chk.collections.has(collection.id),
        onchange: (event) => {
          if (event.target.checked) chk.collections.add(collection.id);
          else chk.collections.delete(collection.id);
        },
      }),
      h('span', { text: t('web.check.collectionLabel', { id: collection.id, count: collection.members }) })
    )
  );

  const modelList = h(
    'div',
    { class: 'stack', style: { maxHeight: '240px', overflow: 'auto' } },
    ...library.items.map((model) =>
      h(
        'label',
        { class: 'checkbox' },
        h('input', {
          type: 'checkbox',
          checked: chk.models.has(model.modelId),
          onchange: (event) => {
            if (event.target.checked) chk.models.add(model.modelId);
            else chk.models.delete(model.modelId);
          },
        }),
        h('span', { text: model.name || `#${model.modelId}` })
      )
    )
  );

  showScreen(
    'web.check.title',
    'web.check.subtitle',
    panel(
      t('web.check.scope'),
      null,
      h('h3', { class: 'small muted', text: t('web.check.collectionsTitle') }),
      collectionList.length
        ? h('div', { class: 'stack' }, ...collectionList)
        : h('p', { class: 'small muted', text: t('web.check.noCollections') }),
      h('div', { class: 'hr' }),
      h('h3', { class: 'small muted', text: t('web.check.modelsTitle') }),
      h('input', {
        type: 'text',
        placeholder: t('web.check.filterModels'),
        oninput: (event) => {
          const query = event.target.value.toLowerCase();
          for (const row of modelList.children) {
            row.hidden = query ? !row.textContent.toLowerCase().includes(query) : false;
          }
        },
      }),
      modelList,
      h('div', { class: 'hr' }),
      h(
        'label',
        { class: 'checkbox' },
        h('input', {
          type: 'checkbox',
          checked: chk.deep,
          onchange: (event) => {
            chk.deep = event.target.checked;
          },
        }),
        h('span', { text: t('web.check.deep') })
      ),
      h('p', { class: 'small muted', text: t('web.check.deepHint') }),
      h('button', {
        class: 'primary',
        type: 'button',
        text: t('web.check.run'),
        onclick: async () => {
          if (!chk.collections.size && !chk.models.size) {
            toast(t('web.check.nothingSelected'), 'warn');
            return;
          }
          await runJob(
            () =>
              api('/api/check', {
                method: 'POST',
                body: { collections: [...chk.collections], models: [...chk.models], deep: chk.deep },
              }),
            (job) => {
              if (job.status === 'done' && job.result) renderCheckReports(job.result.reports);
            }
          );
        },
      })
    )
  );
}

// Render the reports of a finished check job below the scope panel.
// 在范围面板下方渲染检查报告。
function renderCheckReports(reports) {
  const view = document.getElementById('view');
  const existing = document.getElementById('check-reports');
  if (existing) existing.remove();
  const host = h('div', { id: 'check-reports' });
  view.append(host);

  for (const report of reports || []) {
    const title =
      report.target.kind === 'collection'
        ? t('web.check.reportCollection', { id: report.target.id })
        : t('web.check.reportModel', { id: report.target.id });
    const buttons = [];
    if (report.changed) {
      buttons.push(
        h('button', {
          class: 'primary',
          type: 'button',
          text: t('web.check.downloadChanges', { count: report.changed }),
          onclick: () =>
            runJob(() =>
              api('/api/download', {
                method: 'POST',
                body: { collectionId: report.collectionId, items: report.items, force: false },
              })
            ),
        })
      );
    }
    host.append(
      panel(
        title,
        buttons,
        h(
          'p',
          { class: 'small' },
          t('web.check.stats', {
            total: (report.stats && report.stats.total) || 0,
            updated: (report.stats && report.stats.updated) || 0,
            fileChanged: (report.stats && report.stats.fileChanged) || 0,
            missing: (report.stats && report.stats.missing) || 0,
            notDownloaded: (report.stats && report.stats.notDownloaded) || 0,
            failed: (report.stats && report.stats.failed) || 0,
          })
        ),
        h('pre', { class: 'job-log', style: { maxHeight: '22vh' }, text: (report.lines || []).join('\n') })
      )
    );
  }
  host.scrollIntoView({ behavior: 'smooth', block: 'start' });
}

// ---------------------------------------------------------------------------
// Verify
// 校验
// ---------------------------------------------------------------------------

// Persistent state of the verify screen.
// 校验页的持久状态。
const vfy = { models: new Set(), deep: true };

// Verify screen: scope, deep switch, run, render the result.
// 校验界面：范围、深度开关、运行并渲染结果。
async function renderVerify() {
  const state = await loadState();
  updateHeader(state);
  const library = await loadLibrary();

  const modelList = h(
    'div',
    { class: 'stack', style: { maxHeight: '260px', overflow: 'auto' } },
    ...library.items.map((model) =>
      h(
        'label',
        { class: 'checkbox' },
        h('input', {
          type: 'checkbox',
          checked: vfy.models.has(model.modelId),
          onchange: (event) => {
            if (event.target.checked) vfy.models.add(model.modelId);
            else vfy.models.delete(model.modelId);
          },
        }),
        h('span', { text: model.name || `#${model.modelId}` })
      )
    )
  );

  showScreen(
    'web.verify.title',
    'web.verify.subtitle',
    panel(
      t('web.verify.scope'),
      null,
      h('p', { class: 'small muted', text: t('web.verify.scopeHint') }),
      modelList,
      h(
        'label',
        { class: 'checkbox' },
        h('input', {
          type: 'checkbox',
          checked: vfy.deep,
          onchange: (event) => {
            vfy.deep = event.target.checked;
          },
        }),
        h('span', { text: t('web.verify.deep') })
      ),
      h('button', {
        class: 'primary',
        type: 'button',
        text: t('web.verify.run'),
        onclick: () =>
          runJob(
            () =>
              api('/api/verify', {
                method: 'POST',
                body: { modelIds: [...vfy.models], noHash: !vfy.deep },
              }),
            (job) => {
              if (job.status === 'done' && job.result) renderVerifyResult(job.result);
            }
          ),
      })
    )
  );
}

// Render the verification result panel.
// 渲染校验结果面板。
function renderVerifyResult(result) {
  const view = document.getElementById('view');
  const existing = document.getElementById('verify-result');
  if (existing) existing.remove();
  const host = h('div', { id: 'verify-result' });
  view.append(host);

  const rows = (result.broken || []).map((item) => ({
    cells: [
      { text: item.name || `#${item.modelId}`, class: 'name' },
      { text: item.versionId || '—', class: 'mono' },
      { text: (item.reasons || []).join('; ') },
      { text: item.dir || '—', class: 'mono small' },
    ],
  }));

  host.append(
    panel(
      t('web.verify.result'),
      result.broken.length
        ? h('button', {
            class: 'primary',
            type: 'button',
            text: t('web.verify.repair'),
            onclick: () => {
              const items = result.broken.map((item) => ({ modelId: item.modelId, versionId: item.versionId }));
              runJob(() => api('/api/download', { method: 'POST', body: { items, force: true } }));
            },
          })
        : null,
      h(
        'p',
        { class: 'small' },
        t('web.verify.counts', { ok: result.ok, broken: result.broken.length, size: fmtBytes(result.totalBytes) })
      ),
      table(
        [t('web.lib.columnName'), t('web.lib.versionId'), t('web.verify.reason'), t('web.lib.dir')],
        rows,
        t('web.verify.allOk')
      )
    )
  );
}

// ---------------------------------------------------------------------------
// Settings
// 设置
// ---------------------------------------------------------------------------

// Settings form definition (keys must exist in SETTINGS_KEYS on the server).
// 设置表单定义（键必须在服务器端的 SETTINGS_KEYS 里）。
const SETTINGS_SPEC = [
  {
    title: 'web.settings.groupBasic',
    fields: [
      { key: 'site', label: 'web.settings.site', hint: 'web.settings.siteHint' },
      { key: 'outDir', label: 'web.settings.outDir' },
      { key: 'chromePath', label: 'web.settings.chromePath' },
      { key: 'debugPort', label: 'web.settings.debugPort', type: 'number', numeric: true },
      {
        key: 'language',
        label: 'web.settings.language',
        type: 'select',
        options: [
          ['', 'web.settings.languageAuto'],
          ['zh-CN', 'web.settings.languageZh'],
          ['en', 'web.settings.languageEn'],
        ],
      },
      {
        key: 'headless',
        label: 'web.settings.headless',
        type: 'select',
        options: [
          ['auto', 'web.settings.headlessAuto'],
          ['always', 'web.settings.headlessAlways'],
          ['never', 'web.settings.headlessNever'],
        ],
      },
    ],
  },
  {
    title: 'web.settings.groupDownload',
    fields: [
      { key: 'jobs', label: 'web.settings.jobs', type: 'number', numeric: true },
      { key: 'metaConcurrency', label: 'web.settings.metaConcurrency', type: 'number', numeric: true },
      { key: 'downloadAttempts', label: 'web.settings.downloadAttempts', type: 'number', numeric: true },
      { key: 'requestTimeoutMs', label: 'web.settings.requestTimeout', type: 'number', numeric: true },
      { key: 'fileTypes', label: 'web.settings.fileTypes', type: 'list', hint: 'web.settings.fileTypesHint' },
      {
        key: 'engine',
        label: 'web.settings.engine',
        type: 'select',
        options: [
          ['curl', 'web.settings.engineCurl'],
          ['auto', 'web.settings.engineAuto'],
          ['aria2', 'web.settings.engineAria2'],
        ],
      },
      {
        key: 'dedup',
        label: 'web.settings.dedup',
        type: 'select',
        options: [
          ['off', 'web.settings.dedupOff'],
          ['hardlink', 'web.settings.dedupHardlink'],
          ['copy', 'web.settings.dedupCopy'],
        ],
      },
      {
        key: 'layout',
        label: 'web.settings.layout',
        type: 'select',
        options: [
          ['a1111', 'web.settings.layoutA1111'],
          ['comfy', 'web.settings.layoutComfy'],
          ['custom', 'web.settings.layoutCustom'],
        ],
      },
      { key: 'baseModelLayer', label: 'web.settings.baseModelLayer', type: 'checkbox' },
      { key: 'primaryOnly', label: 'web.settings.primaryOnly', type: 'checkbox' },
    ],
  },
  {
    title: 'web.settings.groupNetwork',
    fields: [
      { key: 'proxy', label: 'web.settings.proxy' },
      { key: 'apiRateLimit', label: 'web.settings.apiRateLimit', type: 'number', numeric: true },
      { key: 'retries', label: 'web.settings.retries', type: 'number', numeric: true },
      { key: 'userAgent', label: 'web.settings.userAgent' },
    ],
  },
  {
    title: 'web.settings.groupNotify',
    fields: [
      { key: 'notifyWebhook', label: 'web.settings.notifyWebhook' },
      { key: 'notifyToast', label: 'web.settings.notifyToast', type: 'checkbox' },
    ],
  },
];

// Settings screen: grouped form, validated and saved through `/api/settings`.
// 设置界面：分组表单，经 `/api/settings` 校验并保存。
async function renderSettings() {
  const state = await loadState();
  updateHeader(state);
  const data = await api('/api/settings');
  const draft = { ...data.values };

  function field(spec) {
    const value = draft[spec.key];
    let input;
    if (spec.type === 'select') {
      input = h(
        'select',
        {
          onchange: (event) => {
            draft[spec.key] = event.target.value;
          },
        },
        ...spec.options.map(([optionValue, key]) =>
          h('option', { value: String(optionValue), selected: String(value) === String(optionValue), text: t(key) })
        )
      );
    } else if (spec.type === 'checkbox') {
      input = h('input', {
        type: 'checkbox',
        checked: !!value,
        onchange: (event) => {
          draft[spec.key] = event.target.checked;
        },
      });
    } else if (spec.type === 'list') {
      input = h('input', {
        type: 'text',
        value: Array.isArray(value) ? value.join(',') : '',
        oninput: (event) => {
          draft[spec.key] = event.target.value;
        },
      });
    } else {
      input = h('input', {
        type: spec.type || 'text',
        value: value === undefined || value === null ? '' : String(value),
        oninput: (event) => {
          draft[spec.key] = event.target.value;
          draft[`${spec.key}__raw`] = event.target.value;
        },
      });
    }
    return h(
      'label',
      { class: 'field' },
      h('span', { text: t(spec.label) }),
      input,
      spec.hint ? h('span', { class: 'note', text: t(spec.hint) }) : null
    );
  }

  const save = h('button', {
    class: 'primary',
    type: 'button',
    text: t('web.settings.save'),
    onclick: async () => {
      const patch = {};
      for (const group of SETTINGS_SPEC) {
        for (const spec of group.fields) {
          if (spec.type === 'list') {
            patch[spec.key] = String(draft[spec.key] || '')
              .split(',')
              .map((part) => part.trim())
              .filter(Boolean);
          } else if (spec.numeric) {
            const raw = draft[`${spec.key}__raw`] !== undefined ? draft[`${spec.key}__raw`] : draft[spec.key];
            // Keep the previous value rather than writing NaN for an emptied number field.
            // 数字框被清空时保留原值，而不是写入 NaN。
            if (String(raw).trim() === '') continue;
            patch[spec.key] = Number(raw);
          } else {
            patch[spec.key] = draft[spec.key];
          }
        }
      }
      try {
        await api('/api/settings', { method: 'POST', body: patch });
        toast(t('web.settings.saved'), 'ok');
        invalidate();
        await loadI18n();
        applyStaticI18n();
        renderNav();
        route();
      } catch (error) {
        toast(error.message, 'fail');
      }
    },
  });

  showScreen(
    'web.settings.title',
    'web.settings.subtitle',
    ...SETTINGS_SPEC.map((group) => panel(t(group.title), null, h('div', { class: 'row' }, ...group.fields.map(field)))),
    panel(
      t('web.settings.about'),
      null,
      kvList([
        [t('web.settings.configFile'), h('span', { class: 'mono', text: data.configFile || 'config.json' })],
        [t('web.settings.root'), h('span', { class: 'mono', text: data.root })],
      ]),
      h('div', { class: 'inline' }, save),
      h('p', { class: 'small muted', text: t('web.settings.saveHint') })
    )
  );
}

// ---------------------------------------------------------------------------
// Login
// 登录
// ---------------------------------------------------------------------------

// Login screen: start the browser flow, confirm it, or just check the session.
// 登录界面：启动浏览器登录、确认完成，或只校验会话。
async function renderLogin() {
  const state = await loadState(true);
  updateHeader(state);

  const start = h('button', {
    class: 'primary',
    type: 'button',
    text: t('web.login.start'),
    onclick: () =>
      runJob(() => api('/api/login/start', { method: 'POST', body: {} }), () => {
        invalidate();
        route();
      }),
  });
  const confirm = h('button', {
    type: 'button',
    text: t('web.login.finished'),
    onclick: async () => {
      try {
        await api('/api/login/confirm', { method: 'POST', body: {} });
        toast(t('web.login.confirmed'), 'ok');
      } catch (error) {
        toast(error.message, 'warn');
      }
    },
  });
  const check = h('button', {
    type: 'button',
    text: t('web.dash.checkSession'),
    onclick: async () => {
      try {
        const result = await api('/api/login/check', { method: 'POST', body: {} });
        toast(
          result.ok ? t('web.dash.sessionOk') : t('web.dash.sessionBad', { reason: result.reason }),
          result.ok ? 'ok' : 'warn'
        );
      } catch (error) {
        toast(error.message, 'fail');
      }
    },
  });

  showScreen(
    'web.login.title',
    'web.login.subtitle',
    panel(
      t('web.login.status'),
      null,
      kvList([
        [
          t('web.login.session'),
          badge(state.loggedIn ? t('web.dash.loggedIn') : t('web.dash.notLoggedIn'), state.loggedIn ? 'ok' : 'warn'),
        ],
      ]),
      h('div', { class: 'inline' }, start, confirm, check),
      h('p', { class: 'small muted', text: t('web.login.instructions') })
    )
  );
}

// ---------------------------------------------------------------------------
// Help
// 帮助
// ---------------------------------------------------------------------------

// Help screen: workflows and the CLI equivalents.
// 帮助界面：工作流与命令行等价写法。
async function renderHelp() {
  const rows = ['download', 'library', 'check', 'verify', 'settings', 'login', 'web'].map((key) => ({
    cells: [{ text: t(`web.help.${key}Title`), class: 'name' }, { text: t(`web.help.${key}Body`) }],
  }));

  showScreen(
    'web.help.title',
    'web.help.subtitle',
    panel(t('web.help.workflows'), null, table([t('web.help.topic'), t('web.help.details')], rows, t('web.common.empty'))),
    panel(
      t('web.help.cli'),
      null,
      h('p', { class: 'small muted', text: t('web.help.cliHint') }),
      h('pre', { class: 'job-log', style: { maxHeight: '40vh' } }, [
        'npm run webui                       # this web UI (node web.js)',
        'npm run tui                         # terminal UI (still available)',
        'node cli.js list <id>               # enumerate a collection',
        'node cli.js download <id>           # download a collection',
        'node cli.js models                  # model library',
        'node cli.js check <target>          # check for updates',
        'node cli.js verify                  # verify local files',
        'node cli.js doctor                  # environment check',
      ].join('\n'))
    )
  );
}

// ---------------------------------------------------------------------------
// Boot
// 启动
// ---------------------------------------------------------------------------

// Load the `web.*` dictionary for the current language.
// 读取当前语言的 `web.*` 文案。
async function loadI18n() {
  const data = await api('/api/i18n');
  DICT = data.dict || {};
  LANG = data.language || 'zh-CN';
}

// Switch language and re-render everything.
// 切换语言并重绘界面。
async function toggleLanguage() {
  const next = LANG === 'zh-CN' ? 'en' : 'zh-CN';
  try {
    await api('/api/settings', { method: 'POST', body: { language: next } });
    invalidate();
    await loadI18n();
    applyStaticI18n();
    renderNav();
    route();
  } catch (error) {
    toast(error.message, 'fail');
  }
}

// Boot the SPA.
// 启动单页应用。
async function boot() {
  document.getElementById('refresh-btn').addEventListener('click', () => {
    invalidate();
    route();
  });
  document.getElementById('lang-btn').addEventListener('click', toggleLanguage);
  document.getElementById('job-toggle').addEventListener('click', () => {
    const log = document.getElementById('job-log');
    log.hidden = !log.hidden;
  });
  document.getElementById('job-cancel').addEventListener('click', cancelJob);

  try {
    await loadI18n();
  } catch (error) {
    document.getElementById('view').textContent = `Failed to load /api/i18n: ${error.message}`;
    return;
  }
  applyStaticI18n();
  renderNav();
  connectEvents();
  window.addEventListener('hashchange', route);
  await route();
}

document.addEventListener('DOMContentLoaded', boot);

// Small debugging handle (a browser tab's console is the natural place to poke at the API).
// 调试用的小把手（浏览器控制台就是最方便试 API 的地方）。
window.__dl = { api, t, toast, route, store, get dict() { return DICT; } };
