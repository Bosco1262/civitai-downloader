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
    `${speed} · ${t('tui.run.remaining', { eta: state.eta })}`,
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

async function runWithProgress(config, opts) {
  const { plan, outDir, totalBytes } = opts;
  const entries = buildFileEntries(outDir, plan);
  const itemTotal = plan.filter((p) => !p.error && !p.skipped).length;

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

  const render = () => {
    const width = Math.max(40, process.stdout.columns || 100);
    const done = sumBytes();
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
    const eta = rate > 1024 ? view.formatDuration(etaMs / 1000) : '--';
    const summary = buildSummaryLine({
      done: okCount,
      skipped: skipCount,
      failed: failCount,
      total: itemTotal,
      bytes: done,
      expected: totalBytes,
      speed,
      eta,
      elapsed: view.formatDuration(elapsedMs / 1000),
      width,
    });
    const currentLine = buildCurrentLine({
      width,
      model: currentItem ? currentItem.name : '',
      file: current ? current.name : '',
      bytes: current ? fileSize(current.entry) : 0,
      expected: current ? current.entry.expected : 0,
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
    view.redrawStatus();
  }, 700);

  view.setCancelHandler(() => {
    if (cancelling) {
      console.log('');
      process.exit(130);
    }
    cancelling = true;
    view.log(t('tui.run.cancelNotice'));
    cancelCurrentDownload();
  });
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
        onFileStart: (item, f, dir) => {
          currentItem = item ? { modelId: item.modelId, name: item.name || String(item.modelId) } : currentItem;
          current = { name: f.name, entry: resolveEntry(entries, dir, f.name) };
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
  installKeyHandler,
  buildPanel,
  buildSummaryLine,
  buildCurrentLine,
  buildKeysLine,
};
