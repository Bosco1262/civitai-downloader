'use strict';

/**
 * Delete downloaded versions: remove their files first, then their library records, and prune the
 * empty directories they leave behind up to the download root.
 *
 * Shared by the download workspace and the model-management desired-state selector. Files still
 * referenced by a retained version are kept; pinned versions are never deleted.
 *
 *
 * 删除已下载版本：先删文件，再删模型库记录，并清理留下的空目录（到下载根为止）。
 *
 * 下载工作台与模型管理的期望状态选择器共用。仍被保留版本引用的文件不删除；
 * 固定版本永远不会被删除。
 */

const fs = require('fs');
const path = require('path');
const { removeEmptyDirs } = require('../../util');
const { readLibrary, getVersion } = require('../../storage');
const { markForRedownload } = require('../../updater');

/**
 * Delete the given `{modelId, versionId}` versions.
 * 删除给定的 `{modelId, versionId}` 版本。
 *
 * @param {object} config
 * @param {Array<{modelId:string|number, versionId:string|number}>} rows
 * @returns {number} number of records removed
 */
function deleteVersions(config, rows) {
  const { entries } = readLibrary(config, { allowCorrupt: true });
  const targets = (Array.isArray(rows) ? rows : []).map((row) => ({
    modelId: String(row.modelId),
    versionId: String(row.versionId),
  }));
  const targetKeys = new Set(targets.map((row) => `${row.modelId}:${row.versionId}`));
  const retainedFiles = new Set();

  // A file still referenced by a retained version must survive: deleting it would break a version
  // the user explicitly kept.
  //
  // 仍被保留版本引用的文件不能删除，否则会破坏用户明确保留的版本。
  for (const [modelId, entry] of Object.entries(entries)) {
    if (!entry || !entry.versions) continue;
    for (const [versionId, version] of Object.entries(entry.versions)) {
      if (targetKeys.has(`${modelId}:${versionId}`)) continue;
      const dir = path.join(version.outDir || config.outDir, version.dirName || '');
      for (const file of version.files || []) retainedFiles.add(path.resolve(dir, file.name));
    }
  }

  let count = 0;
  for (const target of targets) {
    const entry = entries[target.modelId];
    const version = getVersion(entry, target.versionId);
    if (!version) continue;
    if (entry && entry.pinnedVersionId !== undefined && entry.pinnedVersionId !== null) {
      if (String(entry.pinnedVersionId) === target.versionId) continue;
    }
    const dir = path.join(version.outDir || config.outDir, version.dirName || '');
    for (const file of version.files || []) {
      const absolute = path.resolve(dir, file.name);
      if (retainedFiles.has(absolute)) continue;
      try {
        fs.rmSync(absolute, { force: true });
      } catch (e) {
        // A missing file must not block the record cleanup.
        // 缺失文件不阻塞记录清理。
      }
    }
    markForRedownload(config, [{ modelId: target.modelId, versionId: target.versionId }]);
    // The version's files are gone, so prune its directory (and empty layout parents) up to the
    // download root: deleting the last version must not leave an empty model folder behind.
    //
    // 该版本的文件已删除，清掉它的目录（以及空的布局父目录），到下载根为止：
    // 删掉最后一个版本不应该留下空的模型目录。
    removeEmptyDirs(dir, version.outDir || config.outDir);
    count++;
  }
  return count;
}

module.exports = {
  deleteVersions,
};
