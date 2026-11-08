'use strict';

/**
 * File manifest comparison.
 *
 * The old implementation only walked the local manifest, looked each entry up online by name and
 * skipped the ones it could not find: online renames and online additions were never noticed. This
 * now compares the name sets in both directions and treats a same-hash remove + add pair as a rename.
 *
 *
 * 文件清单比对。
 *
 * 旧实现只做「遍历本地清单 → 在线上按名字找 → 找不到就跳过」：
 * 线上改名、线上新增文件都不会被发现。这里改成按名字集合做双向比对，
 * 并把「同哈希的移除+新增」识别为改名。
 */

const { sanitizeName } = require('./util');

function keyOf(file) {
  const raw = file && (file.name || file.remoteName);
  return String(raw || '').toLowerCase();
}

function sizeTolerance(bytes) {
  return Math.max(1024, (Number(bytes) || 0) * 0.001);
}

function sizeDiffers(a, b) {
  return Math.abs(Number(a) - Number(b)) > sizeTolerance(b);
}

function sha256Of(file) {
  return file && file.sha256 ? String(file.sha256).toUpperCase() : null;
}

/**
 * Compare two file manifests in both directions.
 * 双向比对两份文件清单。
 * @param {Array<object>} prevFiles 本地记录的文件清单
 * @param {Array<object>} onlineFiles 线上文件清单
 * @returns {{changed:Array, added:Array, removed:Array, renamed:Array<{from:object,to:object}>, same:boolean}}
 */
function manifestDiff(prevFiles, onlineFiles) {
  const prev = new Map((prevFiles || []).filter(Boolean).map((f) => [keyOf(f), f]));
  const online = new Map((onlineFiles || []).filter(Boolean).map((f) => [keyOf(f), f]));

  const changed = [];
  const added = [];
  const removed = [];
  const renamed = [];

  for (const [key, onlineFile] of online) {
    const prevFile = prev.get(key);
    if (!prevFile) {
      added.push(onlineFile);
      continue;
    }
    const prevHash = sha256Of(prevFile);
    const onlineHash = sha256Of(onlineFile);
    if (prevHash && onlineHash) {
      if (prevHash !== onlineHash) changed.push({ prev: prevFile, online: onlineFile });
    } else if (prevFile.bytes && onlineFile.bytes && sizeDiffers(prevFile.bytes, onlineFile.bytes)) {
      changed.push({ prev: prevFile, online: onlineFile });
    }
  }
  for (const [key, prevFile] of prev) {
    if (!online.has(key)) removed.push(prevFile);
  }

  // A same-hash "add + remove" pair counts as a rename (the author renamed the file).
  // 同哈希的「新增 + 移除」视为改名（作者重命名文件）
  const renamedRemoved = new Set();
  const renamedAdded = new Set();
  for (const onlineFile of added) {
    const onlineHash = sha256Of(onlineFile);
    if (!onlineHash) continue;
    const match = removed.find((prevFile) => !renamedRemoved.has(prevFile) && sha256Of(prevFile) === onlineHash);
    if (match) {
      renamedRemoved.add(match);
      renamedAdded.add(onlineFile);
      renamed.push({ from: match, to: onlineFile });
    }
  }

  const addedOnly = added.filter((f) => !renamedAdded.has(f));
  const removedOnly = removed.filter((f) => !renamedRemoved.has(f));

  return {
    changed,
    added: addedOnly,
    removed: removedOnly,
    renamed,
    same: changed.length === 0 && addedOnly.length === 0 && removedOnly.length === 0 && renamed.length === 0,
  };
}

/**
 * Return the names of files whose content changed.
 * 返回发生内容变化的文件名数组。
 */
function changedFileNames(prevFiles, onlineFiles) {
  return manifestDiff(prevFiles, onlineFiles).changed.map((c) => sanitizeName(c.online.name || c.online.remoteName));
}

/**
 * Whether two manifests are equivalent (used after --refresh-meta to decide whether a real
 * re-download is needed).
 *
 * 两份清单是否等价（用于 --refresh-meta 后判断是否需要真的重新下载）
 */
function sameManifest(a, b) {
  return manifestDiff(a, b).same;
}

module.exports = { manifestDiff, changedFileNames, sameManifest, sizeTolerance, sizeDiffers, keyOf };
