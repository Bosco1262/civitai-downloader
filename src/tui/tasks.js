'use strict';

// Live task registry of the TUI.
//
// Everything long-running (a download run, a check, a verify pass) registers a task here, and the app
// shell renders the registry twice: as a one-line-per-task summary inside the info panel, and as the
// full task view behind Tab. The flows stay in charge of the numbers — this module only stores them,
// which keeps the rendering code free of flow-specific knowledge.
//
//
// TUI 的实时任务登记表。
//
// 所有耗时操作（下载、检查、校验）都在这里登记一个任务，应用外壳会渲染它两次：
// 信息面板里每个任务一行摘要，以及 Tab 打开的完整任务视图。数字仍由各流程自己更新——
// 本模块只负责存放，渲染代码因此不必了解任何流程细节。

const { formatDuration } = require('../util');

/**
 * Statuses a task can be in. Only `running` tasks show up in the info panel.
 * 任务可能处于的状态。只有 `running` 会出现在信息面板里。
 */
const RUNNING = 'running';
const DONE = 'done';
const FAILED = 'failed';
const CANCELLED = 'cancelled';

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
 * 登记一个任务并返回它的 id。
 *
 * @param {{
 *   kind?:string, title?:string, name?:string, scope?:string, total?:number, totalBytes?:number
 * }} [init]
 * @returns {string}
 */
function createTask(init = {}) {
  seq += 1;
  const id = `t${seq}`;
  registry.set(id, {
    id,
    kind: String(init.kind || 'task'),
    // `name` is what the task is about (collection / model), `scope` the finer target (a member).
    // `name` 是任务对象（收藏集 / 模型），`scope` 是更细的目标（某个成员）。
    name: String(init.name || ''),
    scope: String(init.scope || ''),
    detail: '',
    status: RUNNING,
    total: num(init.total),
    totalBytes: num(init.totalBytes),
    done: 0,
    skipped: 0,
    failed: 0,
    bytes: 0,
    speed: 0,
    eta: '',
    attempts: null,
    startedAt: Date.now(),
    finishedAt: 0,
    cancel: null,
  });
  return id;
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
  for (const key of ['name', 'scope', 'detail', 'status', 'eta']) {
    if (patch[key] !== undefined) task[key] = String(patch[key]);
  }
  for (const key of ['total', 'totalBytes', 'done', 'skipped', 'failed', 'bytes', 'speed']) {
    if (patch[key] !== undefined) task[key] = num(patch[key]);
  }
  if (patch.attempts !== undefined) task.attempts = patch.attempts;
  return task;
}

/**
 * Mark a task finished (done / failed / cancelled) and stamp the end time.
 * 把任务标记为结束（完成 / 失败 / 取消）并记录结束时间。
 */
function finishTask(id, status = DONE) {
  const task = registry.get(id);
  if (!task) return null;
  task.status = status;
  task.finishedAt = Date.now();
  task.speed = 0;
  task.eta = '';
  return task;
}

/**
 * Register the cancel callback of a running task; the task view and Esc call it.
 * 登记运行中任务的取消回调；任务视图与 Esc 会调用它。
 */
function setTaskCancel(id, fn) {
  const task = registry.get(id);
  if (!task) return null;
  task.cancel = typeof fn === 'function' ? fn : null;
  return task;
}

/**
 * Ask a task to stop. Returns true when something was actually asked to cancel.
 * 请求任务停止。确实发出取消请求时返回 true。
 */
function cancelTask(id) {
  const task = registry.get(id);
  if (!task || task.status !== RUNNING) return false;
  if (typeof task.cancel === 'function') task.cancel();
  else task.status = CANCELLED;
  return true;
}

/**
 * Ask every running task to stop.
 * 请求所有运行中的任务停止。
 */
function cancelAll() {
  let any = false;
  for (const task of registry.values()) {
    if (task.status === RUNNING) any = cancelTask(task.id) || any;
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
 * All tasks, running ones first and newest first inside each group.
 * 全部任务：运行中的在前，同组内新的在前。
 */
function listTasks() {
  const all = [...registry.values()];
  const weight = (task) => (task.status === RUNNING ? 0 : 1);
  return all.sort((a, b) => weight(a) - weight(b) || b.startedAt - a.startedAt);
}

/**
 * Running tasks only (what the info panel shows).
 * 仅运行中的任务（信息面板显示的内容）。
 */
function runningTasks() {
  return [...registry.values()].filter((task) => task.status === RUNNING);
}

/**
 * Drop finished tasks, keeping the registry small across a long session.
 * 清掉已结束的任务，长时间运行时登记表不会无限增长。
 */
function clearFinished() {
  for (const [id, task] of [...registry]) {
    if (task.status !== RUNNING) registry.delete(id);
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
 * Progress percentage of a task (0 when the total is unknown).
 * 任务完成百分比（总量未知时为 0）。
 */
function percentOf(task) {
  if (!task) return 0;
  if (task.totalBytes > 0) return Math.max(0, Math.min(100, (task.bytes / task.totalBytes) * 100));
  if (task.total > 0) return Math.max(0, Math.min(100, ((task.done + task.skipped + task.failed) / task.total) * 100));
  return 0;
}

/**
 * Elapsed milliseconds of a task (frozen once it finished).
 * 任务已用毫秒数（结束后不再增长）。
 */
function elapsedMs(task) {
  if (!task) return 0;
  return Math.max(0, (task.finishedAt || Date.now()) - task.startedAt);
}

/**
 * Short "elapsed" text of a task.
 * 任务的已用时文本。
 */
function elapsedText(task) {
  return formatDuration(elapsedMs(task) / 1000);
}

module.exports = {
  RUNNING,
  DONE,
  FAILED,
  CANCELLED,
  createTask,
  updateTask,
  finishTask,
  setTaskCancel,
  cancelTask,
  cancelAll,
  getTask,
  listTasks,
  runningTasks,
  clearFinished,
  reset,
  percentOf,
  elapsedMs,
  elapsedText,
};
