'use strict';

const fs = require('fs');
const path = require('path');
const { formatBytes, diskFileName, sanitizeName } = require('../util');
const { runDownloadJob } = require('../job');
const { cancelCurrentDownload } = require('../downloader');
const { t } = require('../i18n');
const view = require('./view');

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
 * Raw keyboard handling during downloads: s skips the current model, Ctrl+C cancels
 * (in raw mode the terminal no longer raises SIGINT, so \u0003 must be handled here).
 *
 * 下载中的原始键盘处理：s 跳过当前模型，Ctrl+C 取消
 * （原始模式下终端不会再自动产生 SIGINT，需要自己处理 \u0003）。
 */
function installKeyHandler(handlers) {
  if (!process.stdin.isTTY) return () => {};
  let wasRaw = false;
  try {
    wasRaw = !!process.stdin.isRaw;
    process.stdin.setRawMode(true);
  } catch (e) {
    return () => {};
  }
  process.stdin.resume();
  const onData = (chunk) => {
    const s = chunk.toString('utf8');
    if (s === 's' || s === 'S') handlers.onSkip();
    else if (s === '\u0003') view.triggerCancel();
  };
  process.stdin.on('data', onData);
  return () => {
    process.stdin.removeListener('data', onData);
    try {
      process.stdin.setRawMode(wasRaw);
    } catch (e) {
      // Ignore failures when restoring the raw mode flag.
      // 恢复原始模式标记失败时忽略。
    }
    try {
      process.stdin.pause();
    } catch (e) {
      // Ignore failures when pausing stdin.
      // 暂停 stdin 失败时忽略。
    }
  };
}

async function runWithProgress(config, opts) {
  const { plan, outDir, totalBytes } = opts;
  const entries = buildFileEntries(outDir, plan);
  const itemTotal = plan.filter((p) => !p.error && !p.skipped).length;

  let okCount = 0;
  let failCount = 0;
  let skipCount = 0;
  let current = null;
  let speed = 0;
  let lastSample = { t: Date.now(), bytes: 0 };
  let cancelling = false;
  let skipRequested = false;
  let attemptInfo = null;

  const sumBytes = () => {
    let sum = 0;
    for (const entry of entries.values()) sum += fileSize(entry);
    return sum;
  };

  const render = () => {
    const width = Math.max(80, Math.min(process.stdout.columns || 120, 200));
    const done = sumBytes();
    const pct = totalBytes > 0 ? (done / totalBytes) * 100 : 0;
    const remain = Math.max(0, totalBytes - done);
    const eta = speed > 1024 ? view.formatDuration(remain / speed) : '--';
    const speedStr = speed > 0 ? `${formatBytes(speed)}/s` : '--';
    const barWidth = Math.max(10, Math.min(Math.floor(width * 0.18), 26));
    const line1 =
      `${view.colors.bold(t('tui.run.downloading'))} ${t('tui.run.counts', {
        ok: okCount,
        skipped: skipCount,
        failed: failCount,
        total: itemTotal,
      })}  ` +
      `${view.progressBar(pct, barWidth)} ${pct.toFixed(1)}%  ${formatBytes(done)}/${formatBytes(totalBytes)}  ${speedStr} · ${t(
        'tui.run.remaining',
        { eta }
      )}`;
    let line2;
    if (current) {
      const size = fileSize(current.entry);
      const fp = current.entry.expected > 0 ? (size / current.entry.expected) * 100 : 0;
      const retry =
        attemptInfo && attemptInfo.attempt > 1
          ? view.colors.yellow(
              ` ${t('tui.run.retry', {
                attempt: attemptInfo.attempt,
                max: attemptInfo.max,
                code: attemptInfo.httpCode || '-',
              })}`
            )
          : '';
      line2 =
        `${t('tui.run.current', { name: view.truncate(current.name, 40) })}  ` +
        `${view.progressBar(fp, 14)} ${fp.toFixed(1)}% ${formatBytes(size)}/${formatBytes(current.entry.expected)}${retry}`;
    } else {
      line2 = view.colors.dim(t('tui.run.waiting'));
    }
    return line1 + '\n' + line2;
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
  const restoreKeys = installKeyHandler({
    onSkip: () => {
      if (skipRequested) return;
      skipRequested = true;
      view.log(t('tui.run.skipNotice'));
    },
  });
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
        onItemStart: () => {
          current = null;
          attemptInfo = null;
        },
        onFileStart: (item, f, dir) => {
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
          else failCount++;
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
  }
}

module.exports = { runWithProgress, buildFileEntries, fileSize, installKeyHandler };
