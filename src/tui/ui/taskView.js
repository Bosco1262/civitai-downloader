'use strict';

/**
 * Task view line builders. The shell calls these with the task registry's state.
 * 任务视图的行构建器。外壳传入任务登记表状态；构建器不接触终端，因此可直接单测。
 */

const { t } = require('../../i18n');
const layout = require('../layout');
const tasks = require('../tasks');
const { formatBytes, formatDuration } = require('../../util');

const { displayWidth, truncateTo, padTo } = layout;
const { color } = require('../tokens');

/**
 * Progress bar text of the info panel and the task view.
 * 信息面板与任务视图使用的进度条文本。
 *
 * @param {number} pct
 * @param {number} width
 * @returns {string}
 */
function progressBar(pct, width) {
  const w = Math.max(4, Math.floor(width));
  const clamped = Math.max(0, Math.min(100, Number.isFinite(pct) ? pct : 0));
  const filled = Math.round((clamped / 100) * w);
  const gl = layout.glyphs();
  const bar = gl.barFull.repeat(filled) + gl.barEmpty.repeat(Math.max(0, w - filled));
  return color.cursor(bar);
}

/**
 * The fixed one-line task overview across all tasks in the registry.
 * 对登记表里的全部任务合计出的固定一行总览。
 *
 * @param {Array<object>} allTasks
 * @param {number} [width]
 * @returns {string}
 */
function taskOverviewLine(allTasks, width = 100) {
  if (!allTasks.length) return color.muted(t('tui.screen.infoIdle'));
  const hasActive = allTasks.some((task) => task.status === tasks.RUNNING || task.status === tasks.QUEUED);
  if (!hasActive) return color.muted(t('tui.screen.infoIdle'));
  let done = 0;
  let running = 0;
  let queued = 0;
  let failed = 0;
  let cancelled = 0;
  let totalBytes = 0;
  let bytes = 0;
  for (const task of allTasks) {
    totalBytes += Number(task.totalBytes) || 0;
    bytes += Number(task.bytes) || 0;
    if (task.status === tasks.DONE) done++;
    else if (task.status === tasks.RUNNING) running++;
    else if (task.status === tasks.QUEUED) queued++;
    else if (task.status === tasks.CANCELLED) cancelled++;
    else failed++;
  }
  const total = allTasks.length;
  const raw = totalBytes > 0 ? (bytes / totalBytes) * 100 : total > 0 ? (done / total) * 100 : 0;
  const pct = Math.max(0, Math.min(100, raw));
  const head = t('tui.screen.infoProgress');
  const parts = [t('tui.screen.infoDoneCount', { done, total })];
  if (running) parts.push(t('tui.screen.infoRunningCount', { count: running }));
  if (queued) parts.push(t('tui.screen.infoQueuedCount', { count: queued }));
  if (failed) parts.push(t('tui.screen.infoFailedCount', { count: failed }));
  if (cancelled) parts.push(t('tui.screen.infoCancelledCount', { count: cancelled }));
  const tail = parts.join(color.muted(layout.glyphs().separator));
  const barWidth = Math.max(8, Math.min(24, width - displayWidth(head) - displayWidth(tail) - 10));
  return `${head}  ${progressBar(pct, barWidth)} ${pct.toFixed(1)}%  ${color.muted(layout.glyphs().bullet)} ${tail}`;
}

/**
 * Display name of a task: the collection, plus the model currently being fetched.
 * 任务的显示名：收藏集，外加当前正在下载的模型。
 *
 * @param {object} task
 * @returns {string}
 */
function taskHead(task) {
  const parts = [task.name, task.scope].filter(Boolean);
  return parts.join(color.muted(` ${t('tui.screen.nameSeparator')} `));
}

/**
 * One line of the task list.
 * 任务列表的一行。
 *
 * @param {object} task
 * @param {boolean} cursor
 * @returns {string}
 */
function taskLine(task, cursor) {
  const mark = cursor ? color.cursor(layout.glyphs().cursor) : ' ';
  const kind = task.kind ? `${color.muted(`[${task.kind}]`)} ` : '';
  const head = taskHead(task) || task.id;
  const status = statusText(task);
  if (task.status === tasks.QUEUED) {
    return `${mark} ${kind}${head}  ${status} ${color.muted(
      t('tui.screen.taskQueuePosition', { position: tasks.queuePosition(task.id) })
    )}`;
  }
  return `${mark} ${kind}${head}  ${status}  ${color.muted(
    t('tui.screen.taskElapsed', { elapsed: tasks.elapsedText(task) })
  )}`;
}

/**
 * Expanded detail of one task.
 * 单个任务的展开详情。
 *
 * @param {object} task
 * @param {number} width
 * @param {number} max
 * @returns {string[]}
 */
function taskDetailLines(task, width, max) {
  const limit = Math.max(1, Math.floor(max) || 1);
  const lines = [];
  const push = (line) => {
    if (lines.length < limit) lines.push(line);
  };
  const bullet = color.muted(` ${layout.glyphs().bullet} `);

  if (task.status === tasks.QUEUED) {
    push(color.warning(t('tui.screen.taskQueuedLine', { position: tasks.queuePosition(task.id) })));
    push(
      [
        t('tui.screen.taskPlanSummary', { count: task.total, size: formatBytes(task.totalBytes) }),
        task.outDir ? t('tui.screen.taskOutDirShort', { dir: task.outDir }) : null,
      ]
        .filter(Boolean)
        .join(bullet)
    );
    return lines;
  }

  if (task.status === tasks.RUNNING) {
    const pct = tasks.percentOf(task);
    const parts = [
      `${progressBar(pct, 16)} ${pct.toFixed(1)}%`,
      `${formatBytes(task.bytes)}/${formatBytes(task.totalBytes)}`,
    ];
    if (task.speed > 0) parts.push(t('tui.screen.taskSpeed', { speed: `${formatBytes(task.speed)}/s` }));
    if (task.eta) parts.push(t('tui.run.remaining', { eta: task.eta }));
    if (task.attempts && task.attempts.attempt > 1) {
      parts.push(
        color.warning(
          t('tui.run.retry', {
            attempt: task.attempts.attempt,
            max: task.attempts.max,
            code: task.attempts.httpCode || '-',
          })
        )
      );
    }
    push(parts.join(bullet));
    push(
      [
        t('tui.screen.taskCounts', {
          done: task.done,
          skipped: task.skipped,
          failed: task.failed,
          total: task.total,
        }),
        task.jobs > 1 ? t('tui.screen.taskJobs', { jobs: task.jobs }) : null,
      ]
        .filter(Boolean)
        .join(bullet)
    );
    const current = Array.isArray(task.current) ? task.current : [];
    if (!current.length) {
      push(color.muted(t('tui.screen.taskWaitingFile')));
    } else {
      for (const entry of current) {
        if (lines.length >= limit - 1) break;
        push(taskCurrentLine(entry));
      }
    }
    for (const failure of task.failures.slice(0, Math.max(0, limit - lines.length))) {
      push(taskFailureLine(failure));
    }
    return lines;
  }

  const result = task.result || {};
  const summary = [
    t('tui.screen.taskResultCounts', {
      done: result.done === undefined ? task.done : result.done,
      skipped: result.skipped === undefined ? task.skipped : result.skipped,
      failed: result.failed === undefined ? task.failed : result.failed,
    }),
  ];
  if (result.metaFailed) summary.push(t('tui.screen.taskMetaFailed', { count: result.metaFailed }));
  if (result.elapsedMs !== undefined) {
    summary.push(t('tui.screen.taskElapsed', { elapsed: formatDuration(result.elapsedMs / 1000) }));
  }
  push(summary.join(bullet));
  if (result.error) {
    push(color.danger(t('tui.screen.taskError', { error: result.error })));
  }

  const failures = Array.isArray(task.failures) ? task.failures : [];
  for (const failure of failures.slice(0, Math.max(0, Math.min(3, limit - lines.length - 2)))) {
    push(taskFailureLine(failure));
  }
  if (task.logFile) {
    push(color.muted(t('tui.screen.taskLogFile', { file: task.logFile })));
  }
  if (task.outDir) {
    push(color.muted(t('tui.screen.taskOutDir', { dir: task.outDir })));
  }
  return lines;
}

/**
 * One in-flight file line.
 * 一个在途文件的行。
 *
 * @param {object} entry
 * @returns {string}
 */
function taskCurrentLine(entry) {
  const expected = Number(entry.expected) || 0;
  const bytes = Number(entry.bytes) || 0;
  const pct = expected > 0 ? Math.min(100, (bytes / expected) * 100) : 0;
  const model = entry.model ? color.muted(`[${entry.model}] `) : '';
  return `  ${model}${entry.file || entry.name || ''}  ${progressBar(pct, 10)} ${pct.toFixed(0)}% ${formatBytes(
    bytes
  )}/${formatBytes(expected)}`;
}

/**
 * One failure line: `! name | reason`.
 * 一条失败行：`! 名称 | 原因`。
 *
 * @param {object|string} failure
 * @returns {string}
 */
function taskFailureLine(failure) {
  const text =
    typeof failure === 'string'
      ? failure
      : failure && failure.message
        ? String(failure.message)
        : failure && failure.error
          ? String(failure.error)
          : '';
  const name =
    failure && typeof failure === 'object'
      ? String(failure.name || failure.file || failure.modelId || '')
      : '';
  const label = [name, text].filter(Boolean).join(color.muted(` ${layout.glyphs().bullet} `));
  return color.danger(`  ${layout.glyphs().failure} ${label || String(failure || '')}`);
}

/**
 * Human status text, colored by outcome.
 * 人类可读的状态文本，按结果着色。
 *
 * @param {object} task
 * @returns {string}
 */
function statusText(task) {
  if (!task) return '';
  if (task.status === tasks.QUEUED) return color.warning(t('tui.screen.statusQueued'));
  if (task.status === tasks.RUNNING) return color.success(t('tui.screen.statusRunning'));
  if (task.status === tasks.DONE) return color.accent(t('tui.screen.statusDone'));
  if (task.status === tasks.CANCELLED) return color.warning(t('tui.screen.statusCancelled'));
  return color.danger(t('tui.screen.statusFailed'));
}

module.exports = {
  progressBar,
  taskOverviewLine,
  taskHead,
  taskLine,
  taskDetailLines,
  taskCurrentLine,
  taskFailureLine,
  statusText,
};
