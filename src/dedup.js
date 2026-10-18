'use strict';

/**
 * Cross-collection content deduplication.
 *
 * The same model often shows up in several collections (or even twice in the same one). This keeps
 * a "SHA256 → disk path" index:
 *  - hardlink: create a hard link on the same volume (no extra space, instant);
 *  - copy: fall back to copying across volumes or on filesystems without hard link support;
 *  - off: do not use it (the default).
 *
 * Because hard links share the same data, editing one in place would change the other as well; this
 * tool always downloads by "write .part → verify → rename" and never edits files in place, so it is safe.
 *
 *
 * 跨收藏集内容去重。
 *
 * 同一个模型常常同时出现在多个收藏集里（甚至同一收藏集里有两份副本）。
 * 这里维护一份「SHA256 → 磁盘路径」的索引：
 *  - hardlink：在同一卷上直接建硬链接（不占额外空间，秒完成）
 *  - copy：跨卷或文件系统不支持硬链接时退化为复制
 *  - off：不使用（默认）
 *
 * 因为硬链接共享同一份数据，任何一方被就地修改另一方也会变；本工具的下载
 * 始终是「写 .part → 校验 → rename」，不会就地改文件，所以是安全的。
 */

const fs = require('fs');
const path = require('path');
const { readJson, writeJsonAtomic, sha256File } = require('./util');

const INDEX_VERSION = 1;
const MAX_ENTRIES = 20000;
const MAX_SOURCES_PER_HASH = 5;

function indexPath(config) {
  return path.join(config.dataDir, 'content-index.json');
}

/**
 * Load the index (a corrupted index is treated as empty; downloads are unaffected).
 * 读取索引（损坏时按空索引处理，不影响下载）。
 */
function loadIndex(config) {
  const data = readJson(indexPath(config), null);
  if (!data || typeof data !== 'object' || !data.entries || typeof data.entries !== 'object') {
    return { version: INDEX_VERSION, entries: {} };
  }
  const entries = {};
  for (const [hash, value] of Object.entries(data.entries)) {
    if (typeof hash !== 'string' || !hash) continue;
    if (Array.isArray(value)) {
      // Backwards compatibility with the shorthand form.
      // 兼容简写形式。
      entries[hash] = { files: value.filter((p) => typeof p === 'string'), bytes: null, at: '' };
    } else if (value && Array.isArray(value.files)) {
      entries[hash] = {
        files: value.files.filter((p) => typeof p === 'string'),
        bytes: Number.isFinite(value.bytes) ? value.bytes : null,
        at: value.at || '',
      };
    }
  }
  return { version: INDEX_VERSION, entries };
}

function saveIndex(config, index) {
  const all = Object.entries(index.entries);
  let kept = all;
  if (all.length > MAX_ENTRIES) {
    kept = all.sort((a, b) => String(b[1].at || '').localeCompare(String(a[1].at || ''))).slice(0, MAX_ENTRIES);
  }
  writeJsonAtomic(indexPath(config), {
    version: INDEX_VERSION,
    savedAt: new Date().toISOString(),
    entries: Object.fromEntries(kept),
  });
}

/**
 * Create a dedup index handle for use within one run.
 * 创建一次运行内使用的去重索引句柄。
 * @param {object} config
 */
function createDedupIndex(config) {
  const index = loadIndex(config);
  let dirty = false;

  return {
    /**
     * Record a file that already passed verification.
     * 记录一个已校验通过的文件。
     */
    remember(file, sha256, bytes) {
      if (!sha256) return;
      const hash = String(sha256).toUpperCase();
      const entry = index.entries[hash] || { files: [], bytes: bytes || null, at: '' };
      if (!entry.files.includes(file)) entry.files.unshift(file);
      entry.files = entry.files.slice(0, MAX_SOURCES_PER_HASH);
      entry.bytes = bytes || entry.bytes || null;
      entry.at = new Date().toISOString();
      index.entries[hash] = entry;
      dirty = true;
    },

    /**
     * Find a source file with the same content that really exists and passes hash verification.
     * 找一个内容相同、确实存在且哈希校验通过的来源文件。
     * @param {string} sha256
     * @param {number|null} bytes
     * @param {string} excludePath 目标路径（自身要排除）
     * @returns {Promise<string|null>}
     */
    async findSource(sha256, bytes, excludePath) {
      if (!sha256) return null;
      const hash = String(sha256).toUpperCase();
      const entry = index.entries[hash];
      if (!entry || !entry.files.length) return null;

      for (const candidate of entry.files) {
        if (!candidate || candidate === excludePath) continue;
        let st;
        try {
          st = fs.statSync(candidate);
        } catch (e) {
          continue; // 已被删除/移动 / deleted or moved
        }
        if (!st.isFile() || st.size === 0) continue;
        if (bytes && Math.abs(st.size - bytes) > Math.max(1024, bytes * 0.001)) continue;
        // The index may be stale (the file was replaced), so the content really must be verified.
        // 索引可能过期（文件被替换过），所以真的要校验一次内容
        const actual = await sha256File(candidate).catch(() => null);
        if (actual === hash) return candidate;
      }
      return null;
    },

    /**
     * Link or copy the target file to the given path and return the mode actually used.
     * 把目标文件链接/复制到指定路径，返回实际使用的方式
     */
    materialize(source, target, mode) {
      if (mode === 'hardlink') {
        try {
          fs.linkSync(source, target);
          return 'hardlink';
        } catch (e) {
          // Across volumes or hard links unsupported → fall back to copying.
          // 跨卷或不支持硬链接 → 退化为复制
        }
      }
      fs.copyFileSync(source, target);
      return 'copy';
    },

    save() {
      if (!dirty) return false;
      saveIndex(config, index);
      return true;
    },

    /**
     * For tests and debugging.
     * 测试与调试用
     */
    raw() {
      return index;
    },
  };
}

module.exports = { indexPath, loadIndex, saveIndex, createDedupIndex, INDEX_VERSION };
