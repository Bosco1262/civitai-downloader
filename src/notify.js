'use strict';

/**
 * End-of-task notification: terminal bell + system notification (best effort) + Webhook.
 *
 * Design principle: notifications must never affect the download result — every failure is
 * swallowed and only visible under debug.
 *
 *
 * 任务结束通知：终端响铃 + 系统通知（尽力而为）+ Webhook。
 *
 * 设计原则：通知永远不能影响下载结果 —— 所有失败都被吞掉并只在 debug 下可见。
 */

const { spawn } = require('child_process');
const { t } = require('./i18n');

/**
 * The unified callback payload (used by the Webhook).
 * 统一的回调负载（Webhook 用）。
 */
function buildPayload(summary, extra = {}) {
  return {
    event: extra.event || 'download-finished',
    collectionId: summary && summary.collectionId ? String(summary.collectionId) : null,
    done: Number(summary && summary.done) || 0,
    skipped: Number(summary && summary.skipped) || 0,
    failed: Number(summary && summary.failed) || 0,
    metaFailed: Number(summary && summary.metaFailed) || 0,
    cancelled: !!(summary && summary.cancelled),
    bytes: Number(summary && summary.totalBytes) || 0,
    outDir: (summary && summary.outDir) || '',
    elapsedMs: Number(summary && summary.elapsedMs) || 0,
    at: new Date().toISOString(),
  };
}

/**
 * Build a one-sentence human-readable summary.
 * 生成一句人话摘要。
 */
function describe(summary) {
  if (!summary) return t('notify.finished');
  if (summary.cancelled) {
    return t('notify.cancelledSummary', {
      done: summary.done,
      skipped: summary.skipped,
      failed: summary.failed,
    });
  }
  return t('notify.summary', { done: summary.done, skipped: summary.skipped, failed: summary.failed });
}

function bell() {
  if (process.env.NO_BELL) return false;
  if (!process.stdout.isTTY) return false; // 管道/重定向时不写入控制字符 / no control chars when piped or redirected
  try {
    process.stdout.write('\u0007');
    return true;
  } catch (e) {
    return false;
  }
}

/**
 * The system notification command per platform (null means unsupported).
 * 各平台的系统通知命令（返回 null 表示不支持）。
 */
function toastCommand(title, message) {
  if (process.platform === 'win32') {
    const script = [
      "$ErrorActionPreference='Stop'",
      '[void][Windows.UI.Notifications.ToastNotificationManager, Windows.UI.Notifications, ContentType=WindowsRuntime]',
      '[void][Windows.Data.Xml.Dom.XmlDocument, Windows.Data.Xml.Dom.XmlDocument, ContentType=WindowsRuntime]',
      '$t=[Windows.UI.Notifications.ToastNotificationManager]::GetTemplateContent([Windows.UI.Notifications.ToastTemplateType]::ToastText02)',
      '$n=$t.GetElementsByTagName("text")',
      '$n.Item(0).AppendChild($t.CreateTextNode($env:CIVITAI_TOAST_TITLE)) | Out-Null',
      '$n.Item(1).AppendChild($t.CreateTextNode($env:CIVITAI_TOAST_MSG)) | Out-Null',
      '$toast=[Windows.UI.Notifications.ToastNotification]::new($t)',
      '[Windows.UI.Notifications.ToastNotificationManager]::CreateToastNotifier("Civitai Downloader").Show($toast)',
    ].join('; ');
    return {
      cmd: 'powershell.exe',
      args: ['-NoProfile', '-NonInteractive', '-Command', script],
      env: { ...process.env, CIVITAI_TOAST_TITLE: title, CIVITAI_TOAST_MSG: message },
    };
  }
  if (process.platform === 'darwin') {
    return {
      cmd: 'osascript',
      args: ['-e', `display notification ${JSON.stringify(message)} with title ${JSON.stringify(title)}`],
    };
  }
  return { cmd: 'notify-send', args: [title, message] };
}

function sendToast(title, message) {
  const spec = toastCommand(title, message);
  if (!spec) return false;
  try {
    const child = spawn(spec.cmd, spec.args, {
      detached: true,
      stdio: 'ignore',
      windowsHide: true,
      env: spec.env || process.env,
    });
    child.on('error', () => {});
    child.unref();
    return true;
  } catch (e) {
    return false;
  }
}

/**
 * Send the Webhook (POST JSON).
 * 发送 Webhook（POST JSON）。
 * @returns {Promise<{ok:boolean, status?:number, error?:string}>}
 */
async function sendWebhook(url, payload, opts = {}) {
  if (!url) return { ok: false, error: 'no-url' };
  try {
    const res = await fetch(url, {
      method: 'POST',
      headers: { 'content-type': 'application/json' },
      body: JSON.stringify(payload),
      signal: AbortSignal.timeout(opts.timeoutMs || 10000),
    });
    return { ok: res.ok, status: res.status };
  } catch (e) {
    return { ok: false, error: e && e.message ? e.message : String(e) };
  }
}

/**
 * Unified notification entry point at the end of a task.
 * 任务结束统一通知入口。
 * @param {object} config
 * @param {object} summary
 * @param {{webhook?:string, toast?:boolean, log?:Function}} [opts]
 */
async function notifyFinished(config, summary, opts = {}) {
  const logFn = opts.log;
  const webhook = opts.webhook !== undefined ? opts.webhook : config && config.notifyWebhook;
  const wantToast = opts.toast !== undefined ? opts.toast : !!(config && config.notifyToast);

  bell();

  const result = { bell: true, toast: false, webhook: null };
  if (wantToast) {
    result.toast = sendToast(t('notify.toastTitle'), describe(summary));
  }
  if (webhook) {
    result.webhook = await sendWebhook(webhook, buildPayload(summary));
    if (logFn && !result.webhook.ok) {
      logFn(t('notify.webhookFailed', { error: result.webhook.error || result.webhook.status }));
    }
  }
  return result;
}

module.exports = { buildPayload, describe, bell, toastCommand, sendToast, sendWebhook, notifyFinished };
