'use strict';

/**
 * Unified error types.
 *
 * Previously call sites branched by matching error message text (such as the cancel message),
 * so changing the wording broke the logic. They now use instanceof / code checks instead, which
 * decouples messages from logic.
 *
 *
 * 统一错误类型。
 *
 * 之前各处靠匹配错误文案（如 e.message === '下载已取消'）来分支，
 * 文案一改逻辑就断。这里改为 instanceof / code 判断，文案与逻辑解耦。
 */

class AppError extends Error {
  constructor(message, options = {}) {
    super(message);
    this.name = new.target.name;
    this.code = options.code || new.target.name;
    if (options.detail !== undefined) this.detail = options.detail;
    if (options.cause) this.cause = options.cause;
  }
}

/**
 * Configuration error (invalid config.json, missing required fields, etc.).
 * 配置错误（config.json 非法、缺少必填项等）。
 */
class ConfigError extends AppError {}

/**
 * Not logged in / login expired (HTTP 401, 403, UNAUTHORIZED).
 * 未登录 / 登录过期（HTTP 401、403、UNAUTHORIZED）。
 */
class AuthError extends AppError {}

/**
 * Resource missing or taken down (HTTP 404).
 * 资源不存在或已下架（HTTP 404）。
 */
class NotFoundError extends AppError {}

/**
 * Network layer error (timeout, connection failure, DNS, etc.).
 * 网络层错误（超时、连接失败、DNS 等）。
 */
class NetworkError extends AppError {}

/**
 * Rate limited (HTTP 429); retryAfterMs is the suggested wait in milliseconds.
 * 触发限流（HTTP 429），retryAfterMs 为建议等待毫秒数。
 */
class RateLimitError extends AppError {
  constructor(message, retryAfterMs = 0, options = {}) {
    super(message, options);
    this.retryAfterMs = Number.isFinite(retryAfterMs) && retryAfterMs > 0 ? retryAfterMs : 0;
  }
}

/**
 * Resume / Range request failure (including HTTP 416).
 * 断点续传 / Range 请求异常（含 HTTP 416）。
 */
class ResumeError extends AppError {}

/**
 * Cancelled by the user.
 * 用户主动取消。
 */
class CancelError extends AppError {}

/**
 * Download failed (retries exhausted, etc.).
 * 下载失败（重试耗尽等）。
 */
class DownloadError extends AppError {}

/**
 * Local state file is corrupted.
 * 本地状态文件损坏。
 */
class StateCorruptError extends AppError {
  constructor(message, options = {}) {
    super(message, options);
    this.backupFile = options.backupFile || null;
    this.stateFile = options.stateFile || null;
  }
}

/**
 * The site served a challenge (Cloudflare, etc.) that a human must solve in the browser.
 * 站点出现人机验证（Cloudflare 等），需要人工在浏览器中完成。
 */
class ChallengeError extends AppError {}

/**
 * The site's internal interface changed shape/behavior (tRPC routes, response format, etc.).
 * 站点内部接口结构/行为发生变化（tRPC 路由、响应格式等）。
 */
class SiteInterfaceError extends AppError {}

/**
 * The shared message used on cancellation (kept exported for backwards compatibility).
 * 取消时统一使用的文案（保留导出以兼容旧调用）。
 */
const CANCEL_MESSAGE = '下载已取消';

function isCancelError(e) {
  return e instanceof CancelError || !!(e && e.code === 'CancelError');
}

function isAuthError(e) {
  return e instanceof AuthError || !!(e && e.code === 'AuthError');
}

function isNotFoundError(e) {
  return e instanceof NotFoundError || !!(e && e.code === 'NotFoundError');
}

function errorMessage(e) {
  if (!e) return '未知错误';
  return e.message ? String(e.message) : String(e);
}

module.exports = {
  AppError,
  ConfigError,
  AuthError,
  NotFoundError,
  NetworkError,
  RateLimitError,
  ResumeError,
  CancelError,
  DownloadError,
  StateCorruptError,
  ChallengeError,
  SiteInterfaceError,
  CANCEL_MESSAGE,
  isCancelError,
  isAuthError,
  isNotFoundError,
  errorMessage,
};
