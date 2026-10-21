'use strict';

/**
 * Delete downloaded versions: remove their files first, then their library records.
 *
 * Shared by the download workspace and the model-management desired-state selector. Files still
 * referenced by a retained version are kept; pinned versions are never deleted.
 *
 *
 * 删除已下载版本：先删文件，再删模型库记录。
 *
 * 下载工作台与模型管理的期望状态选择器共用。仍被保留版本引用的文件不删除；
 * 固定版本永远不会被删除。
 */

const fs = require('fs');
const path = require('path');
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
    count++;
  }
  return count;
}

module.exports = {
  deleteVersions,
};
