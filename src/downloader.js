'use strict';

/**
 * Download engine (built on curl).
 *
 * Key guarantee: a *.part file is renamed to its final name only after verification passes, so repeated runs are idempotent.
 *
 * What this adds over the old implementation:
 *  - check whether the .part file is already complete before resuming (avoids a 416 from a Range request on a complete file);
 *  - record ETag/length in <file>.part.json and compare before resuming; drop the stale part when the remote file changed;
 *  - handle 416/resume errors separately (drop the part and download again) instead of spinning 5 times as an ordinary failure;
 *  - wait on 429 rate limiting; proxy support; typed errors.
 *
 *
 * 下载引擎（基于 curl）。
 *
 * 关键保证：只有校验通过才会把 *.part 改名为正式文件，因此重复运行幂等。
 *
 * 相比旧实现补齐：
 *  - 续传前先判断 .part 是否已完整（避免对完整文件发 Range 请求得到 416）；
 *  - 用 <file>.part.json 记录 ETag/长度，续传前比对，文件已变更则丢弃旧分片；
 *  - 416/续传类错误单独处理（丢弃分片重下），而不是当作普通失败空转 5 次；
 *  - 429 按限流等待；代理支持；错误类型化。
 */

const fs = require('fs');
const path = require('path');
const { spawn, spawnSync } = require('child_process');
const { log, sleep, formatBytes, sha256File, readJson, writeJsonAtomic } = require('./util');
const { CancelError, AuthError, NotFoundError, DownloadError, CANCEL_MESSAGE } = require('./errors');
const { t } = require('./i18n');

const ATTEMPTS = 5;
const SPEED_LIMIT = 51200; // 50 KB/s 下限 / 50 KB/s lower bound
const SPEED_TIME = 120; // 低于限速持续 2 分钟即断开 / cut off after 2 minutes below the limit

let curlBin = null;
let currentCurl = null;
let aborted = false;

/**
 * Dependency-injection hooks: real curl is used by default; tests can swap in stubs,
 * because inter-process pipes are unavailable in the restricted environment and real downloads need the network.
 *
 * 依赖注入点：默认使用真实 curl；测试可替换为桩函数，
 * 因为进程间管道在受限环境下不可用，且真实下载需要网络。
 */
let runCurlImpl = null;
let headImpl = null;
let sleepImpl = sleep;

function setCurlImplementations(impl = {}) {
  if (impl.runCurl) runCurlImpl = impl.runCurl;
  if (impl.head) headImpl = impl.head;
  if (impl.sleep) sleepImpl = impl.sleep;
}

function resetCurlImplementations() {
  runCurlImpl = null;
  headImpl = null;
  sleepImpl = sleep;
}

function activeRunCurl(opts) {
  if (runCurlImpl) return runCurlImpl(opts);
  if (opts && opts.engine === 'aria2') return runAria2(opts);
  return runCurl(opts);
}

function activeSleep(ms) {
  return sleepImpl(ms);
}

function checkCurl() {
  if (curlBin) return curlBin;
  let lastError = '';
  for (const bin of ['curl.exe', 'curl']) {
    try {
      const r = spawnSync(bin, ['--version'], { encoding: 'utf8', windowsHide: true });
      if (!r.error && r.status === 0) {
        curlBin = bin;
        return curlBin;
      }
      if (r.error) lastError = r.error.message;
      else lastError = t('downloader.curlExitCode', { bin, code: r.status });
    } catch (e) {
      lastError = e.message;
    }
  }
  throw new DownloadError(
    t('downloader.curlMissing', {
      detail: lastError ? t('downloader.curlLastError', { error: lastError }) : '',
    })
  );
}

// ---------------------------------------------------------------------------
// aria2c engine (optional; multiple connections make large downloads faster)
// aria2c 引擎（可选，多连接下载大文件更快）
// ---------------------------------------------------------------------------

let aria2Available = null;

/**
 * Whether aria2c is available (result cached).
 * 检测 aria2c 是否可用（结果缓存）。
 */
function checkAria2() {
  if (aria2Available !== null) return aria2Available;
  try {
    const r = spawnSync('aria2c', ['--version'], { encoding: 'utf8', windowsHide: true });
    aria2Available = !r.error && r.status === 0;
  } catch (e) {
    aria2Available = false;
  }
  return aria2Available;
}

function resetAria2Cache() {
  aria2Available = null;
}

/**
 * Build the aria2c arguments (pure function, easy to test).
 * It still downloads into *.part, keeping the "rename only after verification" convention.
 *
 * 组装 aria2c 参数（纯函数，便于测试）。
 * 仍然下载到 *.part，保持「校验通过才改名」的约定。
 */
function buildAria2Args(opts) {
  const {
    url,
    out,
    cookieFile,
    userAgent,
    proxy,
    connections = 8,
    split = 8,
    minSplitSize = '1M',
    retryCount = 5,
    speedLimit = '50K',
  } = opts;

  const args = [
    '--no-conf',
    '--continue=true',
    '--auto-file-renaming=false',
    '--allow-overwrite=true',
    '--file-allocation=none',
    '--summary-interval=0',
    '--console-log-level=warn',
    '--show-console-readout=false',
    '--max-tries=' + String(retryCount),
    '--retry-wait=5',
    '--connect-timeout=30',
    '--timeout=60',
    '--max-connection-per-server=' + String(connections),
    '--split=' + String(split),
    '--min-split-size=' + minSplitSize,
    '--lowest-speed-limit=' + speedLimit,
    '-o',
    out,
  ];
  if (userAgent) args.push('--user-agent=' + userAgent);
  if (cookieFile) args.push('--load-cookies=' + cookieFile);
  if (proxy) args.push('--all-proxy=' + proxy);
  args.push(url);
  return args;
}

/**
 * Guess the HTTP status code from the aria2c output (it has no curl-style -w).
 * 从 aria2c 输出里猜 HTTP 状态码（它没有 curl 的 -w）。
 */
function parseAria2HttpCode(text) {
  const s = String(text || '');
  const named = /\b(401|403|404|416|429)\b/.exec(s);
  if (named) return Number(named[1]);
  const server = /\b(5\d\d)\b/.exec(s);
  if (server) return Number(server[1]);
  if (/\bunauthorized\b/i.test(s)) return 401;
  if (/\bforbidden\b/i.test(s)) return 403;
  if (/\bnot found\b/i.test(s)) return 404;
  return 0;
}

/**
 * Download with aria2c (the returned structure matches runCurl).
 * 用 aria2c 下载（返回结构与 runCurl 对齐）。
 */
function runAria2(opts) {
  return new Promise((resolve) => {
    const args = buildAria2Args(opts);
    const child = spawn('aria2c', args, { stdio: ['ignore', 'pipe', 'pipe'], windowsHide: true });
    currentCurl = child;

    const MAX_OUTPUT = 1 * 1024 * 1024;
    let stdout = '';
    let stderr = '';
    child.stdout.on('data', (c) => {
      if (stdout.length < MAX_OUTPUT) stdout += c.toString('utf8');
    });
    child.stderr.on('data', (c) => {
      if (stderr.length < MAX_OUTPUT) stderr += c.toString('utf8');
    });
    child.on('error', (e) => {
      stderr = String((e && e.message) || e);
    });
    child.on('close', (code) => {
      if (currentCurl === child) currentCurl = null;
      const text = `${stdout}\n${stderr}`;
      const httpCode = parseAria2HttpCode(text);
      resolve({
        exitCode: code,
        httpCode,
        sizeDownloaded: 0,
        speed: 0,
        seconds: 0,
        stderr: stderr.trim() || stdout.trim(),
        engine: 'aria2',
        // aria2c: 8 means the server does not support resume; 416 likewise, so the part must be dropped and restarted.
        // aria2c: 8 = 服务端不支持续传；416 同理，需要丢弃分片重来
        resumeFailed: code === 8 || httpCode === 416,
      });
    });
  });
}

/**
 * Pick the engine that is actually used.
 * 选择实际使用的引擎。
 * @param {'curl'|'aria2'|'auto'} requested
 * @returns {'curl'|'aria2'}
 */
function resolveEngine(requested) {
  const want = String(requested || 'curl').toLowerCase();
  if (want === 'aria2') {
    if (!checkAria2()) {
      throw new DownloadError(t('downloader.aria2Missing'));
    }
    return 'aria2';
  }
  if (want === 'auto') return checkAria2() ? 'aria2' : 'curl';
  return 'curl';
}

function resetCancel() {
  aborted = false;
}

function isAborted() {
  return aborted;
}

function isCancelError(e) {
  return e instanceof CancelError || !!(e && e.code === 'CancelError');
}

function cancelCurrentDownload() {
  aborted = true;
  const child = currentCurl;
  if (child && !child.killed) {
    try {
      child.kill();
    } catch (e) {
      // Ignore: the child process may have exited already.
      // 忽略：子进程可能已经退出。
    }
  }
}

function sidecarPath(target) {
  return `${target}.part.json`;
}

/**
 * Invoke curl.
 * @param {{url:string, cookieFile:string, out:string, userAgent:string, quiet?:boolean, proxy?:string,
 *          retryCount?:number, headerFile?:string, resume?:boolean}} opts
 *
 *
 * 调用 curl。
 */
function runCurl(opts) {
  const { url, cookieFile, out, userAgent, quiet, proxy, retryCount = 5, headerFile, resume = true } = opts;
  return new Promise((resolve) => {
    const showProgress = !quiet && !!process.stdout.isTTY;
    const args = [
      '-L',
      '--fail',
      '--cookie', cookieFile,
      '-A', userAgent,
      '--retry', String(retryCount),
      '--retry-delay', '5',
      '--retry-connrefused',
      '--speed-limit', String(SPEED_LIMIT),
      '--speed-time', String(SPEED_TIME),
    ];
    if (resume) args.push('-C', '-');
    if (proxy) args.push('--proxy', proxy);
    if (headerFile) args.push('-D', headerFile);
    args.push('-o', out);
    args.push('-w', '%{http_code} %{size_download} %{speed_download} %{time_total}');
    args.push(url);

    if (showProgress) {
      args.unshift('--progress-bar');
    } else {
      args.unshift('-sS', '--no-progress-meter');
    }

    const MAX_OUTPUT = 16 * 1024 * 1024;
    const child = spawn(checkCurl(), args, {
      stdio: ['ignore', 'pipe', showProgress ? 'inherit' : 'pipe'],
      windowsHide: true,
    });
    currentCurl = child;

    let stdout = '';
    let stderr = '';
    child.stdout.on('data', (chunk) => {
      if (stdout.length < MAX_OUTPUT) stdout += chunk.toString('utf8');
    });
    if (child.stderr) {
      child.stderr.on('data', (chunk) => {
        if (stderr.length < MAX_OUTPUT) stderr += chunk.toString('utf8');
      });
    }
    child.on('error', (e) => {
      stderr = String((e && e.message) || e);
    });
    child.on('close', (code) => {
      if (currentCurl === child) currentCurl = null;
      const parts = stdout.trim().split(/\s+/);
      resolve({
        exitCode: code,
        httpCode: Number(parts[0]) || 0,
        sizeDownloaded: Number(parts[1]) || 0,
        speed: Number(parts[2]) || 0,
        seconds: Number(parts[3]) || 0,
        stderr: stderr.trim(),
      });
    });
  });
}

/**
 * Parse the response headers dumped by curl -D and keep the last response (the one after a followed 307).
 * 解析 curl -D 导出的响应头，取最后一次响应（跟随 307 之后的那个）。
 */
function parseHeaders(headerText) {
  if (!headerText) return {};
  const blocks = String(headerText)
    .split(/\r?\n\r?\n/)
    .map((b) => b.trim())
    .filter(Boolean);
  const last = blocks[blocks.length - 1] || '';
  const out = {};
  for (const line of last.split(/\r?\n/)) {
    const idx = line.indexOf(':');
    if (idx === -1) continue;
    const key = line.slice(0, idx).trim().toLowerCase();
    const value = line.slice(idx + 1).trim();
    if (key) out[key] = value;
  }
  return out;
}

function readSidecar(target) {
  const data = readJson(sidecarPath(target), null);
  return data && typeof data === 'object' ? data : null;
}

function writeSidecar(target, info) {
  try {
    writeJsonAtomic(sidecarPath(target), info);
  } catch (e) {
    // Ignore: writing the sidecar is best-effort.
    // 忽略：sidecar 写入属于尽力而为。
  }
}

/**
 * Clean up the temporary files produced while downloading (sidecar, response headers, aria2 control file).
 * 清理下载过程中产生的临时文件（sidecar、响应头、aria2 控制文件）。
 */
function cleanupArtifacts(target) {
  for (const file of [sidecarPath(target), `${target}.headers.tmp`, `${target}.part.aria2`]) {
    try {
      fs.rmSync(file, { force: true });
    } catch (e) {
      // Ignore: the temp file may already be gone.
      // 忽略：临时文件可能已经不存在。
    }
  }
}

/**
 * Fetch the remote ETag/length with a HEAD request (called only when a resume is really needed).
 * 用 HEAD 请求获取远端 ETag/长度（仅在确实要续传时调用）。
 */
async function fetchRemoteMeta(opts) {
  if (headImpl) return headImpl(opts);
  const { url, cookieFile, userAgent, proxy, timeoutSec = 30 } = opts;
  return new Promise((resolve) => {
    const args = [
      '-sS',
      '-I',
      '-L',
      '--fail',
      '--cookie', cookieFile,
      '-A', userAgent,
      '--max-time', String(timeoutSec),
    ];
    if (proxy) args.push('--proxy', proxy);
    args.push(url);
    const child = spawn(checkCurl(), args, { stdio: ['ignore', 'pipe', 'pipe'], windowsHide: true });
    let stdout = '';
    let stderr = '';
    child.stdout.on('data', (c) => {
      stdout += c.toString('utf8');
    });
    child.stderr.on('data', (c) => {
      stderr += c.toString('utf8');
    });
    child.on('error', (e) => resolve({ ok: false, error: e.message }));
    child.on('close', (code) => {
      if (code !== 0) {
        resolve({ ok: false, error: stderr.trim() || `curl exit ${code}` });
        return;
      }
      const headers = parseHeaders(stdout);
      resolve({
        ok: true,
        etag: headers.etag || null,
        length: Number(headers['content-length']) || 0,
      });
    });
  });
}

/**
 * Verify a file hash (cancellable).
 * 校验文件哈希（可取消）。
 */
function verifyFile(file, expectedSha256) {
  if (!expectedSha256) return Promise.resolve(null);
  return sha256File(file, { shouldAbort: isAborted });
}

/**
 * Download one file.
 * @param {{url:string, cookieFile:string, dir:string, fileName:string, expectedSha256?:string,
 *          expectedBytes?:number, userAgent:string, force?:boolean, quiet?:boolean, proxy?:string,
 *          attempts?:number, retryCount?:number, onAttempt?:Function}} opts
 *
 *
 * 下载一个文件。
 * @returns {Promise<'downloaded'|'verified'>}
 */
async function downloadFile(opts) {
  const {
    url,
    cookieFile,
    dir,
    fileName,
    expectedSha256,
    expectedBytes,
    userAgent,
    force,
    quiet,
    proxy,
    attempts = ATTEMPTS,
    retryCount = 5,
    onAttempt,
    engine,
  } = opts;

  const target = path.join(dir, fileName);
  const part = `${target}.part`;
  const headerFile = `${target}.headers.tmp`;
  const tolerance = expectedBytes ? Math.max(1024, expectedBytes * 0.001) : 0;
  const useEngine = resolveEngine(engine);

  if (aborted) throw new CancelError(CANCEL_MESSAGE);

  // 1) The target file exists and its hash passes → skip.
  // 1) 目标文件已存在且校验通过 → 跳过
  if (!force && fs.existsSync(target) && fs.statSync(target).size > 0) {
    if (!expectedSha256) return 'verified';
    const h = await verifyFile(target, expectedSha256).catch(() => null);
    if (h === expectedSha256) return 'verified';
    log(t('downloader.existingHashMismatch', { file: fileName }));
  }

  // 2) .part is already complete → verify it and rename on success (avoids a 416 from a Range request on a complete file).
  // 2) .part 已完整 → 直接校验，通过就改名（避免对完整文件发 Range 请求得到 416）
  if (fs.existsSync(part) && expectedBytes) {
    const partSize = fs.statSync(part).size;
    if (partSize > expectedBytes + tolerance) {
      log(t('downloader.partTooLarge', { size: formatBytes(partSize) }));
      fs.rmSync(part, { force: true });
      cleanupArtifacts(target);
    } else if (partSize >= expectedBytes - tolerance) {
      const h = await verifyFile(part, expectedSha256).catch(() => null);
      if (!expectedSha256 || h === expectedSha256) {
        fs.rmSync(target, { force: true });
        fs.renameSync(part, target);
        cleanupArtifacts(target);
        log(t('downloader.partReused', { file: fileName }));
        return 'downloaded';
      }
      log(t('downloader.partVerifyFailed', { file: fileName }));
      fs.rmSync(part, { force: true });
      cleanupArtifacts(target);
    }
  }

  for (let attempt = 1; attempt <= attempts; attempt++) {
    if (aborted) throw new CancelError(CANCEL_MESSAGE);

    // 3) Resume consistency: drop the old part when the remote file changed, so a file that cannot verify is never stitched together.
    // 3) 续传一致性：远端文件变了就丢弃旧分片，避免拼出必然校验失败的文件
    if (fs.existsSync(part) && !force) {
      const side = readSidecar(target);
      if (side && side.etag) {
        const remote = await fetchRemoteMeta({ url, cookieFile, userAgent, proxy });
        if (aborted) throw new CancelError(CANCEL_MESSAGE);
        if (remote.ok && remote.etag && remote.etag !== side.etag) {
          log(t('downloader.remoteChanged'));
          fs.rmSync(part, { force: true });
          cleanupArtifacts(target);
        }
      }
    }

    const r = await activeRunCurl({
      url,
      cookieFile,
      out: part,
      userAgent,
      quiet,
      proxy,
      retryCount,
      headerFile,
      resume: !force,
    });
    if (aborted) throw new CancelError(CANCEL_MESSAGE);

    if (onAttempt) onAttempt({ attempt, max: attempts, httpCode: r.httpCode, exitCode: r.exitCode });

    if (r.httpCode === 401 || r.httpCode === 403) {
      throw new AuthError(t('downloader.authFailed', { status: r.httpCode }));
    }
    if (r.httpCode === 404) {
      throw new NotFoundError(t('downloader.notFound404'));
    }
    if (r.httpCode === 416) {
      log(t('downloader.rangeRejected'));
      fs.rmSync(part, { force: true });
      cleanupArtifacts(target);
      await activeSleep(1000);
      continue;
    }
    if (r.httpCode === 429) {
      log(t('downloader.rateLimited'));
      await activeSleep(30000);
      continue;
    }

    // curl resume errors (33/36) and aria2c 8/416 mean the part does not match the server: drop it and start over.
    // curl 的续传类错误（33/36）与 aria2c 的 8/416：分片与服务端不匹配，丢弃重来
    if (r.exitCode === 33 || r.exitCode === 36 || r.resumeFailed) {
      log(
        t('downloader.resumeFailed', {
          engine: r.engine === 'aria2' ? 'aria2c' : 'curl',
          code: r.exitCode,
        })
      );
      fs.rmSync(part, { force: true });
      cleanupArtifacts(target);
      await activeSleep(1000);
      continue;
    }

    if (r.exitCode !== 0) {
      const errLine = r.stderr ? ` ${r.stderr.split('\n')[0].slice(0, 160)}` : '';
      log(
        t('downloader.attemptFailed', {
          attempt,
          attempts,
          code: r.exitCode,
          http: r.httpCode,
          detail: errLine,
        })
      );
      await activeSleep(5000);
      continue;
    }
    if (!fs.existsSync(part)) {
      log(t('downloader.attemptNoFile', { attempt, attempts }));
      await activeSleep(5000);
      continue;
    }

    // Record the ETag so the next resume can compare against it.
    // 记录 ETag，供下次续传比对
    let headers = {};
    try {
      if (fs.existsSync(headerFile)) headers = parseHeaders(fs.readFileSync(headerFile, 'utf8'));
    } catch (e) {
      headers = {};
    }

    const size = fs.statSync(part).size;
    if (expectedBytes && size > expectedBytes + tolerance) {
      log(
        t('downloader.sizeExceeded', {
          size: formatBytes(size),
          expected: formatBytes(expectedBytes),
        })
      );
      fs.rmSync(part, { force: true });
      cleanupArtifacts(target);
      await activeSleep(2000);
      continue;
    }

    const sizeOk = !expectedBytes || size >= expectedBytes - tolerance;
    if (sizeOk) {
      const h = await verifyFile(part, expectedSha256).catch((e) => {
        if (isCancelError(e)) throw e;
        return null;
      });
      if (!expectedSha256 || h === expectedSha256) {
        fs.rmSync(target, { force: true });
        fs.renameSync(part, target);
        cleanupArtifacts(target);
        return 'downloaded';
      }
      log(t('downloader.shaMismatch', { actual: h || t('downloader.hashComputeFailed') }));
      fs.rmSync(part, { force: true });
      cleanupArtifacts(target);
    } else {
      writeSidecar(target, {
        etag: headers.etag || null,
        length: Number(headers['content-length']) || expectedBytes || null,
        url,
        at: new Date().toISOString(),
      });
      log(
        t('downloader.resuming', {
          size: formatBytes(size),
          total: formatBytes(expectedBytes),
          attempt,
          attempts,
        })
      );
    }
    await activeSleep(3000);
  }

  try {
    fs.rmSync(headerFile, { force: true });
  } catch (e) {
    // Ignore: the header file may already be gone.
    // 忽略：响应头文件可能已经不存在。
  }
  throw new DownloadError(t('downloader.failed', { attempts, file: fileName }));
}

module.exports = {
  checkCurl,
  checkAria2,
  resetAria2Cache,
  buildAria2Args,
  parseAria2HttpCode,
  runAria2,
  resolveEngine,
  downloadFile,
  runCurl,
  parseHeaders,
  fetchRemoteMeta,
  resetCancel,
  isAborted,
  isCancelError,
  cancelCurrentDownload,
  sidecarPath,
  setCurlImplementations,
  resetCurlImplementations,
  CANCEL_MESSAGE,
};
