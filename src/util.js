'use strict';

const crypto = require('crypto');
const fs = require('fs');
const path = require('path');
const { Worker } = require('worker_threads');
const { CancelError } = require('./errors');
const { t } = require('./i18n');

// ---------------------------------------------------------------------------
// Basic utilities
// 基础工具
// ---------------------------------------------------------------------------

function ts() {
  const d = new Date();
  const p = (n) => String(n).padStart(2, '0');
  return `${d.getFullYear()}-${p(d.getMonth() + 1)}-${p(d.getDate())} ${p(d.getHours())}:${p(d.getMinutes())}:${p(d.getSeconds())}`;
}

let logSink = null;

function setLogSink(fn) {
  logSink = fn;
}

function log(msg) {
  if (logSink) {
    logSink(msg);
    return;
  }
  console.log(`[${ts()}] ${msg}`);
}

function sleep(ms) {
  return new Promise((resolve) => setTimeout(resolve, ms));
}

// ---------------------------------------------------------------------------
// Names / paths
// 名称 / 路径
// ---------------------------------------------------------------------------

/**
 * Maximum full path length on Windows (headroom kept; external programs such as curl do not accept the \\?\ prefix).
 * Windows 全路径长度上限（保留余量；curl 等外部程序不认 \\?\ 前缀）。
 */
const MAX_PATH_WIN = 250;
/**
 * Default maximum length of a directory name.
 * 目录名默认最大长度。
 */
const DEFAULT_NAME_LIMIT = 120;

/**
 * Sanitize a string into a valid file/directory name.
 * When truncating, the extension is preserved (otherwise a suffix such as .safetensors is lost and the file becomes unusable).
 *
 * 清理成合法的文件/目录名。
 * 截断时保留扩展名（否则 .safetensors 之类的后缀会丢失，文件变得不可用）。
 * @param {string} name
 * @param {number} [maxLen] 传 0 表示不截断
 */
function sanitizeName(name, maxLen = DEFAULT_NAME_LIMIT) {
  const cleaned =
    String(name)
      .replace(/[<>:"/\\|?*\x00-\x1f]/g, '_')
      .replace(/[. ]+$/, '')
      .trim() || 'unnamed';
  if (!(maxLen > 0) || cleaned.length <= maxLen) return cleaned;
  const ext = path.extname(cleaned);
  if (ext && ext.length <= maxLen - 8) {
    const stem = cleaned.slice(0, cleaned.length - ext.length);
    return stem.slice(0, maxLen - ext.length) + ext;
  }
  return cleaned.slice(0, maxLen);
}

function shortHash(value, len = 6) {
  return crypto.createHash('sha1').update(String(value)).digest('hex').slice(0, len);
}

function pathTooLong(p, limit = MAX_PATH_WIN) {
  return process.platform === 'win32' && String(p).length > limit;
}

/**
 * Build the on-disk name of a directory: truncate when too long and append a short hash so it stays unique and within the limit.
 * 为目录名生成磁盘名：过长时截断并追加短哈希，保证唯一且不超长。
 * @param {string} parentDir 父目录（绝对路径）
 * @param {string} remoteName 线上模型名
 * @param {string|number} [uniqueKey] 唯一键（通常 modelId），用于碰撞/截断时的区分
 * @param {number} [reserveForFile] 为内部文件名预留的字符数
 */
function diskDirName(parentDir, remoteName, uniqueKey, reserveForFile = 60) {
  const base = sanitizeName(remoteName);
  if (!pathTooLong(path.join(parentDir, base))) return base;
  const tag = `-${shortHash(uniqueKey === undefined ? remoteName : uniqueKey)}`;
  const budget = MAX_PATH_WIN - parentDir.length - 1 - tag.length - reserveForFile;
  const stem = base.slice(0, Math.max(8, budget));
  return `${stem}${tag}`;
}

/**
 * Build the on-disk name of a file: keep the extension and append a short hash when the path is too long.
 * 为文件名生成磁盘名：过长时保留扩展名并追加短哈希。
 * @param {string} dir 目标目录（绝对路径）
 * @param {string} remoteName 线上文件名
 */
function diskFileName(dir, remoteName) {
  const safe = sanitizeName(remoteName);
  if (!pathTooLong(path.join(dir, safe))) return safe;
  const ext = path.extname(safe);
  const stem = safe.slice(0, safe.length - ext.length);
  const tag = `-${shortHash(remoteName)}`;
  const budget = MAX_PATH_WIN - dir.length - 1 - ext.length - tag.length;
  return `${stem.slice(0, Math.max(8, budget))}${tag}${ext}`;
}

/**
 * Pick a non-conflicting name from the set of used names (append -1/-2… on collision).
 * 在已用名称集合中取一个不冲突的名字（同名时追加 -1/-2…）。
 * @param {string} base 期望名称
 * @param {Set<string>|string[]} used 已用名称（大小写不敏感比较）
 */
function uniqueName(base, used) {
  const taken = (name) => {
    for (const item of used) {
      if (String(item).toLowerCase() === name.toLowerCase()) return true;
    }
    return false;
  };
  if (!taken(base)) return base;
  for (let i = 2; i < 1000; i++) {
    const candidate = `${base}-${i}`;
    if (!taken(candidate)) return candidate;
  }
  return `${base}-${shortHash(Date.now())}`;
}

/**
 * Relative paths always resolve against the project root, so the process working directory cannot affect them.
 * 相对路径一律相对项目根解析，避免受进程工作目录影响。
 * @param {string} p
 * @param {string} root
 */
function resolveUserPath(p, root) {
  const raw = String(p === undefined || p === null ? '' : p).trim();
  if (!raw) return root;
  return path.isAbsolute(raw) ? path.normalize(raw) : path.resolve(root, raw);
}

// ---------------------------------------------------------------------------
// Formatting
// 格式化
// ---------------------------------------------------------------------------

function formatBytes(n) {
  if (!Number.isFinite(n) || n < 0) return String(n);
  const units = ['B', 'KiB', 'MiB', 'GiB', 'TiB'];
  let i = 0;
  let v = n;
  while (v >= 1024 && i < units.length - 1) {
    v /= 1024;
    i++;
  }
  return `${v.toFixed(i === 0 ? 0 : 2)} ${units[i]}`;
}

function formatDuration(sec) {
  if (!Number.isFinite(sec) || sec < 0) return '--';
  if (sec < 60) return t('common.seconds', { n: Math.ceil(sec) });
  if (sec < 3600) return t('common.minutesSeconds', { m: Math.floor(sec / 60), s: Math.ceil(sec % 60) });
  const h = Math.floor(sec / 3600);
  const m = Math.floor((sec % 3600) / 60);
  return t('common.hoursMinutes', { h, m });
}

function truncate(s, n) {
  const str = String(s);
  if (str.length <= n) return str;
  return str.slice(0, Math.max(1, n - 1)) + '…';
}

// ---------------------------------------------------------------------------
// File hashing
// 文件哈希
// ---------------------------------------------------------------------------

const HASH_WORKER = path.join(__dirname, 'hashWorker.js');
const HASH_CHUNK = 4 * 1024 * 1024;

function sha256FileMainThread(file, opts = {}) {
  return new Promise((resolve, reject) => {
    const hash = crypto.createHash('sha256');
    const stream = fs.createReadStream(file, { highWaterMark: opts.chunkSize || HASH_CHUNK });
    let bytes = 0;
    let settled = false;
    const fail = (e) => {
      if (settled) return;
      settled = true;
      reject(e);
    };
    stream.on('data', (chunk) => {
      if (opts.shouldAbort && opts.shouldAbort()) {
        stream.destroy();
        fail(new CancelError(t('util.verifyCancelled')));
        return;
      }
      hash.update(chunk);
      bytes += chunk.length;
      if (opts.onProgress) opts.onProgress(bytes);
    });
    stream.on('end', () => {
      if (settled) return;
      settled = true;
      resolve(hash.digest('hex').toUpperCase());
    });
    stream.on('error', fail);
  });
}

function sha256FileInWorker(file, opts = {}) {
  return new Promise((resolve, reject) => {
    let worker;
    try {
      worker = new Worker(HASH_WORKER, {
        workerData: {
          file,
          highWaterMark: opts.chunkSize || HASH_CHUNK,
          progressIntervalMs: opts.progressIntervalMs || 250,
        },
      });
    } catch (e) {
      const err = new Error(e.message);
      err.workerFailed = true;
      reject(err);
      return;
    }

    let settled = false;
    let timer = null;
    const finish = (fn, arg) => {
      if (settled) return;
      settled = true;
      if (timer) clearInterval(timer);
      worker.terminate().catch(() => {});
      fn(arg);
    };

    worker.on('message', (m) => {
      if (!m) return;
      if (m.type === 'progress') {
        if (opts.onProgress) opts.onProgress(m.bytes);
        return;
      }
      if (m.type === 'done') {
        finish(resolve, m.hash);
        return;
      }
      if (m.type === 'error') {
        const err = new Error(m.message);
        if (m.code) err.code = m.code;
        finish(reject, err);
      }
    });
    worker.on('error', (e) => {
      e.workerFailed = true;
      finish(reject, e);
    });
    worker.on('exit', (code) => {
      if (code !== 0) {
        const err = new Error(t('util.hashWorkerExited', { code }));
        err.workerFailed = true;
        finish(reject, err);
      }
    });

    if (opts.shouldAbort) {
      timer = setInterval(() => {
        if (opts.shouldAbort()) finish(reject, new CancelError(t('util.verifyCancelled')));
      }, 200);
      if (timer.unref) timer.unref();
    }
  });
}

/**
 * Compute the SHA256 of a file (uppercase hex).
 * Runs on a worker thread by default so the main thread is not blocked; falls back to the main thread when the worker is unavailable.
 *
 * 计算文件 SHA256（大写十六进制）。
 * 默认放到 worker 线程，避免阻塞主线程；worker 不可用时回退主线程。
 *
 * @param {string} file
 * @param {{onProgress?: (bytes:number)=>void, shouldAbort?: ()=>boolean, worker?: boolean, chunkSize?: number}} [opts]
 * @returns {Promise<string>}
 */
async function sha256File(file, opts = {}) {
  const wantWorker = opts.worker !== false && process.env.CIVITAI_NO_HASH_WORKER !== '1';
  if (wantWorker && fs.existsSync(HASH_WORKER)) {
    try {
      return await sha256FileInWorker(file, opts);
    } catch (e) {
      if (!e.workerFailed) throw e;
      // Worker infrastructure failed → fall back to the main thread so the feature still works
      // worker 基础设施异常 → 回退主线程，保证功能可用
    }
  }
  return sha256FileMainThread(file, opts);
}

// ---------------------------------------------------------------------------
// File moves
// 文件移动
// ---------------------------------------------------------------------------

/**
 * Move one file, falling back to copy+delete when it crosses volumes.
 * 移动单个文件，跨卷时回退为「复制 + 删除」。
 * @returns {'renamed'|'copied'|null} null 表示源文件不存在或移动失败
 */
function moveFile(from, to) {
  try {
    if (!fs.existsSync(from)) return null;
    fs.mkdirSync(path.dirname(to), { recursive: true });
    fs.renameSync(from, to);
    return 'renamed';
  } catch (e) {
    // EXDEV (or a locked rename): copy and delete instead
    // EXDEV（或 rename 被占用）：改为复制 + 删除
    try {
      fs.copyFileSync(from, to);
      fs.rmSync(from, { force: true });
      return 'copied';
    } catch (err) {
      return null;
    }
  }
}

/**
 * Apply a rename plan inside one directory (entries that no longer exist are skipped).
 * 在一个目录内执行改名计划（已不存在的条目直接跳过）。
 * @param {{dir:string, renames:Array<{versionId?:string, from:string, to:string}>}} input
 * @returns {Array<{versionId?:string, from:string, to:string, how:string}>} 实际完成的改名
 */
function applyRenames(input = {}) {
  const dir = input.dir;
  const done = [];
  for (const rename of Array.isArray(input.renames) ? input.renames : []) {
    if (!rename || !rename.from || !rename.to || rename.from === rename.to) continue;
    const how = moveFile(path.join(dir, rename.from), path.join(dir, rename.to));
    if (!how) continue;
    done.push({ versionId: rename.versionId, from: rename.from, to: rename.to, how });
  }
  return done;
}

// ---------------------------------------------------------------------------
// JSON / directories
// JSON / 目录
// ---------------------------------------------------------------------------

/**
 * Read JSON, telling "file missing" apart from "file corrupt".
 * 读取 JSON，区分「文件不存在」与「文件损坏」。
 * @returns {{ok:boolean, missing:boolean, empty?:boolean, error:Error|null, data:any}}
 */
function readJsonResult(file) {
  let text;
  try {
    text = fs.readFileSync(file, 'utf8');
  } catch (e) {
    if (e.code === 'ENOENT') return { ok: false, missing: true, error: null, data: undefined };
    return { ok: false, missing: false, error: e, data: undefined };
  }
  if (!text.trim()) {
    return { ok: false, missing: false, empty: true, error: new Error(t('util.emptyFile')), data: undefined };
  }
  try {
    return { ok: true, missing: false, error: null, data: JSON.parse(text) };
  } catch (e) {
    return { ok: false, missing: false, error: e, data: undefined };
  }
}

/**
 * Lenient read: return fallback when the file is corrupt or missing (for non-critical caches only).
 * 宽容读取：损坏或缺席都返回 fallback（仅供非关键缓存使用）。
 */
function readJson(file, fallback) {
  const r = readJsonResult(file);
  return r.ok ? r.data : fallback;
}

function ensureDir(dir) {
  fs.mkdirSync(dir, { recursive: true });
}

/**
 * Back the file up and return the backup path (null when the file is missing or the copy failed).
 * 备份文件，返回备份路径（不存在或失败返回 null）。
 */
function backupFile(file, tag = 'bak') {
  if (!fs.existsSync(file)) return null;
  const dest = `${file}.${tag}-${Date.now()}`;
  try {
    fs.copyFileSync(file, dest);
    return dest;
  } catch (e) {
    return null;
  }
}

/**
 * Atomically write JSON: write a temp file, fsync it, then rename it over the target.
 * Prevents a crash or power loss mid-write from leaving a half-written file.
 *
 * 原子写入 JSON：先写临时文件并 fsync，再 rename 覆盖。
 * 避免写入过程中崩溃/断电导致文件半截。
 * @param {string} file
 * @param {any} data
 * @param {{backup?: boolean}} [opts]
 */
function writeJsonAtomic(file, data, opts = {}) {
  const dir = path.dirname(file);
  fs.mkdirSync(dir, { recursive: true });
  const tmp = path.join(dir, `.${path.basename(file)}.${process.pid}.tmp`);
  const payload = JSON.stringify(data, null, 2) + '\n';
  const fd = fs.openSync(tmp, 'w');
  try {
    fs.writeFileSync(fd, payload, 'utf8');
    try {
      fs.fsyncSync(fd);
    } catch (e) {
      // Some file systems do not support fsync; ignore the failure
      // 某些文件系统不支持 fsync，忽略
    }
  } finally {
    fs.closeSync(fd);
  }
  if (opts.backup && fs.existsSync(file)) {
    try {
      fs.copyFileSync(file, `${file}.bak`);
    } catch (e) {
      // A failed backup must not block the main flow
      // 备份失败不阻断主流程
    }
  }
  fs.renameSync(tmp, file);
  return file;
}

/**
 * Default write (atomic, no backup).
 * 默认写入（原子，无备份）。
 */
function writeJson(file, data) {
  return writeJsonAtomic(file, data);
}

// ---------------------------------------------------------------------------
// Argument parsing
// 参数解析
// ---------------------------------------------------------------------------

/**
 * Value flags: only these flags consume the argument that follows them.
 * The strategy is "only an explicitly declared flag eats a value" — unknown flags are always treated as booleans,
 * so a typo or a newly added switch never silently swallows the positional argument after it
 * (for example `pin --list 161106` used to take the collection ID as the value of --list).
 *
 * 取值旗标：只有这些旗标才会消费后面的参数。
 * 采用"显式声明才吃值"的策略 —— 未知旗标一律当作布尔旗标，
 * 这样任何拼错/新增的开关都不会悄悄吞掉后面的位置参数
 * （例如 `pin --list 161106` 以前会把收藏集 ID 当成 --list 的值）。
 */
const VALUE_FLAGS = new Set([
  'out',
  'only',
  'version',
  'jobs',
  'attempts',
  'file-types',
  'collections',
  'model',
  'out-report',
  'type',
  'base-model',
  'min-size',
  'max-size',
  'exclude-tag',
  'trpc-path',
  'limit',
  'cursor',
  'dedup',
  'engine',
  'notify',
  // Single-model management (the `models` command)
  // 单模型管理（models 命令）
  'search',
  'sort',
  'export',
  'forget',
  'from-file',
]);

/**
 * Known boolean flags (they consume no argument). Documentation/validation only; unlisted flags are treated as booleans too.
 * 已知的布尔旗标（不消费参数）。仅用于文档/校验，未列出的旗标同样按布尔处理。
 */
const BOOLEAN_FLAGS = new Set([
  'json',
  'plan',
  'force',
  'dry-run',
  'verify-files',
  'download',
  'all',
  'yes',
  'verbose',
  'quiet',
  'help',
  'refresh-meta',
  'from-cache',
  'offline',
  'resume',
  'repair',
  'local',
  'deep',
  'quick',
  'pin',
  'unpin',
  'list',
  'no-hash',
  'no-color',
  'no-primary',
  'keep-part',
  'ignore-space',
  'force-lock',
  'check',
  'reset-state',
  'toast',
  'relayout',
]);

/**
 * @param {string[]} argv
 * @param {{booleanFlags?: string[], valueFlags?: string[], knownFlags?: string[]}} [options]
 * @returns {{positionals:string[], flags:Record<string,string|boolean>, unknown:string[]}}
 */
function parseArgs(argv, options = {}) {
  const values = new Set([...VALUE_FLAGS, ...(options.valueFlags || [])]);
  const known = options.knownFlags ? new Set(options.knownFlags) : null;
  const positionals = [];
  const flags = {};
  const unknown = [];
  let onlyPositional = false;

  for (let i = 0; i < argv.length; i++) {
    const arg = String(argv[i]);
    if (onlyPositional) {
      positionals.push(arg);
      continue;
    }
    if (arg === '--') {
      onlyPositional = true;
      continue;
    }
    if (arg.startsWith('--')) {
      const eq = arg.indexOf('=');
      let key;
      let value;
      if (eq !== -1) {
        key = arg.slice(2, eq);
        value = arg.slice(eq + 1);
      } else {
        key = arg.slice(2);
        const next = argv[i + 1];
        const nextIsFlag = next !== undefined && String(next).startsWith('--');
        if (values.has(key) && next !== undefined && !nextIsFlag) {
          value = String(next);
          i++;
        } else {
          value = true;
        }
      }
      if (known && !known.has(key)) unknown.push(key);
      flags[key] = value;
    } else {
      positionals.push(arg);
    }
  }
  return { positionals, flags, unknown };
}

// ---------------------------------------------------------------------------
// Concurrency / retries
// 并发 / 重试
// ---------------------------------------------------------------------------

/**
 * Map with a concurrency limit (input order is preserved).
 * 有并发上限的 map（保持输入顺序）。
 * @template T,R
 * @param {T[]} items
 * @param {number} limit
 * @param {(item:T, index:number)=>Promise<R>} fn
 * @param {(error:Error, item:T, index:number)=>void} [onError] 提供时错误不中断整体，结果记 undefined
 * @returns {Promise<R[]>}
 */
async function mapPool(items, limit, fn, onError) {
  const list = Array.from(items);
  const results = new Array(list.length);
  if (!list.length) return results;
  const size = Math.max(1, Math.min(Math.floor(limit) || 1, list.length));
  let cursor = 0;
  const runners = Array.from({ length: size }, async () => {
    for (;;) {
      const index = cursor++;
      if (index >= list.length) return;
      try {
        results[index] = await fn(list[index], index);
      } catch (e) {
        if (!onError) throw e;
        onError(e, list[index], index);
        results[index] = undefined;
      }
    }
  });
  await Promise.all(runners);
  return results;
}

/**
 * Generic retry: exponential backoff with jitter, honouring RateLimitError.retryAfterMs.
 * 通用重试：指数退避 + 抖动，识别 RateLimitError.retryAfterMs。
 * @template T
 * @param {(attempt:number)=>Promise<T>} fn
 * @param {{attempts?:number, baseDelayMs?:number, maxDelayMs?:number, shouldRetry?:(e:Error,attempt:number)=>boolean, onRetry?:(e:Error,attempt:number,delayMs:number)=>void}} [opts]
 * @returns {Promise<T>}
 */
async function withRetry(fn, opts = {}) {
  const attempts = Math.max(1, opts.attempts || 3);
  const base = opts.baseDelayMs || 500;
  const maxDelay = opts.maxDelayMs || 15000;
  let lastError;
  for (let attempt = 1; attempt <= attempts; attempt++) {
    try {
      return await fn(attempt);
    } catch (e) {
      lastError = e;
      const retryable = opts.shouldRetry ? opts.shouldRetry(e, attempt) : true;
      if (attempt >= attempts || !retryable) throw e;
      const hinted = e && e.retryAfterMs ? Math.min(e.retryAfterMs, maxDelay * 4) : 0;
      const backoff = Math.min(maxDelay, base * 2 ** (attempt - 1));
      const delay = hinted || Math.round(backoff * (0.5 + Math.random() * 0.5));
      if (opts.onRetry) opts.onRetry(e, attempt, delay);
      await sleep(delay);
    }
  }
  throw lastError;
}

module.exports = {
  // Basics
  // 基础
  log,
  setLogSink,
  ts,
  sleep,
  // Names / paths
  // 名称 / 路径
  MAX_PATH_WIN,
  sanitizeName,
  shortHash,
  pathTooLong,
  diskDirName,
  diskFileName,
  uniqueName,
  resolveUserPath,
  // File moves
  // 文件移动
  moveFile,
  applyRenames,
  // Formatting
  // 格式化
  formatBytes,
  formatDuration,
  truncate,
  // Hashing
  // 哈希
  sha256File,
  // JSON / directories
  // JSON / 目录
  readJson,
  readJsonResult,
  writeJson,
  writeJsonAtomic,
  backupFile,
  ensureDir,
  // Arguments
  // 参数
  parseArgs,
  BOOLEAN_FLAGS,
  VALUE_FLAGS,
  // Concurrency / retries
  // 并发 / 重试
  mapPool,
  withRetry,
};
