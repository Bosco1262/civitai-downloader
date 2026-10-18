'use strict';

/**
 * SHA256 hashing worker thread.
 *
 * Hashing used to run update() chunk by chunk on the main thread, which kept the main thread busy
 * for multi-GB files and delayed the TUI's periodic redraw (the UI looked frozen). The computation
 * now runs in a worker, and the main thread only receives progress messages.
 *
 *
 * SHA256 计算工作线程。
 *
 * 之前哈希在主线程逐块 update，校验数 GB 文件时会持续占用主线程，
 * 导致 TUI 的定时重绘被推迟（界面看起来卡死）。这里把计算搬到 worker，
 * 主线程只接收进度消息。
 */

const crypto = require('crypto');
const fs = require('fs');
const { parentPort, workerData } = require('worker_threads');

const file = workerData && workerData.file;
const highWaterMark = (workerData && workerData.highWaterMark) || 4 * 1024 * 1024;
const progressIntervalMs = (workerData && workerData.progressIntervalMs) || 250;

const hash = crypto.createHash('sha256');
let read = 0;
let lastReport = Date.now();
let settled = false;

function finish(msg) {
  if (settled) return;
  settled = true;
  try {
    parentPort.postMessage(msg);
  } catch (e) {
    // The main thread may have terminated this worker; ignore.
    // 主线程可能已终止本线程，忽略。
  }
}

let stream;
try {
  stream = fs.createReadStream(file, { highWaterMark });
} catch (e) {
  finish({ type: 'error', message: e.message, code: e.code || null });
}

if (stream) {
  stream.on('data', (chunk) => {
    hash.update(chunk);
    read += chunk.length;
    const now = Date.now();
    if (now - lastReport >= progressIntervalMs) {
      lastReport = now;
      try {
        parentPort.postMessage({ type: 'progress', bytes: read });
      } catch (e) {
        // Ignore.
        // 忽略。
      }
    }
  });
  stream.on('end', () => {
    finish({ type: 'done', hash: hash.digest('hex').toUpperCase(), bytes: read });
  });
  stream.on('error', (e) => {
    finish({ type: 'error', message: e.message, code: e.code || null });
  });
}
