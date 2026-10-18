'use strict';

const fs = require('fs');
const path = require('path');
const { resolveUserPath } = require('./util');
const { LAYOUTS } = require('./layout');
const { ConfigError } = require('./errors');
const { t, normalizeLanguage } = require('./i18n');

const ROOT = path.resolve(__dirname, '..');

/**
 * Current config format version (used for future migrations).
 * 当前配置格式版本（用于将来迁移）
 */
const CONFIG_VERSION = 1;

const DEFAULTS = {
  configVersion: CONFIG_VERSION,
  site: 'https://civitai.red',
  outDir: 'downloads',
  profileDir: '.data/chrome-profile',
  chromePath: '',
  debugPort: 9222,
  userAgent:
    'Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/155.0.0.0 Safari/537.36',
  /**
   * Proxy (optional), e.g. http://127.0.0.1:7890 or socks5://127.0.0.1:1080
   * 代理（可选），如 http://127.0.0.1:7890 或 socks5://127.0.0.1:1080
   */
  proxy: '',
  /**
   * Chrome mode: auto = headless when a login already exists / always / never.
   * Chrome 运行模式：auto = 已有登录态时用无头浏览器 / always / never
   */
  headless: 'auto',
  /**
   * Number of files downloaded at the same time (1 = sequential, same as older versions).
   * 同时下载的文件数（1 = 串行，保持与旧版本一致）
   */
  jobs: 1,
  /**
   * Concurrency for fetching metadata.
   * 获取元数据的并发数
   */
  metaConcurrency: 4,
  /**
   * Site API requests per second limit (0 = unlimited).
   * 站点 API 每秒请求上限（0 = 不限）
   */
  apiRateLimit: 4,
  /**
   * Timeout for a single HTTP request (milliseconds).
   * 单次 HTTP 请求超时（毫秒）
   */
  requestTimeoutMs: 60000,
  /**
   * Retry count for metadata/status requests.
   * 元数据/状态类请求的重试次数
   */
  retries: 3,
  /**
   * Log rotation threshold (bytes).
   * 日志轮转阈值（字节）
   */
  logMaxBytes: 5 * 1024 * 1024,
  /**
   * Maximum attempts per downloaded item.
   * 下载单项的最大尝试次数
   */
  downloadAttempts: 5,
  /**
   * Download only the primary file (multi-file versions take just the main file).
   * 只下载 primary 文件（多文件版本只取主文件）
   */
  primaryOnly: true,
  /**
   * File types to download (the site's files[].type); only Model by default.
   * 参与下载的文件类型（站点 files[].type），默认只下 Model
   */
  fileTypes: ['Model'],
  /**
   * Site tRPC procedure name (overridable when the site changes).
   * 站点 tRPC 过程名（站点改版时可覆盖）
   */
  trpcPath: 'model.getAll',
  /**
   * Overrides for the site tRPC request body (shallow-merged with the built-in template).
   * 站点 tRPC 请求体覆盖项（会与内置模板浅合并）
   */
  trpcInput: {},
  /**
   * Download engine: curl (default) | aria2 | auto (use aria2c when available).
   * 下载引擎：curl（默认）| aria2 | auto（有 aria2c 就用它）
   */
  engine: 'curl',
  /**
   * Deduplicate by content across collections: off (default) | hardlink | copy.
   * 跨收藏集按内容去重：off（默认）| hardlink | copy
   */
  dedup: 'off',
  /**
   * Directory layout preset: a1111 (default) | comfy | custom.
   * 目录布局预设：a1111（默认）| comfy | custom
   */
  layout: 'a1111',
  /**
   * Add one more folder level for the base model, e.g. loras/sdxl/<model>.
   * 是否再按底模分层，例如 loras/sdxl/<模型>
   */
  baseModelLayer: false,
  /**
   * Site type → folder name, used by layout=custom only (a missing type falls back to "other").
   * 站点类型 → 目录名，仅 layout=custom 使用（缺失的类型回落到 other）
   */
  typeFolders: {},
  /**
   * Notification webhook fired after a task finishes (empty = do not send).
   * 任务结束后的通知 Webhook（留空 = 不发送）
   */
  notifyWebhook: '',
  /**
   * Show a system notification when a task finishes (best effort on Windows/macOS/Linux).
   * 任务结束后弹系统通知（Windows/macOS/Linux 尽力而为）
   */
  notifyToast: false,
  /**
   * UI language: empty = auto (explicit switch → env vars → system locale → English fallback); supports en / zh-CN.
   * 界面语言：留空 = 自动（显式开关 → 环境变量 → 系统区域 → 英文兜底），支持 en / zh-CN。
   */
  language: '',
};

const KNOWN_KEYS = new Set(Object.keys(DEFAULTS));

function checkInt(cfg, key, { min, max }) {
  const raw = cfg[key];
  if (raw === undefined || raw === null || raw === '') {
    cfg[key] = DEFAULTS[key];
    return;
  }
  const range = max === undefined ? String(min) : `${min}-${max}`;
  const invalid = () =>
    new ConfigError(t('config.intRange', { key, range, value: JSON.stringify(raw) }));
  if (typeof raw === 'boolean' || typeof raw === 'object') {
    throw invalid();
  }
  const n = Number(raw);
  if (!Number.isFinite(n) || Math.floor(n) !== n || n < min || (max !== undefined && n > max)) {
    throw invalid();
  }
  cfg[key] = n;
}

function checkString(cfg, key, { required, pattern, hint }) {
  const raw = cfg[key];
  const value = raw === undefined || raw === null ? '' : String(raw).trim();
  const hintSuffix = hint ? t('config.hintSuffix', { hint }) : '';
  if (!value && required) {
    throw new ConfigError(t('config.required', { key, hint: hintSuffix }));
  }
  if (value && pattern && !pattern.test(value)) {
    throw new ConfigError(t('config.invalidFormat', { key, value, hint: hintSuffix }));
  }
  cfg[key] = value;
}

/**
 * Validate and normalize a config object (returns a new object).
 * 校验并规范化配置对象（返回新对象）。
 * @param {object} input 用户配置
 * @param {{warnings?: string[]}} [opts]
 */
function validateConfig(input, opts = {}) {
  const warnings = opts.warnings || [];
  const cfg = { ...input };

  for (const key of Object.keys(cfg)) {
    if (!KNOWN_KEYS.has(key)) {
      warnings.push(t('config.unknownKey', { key }));
    }
  }

  cfg.configVersion = Number(cfg.configVersion) || CONFIG_VERSION;
  checkString(cfg, 'site', {
    required: true,
    pattern: /^https?:\/\/\S+$/i,
    hint: t('config.hintSiteUrl'),
  });
  checkString(cfg, 'outDir', { required: true, hint: t('config.hintOutDir') });
  checkString(cfg, 'profileDir', { required: true });
  checkString(cfg, 'chromePath', { required: false });
  checkString(cfg, 'userAgent', { required: true });
  checkString(cfg, 'proxy', {
    required: false,
    pattern: /^(https?|socks[45]?):\/\/\S+$/i,
    hint: t('config.hintProxy'),
  });
  checkInt(cfg, 'debugPort', { min: 1, max: 65535 });
  checkInt(cfg, 'jobs', { min: 1, max: 8 });
  checkInt(cfg, 'metaConcurrency', { min: 1, max: 8 });
  checkInt(cfg, 'apiRateLimit', { min: 0, max: 1000 });
  checkInt(cfg, 'requestTimeoutMs', { min: 1000, max: 600000 });
  checkInt(cfg, 'retries', { min: 0, max: 10 });
  checkInt(cfg, 'logMaxBytes', { min: 64 * 1024, max: 1024 * 1024 * 1024 });
  checkInt(cfg, 'downloadAttempts', { min: 1, max: 20 });

  // Site API related (overridable, so a site revamp needs no code change).
  // 站点接口相关（可覆盖，便于站点改版时不动代码）
  checkString(cfg, 'trpcPath', { required: true });
  if (cfg.trpcInput === null || typeof cfg.trpcInput !== 'object' || Array.isArray(cfg.trpcInput)) {
    throw new ConfigError(t('config.trpcInputNotObject'));
  }
  if (!Array.isArray(cfg.fileTypes) || !cfg.fileTypes.length || cfg.fileTypes.some((t2) => typeof t2 !== 'string' || !t2.trim())) {
    throw new ConfigError(t('config.fileTypesInvalid'));
  }
  cfg.fileTypes = cfg.fileTypes.map((t2) => String(t2).trim());
  cfg.primaryOnly = cfg.primaryOnly !== false;

  if (!['curl', 'aria2', 'auto'].includes(String(cfg.engine))) {
    throw new ConfigError(t('config.engineInvalid'));
  }
  if (!['off', 'hardlink', 'copy'].includes(String(cfg.dedup))) {
    throw new ConfigError(t('config.dedupInvalid'));
  }

  // Directory layout: the preset name plus (for custom) the type → folder map.
  // 目录布局：预设名，以及 custom 时的「类型 → 目录」映射。
  cfg.layout = String(cfg.layout === undefined || cfg.layout === null ? '' : cfg.layout)
    .trim()
    .toLowerCase();
  if (!LAYOUTS.includes(cfg.layout)) {
    throw new ConfigError(t('config.layoutInvalid', { value: String(cfg.layout) }));
  }
  cfg.baseModelLayer = cfg.baseModelLayer === true;
  if (cfg.typeFolders === null || typeof cfg.typeFolders !== 'object' || Array.isArray(cfg.typeFolders)) {
    throw new ConfigError(t('config.typeFoldersNotObject'));
  }
  const typeFolders = {};
  for (const [type, folder] of Object.entries(cfg.typeFolders)) {
    if (typeof folder !== 'string' || !folder.trim()) {
      throw new ConfigError(t('config.typeFoldersInvalid', { type }));
    }
    typeFolders[type] = folder.trim();
  }
  cfg.typeFolders = typeFolders;

  cfg.headless = String(cfg.headless || 'auto')
    .trim()
    .toLowerCase();
  if (!['auto', 'always', 'never'].includes(cfg.headless)) {
    throw new ConfigError(t('config.headlessInvalid', { value: String(cfg.headless) }));
  }
  checkString(cfg, 'notifyWebhook', {
    required: false,
    pattern: /^https?:\/\/\S+$/i,
    hint: t('config.hintWebhook'),
  });
  cfg.notifyToast = cfg.notifyToast === true;

  // Language accepts an explicit tag (en / zh-CN and variants) or an empty value meaning "auto".
  // 语言接受显式标签（en / zh-CN 及其变体），留空表示「自动解析」。
  checkString(cfg, 'language', { required: false });
  if (cfg.language) {
    const normalized = normalizeLanguage(cfg.language);
    if (!normalized) {
      throw new ConfigError(t('config.languageUnsupported', { value: String(cfg.language) }));
    }
    cfg.language = normalized;
  }

  return cfg;
}

/**
 * Site hostname → a fragment that is safe to use in a directory name.
 * 站点主机名 → 可安全用于目录名的片段
 */
function safeHostSlug(site) {
  try {
    const u = new URL(site);
    return `${u.hostname}${u.port ? `_${u.port}` : ''}`.replace(/[^a-zA-Z0-9._-]/g, '_') || 'default';
  } catch (e) {
    return 'default';
  }
}

/**
 * Load the config.
 * 加载配置。
 * @param {{root?:string, file?:string}} [options]
 * @returns {object} 配置对象，另含非枚举的 warnings
 */
function loadConfig(options = {}) {
  const root = options.root || ROOT;
  const file = options.file || path.join(root, 'config.json');
  const warnings = [];
  let user = {};
  let exists = false;

  if (fs.existsSync(file)) {
    exists = true;
    let text;
    try {
      text = fs.readFileSync(file, 'utf8');
    } catch (e) {
      throw new ConfigError(t('config.readFailed', { error: e.message }));
    }
    if (text.trim()) {
      try {
        user = JSON.parse(text);
      } catch (e) {
        throw new ConfigError(t('config.parseFailed', { error: e.message }));
      }
      if (!user || typeof user !== 'object' || Array.isArray(user)) {
        throw new ConfigError(t('config.topLevelNotObject'));
      }
    }
  }

  const cfg = validateConfig({ ...DEFAULTS, ...user }, { warnings });
  cfg.site = String(cfg.site).replace(/\/+$/, '');
  cfg.outDir = resolveUserPath(cfg.outDir, root);

  // Chrome profile directories are isolated per site: unless the user explicitly configured a "non-default" profileDir,
  // use <profileDir>/<site host>, so switching sites does not mix sessions/Cookies.
  // Note: explicitly writing the default profileDir (.data/chrome-profile) does not mean "disable isolation",
  // otherwise old config files would stay on the shared directory forever.
  //
  // Chrome 用户目录按站点隔离：除非用户显式配置了「非默认」的 profileDir，
  // 否则用 <profileDir>/<站点主机>，避免切换站点时会话/Cookie 互相干扰。
  // 注意：把 profileDir 显式写成默认值（.data/chrome-profile）不算"想关闭隔离"，
  // 否则老配置文件会永远停在共享目录上。
  const rawProfile = user.profileDir === undefined || user.profileDir === null ? '' : String(user.profileDir).trim();
  const explicitProfile = rawProfile !== '' && path.normalize(rawProfile) !== path.normalize(DEFAULTS.profileDir);
  const baseProfileDir = resolveUserPath(cfg.profileDir, root);
  cfg.profileDirExplicit = explicitProfile;
  cfg.profileDirBase = baseProfileDir;
  cfg.profileDir = explicitProfile ? baseProfileDir : path.join(baseProfileDir, safeHostSlug(cfg.site));

  cfg.root = root;
  cfg.configFile = file;
  cfg.configExists = exists;
  cfg.dataDir = path.join(root, '.data');
  cfg.cookiesFile = path.join(cfg.dataDir, 'cookies.txt');

  Object.defineProperty(cfg, 'warnings', { value: warnings, enumerable: false });
  return cfg;
}

/**
 * Resolve a user-supplied directory into an absolute path (relative paths are relative to the project root, not the process cwd).
 * 把用户输入的目录解析为绝对路径（相对路径相对项目根，而非进程 cwd）
 */
function resolveOutDir(config, dir) {
  return resolveUserPath(dir || config.outDir, config.root || ROOT);
}

/**
 * Write config.json back (keeping user-defined fields, adding configVersion).
 * 写回 config.json（保留用户自定义字段，补上 configVersion）
 */
function saveConfig(config, patch = {}) {
  const file = config.configFile || path.join(ROOT, 'config.json');
  let raw = {};
  if (fs.existsSync(file)) {
    try {
      raw = JSON.parse(fs.readFileSync(file, 'utf8')) || {};
    } catch (e) {
      raw = {};
    }
  }
  const merged = { ...raw, ...patch, configVersion: CONFIG_VERSION };
  fs.mkdirSync(path.dirname(file), { recursive: true });
  fs.writeFileSync(file, JSON.stringify(merged, null, 2) + '\n', 'utf8');
  return merged;
}

module.exports = {
  ROOT,
  DEFAULTS,
  CONFIG_VERSION,
  KNOWN_KEYS,
  loadConfig,
  validateConfig,
  resolveOutDir,
  saveConfig,
  safeHostSlug,
};
