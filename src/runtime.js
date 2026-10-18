'use strict';

/**
 * Runtime wiring: config → API layer / env vars / logging / language, plus a uniform error renderer.
 *
 * 运行时装配：把配置接到 API 层 / 环境变量 / 日志 / 语言，并统一错误呈现。
 * CLI 与 TUI 共用，避免两边各写一份。
 */

const { log } = require('./util');
const { configureApi } = require('./api');
const { createRateLimiter } = require('./ratelimit');
const { setLanguage, getLanguage, resolveLanguage, getLanguageSource, t } = require('./i18n');
const {
  AppError,
  CancelError,
  AuthError,
  NotFoundError,
  NetworkError,
  RateLimitError,
  ChallengeError,
  SiteInterfaceError,
  StateCorruptError,
  ConfigError,
  DownloadError,
} = require('./errors');

/**
 * Apply configuration: resolve the UI language, set proxy env vars, configure the API layer.
 *
 * Language priority: hooks.language (CLI flag) → config.language → auto-detect → English.
 *
 *
 * 应用配置：解析界面语言、设置代理环境变量、配置 API 层。
 *
 * 语言优先级：hooks.language（CLI 参数）→ config.language → 自动检测 → 英文兜底。
 *
 * @param {object} config
 * @param {{language?: string|null, onRetry?: Function}} [hooks]
 */
function configureRuntime(config, hooks = {}) {
  const explicit =
    hooks.language !== undefined && hooks.language !== null ? hooks.language : config.language;
  const resolved = resolveLanguage({ explicit });
  setLanguage(resolved.language);
  try {
    Object.defineProperty(config, 'languageInfo', {
      value: resolved,
      enumerable: false,
      configurable: true,
    });
  } catch (e) {
    // The config object may be frozen in tests; the language is already applied.
    // 测试里 config 可能被冻结；语言本身已经生效，忽略该属性写入失败。
  }
  if (config.proxy && !process.env.CIVITAI_NO_PROXY_ENV) {
    // Node >= 24 supports proxies via env vars; versions that do not support it ignore both variables.
    // Node >= 24 支持通过环境变量使用代理；不支持的版本会忽略这两个变量
    if (!process.env.HTTP_PROXY) process.env.HTTP_PROXY = config.proxy;
    if (!process.env.HTTPS_PROXY) process.env.HTTPS_PROXY = config.proxy;
    if (!process.env.NODE_USE_ENV_PROXY) process.env.NODE_USE_ENV_PROXY = '1';
  }
  configureApi({
    apiRateLimit: config.apiRateLimit,
    retries: config.retries,
    requestTimeoutMs: config.requestTimeoutMs,
    userAgent: config.userAgent,
    onRetry: hooks.onRetry,
  });
  return config;
}

/**
 * Site API rate limiter (used for tRPC enumeration).
 * 站点接口限流器（tRPC 枚举用）。
 */
function createSiteLimiter(config) {
  return createRateLimiter(config.apiRateLimit);
}

/**
 * Print configuration hints (unknown keys, etc.).
 * 打印配置提示（未知键等）。
 */
function printConfigWarnings(config, write = console.error) {
  for (const w of config.warnings || []) write(t('runtime.configWarning', { message: w }));
}

/**
 * Turn an error into one actionable message (without hiding the type information).
 * 把错误转成一句可操作的提示（不吞掉类型信息）。
 * @param {Error} e
 */
function describeError(e) {
  if (!e) return t('common.unknownError');
  if (e instanceof CancelError) return t('common.cancelled');
  if (e instanceof StateCorruptError) return e.message;
  if (e instanceof ConfigError) return e.message;
  if (e instanceof AuthError) return `${e.message}\n${t('runtime.hintAuth')}`;
  if (e instanceof ChallengeError) return `${e.message}\n${t('runtime.hintChallenge')}`;
  if (e instanceof RateLimitError) return `${e.message}\n${t('runtime.hintRateLimit')}`;
  if (e instanceof NotFoundError) return e.message;
  if (e instanceof SiteInterfaceError) {
    return `${e.message}\n${t('runtime.hintSiteInterface')}`;
  }
  if (e instanceof NetworkError) return `${e.message}\n${t('runtime.hintNetwork')}`;
  if (e instanceof DownloadError) return e.message;
  if (e instanceof AppError) return e.message;
  return (e && e.message) || String(e);
}

/**
 * Unified error handling: print the hint and set the exit code.
 * 统一的错误处理：输出提示并设置退出码。
 * @param {Error} e
 * @param {{logger?:Function, debug?:boolean}} [opts]
 */
function handleFatal(e, opts = {}) {
  const write = opts.logger || ((msg) => console.error(msg));
  write(t('runtime.fatalError', { message: describeError(e) }));
  if (opts.debug || process.env.DEBUG) {
    console.error(e);
  }
  process.exitCode = 1;
}

module.exports = {
  configureRuntime,
  createSiteLimiter,
  printConfigWarnings,
  describeError,
  handleFatal,
  getLanguage,
  getLanguageSource,
  log,
};
