'use strict';

/**
 * Progress panel of a running download job.
 *
 * The panel is a three-line status block: overall progress (bar, bytes, speed, ETA, elapsed), the
 * file being downloaded right now (model + file + per-file bar + retries), and the keys that do
 * something (s skips the current model, Ctrl+C cancels; a second Ctrl+C force-quits).
 *
 * The text builders are pure functions so the layout can be unit-tested without a terminal.
 *
 *
 * 下载任务的进度面板。
 *
 * 面板是三行状态：总体进度（进度条、字节、速度、剩余时间、已用时）、
 * 当前文件（模型 + 文件 + 单文件进度 + 重试信息），以及当前可用的按键
 * （s 跳过当前模型，Ctrl+C 取消；再按一次强制退出）。
 *
 * 文本构造是纯函数，便于在没有终端的情况下单测排版。
 */

const fs = require('fs');
const path = require('path');
const { formatBytes, diskFileName, sanitizeName, formatDuration } = require('../util');
const { runDownloadJob } = require('../job');
const { cancelCurrentDownload } = require('../downloader');
const { t } = require('../i18n');
const view = require('./view');
const tasks = require('./tasks');
const { installRawKeys } = require('./keys');

function itemDir(outDir, item) {
  const base = item.outDirOverride ? path.resolve(item.outDirOverride) : outDir;
  const dirName = item.dirName || sanitizeName(item.name);
  return path.join(base, dirName);
}

function buildFileEntries(outDir, plan) {
  const entries = new Map();
  for (const item of plan) {
    if (item.error) continue;
    const dir = itemDir(outDir, item);
    for (const f of item.files) {
      const target = path.join(dir, diskFileName(dir, f.name));
      entries.set(target, { target, part: target + '.part', expected: f.bytes || 0 });
    }
  }
  return entries;
}

function fileSize(entry) {
  try {
    const st = fs.statSync(entry.target);
    if (st.size > 0) return entry.expected ? Math.min(st.size, entry.expected) : st.size;
  } catch (e) {
    // Not finished yet.
    // 尚未完成
  }
  try {
    const st = fs.statSync(entry.part);
    return entry.expected ? Math.min(st.size, entry.expected) : st.size;
  } catch (e) {
    return 0;
  }
}

function resolveEntry(entries, dir, fileName) {
  const target = path.join(dir, diskFileName(dir, fileName));
  return entries.get(target) || { target, part: target + '.part', expected: 0 };
}

/**
 * Add the final destinations of one item to the progress map (directories and names come from the
 * job, which knows the layout and version-suffix renames).
 *
 * 把一个条目的最终落盘位置加入进度表（目录与文件名来自 job，它知道布局与版本后缀改名）。
 */
function addItemEntries(entries, item, dir, names) {
  const files = Array.isArray(item.files) ? item.files : [];
  for (let index = 0; index < files.length; index++) {
    const file = files[index];
    const named = names && names[index] ? names[index].diskName : null;
    const target = path.join(dir, named || diskFileName(dir, file.name));
    if (entries.has(target)) continue;
    entries.set(target, {
      target,
      part: `${target}.part`,
      expected: Number(file.bytes) || 0,
    });
  }
}

/**
 * Overall progress line: counts, bar, bytes, speed, ETA, elapsed.
 * 总体进度行：计数、进度条、字节、速度、剩余时间、已用时。
 *
 * @param {{
 *   done:number, skipped:number, failed:number, total:number, bytes:number, expected:number,
 *   speed:number, eta:string, elapsed:string, width:number
 * }} state
 * @returns {string}
 */

function buildSummaryLine(state) {
  const width = Math.max(24, Math.floor(Number(state.width) || 100));
  const pct = state.expected > 0 ? (state.bytes / state.expected) * 100 : 0;
  const speed = state.speed > 0 ? `${formatBytes(state.speed)}/s` : '--';
  const parts = [
    `${formatBytes(state.bytes)}/${formatBytes(state.expected)}`,
    `${speed}${view.separator()}${t('tui.run.remaining', { eta: state.eta })}`,
    t('tui.run.elapsed', { elapsed: state.elapsed }),
  ];
  const head = `${view.colors.bold(t('tui.run.downloading'))} ${t('tui.run.counts', {
    ok: state.done,
    skipped: state.skipped,
    failed: state.failed,
    total: state.total,
  })}`;
  const fixed = view.displayWidth(head) + 4 + parts.reduce((sum, p) => sum + view.displayWidth(p) + 3, 0);
  const barWidth = Math.max(6, Math.min(width - fixed, 28));
  return `${head}  ${view.progressBar(pct, barWidth)} ${pct.toFixed(1)}%  ${parts.join('  ')}`;
}

/**
 * Current-file line: which model and file are being fetched, plus per-file progress and retries.
 * 当前文件行：正在下载哪个模型的哪个文件，含单文件进度与重试信息。
 *
 * @param {{
 *   width:number, model:string, file:string, bytes:number, expected:number,
 *   attempt:{attempt:number, max:number, httpCode:number}|null
 * }} state
 * @returns {string}
 */

function buildCurrentLine(state) {
  const width = Math.max(24, Math.floor(Number(state.width) || 100));
  if (!state.file) return view.colors.dim(t('tui.run.waiting'));
  const pct = state.expected > 0 ? (state.bytes / state.expected) * 100 : 0;
  const retry =
    state.attempt && state.attempt.attempt > 1
      ? view.colors.yellow(
          ` ${t('tui.run.retry', {
            attempt: state.attempt.attempt,
            max: state.attempt.max,
            code: state.attempt.httpCode || '-',
          })}`
        )
      : '';
  const prefix = `${t('tui.run.fileLabel')} `;
  const model = state.model ? view.colors.dim(`[${state.model}] `) : '';
  const size = `${formatBytes(state.bytes)}/${formatBytes(state.expected)}`;
  // The tail (bar + percentage + sizes + retry marker) is fixed; whatever is left goes to the name.
  // 尾部（进度条 + 百分比 + 大小 + 重试标记）宽度固定，剩下的都留给文件名。
  const tail = `  ${view.progressBar(pct, 14)} ${pct.toFixed(1)}% ${size}${retry}`;
  const nameWidth = Math.max(
    12,
    width - view.displayWidth(prefix) - view.displayWidth(model) - view.displayWidth(tail)
  );
  return `${prefix}${model}${view.truncateTo(state.file, nameWidth)}${tail}`;
}

/**
 * Key-hint line; the escape hint is spelled out because raw mode swallows SIGINT.
 * 按键提示行；原始模式下 SIGINT 被吞掉，所以把 Ctrl+C 的语义写清楚。
 * @returns {string}
 */
function buildKeysLine() {
  return view.colors.dim(`  ${t('tui.run.keys')}`);
}

/**
 * Full panel text (the status renderer draws exactly this).
 * 完整面板文本（状态渲染器原样绘制）。
 */
function buildPanel(state) {
  return [buildSummaryLine(state), buildCurrentLine(state), buildKeysLine()].join('\n');
}

/**
 * Raw keyboard handling during downloads: s skips the current model, Ctrl+C cancels
 * (in raw mode the terminal no longer raises SIGINT, so \u0003 must be handled here).
 *
 * Returns null when the terminal cannot provide raw keys; the download still runs and can be
 * stopped with a real SIGINT (the terminal's Ctrl+C) instead.
 *
 *
 * 下载中的原始键盘处理：s 跳过当前模型，Ctrl+C 取消
 * （原始模式下终端不会再自动产生 SIGINT，需要自己处理 \u0003）。
 *
 * 终端拿不到原始按键时返回 null；下载照常进行，可以用真正的 SIGINT（终端发出的 Ctrl+C）停止。
 */
function installKeyHandler(handlers) {
  const onSkip = handlers && typeof handlers.onSkip === 'function' ? handlers.onSkip : () => {};
  // Inside the app shell the shell owns the keyboard: a second raw-mode listener would fight it for
  // the same keypresses (and switching raw mode off on restore would mute the whole UI), so the skip
  // key is registered as a hook instead. Outside the shell the raw listener is the only way.
  //
  // 应用外壳里键盘归外壳所有：再装一个原始模式监听会与它抢同一批按键
  // （还原时还会关掉原始模式，让整个界面失去输入），因此跳过键改为登记成钩子。
  // 没有外壳时，原始监听是唯一可行的方式。
  if (screen.isActive()) {
    screen.setKeyHook((text) => {
      if (text === 's' || text === 'S') {
        onSkip();
        return true;
      }
      return false;
    });
    return () => screen.setKeyHook(null);
  }
  return installRawKeys({
    onKey: (text) => {
      if (text === 's' || text === 'S') onSkip();
    },
    // Ctrl+C goes through the shared cancel entry point so it behaves like SIGINT.
    // Ctrl+C 走统一的取消入口，与 SIGINT 行为一致。
    onSignal: (intent) => {
      if (intent === 'cancel') view.triggerCancel();
    },
  });
}

/**
 * Watch a download job run and report its progress everywhere the TUI can show it.
 *
 * Progress goes to two places at once: the legacy three-line status block of the plain path (CI,
 * redirected runs) and the task registry of the app shell, which renders it in the info panel and in
 * the task view behind Tab.
 *
 *
 * 观察下载任务的运行，并把进度汇报到 TUI 所有能显示它的地方。
 *
 * 进度同时送往两处：简易路径的传统三行状态块（CI、重定向运行），以及应用外壳的任务表——
 * 后者把它渲染在信息面板与 Tab 打开的任务视图里。
 *
 * @param {object} config
 * @param {{plan:Array, outDir:string, totalBytes:number, name?:string, collectionId?:string}} opts
 * @returns {Promise<any>}
 */
async function runWithProgress(config, opts) {
  const { plan, outDir, totalBytes } = opts;
  // Entries are added when the job tells us the final directory and disk names (`onItemFiles`):
  // the layout and version-suffix renames make `outDir/<model>` a wrong guess.
  //
  // entry 在 job 给出最终目录与落盘文件名时才加入（`onItemFiles`）：
  // 布局与版本后缀改名会让 `outDir/<模型>` 这个猜测不成立。
  const entries = new Map();
  const itemTotal = plan.filter((p) => !p.error && !p.skipped).length;
  // Human label of the run: the collection (or model) name the flows pass in, then the collection id,
  // then an empty label. The flows start passing `name` later, so the option stays optional.
  //
  // 这次运行的人读标签：优先各流程传入的收藏集（或模型）名，其次收藏集 ID，最后留空。
  // 各流程稍后才会传 `name`，因此该选项保持可选。
  const taskName = String(opts.name || opts.collectionId || '');
  // Register the run in the task registry: the shell shows it in the info panel while it lasts and in
  // the task view afterwards. Without the shell the registry is inert.
  //
  // 把这次运行登记到任务表：外壳在运行期间把它显示在信息面板里，结束后仍留在任务视图里。
  // 没有外壳时任务表不起作用。
  const taskId = tasks.createTask({ kind: 'download', name: taskName, total: itemTotal, totalBytes });

  const started = Date.now();
  let okCount = 0;
  let failCount = 0;
  let skipCount = 0;
  let current = null;
  let currentItem = null;
  let speed = 0;
  let lastSample = { t: Date.now(), bytes: 0 };
  let cancelling = false;
  let skipRequested = false;
  let attemptInfo = null;
  const failedNames = [];

  const sumBytes = () => {
    let sum = 0;
    for (const entry of entries.values()) sum += fileSize(entry);
    return sum;
  };

  /**
   * One measurement of the run: bytes on disk, the rate-based ETA, and the file being fetched.
   *
   * Both consumers read the same numbers, so the legacy status block, the info panel and the task view
   * can never disagree about what is going on.
   *
   *
   * 一次运行测量：磁盘上的字节数、按速率推算的剩余时间，以及正在下载的文件。
   *
   * 两个消费者读的是同一组数字，传统状态块、信息面板与任务视图因此不会互相矛盾。
   */
  const snapshot = (done) => {
    const remaining = Math.max(0, totalBytes - done);
    const elapsedMs = Date.now() - started;
    // ETA mixes the byte rate with the per-item overhead, so a long queue with many small items does
    // not report "00:00" forever.
    //
    // 剩余时间同时考虑字节速率与每项的固定开销，条目多而体积小时不会一直显示 00:00。
    const finishedItems = okCount + failCount;
    const rate = elapsedMs > 0 && done > 0 ? done / elapsedMs : 0;
    const overhead = finishedItems > 0 ? elapsedMs / finishedItems : 0;
    const pending = Math.max(0, itemTotal - finishedItems - (currentItem ? 1 : 0));
    const etaMs = rate > 0 ? remaining / rate + pending * overhead : 0;
    return {
      bytes: done,
      eta: rate > 1024 ? view.formatDuration(etaMs / 1000) : '--',
      elapsed: view.formatDuration(elapsedMs / 1000),
      model: currentItem ? currentItem.name : '',
      file: current ? current.name : '',
      fileBytes: current ? fileSize(current.entry) : 0,
      fileExpected: current ? current.entry.expected : 0,
    };
  };

  const render = () => {
    const width = Math.max(40, process.stdout.columns || 100);
    const state = snapshot(sumBytes());
    const summary = buildSummaryLine({
      done: okCount,
      skipped: skipCount,
      failed: failCount,
      total: itemTotal,
      bytes: state.bytes,
      expected: totalBytes,
      speed,
      eta: state.eta,
      elapsed: state.elapsed,
      width,
    });
    const currentLine = buildCurrentLine({
      width,
      model: state.model,
      file: state.file,
      bytes: state.fileBytes,
      expected: state.fileExpected,
      attempt: attemptInfo,
    });
    return `${summary}\n${currentLine}\n${buildKeysLine()}`;
  };

  const timer = setInterval(() => {
    const now = Date.now();
    const bytes = sumBytes();
    const dt = (now - lastSample.t) / 1000;
    if (dt >= 0.5) {
      const inst = (bytes - lastSample.bytes) / dt;
      if (inst >= 0) speed = speed > 0 ? speed * 0.6 + inst * 0.4 : inst;
      lastSample = { t: now, bytes };
    }
    const state = snapshot(bytes);
    // The model goes to `scope` (the info panel reads "collection · model") and the model plus the file
    // to `detail`, which is what the task view prints under the progress line.
    //
    // 模型放进 `scope`（信息面板由此显示「收藏集 · 模型」），模型加文件放进 `detail`，
    // 也就是任务视图在进度行下面打印的内容。
    tasks.updateTask(taskId, {
      bytes: state.bytes,
      speed,
      eta: state.eta,
      done: okCount,
      skipped: skipCount,
      failed: failCount,
      scope: state.model,
      detail: [state.model, state.file].filter(Boolean).join(view.separator()),
    });
    view.redrawStatus();
  }, 700);

  /**
   * Cancel the run: the first press stops the current download, a second one force-quits.
   *
   * Esc (through `view.setCancelHandler`) and the task view's `c` key (through the registry) both end
   * up here, so there is exactly one cancel path.
   *
   *
   * 取消本次运行：第一次停止当前下载，再按一次强制退出。
   *
   * Esc（经由 `view.setCancelHandler`）与任务视图的 `c` 键（经由任务表）都走到这里，取消路径只有一条。
   */
  const cancelRun = () => {
    if (cancelling) {
      // Asking twice is not an error: the first request already stopped the transfer, and a forced
      // process exit is left to Ctrl+C (which the app shell handles).
      //
      // 再按一次不算错误：第一次请求已经停下载，强制退出进程交给 Ctrl+C（由应用外壳处理）。
      view.note(t('tui.run.cancelPending'));
      return;
    }
    cancelling = true;
    view.log(t('tui.run.cancelNotice'));
    cancelCurrentDownload();
  };

  view.setCancelHandler(cancelRun);
  // The task view's `c` key asks the registry, which forwards to the very same handler.
  // 任务视图的 `c` 键询问任务表，任务表把它转给同一个回调。
  tasks.setTaskCancel(taskId, cancelRun);
  const restoreKeys =
    installKeyHandler({
      onSkip: () => {
        if (skipRequested) return;
        skipRequested = true;
        view.log(t('tui.run.skipNotice'));
      },
    }) || (() => {});
  view.beginStatus(render);

  try {
    return await runDownloadJob(
      config,
      {
        ...opts,
        quiet: true,
        isCancelled: () => cancelling,
        shouldSkipItem: () => {
          if (!skipRequested) return false;
          skipRequested = false;
          return true;
        },
      },
      {
        onItemStart: (item) => {
          current = null;
          attemptInfo = null;
          currentItem = item ? { modelId: item.modelId, name: item.name || String(item.modelId) } : null;
        },
        onItemFiles: (item, dir, names) => {
          addItemEntries(entries, item, dir, names);
          // Existing files are counted immediately; do not report that jump as download speed.
          // 已存在的文件会立刻计入；不要把这次跳变当成下载速度。
          lastSample = { t: Date.now(), bytes: sumBytes() };
        },
        onFileStart: (item, f, dir) => {
          currentItem = item ? { modelId: item.modelId, name: item.name || String(item.modelId) } : currentItem;
          current = { name: f.diskName || f.name, entry: resolveEntry(entries, dir, f.diskName || f.name) };
          attemptInfo = null;
        },
        onAttempt: (info) => {
          attemptInfo = info;
        },
        onItemDone: (item, ok, status) => {
          current = null;
          attemptInfo = null;
          if (status === 'skipped') skipCount++;
          else if (ok) okCount++;
          else {
            failCount++;
            if (item && item.name) failedNames.push(item.name);
          }
        },
        onSkip: () => {
          skipCount++;
        },
      }
    );
  } finally {
    clearInterval(timer);
    restoreKeys();
    view.setCancelHandler(null);
    // Final numbers: the run is over, but the task view keeps showing it and the last timer tick may be
    // almost a second old.
    //
    // 收尾数字：运行已经结束，但任务视图仍会显示它，而最后一次定时刷新可能已经过去近一秒。
    tasks.updateTask(taskId, {
      bytes: sumBytes(),
      speed: 0,
      eta: '',
      done: okCount,
      skipped: skipCount,
      failed: failCount,
      detail: '',
    });
    // A finished task must not stay cancellable: a stale handler would cancel whatever runs next.
    // 已结束的任务不能还留着取消回调：残留的回调会取消下一次运行。
    tasks.setTaskCancel(taskId, null);
    // Cancelled wins over failed: the user asked for it, and the failed count usually also contains the
    // item that was interrupted.
    //
    // 「取消」优先于「失败」：那是用户要求的，而失败计数里通常还包含被打断的那一项。
    tasks.finishTask(taskId, cancelling ? tasks.CANCELLED : failCount > 0 ? tasks.FAILED : tasks.DONE);
    view.endStatus();
    if (failedNames.length) {
      view.log(
        view.colors.red(
          t('tui.run.failedItems', { count: failedNames.length, names: view.truncate(failedNames.join(', '), 120) })
        )
      );
    }
  }
}

module.exports = {
  runWithProgress,
  buildFileEntries,
  fileSize,
  resolveEntry,
  installKeyHandler,
  buildPanel,
  buildSummaryLine,
  buildCurrentLine,
  buildKeysLine,
};
