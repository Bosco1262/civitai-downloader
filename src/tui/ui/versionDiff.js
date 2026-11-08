'use strict';

/**
 * Desired-state diff for one model's versions.
 *
 * The caller hands in installed versions and the versions the user kept selected. The result is what
 * has to happen on disk: keep/verify, download, delete or skip. It is shared by the download
 * workspace, the model detail page and collection member selection.
 *
 *
 * 单模型版本的期望状态差异。
 *
 * 调用方传入已安装版本与用户保留勾选的版本；结果描述磁盘上要发生的事：
 * 保留/校验、下载、删除或跳过。下载工作台、模型详情与收藏集成员选择共用它。
 */

/**
 * Normalize a version id into a string.
 * 把版本 ID 归一化成字符串。
 *
 * @param {any} versionId
 * @returns {string}
 */
function keyOf(versionId) {
  return String(versionId === undefined || versionId === null ? '' : versionId);
}

/**
 * Build the desired-state diff.
 * 构建期望状态差异。
 *
 * @param {Array<{versionId:string|number, versionName?:string, files?:Array<{name:string,bytes?:number}>, totalBytes?:number}>} installed
 * @param {Iterable<string|number>} selectedIds
 * @returns {{
 *   keep: object[], download: object[], delete: object[], skip: object[],
 *   deleteBytes: number, downloadBytes: number
 * }}
 */
function versionDiff(installed, selectedIds) {
  const installedList = Array.isArray(installed) ? installed.filter(Boolean) : [];
  const selected = new Set(Array.from(selectedIds || [], keyOf));
  const keep = [];
  const download = [];
  const remove = [];
  const skip = [];
  let deleteBytes = 0;
  let downloadBytes = 0;

  for (const version of installedList) {
    const id = keyOf(version.versionId);
    const bytes = Number(version.totalBytes) || 0;
    const files = Array.isArray(version.files) ? version.files : [];
    const record = { ...version, versionId: id, files, totalBytes: bytes };
    if (selected.has(id)) {
      if (files.length) {
        keep.push(record);
        continue;
      }
      download.push(record);
      downloadBytes += bytes;
      continue;
    }
    if (files.length) {
      remove.push(record);
      deleteBytes += files.reduce((sum, file) => sum + (Number(file.bytes) || 0), 0);
      continue;
    }
    skip.push(record);
  }

  return { keep, download, delete: remove, skip, deleteBytes, downloadBytes };
}

module.exports = {
  keyOf,
  versionDiff,
};
