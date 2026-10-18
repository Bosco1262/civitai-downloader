'use strict';

/**
 * Progress tracking for a download job, independent of the UI layer.
 *
 * The download job reports what it is doing through callbacks (`onFileStart`, `onItemDone`); this
 * tracker turns those callbacks plus on-disk file sizes into the numbers the web UI shows: how many
 * items are done, how many bytes are on disk, the current speed and the file being downloaded.
 *
 * It is pure apart from `fs.statSync`, which can be injected, so the arithmetic is unit-testable
 * without a terminal or a real download.
 *
 *
 * 下载任务的进度统计，与具体界面无关。
 *
 * 下载任务通过回调（`onFileStart`、`onItemDone`）汇报自己在做什么；这个跟踪器把这些回调加上磁盘上的
 * 文件大小，换算成 Web UI 需要显示的数字：完成多少项、已落盘多少字节、当前速度、正在下载的文件。
 *
 * 除 `fs.statSync`（可注入）之外都是纯计算，因此不依赖终端或真实下载即可单测。
 */

const fs = require('fs');
const path = require('path');
const { diskFileName } = require('../util');

/**
 * Size of the downloaded part of one file (finished file first, then the `.part` file).
 * Caps at the expected size so a resumed file that overshoots never skews the totals.
 *
 * 单个文件已下载的大小（先看成品文件，再看 `.part`）。上限取预期大小，
 * 避免续传时的超额部分把总量算歪。
 */
function sizeOnDisk(entry, statFile = fs.statSync) {
  const expected = Number(entry.expected) || 0;
  for (const file of [entry.target, entry.part]) {
    try {
      const st = statFile(file);
      if (st && st.size > 0) return expected > 0 ? Math.min(st.size, expected) : st.size;
    } catch (e) {
      // Not there (yet): try the next candidate.
      // 还不存在：试下一个候选。
    }
  }
  return 0;
}

/**
 * Create a tracker for one plan.
 * 为一个下载计划创建跟踪器。
 *
 * @param {{
 *   plan:Array<{modelId:string|number, name?:string, totalBytes?:number}>,
 *   now?:() => number,
 *   statFile?:(file:string) => {size:number}
 * }} opts
 * @returns {{
 *   fileStarted:(item:object, file:object, dir:string) => void,
 *   itemDone:(item:object, ok:boolean, status?:string) => void,
 *   attempt:(info:object) => void,
 *   snapshot:() => object
 * }}
 */
function createTracker(opts = {}) {
  const plan = Array.isArray(opts.plan) ? opts.plan : [];
  const now = typeof opts.now === 'function' ? opts.now : () => Date.now();
  const statFile = typeof opts.statFile === 'function' ? opts.statFile : fs.statSync;

  const expectedTotal = plan.reduce((sum, item) => sum + (Number(item.totalBytes) || 0), 0);
  // In-flight file per model id.
  // 每个模型正在写的文件。
  const active = new Map();
  let doneBytes = 0;
  let done = 0;
  let skipped = 0;
  let failed = 0;
  let attempt = null;
  let lastSample = { at: now(), bytes: 0 };
  let speed = 0;

  function activeBytes() {
    let sum = 0;
    for (const entry of active.values()) sum += sizeOnDisk(entry, statFile);
    return sum;
  }

  return {
    /**
     * A file started downloading: remember where it goes so its size can be sampled later.
     * 某个文件开始下载：记住落点，之后才能采样它的大小。
     */
    fileStarted(item, file, dir) {
      if (!item || !file) return;
      const name = file.name || file.remoteName || 'unnamed';
      const target = path.join(dir, diskFileName(dir, name));
      active.set(String(item.modelId), {
        modelId: String(item.modelId),
        model: item.name || String(item.modelId),
        name,
        target,
        part: `${target}.part`,
        expected: Number(file.bytes) || 0,
      });
      attempt = null;
    },

    /**
     * The current file failed once and is being retried.
     * 当前文件失败了一次，正在重试。
     */
    attempt(info) {
      attempt = info || null;
    },

    /**
     * One plan item finished: count it and drop its in-flight file.
     * 某个计划项结束：计入统计并移除在途文件。
     */
    itemDone(item, ok, status) {
      if (item) active.delete(String(item.modelId));
      attempt = null;
      if (status === 'skipped') {
        skipped++;
        return;
      }
      if (ok) {
        done++;
        doneBytes += Number(item && item.totalBytes) || 0;
        return;
      }
      failed++;
    },

    /**
     * Current numbers for the UI (speed is an exponential moving average, like the TUI panel).
     * 供 UI 使用的当前数字（速度用指数滑动平均，与 TUI 面板一致）。
     */
    snapshot() {
      const at = now();
      const bytes = doneBytes + activeBytes();
      const dt = (at - lastSample.at) / 1000;
      if (dt >= 0.4) {
        const instant = Math.max(0, (bytes - lastSample.bytes) / dt);
        speed = speed > 0 ? speed * 0.6 + instant * 0.4 : instant;
        lastSample = { at, bytes };
      }
      const expected = expectedTotal;
      const percent = expected > 0 ? Math.min(100, (bytes / expected) * 100) : 0;
      const remaining = Math.max(0, expected - bytes);
      return {
        done,
        skipped,
        failed,
        total: plan.length,
        bytes,
        expected,
        percent,
        speed,
        etaMs: speed > 0 ? Math.round((remaining / speed) * 1000) : null,
        running: [...active.values()].map((entry) => ({
          modelId: entry.modelId,
          model: entry.model,
          name: entry.name,
          bytes: sizeOnDisk(entry, statFile),
          expected: entry.expected,
        })),
        attempt,
      };
    },
  };
}

module.exports = { createTracker, sizeOnDisk };
