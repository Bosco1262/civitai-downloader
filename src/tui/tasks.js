'use strict';

// Live task registry of the TUI.
//
// Everything long-running (a download run, a check, a verify pass) registers a task here, and the app
// shell renders the registry twice: as a one-line-per-task summary inside the info panel, and as the
// full task view behind Tab. The flows stay in charge of the numbers — this module only stores them,
// which keeps the rendering code free of flow-specific knowledge.
//
// Downloads are special: they keep running after the flow that started them has returned. The task
// therefore holds everything the task view needs (plan totals, the files currently being written,
// failures, the log file, the run result) plus the callbacks that let the task view cancel, skip or
// retry the job. Queued downloads are registered immediately with status `queued`; the download queue
// starts them one by one as the previous task finishes.
//
//
// TUI 的实时任务登记表。
//
// 所有耗时操作（下载、检查、校验）都在这里登记一个任务，应用外壳会渲染它两次：
// 信息面板里每个任务一行摘要，以及 Tab 打开的完整任务视图。数字仍由各流程自己更新——
// 本模块只负责存放，渲染代码因此不必了解任何流程细节。
//
// 下载是特殊的：启动它的流程返回之后，下载仍在继续。因此任务里保存了任务视图需要的一切
// （计划总量、正在写的文件、失败项、日志文件、运行结果），以及让任务视图取消、跳过或重试的
// 回调。排队中的下载立刻以 `queued` 状态登记；下载队列在前一个任务结束后逐个启动它们。

const { formatDuration } = require('../util');
const { t } = require('../i18n');

/**
 * Statuses a task can be in. Only `running` tasks show progress in the info panel; queued tasks show
 * as a waiting line, and the task view shows every status.
 *
 * 任务可能处于的状态。信息面板只为 `running` 任务显示进度，`queued` 显示为等待行，
 * 任务视图显示全部状态。
 */
const QUEUED = 'queued';
const RUNNING = 'running';
const DONE = 'done';
const FAILED = 'failed';
const CANCELLED = 'cancelled';

/**
 * How many log lines one task keeps in memory for the task view.
 * 任务视图里每个任务在内存中保留的日志行数。
 */
const LOG_KEEP = 200;

let seq = 0;
const registry = new Map();

/**
 * Clamp a numeric field into a sane range (counters and byte totals come from many places).
 * 把数字字段夹到合理区间（计数与字节数来自多处调用）。
 */
function num(value, fallback = 0) {
  const n = Number(value);
  return Number.isFinite(n) && n >= 0 ? n : fallback;
}

/**
 * Register a task and return its id.
 *
 * A task created with `status: 'queued'` has not started yet: its elapsed clock stays at zero and it
 * is ordered by `queuedAt` until the queue starts it.
 *
 *
 * 登记一个任务并返回它的 id。
 *
 * 以 `status: 'queued'` 创建的任务尚未开始：已用时间保持 0，按 `queuedAt` 排序，直到队列启动它。
 *
 * @param {{
 *   kind?:string, title?:string, name?:string, scope?:string, total?:number, totalBytes?:number,
 *   status?:string, outDir?:string, jobs?:number
 * }} [init]
 * @returns {string}
 */
function createTask(init = {}) {
  seq += 1;
  const id = `t${seq}`;
  const queued = init.status === QUEUED;
  const now = Date.now();
  registry.set(id, {
    id,
    kind: String(init.kind || 'task'),
    // `name` is what the task is about (collection / model), `scope` the finer target (a member).
    // `name` 是任务对象（收藏集 / 模型），`scope` 是更细的目标（某个成员）。
    name: String(init.name || ''),
    scope: String(init.scope || ''),
    detail: '',
    status: queued ? QUEUED : RUNNING,
    total: num(init.total),
    totalBytes: num(init.totalBytes),
    done: 0,
    skipped: 0,
    failed: 0,
    bytes: 0,
    speed: 0,
    eta: '',
    attempts: null,
    jobs: Math.max(1, num(init.jobs, 1)),
    outDir: String(init.outDir || ''),
    logFile: '',
    startedAt: queued ? 0 : now,
    queuedAt: queued ? now : 0,
    finishedAt: 0,
    cancel: null,
    skip: null,
    retry: null,
    result: null,
    failures: [],
    current: [],
    logLines: [],
  });
  return id;
}

/**
 * Mark a queued task as started (called by the download queue).
 * 把排队中的任务标记为开始（下载队列调用）。
 */
function startTask(id) {
  const task = registry.get(id);
  if (!task) return null;
  task.status = RUNNING;
  task.startedAt = Date.now();
  task.queuedAt = 0;
  return task;
}

/**
 * Patch the mutable fields of a task. Unknown ids are ignored, so a late timer tick after the task
 * was dropped cannot throw inside the render loop.
 *
 * 更新任务的可变字段。未知 id 直接忽略，任务被移除后迟到的定时器不会在渲染循环里抛错。
 */
function updateTask(id, patch) {
  const task = registry.get(id);
  if (!task || !patch) return null;
  for (const key of ['name', 'scope', 'detail', 'status', 'eta', 'outDir', 'logFile']) {
    if (patch[key] !== undefined) task[key] = String(patch[key]);
  }
  for (const key of ['total', 'totalBytes', 'done', 'skipped', 'failed', 'bytes', 'speed', 'jobs']) {
    if (patch[key] !== undefined) task[key] = num(patch[key]);
  }
  if (patch.attempts !== undefined) task.attempts = patch.attempts;
  if (patch.result !== undefined) task.result = patch.result;
  if (Array.isArray(patch.failures)) task.failures = patch.failures.slice();
  if (Array.isArray(patch.current)) task.current = patch.current.slice();
  return task;
}

/**
 * Append one line to the task's in-memory log (the task view shows the tail).
 * 追加一行任务内存日志（任务视图显示尾部）。
 */
function appendLog(id, line, max = LOG_KEEP) {
  const task = registry.get(id);
  if (!task) return null;
  for (const part of String(line === undefined || line === null ? '' : line).split('\n')) {
    task.logLines.push(part);
  }
  const keep = Math.max(1, num(max, LOG_KEEP));
  if (task.logLines.length > keep) task.logLines.splice(0, task.logLines.length - keep);
  return task;
}

/**
 * Mark a task finished (done / failed / cancelled) and stamp the end time.
 * 把任务标记为结束（完成 / 失败 / 取消）并记录结束时间。
 */
function finishTask(id, status = DONE, result) {
  const task = registry.get(id);
  if (!task) return null;
  task.status = status;
  task.finishedAt = Date.now();
  task.speed = 0;
  task.eta = '';
  task.current = [];
  if (result !== undefined) task.result = result;
  return task;
}

/**
 * Register the cancel callback of a task; the task view calls it.
 * 登记任务的取消回调；任务视图会调用它。
 */
function setTaskCancel(id, fn) {
  const task = registry.get(id);
  if (!task) return null;
  task.cancel = typeof fn === 'function' ? fn : null;
  return task;
}

/**
 * Register the "skip current model" callback of a running download.
 * 登记运行中下载的「跳过当前模型」回调。
 */
function setTaskSkip(id, fn) {
  const task = registry.get(id);
  if (!task) return null;
  task.skip = typeof fn === 'function' ? fn : null;
  return task;
}

/**
 * Register the retry callback of a finished download (retry what failed).
 * 登记已结束下载的重试回调（重试失败项）。
 */
function setTaskRetry(id, fn) {
  const task = registry.get(id);
  if (!task) return null;
  task.retry = typeof fn === 'function' ? fn : null;
  return task;
}

/**
 * Ask a task to stop. Returns true when something was actually asked to cancel.
 * 请求任务停止。确实发出取消请求时返回 true。
 */
function cancelTask(id) {
  const task = registry.get(id);
  if (!task) return false;
  if (task.status === QUEUED) {
    if (typeof task.cancel === 'function') task.cancel();
    task.status = CANCELLED;
    task.finishedAt = Date.now();
    return true;
  }
  if (task.status !== RUNNING) return false;
  if (typeof task.cancel === 'function') task.cancel();
  else task.status = CANCELLED;
  return true;
}

/**
 * Ask a running download to skip the model it is working on.
 * 请求运行中的下载跳过当前模型。
 */
function skipTask(id) {
  const task = registry.get(id);
  if (!task || task.status !== RUNNING) return false;
  if (typeof task.skip !== 'function') return false;
  task.skip();
  return true;
}

/**
 * Retry the failed items of a finished download.
 * 重试已结束下载的失败项。
 */
function retryTask(id) {
  const task = registry.get(id);
  if (!task || typeof task.retry !== 'function') return false;
  task.retry();
  return true;
}

/**
 * Ask every queued or running task to stop.
 * 请求所有排队中或运行中的任务停止。
 */
function cancelAll() {
  let any = false;
  for (const task of registry.values()) {
    if (task.status === RUNNING || task.status === QUEUED) any = cancelTask(task.id) || any;
  }
  return any;
}

/**
 * One task by id.
 * 按 id 取任务。
 */
function getTask(id) {
  return registry.get(id) || null;
}

/**
 * All tasks: running first, then queued (FIFO), then finished (newest first).
 * 全部任务：运行中的在前，其次是排队中的（先进先出），最后是已结束的（新的在前）。
 */
function listTasks() {
  const weight = (task) => (task.status === RUNNING ? 0 : task.status === QUEUED ? 1 : 2);
  return [...registry.values()].sort((a, b) => {
    const diff = weight(a) - weight(b);
    if (diff !== 0) return diff;
    if (a.status === QUEUED) return a.queuedAt - b.queuedAt;
    if (a.status === RUNNING) return b.startedAt - a.startedAt;
    return b.finishedAt - a.finishedAt;
  });
}

/**
 * Running tasks only.
 * 仅运行中的任务。
 */
function runningTasks() {
  return [...registry.values()].filter((task) => task.status === RUNNING);
}

/**
 * Queued tasks in the order they will start.
 * 排队中的任务，按启动顺序。
 */
function queuedTasks() {
  return [...registry.values()]
    .filter((task) => task.status === QUEUED)
    .sort((a, b) => a.queuedAt - b.queuedAt);
}

/**
 * Running and queued tasks (what the info panel shows).
 * 运行中与排队中的任务（信息面板显示的内容）。
 */
function activeTasks() {
  const running = [...registry.values()].filter((task) => task.status === RUNNING);
  return running.concat(queuedTasks());
}

/**
 * 1-based position of a queued task in the download queue, or 0 when it is not queued.
 * 排队任务在下载队列中的位置（从 1 开始）；不在队列中时返回 0。
 */
function queuePosition(id) {
  const index = queuedTasks().findIndex((task) => task.id === id);
  return index < 0 ? 0 : index + 1;
}

/**
 * Drop finished tasks, keeping the registry small across a long session.
 * 清掉已结束的任务，长时间运行时登记表不会无限增长。
 */
function clearFinished() {
  for (const [id, task] of [...registry]) {
    if (task.status !== RUNNING && task.status !== QUEUED) registry.delete(id);
  }
}

/**
 * Forget everything (used by tests).
 * 清空全部（测试使用）。
 */
function reset() {
  registry.clear();
  seq = 0;
}

/**
 * Progress percentage of a task (0 when the total is unknown or the task is queued).
 * 任务完成百分比（总量未知或排队中时为 0）。
 */
function percentOf(task) {
  if (!task || task.status === QUEUED) return 0;
  if (task.totalBytes > 0) return Math.max(0, Math.min(100, (task.bytes / task.totalBytes) * 100));
  if (task.total > 0) return Math.max(0, Math.min(100, ((task.done + task.skipped + task.failed) / task.total) * 100));
  return 0;
}

/**
 * Elapsed milliseconds of a task (zero while queued, frozen once finished).
 * 任务已用毫秒数（排队中为 0，结束后不再增长）。
 */
function elapsedMs(task) {
  if (!task || task.status === QUEUED || !task.startedAt) return 0;
  return Math.max(0, (task.finishedAt || Date.now()) - task.startedAt);
}

/**
 * Short "elapsed" text of a task.
 * 任务的已用时文本。
 */
function elapsedText(task) {
  return formatDuration(elapsedMs(task) / 1000);
}

/**
 * Human status text (used by the task view).
 * 人类可读的状态文本（任务视图使用）。
 */
function statusText(task) {
  if (!task) return '';
  if (task.status === QUEUED) return t('tui.screen.statusQueued');
  if (task.status === RUNNING) return t('tui.screen.statusRunning');
  if (task.status === DONE) return t('tui.screen.statusDone');
  if (task.status === CANCELLED) return t('tui.screen.statusCancelled');
  return t('tui.screen.statusFailed');
}

module.exports = {
  QUEUED,
  RUNNING,
  DONE,
  FAILED,
  CANCELLED,
  LOG_KEEP,
  createTask,
  startTask,
  updateTask,
  appendLog,
  finishTask,
  setTaskCancel,
  setTaskSkip,
  setTaskRetry,
  cancelTask,
  skipTask,
  retryTask,
  cancelAll,
  getTask,
  listTasks,
  runningTasks,
  queuedTasks,
  activeTasks,
  queuePosition,
  clearFinished,
  reset,
  percentOf,
  elapsedMs,
  elapsedText,
  statusText,
};
