'use strict';

/**
 * Background download tasks and their queue.
 *
 * A download no longer belongs to the page that started it: the page submits a task, shows a receipt
 * and returns. The task keeps running in this module (one at a time; the core downloader holds a
 * global library lock), and the task registry is the only place where its progress and result live.
 *
 * When another download is already running, the new one is queued: it appears in the task list as
 * `queued` with its position, and starts automatically when the previous task finishes (success,
 * failure or cancellation).
 *
 *
 * 后台下载任务与队列。
 *
 * 下载不再属于启动它的页面：页面提交任务、显示回执后返回。任务在本模块里继续运行
 * （同一时间只跑一个；核心下载器持有全局模型库锁），任务登记表是它进度与结果的唯一定位。
 *
 * 已有下载在跑时，新下载进入队列：在任务列表里显示为 `queued` 与排队位置，
 * 前一个任务结束（成功/失败/取消）后自动开始。
 */

const path = require('path');
const { runDownloadJob } = require('../job');
const { cancelCurrentDownload } = require('../downloader');
const { dataPaths } = require('../storage');
const { formatBytes, formatDuration, diskFileName } = require('../util');
const { t } = require('../i18n');
const view = require('./view');
const tasks = require('./tasks');
const screen = require('./screen');
const { fileSize } = require('./run');

/**
 * The task that currently owns the downloader, and the downloads waiting behind it.
 * 当前占用下载器的任务，以及排在它后面的下载。
 */
let activeJob = null;
const queue = [];

/**
 * Whether a background download is running.
 * 是否有后台下载正在运行。
 */
function hasActiveDownload() {
  return activeJob !== null;
}

/**
 * Number of downloads waiting in the queue.
 * 队列中等待的下载数量。
 */
function queuedDownloads() {
  return queue.length;
}

/**
 * Add the final on-disk destinations of one item to the run's entry map.
 *
 * `names` comes from the job itself (`onItemFiles`), so layout directories, recorded directories and
 * version-suffix renames are already applied. Guessing `outDir/<model name>` here is what made the
 * old progress panel measure files that did not exist (size 0, speed 0).
 *
 *
 * 把某个条目的最终落盘位置加入本次运行的 entry 表。
 *
 * `names` 由 job 自己给出（`onItemFiles`），布局目录、已记录目录与版本后缀改名都已处理。
 * 以前按 `outDir/<模型名>` 猜目录，量到的是不存在的文件（大小为 0、速度 0）。
 */
function addItemEntries(entries, item, dir, names) {
  const files = Array.isArray(item.files) ? item.files : [];
  for (let index = 0; index < files.length; index++) {
    const file = files[index];
    const named = names && names[index] ? names[index].diskName : null;
    const diskName = named || diskFileName(dir, file.name);
    const target = path.join(dir, diskName);
    if (entries.has(target)) continue;
    entries.set(target, {
      target,
      part: `${target}.part`,
      expected: Number(file.bytes) || 0,
    });
  }
}

/**
 * Entry of the file a job just started (the job carries the final disk name).
 * 任务刚开始下载的文件对应的 entry（job 会带上最终落盘文件名）。
 */
function entryOfFile(entries, dir, file) {
  const diskName = (file && file.diskName) || diskFileName(dir, (file && file.name) || '');
  const target = path.join(dir, diskName);
  const existing = entries.get(target);
  if (existing) return existing;
  const created = { target, part: `${target}.part`, expected: Number(file && file.bytes) || 0 };
  entries.set(target, created);
  return created;
}

/**
 * Sum of the bytes on disk for a run's planned files.
 * 一次运行的计划文件已落盘的字节数。
 */
function sumBytes(entries) {
  let sum = 0;
  for (const entry of entries.values()) sum += fileSize(entry);
  return sum;
}

/**
 * Current in-flight files as plain rows for the task registry (and the task view).
 * 当前在途文件的普通行，供任务登记表（与任务视图）使用。
 */
function currentRows(job) {
  const rows = [];
  for (const entry of job.current.values()) {
    const expected = entry.entry.expected || 0;
    const bytes = fileSize(entry.entry);
    rows.push({
      modelId: entry.modelId,
      model: entry.model,
      file: entry.name,
      bytes,
      expected,
    });
  }
  return rows;
}

/**
 * Compute the live snapshot of a running job (bytes, speed, ETA, counts, current files).
 * 计算运行中任务的实时快照（字节、速度、剩余时间、计数、当前文件）。
 */
function snapshot(job) {
  const bytes = sumBytes(job.entries);
  const now = Date.now();
  const dt = (now - job.lastSample.t) / 1000;
  if (dt >= 0.5) {
    const instant = (bytes - job.lastSample.bytes) / dt;
    if (instant >= 0) job.speed = job.speed > 0 ? job.speed * 0.6 + instant * 0.4 : instant;
    job.lastSample = { t: now, bytes };
  }
  const elapsedMs = now - job.startedAt;
  const remaining = Math.max(0, job.totalBytes - bytes);
  const finishedItems = job.done + job.failed;
  const rate = elapsedMs > 0 && bytes > 0 ? bytes / elapsedMs : 0;
  const overhead = finishedItems > 0 ? elapsedMs / finishedItems : 0;
  const pending = Math.max(0, job.itemTotal - finishedItems - job.current.size);
  const etaMs = rate > 0 ? remaining / rate + pending * overhead : 0;
  return {
    bytes,
    speed: job.speed,
    eta: rate > 1024 ? formatDuration(etaMs / 1000) : '',
    elapsed: formatDuration(elapsedMs / 1000),
    done: job.done,
    skipped: job.skipped,
    failed: job.failed,
    current: currentRows(job),
  };
}

/**
 * Push the live numbers into the task registry and ask the shell to repaint.
 * 把实时数字写进任务登记表，并请求外壳重绘。
 */
function publish(job) {
  const state = snapshot(job);
  const first = state.current[0];
  tasks.updateTask(job.taskId, {
    bytes: state.bytes,
    speed: state.speed,
    eta: state.eta,
    done: state.done,
    skipped: state.skipped,
    failed: state.failed,
    scope: first ? first.model : '',
    detail: first ? `${first.model} · ${first.file}` : '',
    current: state.current,
    failures: job.failures.slice(),
    attempts: job.attemptInfo,
  });
  if (screen.isActive()) screen.refresh();
}

/**
 * Start the job that owns the downloader. The caller is the queue pump.
 * 启动占用下载器的任务。调用方是队列泵。
 */
async function runJob(job) {
  activeJob = job;
  job.startedAt = Date.now();
  job.lastSample = { t: job.startedAt, bytes: 0 };
  job.entries = new Map();
  job.itemTotal = job.plan.filter((item) => !item.error && !item.skipped).length;
  job.done = 0;
  job.skipped = 0;
  job.failed = 0;
  job.current = new Map();
  job.failures = [];
  job.lastErrors = new Map();
  job.attemptInfo = null;
  job.speed = 0;
  job.cancelRequested = false;
  job.skipRequested = false;

  tasks.startTask(job.taskId);
  tasks.updateTask(job.taskId, {
    total: job.itemTotal,
    totalBytes: job.totalBytes,
    outDir: job.outDir,
    jobs: job.jobs,
    current: [],
    failures: [],
  });
  if (screen.isActive()) screen.refresh();

  const timer = setInterval(() => {
    try {
      publish(job);
    } catch (e) {
      // A broken progress hint must never break the download.
      // 进度提示出错不能影响下载本身。
    }
  }, 700);
  if (typeof timer.unref === 'function') timer.unref();

  try {
    const summary = await job.runner(
      job.config,
      {
        collectionId: job.collectionId,
        name: job.name,
        plan: job.plan,
        outDir: job.outDir,
        force: job.force,
        totalBytes: job.totalBytes,
        jobs: job.jobs,
        attempts: job.maxAttempts,
        quiet: true,
        isCancelled: () => job.cancelRequested,
        shouldSkipItem: () => {
          if (!job.skipRequested) return false;
          job.skipRequested = false;
          return true;
        },
      },
      {
        log: (line) => {
          tasks.appendLog(job.taskId, line);
          view.log(line);
        },
        onItemStart: (item) => {
          tasks.updateTask(job.taskId, { scope: item ? item.name || String(item.modelId) : '' });
        },
        onItemFiles: (item, dir, names) => {
          addItemEntries(job.entries, item, dir, names);
          // Files that already exist are measured immediately; reset the speed sample so that this
          // jump is not reported as a download speed.
          //
          // 已存在的文件会立刻被统计；重置速度采样，避免把这部分增量显示成下载速度。
          job.lastSample = { t: Date.now(), bytes: sumBytes(job.entries) };
        },
        onFileStart: (item, file, dir) => {
          job.attemptInfo = null;
          job.current.set(String(item.modelId), {
            modelId: String(item.modelId),
            model: item.name || String(item.modelId),
            name: file.diskName || file.name,
            entry: entryOfFile(job.entries, dir, file),
          });
          publish(job);
        },
        onAttempt: (info) => {
          job.attemptInfo = info;
        },
        onFileError: (item, file, error) => {
          job.lastErrors.set(String(item.modelId), (error && error.message) || String(error));
        },
        onFileDone: (item, file, status) => {
          if (status === 'failed') {
            const key = String(item.modelId);
            if (!job.lastErrors.has(key)) job.lastErrors.set(key, file && file.name ? file.name : '');
          }
        },
        onItemDone: (item, ok, status) => {
          job.current.delete(String(item.modelId));
          if (status === 'skipped') {
            job.skipped++;
          } else if (ok) {
            job.done++;
          } else {
            job.failed++;
            if (item && item.name) {
              job.failures.push({
                modelId: item.modelId === undefined ? null : String(item.modelId),
                name: item.name,
                message: job.lastErrors.get(String(item.modelId)) || '',
              });
            }
          }
          publish(job);
        },
      }
    );

    clearInterval(timer);
    const state = snapshot(job);
    const result = {
      collectionId: job.collectionId,
      outDir: job.outDir,
      done: summary.done,
      skipped: summary.skipped,
      failed: summary.failed,
      metaFailed: summary.metaFailed || 0,
      cancelled: !!summary.cancelled,
      error: summary.error || null,
      elapsedMs: summary.elapsedMs || Date.now() - job.startedAt,
      logFile: summary.logFile || job.logFile,
      remaining: summary.remaining || 0,
    };
    const status = summary.cancelled
      ? tasks.CANCELLED
      : summary.failed || summary.error
        ? tasks.FAILED
        : tasks.DONE;
    tasks.updateTask(job.taskId, {
      bytes: state.bytes,
      speed: 0,
      eta: '',
      done: summary.done,
      skipped: summary.skipped,
      failed: summary.failed,
      current: [],
      failures: job.failures.slice(),
      logFile: result.logFile,
      result,
    });
    tasks.finishTask(job.taskId, status, result);
    // A failure list is only useful for a retry when the items still carry their file list.
    // 只有条目还带着文件清单时，失败列表才值得重试。
    if (retryPlan(job).length > 0) {
      tasks.setTaskRetry(job.taskId, () => retryFailed(job));
    }
    if (typeof job.onComplete === 'function') {
      try {
        await job.onComplete(summary, job);
      } catch (e) {
        view.log(t('tui.download.postProcessFailed', { error: (e && e.message) || e }));
      }
    }
    announceResult(job, result);
    activeJob = null;
    if (screen.isActive()) screen.refresh();
    pump();
  } catch (error) {
    clearInterval(timer);
    const message = (error && error.message) || String(error);
    tasks.updateTask(job.taskId, {
      failures: job.failures.slice(),
      current: [],
      logFile: job.logFile,
      result: { error: message, outDir: job.outDir },
    });
    tasks.finishTask(job.taskId, tasks.FAILED, { error: message, outDir: job.outDir });
    view.notice(t('tui.download.taskFailedNotice', { error: message }), view.colors.red);
    view.log(t('tui.download.taskFailedNotice', { error: message }));
    activeJob = null;
    if (screen.isActive()) screen.refresh();
    pump();
  }
}

/**
 * The planned items whose download failed and that still carry a file list (retryable).
 * 下载失败且仍带文件清单（可重试）的计划项。
 */
function retryPlan(job) {
  const failedIds = new Set(job.failures.map((failure) => String(failure.modelId)));
  return job.plan.filter(
    (item) => failedIds.has(String(item.modelId)) && Array.isArray(item.files) && item.files.length > 0
  );
}

/**
 * Re-queue the failed items of a finished job as a new download task.
 * 把已结束任务的失败项重新排进任务队列。
 */
function retryFailed(job) {
  const plan = retryPlan(job);
  if (!plan.length) return false;
  const totalBytes = plan.reduce((sum, item) => sum + (Number(item.totalBytes) || 0), 0);
  startDownloadTask(job.config, {
    collectionId: job.collectionId,
    name: t('tui.download.retryName', { name: job.name || job.collectionId }),
    plan,
    outDir: job.outDir,
    force: true,
    totalBytes,
    jobs: job.jobs,
    attempts: job.maxAttempts,
    onComplete: null,
  });
  return true;
}

/**
 * Start the next queued job, if the downloader is free.
 * 下载器空闲时启动队列里的下一个任务。
 */
function pump() {
  if (activeJob || !queue.length) return;
  const next = queue.shift();
  if (!next) return;
  startQueued(next);
}

/**
 * Start one job that was waiting in the queue (its task id already exists).
 * 启动一个已在队列中等待的任务（它的任务 id 已存在）。
 */
function startQueued(job) {
  runJob(job).catch((error) => {
    // runJob handles its own failures; this catch covers a failure in its setup (before the inner
    // try) so the queue can never stall with a "running" task that has no runner.
    //
    // runJob 自己处理运行中的失败；这个 catch 覆盖它内部 try 之前的准备阶段，
    // 避免队列卡在一个「运行中」却没有执行者的任务上。
    const message = (error && error.message) || String(error);
    tasks.updateTask(job.taskId, { current: [], result: { error: message } });
    tasks.finishTask(job.taskId, tasks.FAILED, { error: message, outDir: job.outDir });
    view.notice(t('tui.download.taskFailedNotice', { error: message }), view.colors.red);
    if (activeJob === job) activeJob = null;
    if (screen.isActive()) screen.refresh();
    pump();
  });
}

/**
 * Announce the finish of a download in the frame (and keep the task view as the detailed record).
 * 在框架里提示下载结束（详细记录留在任务视图）。
 */
function announceResult(job, result) {
  const stats = {
    done: result.done,
    skipped: result.skipped,
    failed: result.failed,
    metaFailed: result.metaFailed,
  };
  const hint = t('tui.download.viewTasksHint');
  let text;
  let color;
  if (result.error) {
    text = t('tui.download.taskFailedNotice', { error: result.error });
    color = view.colors.red;
  } else if (result.cancelled) {
    text = `${t('tui.download.summaryCancelled', stats)}${hint}`;
    color = view.colors.yellow;
  } else if (result.failed) {
    text = `${t('tui.download.summaryDone', stats)}${hint}`;
    color = view.colors.yellow;
  } else {
    text = `${t(result.metaFailed ? 'tui.download.summaryDoneMeta' : 'tui.download.summaryDone', stats)}${hint}`;
    color = view.colors.green;
  }
  view.notice(text, color);
  view.bell();
}

/**
 * Submit a download to the task list. It starts immediately unless another download is running, in
 * which case it is queued and starts automatically when the previous one finishes.
 *
 * 把一个下载提交到任务列表。没有下载在跑时立即开始；否则排队，等前一个结束后自动开始。
 *
 * @param {object} config
 * @param {{
 *   collectionId:string|number, name?:string, plan:Array, outDir:string, force?:boolean,
 *   totalBytes?:number, jobs?:number, attempts?:number, onComplete?:Function
 * }} opts
 * @returns {{taskId:string, queued:boolean, position:number}}
 */
function startDownloadTask(config, opts) {
  const plan = Array.isArray(opts.plan) ? opts.plan.filter(Boolean) : [];
  const totalBytes =
    opts.totalBytes === undefined || opts.totalBytes === null
      ? plan.reduce((sum, item) => sum + (Number(item.totalBytes) || 0), 0)
      : Number(opts.totalBytes) || 0;
  const outDir = String(opts.outDir || config.outDir || '');
  const jobs = Math.max(1, Math.min(Number(opts.jobs) || Number(config.jobs) || 1, 8));
  const collectionId = String(opts.collectionId || `task-${Date.now()}`);
  const name = String(opts.name || collectionId);
  const queued = hasActiveDownload();
  const taskId = tasks.createTask({
    kind: 'download',
    name,
    total: plan.length,
    totalBytes,
    outDir,
    jobs,
    status: queued ? tasks.QUEUED : tasks.RUNNING,
  });
  const job = {
    taskId,
    config: {
      ...config,
      fileTypes: Array.isArray(config.fileTypes) ? config.fileTypes.slice() : config.fileTypes,
    },
    collectionId,
    name,
    plan,
    outDir,
    force: !!opts.force,
    totalBytes,
    jobs,
    maxAttempts: opts.attempts,
    onComplete: opts.onComplete,
    // Tests (and embedders) can replace the whole downloader; production uses the real job.
    // 测试（与嵌入方）可以替换整个下载器；生产使用真实任务。
    runner: typeof opts.runner === 'function' ? opts.runner : runDownloadJob,
    logFile: dataPaths(config, collectionId).log,
    startedAt: 0,
    lastSample: { t: 0, bytes: 0 },
    entries: new Map(),
    itemTotal: plan.length,
    done: 0,
    skipped: 0,
    failed: 0,
    current: new Map(),
    failures: [],
    lastErrors: new Map(),
    attemptInfo: null,
    speed: 0,
    cancelRequested: false,
    skipRequested: false,
  };
  tasks.updateTask(taskId, { logFile: job.logFile });

  // Cancel works differently depending on where the task is: a queued task leaves the queue; a
  // running one asks the downloader to stop and reports `cancelled` when the job settles.
  //
  // 取消在两种位置语义不同：排队中的任务离开队列；运行中的任务请求下载器停止，任务结束时报告「已取消」。
  tasks.setTaskCancel(taskId, () => {
    if (activeJob === job) {
      job.cancelRequested = true;
      cancelCurrentDownload();
      return;
    }
    const index = queue.indexOf(job);
    if (index >= 0) queue.splice(index, 1);
    if (screen.isActive()) screen.refresh();
    if (!activeJob) pump();
  });
  tasks.setTaskSkip(taskId, () => {
    if (activeJob !== job) return;
    job.skipRequested = true;
    view.note(t('tui.run.skipNotice'));
  });

  if (queued) {
    queue.push(job);
    if (screen.isActive()) screen.refresh();
    return { taskId, queued: true, position: tasks.queuePosition(taskId) };
  }
  startQueued(job);
  return { taskId, queued: false, position: 0 };
}

module.exports = {
  startDownloadTask,
  hasActiveDownload,
  queuedDownloads,
  // Exposed for tests.
  // 供测试使用
  _snapshot: snapshot,
  _sumBytes: sumBytes,
  _currentRows: currentRows,
};
