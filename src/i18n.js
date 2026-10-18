'use strict';

// Minimal i18n: key → message table with placeholder interpolation.
//
// Language resolution order (fixed):
//  1. explicit parameter (CLI `-l/--lang/--language`, `language` in config.json);
//  2. auto-detection (CIVITAI_LANG / LC_ALL / LANG env vars, then the Intl locale);
//  3. English as the guaranteed fallback.
//
// Other decisions:
//  - unknown keys are returned as-is, so missing entries are easy to spot;
//  - a key missing in the current language falls back to English, then to the Chinese base;
//  - no dependencies, so it stays testable and usable inside worker threads.
//
//
// 极简 i18n：键 → 文案表 + 占位符插值。
//
// 语言解析优先级（固定顺序）：
//  1. 显式参数（CLI `-l/--lang/--language`、config.json 的 language）；
//  2. 自动检测（CIVITAI_LANG / LC_ALL / LANG 环境变量，其次 Intl 系统区域）；
//  3. 英文兜底（无论如何都能拿到英文文案）。
//
// 其它取舍：
//  - 未登记的键原样返回，便于发现漏翻；
//  - 当前语言缺某个键时，先回退英文、再回退中文基准表；
//  - 不引入任何依赖，便于测试与在 worker 中使用。

const catalogs = {
  'zh-CN': require('./i18n/zh-CN'),
  en: require('./i18n/en'),
};

// Key-set baseline: both catalogs must stay in sync (the tests enforce it).
// 键集合基准：两个语言包必须完全一致（测试会校验）。
const BASE = 'zh-CN';

// The guaranteed fallback language is English.
// 兜底语言必须是英文。
const FALLBACK = 'en';

let current = null;

// Normalize a language tag: zh / zh-Hans / zh-CN → zh-CN; en / en-US → en; anything else → null.
// 归一化语言标识：zh / zh-Hans / zh-CN → zh-CN；en / en-US → en；其它 → null。
function normalizeLanguage(value) {
  const raw = String(value || '')
    .trim()
    .toLowerCase()
    .replace(/_/g, '-');
  if (!raw) return null;
  if (raw.startsWith('zh')) return 'zh-CN';
  if (raw.startsWith('en')) return 'en';
  return null;
}

// Auto-detect the system language: env vars first, then the Intl locale.
// 自动检测系统语言：先看环境变量，再看 Intl 区域设置。
function detectSystemLanguage() {
  const envKeys = ['CIVITAI_LANG', 'LC_ALL', 'LC_MESSAGES', 'LANG'];
  for (const key of envKeys) {
    const value = process.env[key];
    if (!value) continue;
    const normalized = normalizeLanguage(value);
    if (normalized) return normalized;
  }
  try {
    const locale = Intl.DateTimeFormat().resolvedOptions().locale;
    const normalized = normalizeLanguage(locale);
    if (normalized) return normalized;
  } catch (e) {
    // Ignore when Intl is unavailable.
    // Intl 不可用时忽略。
  }
  return null;
}

/**
 * Resolve the language following the fixed priority order.
 * 按固定优先级解析语言。
 *
 * @param {{explicit?: string|null}} [options]
 * @returns {{language: 'en'|'zh-CN', source: 'explicit'|'auto'|'fallback'}}
 */
function resolveLanguage(options = {}) {
  const explicit = normalizeLanguage(options.explicit);
  if (explicit) return { language: explicit, source: 'explicit' };

  const detected = detectSystemLanguage();
  if (detected) return { language: detected, source: 'auto' };

  return { language: FALLBACK, source: 'fallback' };
}

function defaultLanguage() {
  return resolveLanguage().language;
}

// Set the active language; null / empty / unknown values mean "resolve automatically".
// 设置当前语言；传 null / 空 / 未知值表示「交给自动解析」。
function setLanguage(lang) {
  current = normalizeLanguage(lang);
  return current || defaultLanguage();
}

function getLanguage() {
  return current || defaultLanguage();
}

// Where the active language came from (explicit / auto / fallback).
// 当前语言是怎么来的（explicit / auto / fallback）。
function getLanguageSource() {
  if (current) return 'explicit';
  return resolveLanguage().source;
}

function availableLanguages() {
  return Object.keys(catalogs);
}

function table(lang) {
  return catalogs[lang] || catalogs[FALLBACK];
}

// Placeholder interpolation: {name} → params.name.
// 占位符插值：{name} → params.name。
function interpolate(text, params) {
  if (!params) return String(text);
  return String(text).replace(/\{(\w+)\}/g, (match, key) =>
    params[key] === undefined || params[key] === null ? match : String(params[key])
  );
}

/**
 * Look up a message: current language → English → Chinese base → the key itself.
 * 取文案：当前语言 → 英文 → 中文基准 → 键名本身。
 *
 * @param {string} key e.g. 'cli.unknownCommand'
 * @param {Record<string, any>} [params]
 */
function t(key, params) {
  const lang = getLanguage();
  const primary = table(lang)[key];
  if (primary !== undefined) return interpolate(primary, params);
  if (lang !== FALLBACK && catalogs[FALLBACK][key] !== undefined) {
    return interpolate(catalogs[FALLBACK][key], params);
  }
  if (lang !== BASE && catalogs[BASE][key] !== undefined) {
    return interpolate(catalogs[BASE][key], params);
  }
  // Unknown keys are returned as-is, which makes missing entries easy to locate.
  // 未登记的键原样返回，方便定位遗漏。
  return key;
}

// Whether a language defines the key.
// 某个语言是否登记了该键。
function has(key, lang) {
  return table(lang || getLanguage())[key] !== undefined;
}

// Keys missing a translation, measured against the Chinese base table.
// 缺失翻译的键：以中文基准表为参照。
function missingKeys(lang) {
  const base = Object.keys(catalogs[BASE]);
  const target = table(lang);
  return base.filter((key) => target[key] === undefined);
}

// Create a standalone translator for one language (handy in tests).
// 为某个语言创建独立的取词函数（便于测试）。
function createTranslator(lang) {
  const chosen = normalizeLanguage(lang) || FALLBACK;
  return (key, params) => {
    const value = catalogs[chosen][key];
    if (value !== undefined) return interpolate(value, params);
    if (catalogs[FALLBACK][key] !== undefined) return interpolate(catalogs[FALLBACK][key], params);
    if (catalogs[BASE][key] !== undefined) return interpolate(catalogs[BASE][key], params);
    return key;
  };
}

/**
 * Extract the language switch from argv (`-l` / `--lang` / `--language`, space or `=` form).
 * 从 argv 中提取语言参数（支持 -l / --lang / --language，空格或 = 传值）。
 *
 * @param {string[]} argv
 * @returns {{lang: string|null, rest: string[]}}
 */
function extractLanguageArg(argv) {
  const rest = [];
  let lang = null;
  for (let i = 0; i < argv.length; i++) {
    const arg = String(argv[i]);
    if (arg === '-l' || arg === '--lang' || arg === '--language') {
      const next = argv[i + 1];
      if (next !== undefined && !String(next).startsWith('-')) {
        lang = String(next);
        i++;
      }
      continue;
    }
    if (arg.startsWith('--lang=') || arg.startsWith('--language=')) {
      lang = arg.slice(arg.indexOf('=') + 1);
      continue;
    }
    if (arg.startsWith('-l') && arg.length > 2) {
      lang = arg.slice(2);
      continue;
    }
    rest.push(arg);
  }
  return { lang: normalizeLanguage(lang), rest };
}

module.exports = {
  t,
  has,
  setLanguage,
  getLanguage,
  getLanguageSource,
  defaultLanguage,
  resolveLanguage,
  detectSystemLanguage,
  normalizeLanguage,
  availableLanguages,
  missingKeys,
  createTranslator,
  interpolate,
  extractLanguageArg,
  BASE,
  FALLBACK,
};
