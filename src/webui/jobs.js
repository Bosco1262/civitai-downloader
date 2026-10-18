'use strict';

/**
 * In-process job manager for the web UI.
 *
 * The CLI runs one command and exits; the web UI keeps a process alive, so every long action
 * (enumerate + plan, download, update check, verification, login) becomes a *job* with an id, a
 * status, a log tail and optional progress. Clients follow a job through the SSE stream or by
 * polling `GET /api/jobs/<id>`.
 *
 * Only one job runs at a time on purpose: the downloader takes a global lock, and a second
 * concurrent job would either fail on that lock or interleave logs that users cannot follow.
 *
 *
 * Web UI 的进程内任务管理。
 *
 * 命令行跑完一条命令就退出；Web UI 的进程一直活着，因此每个耗时动作
 * （枚举+计划、下载、检查更新、校验、登录）都变成一个带 id、状态、日志尾部与可选进度的「任务」。
 * 客户端可以通过 SSE 流跟踪，也可以轮询 `GET /api/jobs/<id>`。
 *
 * 有意限定同一时间只跑一个任务：下载器本身有全局锁，第二个并发任务要么撞锁失败，
 * 要么把日志交叉在一起、让人看不懂。
 */

const crypto = require('crypto');

/**
 * How many log lines a finished job keeps in memory.
 * 已完成任务在内存里保留多少行日志。
 */
const LOG_LIMIT = 500;

/**
 * Minimum interval between progress notifications, in milliseconds.
 * 进度通知的最小间隔（毫秒）。
 */
const PROGRESS_INTERVAL_MS = 500;

/**
 * Statuses a job can be in.
 * 任务可能处于的状态。
 */
const STATUS = {
  running: 'running',
  done: 'done',
  failed: 'failed',
  cancelled: 'cancelled',
};

/**
 * Create a job manager.
 * 创建任务管理器。
 *
 * @param {{
 *   emit:(event:object)=>void,
 *   now?:() => number,
 *   logLimit?:number,
 *   progressIntervalMs?:number
 * }} opts
 * @returns {object} manager
 */
function createJobs(opts = {}) {
  const emit = typeof opts.emit === 'function' ? opts.emit : () => {};
  const now = typeof opts.now === 'function' ? opts.now : () => Date.now();
  const logLimit = Math.max(10, Number(opts.logLimit) || LOG_LIMIT);
  const progressInterval = Math.max(0, Number(opts.progressIntervalMs) || PROGRESS_INTERVAL_MS);

  const jobs = new Map();
  const order = [];
  let activeId = null;

  /**
   * Public (serialisable) view of a job: everything except the internal cancel hook.
   * 任务对外的可序列化视图：除内部取消钩子之外的全部字段。
   */
  function view(job) {
    if (!job) return null;
    return {
      id: job.id,
      kind: job.kind,
      title: job.title,
      status: job.status,
      startedAt: job.startedAt,
      endedAt: job.endedAt,
      elapsedMs: (job.endedAt || now()) - job.startedAt,
      progress: job.progress,
      result: job.result,
      error: job.error,
      cancelled: job.cancelRequested,
      logs: job.logs.slice(-200),
    };
  }

  function publish(job) {
    emit({ type: 'job', job: view(job) });
  }

  /**
   * Append a log line to a job and push it to the clients.
   * 追加一行日志并推送给客户端。
   */
  function log(job, line) {
    const text = String(line === undefined || line === null ? '' : line);
    job.logs.push(text);
    if (job.logs.length > logLimit) job.logs.splice(0, job.logs.length - logLimit);
    emit({ type: 'log', jobId: job.id, line: text });
  }

  /**
   * Update the progress payload, throttled per job.
   * 更新进度负载（每个任务按最小间隔节流）。
   */
  function progress(job, payload) {
    job.progress = payload;
    const at = now();
    if (at - job.lastProgressAt < progressInterval) return;
    job.lastProgressAt = at;
    emit({ type: 'progress', jobId: job.id, progress: job.progress });
  }

  /**
   * Start a job.
   *
   * `task(ctx)` receives `{id, log, progress, isCancelled, onCancel}` and may return any value,
   * which becomes `result`. Throwing marks the job failed; a job cancelled while it runs stays
   * cancelled even if the task later resolves.
   *
   *
   * 启动一个任务。
   *
   * `task(ctx)` 会拿到 `{id, log, progress, isCancelled, onCancel}`，返回值成为 `result`。
   * 抛错即标记为失败；运行中被取消的任务即使随后正常返回，也保持「已取消」。
   *
   * @param {{kind:string, title?:string}} meta
   * @param {(ctx:object) => Promise<any>} task
   * @returns {object|null} the job view, or null when another job is still running
   */
  function start(meta, task) {
    if (activeId) {
      const running = jobs.get(activeId);
      if (running && running.status === STATUS.running) return null;
    }
    const id = crypto.randomBytes(6).toString('hex');
    const job = {
      id,
      kind: String((meta && meta.kind) || 'task'),
      title: String((meta && meta.title) || ''),
      status: STATUS.running,
      startedAt: now(),
      endedAt: null,
      progress: null,
      result: null,
      error: null,
      cancelRequested: false,
      logs: [],
      lastProgressAt: 0,
      onCancel: null,
    };
    jobs.set(id, job);
    order.push(id);
    activeId = id;

    const ctx = {
      id,
      log: (line) => log(job, line),
      progress: (payload) => progress(job, payload),
      isCancelled: () => job.cancelRequested,
      onCancel: (fn) => {
        job.onCancel = typeof fn === 'function' ? fn : null;
      },
      meta: { kind: job.kind, title: job.title },
    };

    publish(job);

    // The task runs asynchronously; callers get the view immediately and follow it by events.
    // 任务异步执行：调用方立刻拿到视图，之后通过事件跟踪。
    Promise.resolve()
      .then(() => task(ctx))
      .then((result) => {
        if (job.status === STATUS.cancelled) return;
        job.result = result === undefined ? null : result;
        job.status = STATUS.done;
      })
      .catch((error) => {
        if (job.status === STATUS.cancelled) return;
        job.error = (error && error.message) || String(error);
        job.status = STATUS.failed;
        log(job, job.error);
      })
      .finally(() => {
        job.endedAt = job.endedAt || now();
        if (activeId === id) activeId = null;
        publish(job);
      });

    return view(job);
  }

  /**
   * Ask a job to stop.
   *
   * The status flips to `cancelled` immediately so the UI reacts at once; the task may still be
   * unwinding (a download aborts on the next chunk), and the slot is only freed when it settles.
   *
   *
   * 请求任务停止。
   *
   * 状态立刻变成 `cancelled`，UI 可以马上响应；任务本身可能还在收尾（下载会在下一个分片处中止），
   * 槽位要等它真正结束才释放。
   *
   * @returns {boolean} false when the job is unknown or already finished
   */
  function cancel(id) {
    const job = jobs.get(String(id));
    if (!job || job.status !== STATUS.running) return false;
    job.cancelRequested = true;
    job.status = STATUS.cancelled;
    job.endedAt = now();
    publish(job);
    if (job.onCancel) {
      try {
        job.onCancel();
      } catch (e) {
        log(job, e.message);
      }
    }
    return true;
  }

  return {
    start,
    cancel,
    log,
    progress,
    /**
     * Append a line produced outside the job (a module logging through the shared sink) to the
     * running job. Returns false when no job is running.
     *
     * 把「任务外部来的日志」（通过共享日志出口输出的模块）追加到正在运行的任务。
     * 没有任务在跑时返回 false。
     */
    note: (line) => {
      if (!activeId) return false;
      const job = jobs.get(activeId);
      if (!job || job.status !== STATUS.running) return false;
      log(job, line);
      return true;
    },
    get: (id) => view(jobs.get(String(id))),
    has: (id) => jobs.has(String(id)),
    list: () => order.map((id) => view(jobs.get(id))).filter(Boolean),
    active: () => (activeId ? view(jobs.get(activeId)) : null),
    /**
     * Test hook: forget every finished job.
     * 测试用：清掉已结束的任务。
     */
    clearFinished: () => {
      for (const id of [...order]) {
        const job = jobs.get(id);
        if (!job || job.status === STATUS.running) continue;
        jobs.delete(id);
        order.splice(order.indexOf(id), 1);
      }
    },
    STATUS,
  };
}

module.exports = { createJobs, STATUS, LOG_LIMIT, PROGRESS_INTERVAL_MS };
