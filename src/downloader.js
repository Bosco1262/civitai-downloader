'use strict';

const fs = require('fs');
const path = require('path');
const { spawnSync } = require('child_process');
const { log, sleep, formatBytes, sha256File } = require('./util');

const ATTEMPTS = 5;

let curlBin = null;

function checkCurl() {
  if (curlBin) return curlBin;
  for (const bin of ['curl.exe', 'curl']) {
    try {
      const r = spawnSync(bin, ['--version'], { encoding: 'utf8', windowsHide: true });
      if (!r.error && r.status === 0) {
        curlBin = bin;
        return curlBin;
      }
    } catch (e) {
      // try next candidate
    }
  }
  throw new Error('未找到 curl，请先安装 curl（Windows 10/11 自带）或将其加入 PATH');
}

function runCurl({ url, cookieFile, out, userAgent }) {
  const isTTY = !!process.stdout.isTTY;
  const args = [
    '-L',
    '--fail',
    '--cookie', cookieFile,
    '-A', userAgent,
    '--retry', '5',
    '--retry-delay', '5',
    '--retry-connrefused',
    '--speed-limit', '51200',
    '--speed-time', '120',
    '-C', '-',
    '-o', out,
    '-w', '%{http_code} %{size_download} %{speed_download} %{time_total}',
    url,
  ];
  if (isTTY) {
    args.unshift('--progress-bar');
  } else {
    args.unshift('-sS', '--no-progress-meter');
  }
  const r = spawnSync(checkCurl(), args, {
    stdio: ['ignore', 'pipe', isTTY ? 'inherit' : 'pipe'],
    maxBuffer: 16 * 1024 * 1024,
    windowsHide: true,
  });
  const stdout = (r.stdout || '').toString('utf8').trim();
  const stderr = (r.stderr || '').toString('utf8').trim();
  const parts = stdout.split(/\s+/);
  return {
    exitCode: r.status,
    httpCode: Number(parts[0]) || 0,
    sizeDownloaded: Number(parts[1]) || 0,
    stderr,
  };
}

async function downloadFile(opts) {
  const { url, cookieFile, dir, fileName, expectedSha256, expectedBytes, userAgent, force } = opts;
  const target = path.join(dir, fileName);
  const part = target + '.part';
  const tolerance = expectedBytes ? Math.max(1024, expectedBytes * 0.001) : 0;

  if (!force && fs.existsSync(target) && fs.statSync(target).size > 0) {
    if (!expectedSha256) return 'verified';
    const h = await sha256File(target).catch(() => null);
    if (h === expectedSha256) return 'verified';
    log(`  已存在的文件哈希不匹配，将重新下载: ${fileName}`);
  }

  for (let attempt = 1; attempt <= ATTEMPTS; attempt++) {
    const r = runCurl({ url, cookieFile, out: part, userAgent });

    if (r.httpCode === 401 || r.httpCode === 403) {
      throw new Error(`认证失败（HTTP ${r.httpCode}），登录可能已过期，请重新运行: npm run login`);
    }
    if (r.httpCode === 404) {
      throw new Error('HTTP 404: 下载链接无效或文件已下架');
    }
    if (r.exitCode !== 0) {
      const errLine = r.stderr ? ` ${r.stderr.split('\n')[0].slice(0, 160)}` : '';
      log(`  第 ${attempt}/${ATTEMPTS} 次失败（exit=${r.exitCode}, HTTP ${r.httpCode}）${errLine}，稍后重试`);
      await sleep(5000);
      continue;
    }
    if (!fs.existsSync(part)) {
      log(`  第 ${attempt}/${ATTEMPTS} 次未产生文件，稍后重试`);
      await sleep(5000);
      continue;
    }

    const size = fs.statSync(part).size;
    if (expectedBytes && size > expectedBytes + tolerance) {
      log(`  文件超出预期大小（${formatBytes(size)} > ${formatBytes(expectedBytes)}），删除后重试`);
      fs.rmSync(part, { force: true });
      await sleep(2000);
      continue;
    }
    const sizeOk = !expectedBytes || size >= expectedBytes - tolerance;
    if (sizeOk) {
      const h = expectedSha256 ? await sha256File(part).catch(() => null) : null;
      if (!expectedSha256 || h === expectedSha256) {
        fs.rmSync(target, { force: true });
        fs.renameSync(part, target);
        return 'downloaded';
      }
      log(`  SHA256 不匹配（实际 ${h || '计算失败'}），删除后重新下载`);
      fs.rmSync(part, { force: true });
    } else {
      log(
        `  已下载 ${formatBytes(size)} / ${formatBytes(expectedBytes)}，继续断点续传（第 ${attempt}/${ATTEMPTS} 次）`
      );
    }
    await sleep(3000);
  }
  throw new Error(`下载失败（已重试 ${ATTEMPTS} 次）: ${fileName}`);
}

module.exports = { checkCurl, downloadFile, runCurl };
