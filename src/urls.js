'use strict';

/**
 * User input parsing: accepts a bare ID as well as a pasted site URL.
 *
 * Supported forms:
 *  161131
 *  https://civitai.red/collections/161131?sort=Newest
 *  https://civitai.red/models/1191424?modelVersionId=1990837
 *  model:1191424
 *  version:1990837
 *
 *
 * 用户输入解析：既接受纯 ID，也接受粘贴的站点 URL。
 */

/** @returns {string|null} */
function parseCollectionId(input) {
  const raw = String(input || '').trim();
  if (!raw) return null;
  if (/^\d+$/.test(raw)) return raw;
  const fromUrl = /\/collections\/(\d+)/i.exec(raw);
  if (fromUrl) return fromUrl[1];
  if (/^collection:\d+$/i.test(raw)) return raw.split(':')[1];
  return null;
}

/**
 * Parse a model reference.
 * 解析模型引用。
 * @returns {{modelId:string, versionId:string|null}|null}
 */
function parseModelRef(input) {
  const raw = String(input || '').trim();
  if (!raw) return null;

  if (/^model:\d+/i.test(raw)) return { modelId: raw.split(':')[1], versionId: null };
  if (/^version:\d+/i.test(raw)) return { modelId: null, versionId: raw.split(':')[1] };

  const versionFromQuery = /[?&]modelVersionId=(\d+)/i.exec(raw);
  const modelFromPath = /\/models\/(\d+)/i.exec(raw);
  if (modelFromPath) {
    return { modelId: modelFromPath[1], versionId: versionFromQuery ? versionFromQuery[1] : null };
  }
  if (versionFromQuery) return { modelId: null, versionId: versionFromQuery[1] };
  if (/^\d+$/.test(raw)) return { modelId: raw, versionId: null };
  return null;
}

/**
 * Comma-separated ID list → string array.
 * 逗号分隔的 ID 列表 → 字符串数组。
 */
function parseIdList(raw) {
  if (!raw || raw === true) return null;
  return String(raw)
    .split(',')
    .map((s) => s.trim())
    .filter(Boolean);
}

module.exports = { parseCollectionId, parseModelRef, parseIdList };
