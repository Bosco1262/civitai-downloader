'use strict';

/**
 * Single entry point for runtime data (.data): file paths, the model library, collection snapshots, the concurrency lock and logging.
 *
 * Why it lives in one place:
 *  - call sites used to build their own path.join(config.dataDir, `state-${id}.json`), so a path change had to be made in many places;
 *  - reads/writes were scattered and unprotected (corruption silently swallowed, non-atomic writes, no concurrency guard).
 *
 * Storage model (schema v1):
 *  - .data/library.json                     the single source of truth: one record per model;
 *  - .data/collections/<collectionId>.json  membership snapshot of a collection (plus the change report);
 *  - collections are never download records, so the same model downloaded from two collections keeps exactly one record.
 * Old state-*.json files are not migrated: they are moved to .data/legacy/ by cleanupLegacy().
 *
 *
 * 运行时数据（.data）统一入口：文件路径、模型库、收藏集快照、并发锁与日志。
 *
 * 集中在这里的原因：
 *  - 之前各处自行 path.join(config.dataDir, `state-${id}.json`)，改路径要改多处；
 *  - 读写分散且不设防（损坏被静默吞掉、写入非原子、无并发保护）。
 *
 * 存储模型（schema v1）：
 *  - .data/library.json                     唯一事实源：一个模型一条记录；
 *  - .data/collections/<收藏集ID>.json       收藏集的成员快照（含变化报告）；
 *  - 收藏集不再是下载记录，因此同一模型从两个收藏集下载也只保留一条记录。
 * 旧的 state-*.json 不做迁移：由 cleanupLegacy() 移到 .data/legacy/。
 */

const fs = require('fs');
const path = require('path');
const { readJson, readJsonResult, writeJsonAtomic, backupFile, ensureDir, ts } = require('./util');
const { AppError, StateCorruptError } = require('./errors');
const { t } = require('./i18n');

/**
 * Library file format version (v1: one model, several versions, one directory).
 * 模型库文件格式版本（v1：一个模型、多个版本、一个目录）。
 */
const LIBRARY_SCHEMA = 1;
/**
 * Snapshot file format version of a collection.
 * 收藏集快照的文件格式版本。
 */
const COLLECTION_SCHEMA = 1;
/**
 * Default log rotation threshold.
 * 默认日志轮转阈值。
 */
const DEFAULT_LOG_MAX_BYTES = 5 * 1024 * 1024;
/**
 * Old per-target files moved into .data/legacy once, on the first run of the new format.
 * 首次使用新格式时一次性移入 .data/legacy 的旧「按目标分文件」产物。
 */
const LEGACY_PATTERNS = [/^state-.*\.json$/i, /^items-.*\.json$/i, /^plan-.*\.json$/i, /^report-.*\.json$/i];
/**
 * Longest string kept when copying site metadata into the library (descriptions can be huge).
 * 站点元数据写入模型库时保留的最长字符串（描述可能非常长）。
 */
const SITE_TEXT_LIMIT = 8192;
/**
 * Longest list kept when copying site metadata into the library.
 * 站点元数据写入模型库时保留的最长列表。
 */
const SITE_LIST_LIMIT = 500;
/**
 * Deepest nesting copied from site metadata (defensive bound).
 * 站点元数据复制的最大嵌套层数（防御性上限）。
 */
const SITE_DEPTH_LIMIT = 8;

// ---------------------------------------------------------------------------
// Paths
// 路径
// ---------------------------------------------------------------------------

/**
 * Path of the model library (the single source of truth).
 * 模型库路径（唯一事实源）。
 */
function libraryPath(config) {
  return path.join(config.dataDir, 'library.json');
}

/**
 * Directory holding the collection snapshots.
 * 收藏集快照所在目录。
 */
function collectionsDir(config) {
  return path.join(config.dataDir, 'collections');
}

/**
 * Path of one collection snapshot.
 * 某个收藏集快照的路径。
 * @param {object} config
 * @param {string|number} collectionId
 */
function collectionPath(config, collectionId) {
  return path.join(collectionsDir(config), `${String(collectionId)}.json`);
}

/**
 * Directory that holds the ignored files of the old format.
 * 旧格式中被忽略文件的存放目录。
 */
function legacyDir(config) {
  return path.join(config.dataDir, 'legacy');
}

/**
 * Job-scoped files that stay keyed by a job label (collection ID, or model-<id> for a single model).
 * 仍按「任务标签」（收藏集 ID，单模型为 model-<id>）区分的任务级文件。
 */
function dataPaths(config, collectionId) {
  const id = String(collectionId);
  const base = config.dataDir;
  return {
    targetId: id,
    library: libraryPath(config),
    collection: collectionPath(config, id),
    log: path.join(base, `download-${id}.log`),
    items: path.join(base, `items-${id}.json`),
    plan: path.join(base, `plan-${id}.json`),
    queue: path.join(base, `queue-${id}.json`),
    report: path.join(base, `report-${id}.json`),
    lock: path.join(base, 'library.lock'),
  };
}

/**
 * Job label of a single model: model-<modelId> (keeps its log/queue apart from collections).
 * 单模型的任务标签：model-<模型ID>（让它的日志/断点清单与收藏集区分开）。
 */
function singleModelKey(modelId) {
  return `model-${String(modelId)}`;
}

function isSingleModelKey(id) {
  return /^model-\d+$/.test(String(id || ''));
}

function modelIdFromKey(id) {
  const m = /^model-(\d+)$/.exec(String(id || ''));
  return m ? m[1] : null;
}

/**
 * Collection IDs that have a snapshot under .data/collections.
 * .data/collections 下存在快照的收藏集 ID。
 */
function listCollectionIds(config) {
  try {
    return fs
      .readdirSync(collectionsDir(config))
      .map((f) => /^(.+)\.json$/.exec(f))
      .filter(Boolean)
      .map((m) => String(m[1]))
      .sort();
  } catch (e) {
    return [];
  }
}

// ---------------------------------------------------------------------------
// Model library
// 模型库
// ---------------------------------------------------------------------------

function normalizeFileEntry(f) {
  if (!f || typeof f !== 'object') return null;
  return {
    fileId: f.fileId === undefined ? null : f.fileId,
    name: f.name || null,
    remoteName: f.remoteName || f.name || null,
    sha256: f.sha256 ? String(f.sha256).toUpperCase() : null,
    bytes: Number.isFinite(f.bytes) ? f.bytes : null,
    downloadUrl: f.downloadUrl || null,
  };
}

/**
 * Truncate one string to the site-metadata limit.
 * 把单个字符串截断到站点元数据上限。
 */
function truncateText(value, limit = SITE_TEXT_LIMIT) {
  if (typeof value !== 'string') return null;
  return value.length <= limit ? value : `${value.slice(0, limit)}…`;
}

/**
 * Copy site metadata with bounded size: long strings are truncated, long lists are cut and deep
 * nesting stops at a fixed level, so library.json cannot grow without limit.
 *
 * 有界地复制站点元数据：过长字符串截断、过长列表截断、过深层级截断，
 * 避免 library.json 无限膨胀。
 */
function trimSiteValue(value, depth = 0) {
  if (typeof value === 'string') return truncateText(value);
  if (value === null || value === undefined) return null;
  if (typeof value !== 'object') return value;
  if (depth >= SITE_DEPTH_LIMIT) return null;
  if (Array.isArray(value)) {
    return value.slice(0, SITE_LIST_LIMIT).map((item) => trimSiteValue(item, depth + 1));
  }
  const out = {};
  for (const [key, item] of Object.entries(value)) {
    if (item === undefined) continue;
    out[key] = trimSiteValue(item, depth + 1);
  }
  return out;
}

/**
 * Version details: the raw site object plus the fields that are handy for display.
 * 版本详情：站点原始对象，以及便于展示的几个字段。
 */
function versionDetails(input) {
  const src = input && typeof input === 'object' ? input : {};
  const meta = src.site && typeof src.site === 'object' ? src.site : null;
  return {
    versionName: src.versionName || (meta && meta.name) || null,
    baseModel: src.baseModel || (meta && meta.baseModel) || null,
    publishedAt: (meta && meta.publishedAt) || null,
    createdAt: (meta && meta.createdAt) || null,
    trainedWords: Array.isArray(meta && meta.trainedWords)
      ? meta.trainedWords.slice(0, SITE_LIST_LIMIT)
      : null,
    description: meta ? truncateText(meta.description) : null,
    stats: meta && meta.stats && typeof meta.stats === 'object' ? trimSiteValue(meta.stats, 1) : null,
    availability: (meta && meta.availability) || null,
    earlyAccessEndsAt: (meta && meta.earlyAccessEndsAt) || null,
    site: meta ? trimSiteValue(meta) : null,
  };
}

/**
 * Model-level details taken from /api/v1/models/{id} (null when only collection data is known).
 * 来自 /api/v1/models/{id} 的模型级详情（只有收藏集信息时为 null）。
 */
function modelDetails(model) {
  const meta = model && typeof model === 'object' ? model : null;
  if (!meta) return { creator: null, stats: null, nsfw: null, mode: null };
  return {
    creator: meta.creator ? trimSiteValue(meta.creator, 1) : null,
    stats: meta.stats && typeof meta.stats === 'object' ? trimSiteValue(meta.stats, 1) : null,
    nsfw: typeof meta.nsfw === 'boolean' ? meta.nsfw : null,
    mode: meta.mode || null,
  };
}

/**
 * Keep the previously recorded value when the new input does not carry one.
 * 新输入没有携带某个字段时，保留上次记录的值。
 */
function keepPrev(next, prev, key) {
  if (next[key] !== null && next[key] !== undefined) return next[key];
  if (prev && prev[key] !== null && prev[key] !== undefined) return prev[key];
  return null;
}

/**
 * Download record of a single version (including the mirrored site metadata).
 * 单个版本的下载记录（含镜像的站点元数据）。
 */
function normalizeVersionRecord(rec) {
  const src = rec && typeof rec === 'object' ? rec : {};
  return {
    versionName: src.versionName || null,
    baseModel: src.baseModel || null,
    publishedAt: src.publishedAt || null,
    createdAt: src.createdAt || null,
    trainedWords: Array.isArray(src.trainedWords) ? src.trainedWords : null,
    description: src.description || null,
    stats: src.stats && typeof src.stats === 'object' ? src.stats : null,
    availability: src.availability || null,
    earlyAccessEndsAt: src.earlyAccessEndsAt || null,
    site: src.site && typeof src.site === 'object' ? src.site : null,
    dirName: src.dirName || null,
    outDir: src.outDir || null,
    files: Array.isArray(src.files) ? src.files.map(normalizeFileEntry).filter(Boolean) : [],
    verifiedAt: src.verifiedAt || null,
  };
}

/**
 * Normalize one library entry: { name, type, baseModel, creator, stats, nsfw, mode, pinnedVersionId, versions, updatedAt }
 * 归一化一条模型库记录：{ name, type, baseModel, creator, stats, nsfw, mode, pinnedVersionId, versions, updatedAt }
 */
function normalizeEntry(prev) {
  const src = prev && typeof prev === 'object' ? prev : {};
  const entry = {
    name: src.name || null,
    type: src.type || null,
    baseModel: src.baseModel || null,
    creator: src.creator === undefined ? null : src.creator,
    stats: src.stats && typeof src.stats === 'object' ? src.stats : null,
    nsfw: typeof src.nsfw === 'boolean' ? src.nsfw : null,
    mode: src.mode || null,
    pinnedVersionId:
      src.pinnedVersionId === undefined || src.pinnedVersionId === null ? null : String(src.pinnedVersionId),
    versions: {},
    updatedAt: src.updatedAt || null,
  };
  if (src.versions && typeof src.versions === 'object' && !Array.isArray(src.versions)) {
    for (const [versionId, rec] of Object.entries(src.versions)) {
      if (!rec || typeof rec !== 'object') continue;
      entry.versions[String(versionId)] = normalizeVersionRecord(rec);
    }
  }
  return entry;
}

/**
 * Whether the entry carries no version information at all.
 * The library never writes such entries (they can only come from a hand-edited file), so this is
 * effectively always false; it is kept as a defensive check for the callers that used to migrate v1 records.
 *
 * 条目是否完全没有版本信息。
 * 模型库不会写出这种条目（只可能来自手工改过的文件），实际上恒为 false；
 * 这里保留它，供原先做 v1 迁移的调用方做防御性判断。
 */
function isLegacyEntry(entry) {
  if (!entry) return true;
  return !entry.versions || Object.keys(entry.versions).length === 0;
}

/**
 * All version records of the entry (newest completion first).
 * 条目的全部版本记录（按完成时间倒序）。
 */
function entryVersions(entry) {
  if (!entry || !entry.versions) return [];
  return Object.entries(entry.versions)
    .map(([versionId, rec]) => ({ versionId, ...rec }))
    .sort((a, b) => String(b.verifiedAt || '').localeCompare(String(a.verifiedAt || '')));
}

/**
 * Get the record of one version.
 * 取某个版本的记录。
 */
function getVersion(entry, versionId) {
  if (!entry || !entry.versions || versionId === undefined || versionId === null) return null;
  const rec = entry.versions[String(versionId)];
  return rec ? { versionId: String(versionId), ...rec } : null;
}

/**
 * The most recently completed version record.
 * 最近一次完成的版本记录。
 */
function newestVersion(entry) {
  return entryVersions(entry)[0] || null;
}

/**
 * The version a model "is at" right now: the pinned one, else the most recently completed one.
 * 模型「当前所在」的版本：优先固定版本，否则最近完成的版本。
 */
function currentVersionId(entry) {
  if (!entry) return null;
  if (entry.pinnedVersionId) return String(entry.pinnedVersionId);
  const newest = newestVersion(entry);
  return newest ? String(newest.versionId) : null;
}

/**
 * List of version IDs already recorded on the entry.
 * 条目已记录的版本号列表。
 */
function versionIds(entry) {
  return entryVersions(entry).map((v) => String(v.versionId));
}

/**
 * Read the model library.
 * 读取模型库。
 * @param {object} config
 * @param {{allowCorrupt?: boolean}} [opts] allowCorrupt=true 时损坏返回空记录并带出错误对象
 * @returns {{entries: Record<string, any>, corrupt: StateCorruptError|null, backupFile: string|null, migrated: boolean, exists: boolean, file: string}}
 */
function readLibrary(config, opts = {}) {
  const file = libraryPath(config);
  const r = readJsonResult(file);

  if (r.missing) {
    return { entries: {}, corrupt: null, backupFile: null, migrated: false, exists: false, file };
  }

  const fail = (reason, cause) => {
    const backup = backupFile(file, 'corrupt');
    const err = new StateCorruptError(
      t('storage.stateCorrupt', {
        reason,
        file,
        backup: backup || t('storage.backupFailed'),
      }),
      { stateFile: file, backupFile: backup, cause }
    );
    if (opts.allowCorrupt) {
      return { entries: {}, corrupt: err, backupFile: backup, migrated: false, exists: true, file };
    }
    throw err;
  };

  if (!r.ok) {
    return fail(
      r.empty ? t('storage.reasonEmpty') : (r.error && r.error.message) || t('storage.reasonUnknown'),
      r.error
    );
  }
  if (!r.data || typeof r.data !== 'object' || Array.isArray(r.data)) {
    return fail(t('storage.reasonNotObject'), null);
  }
  if (!r.data.entries || typeof r.data.entries !== 'object' || Array.isArray(r.data.entries)) {
    return fail(t('storage.reasonNoEntries'), null);
  }

  const entries = {};
  for (const [key, value] of Object.entries(r.data.entries)) {
    if (value && typeof value === 'object') entries[key] = normalizeEntry(value);
  }
  return {
    entries,
    corrupt: null,
    backupFile: null,
    migrated: Number(r.data.schemaVersion) !== LIBRARY_SCHEMA,
    exists: true,
    file,
  };
}

/**
 * Write the model library (atomic write + keep a .bak).
 * 写入模型库（原子写 + 保留 .bak）。
 * @param {object} config
 * @param {Record<string, any>} entries
 */
function writeLibrary(config, entries) {
  const file = libraryPath(config);
  ensureDir(path.dirname(file));
  writeJsonAtomic(
    file,
    { schemaVersion: LIBRARY_SCHEMA, updatedAt: new Date().toISOString(), entries: entries || {} },
    { backup: true }
  );
  return file;
}

/**
 * Build the record of a single version (internal use).
 * Details that the input does not carry are kept from the previous record.
 *
 * 构造单个版本的记录（内部使用）。
 * 输入未携带的详情字段沿用上一次的记录。
 */
function makeVersionRecord(input, prev) {
  const details = versionDetails(input);
  const pick = (key) => keepPrev(details, prev, key);
  return {
    versionName: pick('versionName'),
    baseModel: pick('baseModel'),
    publishedAt: pick('publishedAt'),
    createdAt: pick('createdAt'),
    trainedWords: pick('trainedWords'),
    description: pick('description'),
    stats: pick('stats'),
    availability: pick('availability'),
    earlyAccessEndsAt: pick('earlyAccessEndsAt'),
    site: pick('site'),
    dirName: input.dirName || (prev && prev.dirName) || null,
    outDir: input.outDir || (prev && prev.outDir) || null,
    files: (input.files || []).map(normalizeFileEntry).filter(Boolean),
    verifiedAt: new Date().toISOString(),
  };
}

/**
 * Write/update one version of a model (the other versions of that model are preserved).
 * 写入/更新某个模型的一个版本（保留该模型的其它版本）。
 * @param {Record<string, any>} entries
 * @param {string|number} modelId
 * @param {{name?:string, type?:string, baseModel?:string, model?:object, site?:object, versionId:string|number, versionName?:string, dirName?:string, outDir:string, files:Array<object>, pinnedVersionId?:string|number|null}} input
 */
function upsertVersion(entries, modelId, input) {
  const key = String(modelId);
  const prev = entries[key] && typeof entries[key] === 'object' ? entries[key] : null;
  const model = modelDetails(input.model);
  const entry = {
    name: input.name || (prev && prev.name) || null,
    type: input.type || (prev && prev.type) || null,
    baseModel: input.baseModel || (prev && prev.baseModel) || null,
    creator: keepPrev(model, prev, 'creator'),
    stats: keepPrev(model, prev, 'stats'),
    nsfw: keepPrev(model, prev, 'nsfw'),
    mode: keepPrev(model, prev, 'mode'),
    pinnedVersionId:
      prev && prev.pinnedVersionId
        ? String(prev.pinnedVersionId)
        : input.pinnedVersionId === undefined || input.pinnedVersionId === null
          ? null
          : String(input.pinnedVersionId),
    versions: { ...((prev && prev.versions) || {}) },
    updatedAt: new Date().toISOString(),
  };
  const versionId = String(input.versionId);
  entry.versions[versionId] = makeVersionRecord(input, (prev && prev.versions && prev.versions[versionId]) || null);
  entries[key] = entry;
  return entry;
}

/**
 * Remove one version and return the removed record (null when it does not exist).
 * 删除某个版本，返回被删除的记录（不存在返回 null）。
 */
function removeVersion(entries, modelId, versionId) {
  const key = String(modelId);
  const entry = entries[key];
  if (!entry || !entry.versions) return null;
  const vid = String(versionId);
  const rec = entry.versions[vid];
  if (!rec) return null;
  delete entry.versions[vid];
  if (!Object.keys(entry.versions).length) delete entries[key];
  else entry.updatedAt = new Date().toISOString();
  return { versionId: vid, ...rec };
}

/**
 * Remove the whole model record and return the original entry.
 * 删除整个模型记录，返回原条目。
 */
function removeModel(entries, modelId) {
  const key = String(modelId);
  const entry = entries[key] || null;
  delete entries[key];
  return entry;
}

/**
 * Set/clear the pinned version (pass null as versionId to unpin).
 * 设置/清除版本固定（versionId 传 null 表示取消固定）。
 */
function setPinnedVersion(entries, modelId, versionId) {
  const key = String(modelId);
  const entry = entries[key];
  if (!entry) return false;
  entry.pinnedVersionId = versionId === undefined || versionId === null ? null : String(versionId);
  entry.updatedAt = new Date().toISOString();
  return true;
}

// ---------------------------------------------------------------------------
// Collection snapshots
// 收藏集快照
// ---------------------------------------------------------------------------

/**
 * Turn one enumerated item into the snapshot shape (membership only, never a download record).
 * 把枚举到的条目整理为快照结构（只记成员，不是下载记录）。
 */
function snapshotItem(item) {
  return {
    modelId: item.modelId === undefined ? null : item.modelId,
    name: item.name || null,
    type: item.type || null,
    baseModel: item.baseModel || null,
    versionId: item.versionId === undefined ? null : item.versionId,
    versionName: item.versionName || null,
  };
}

/**
 * Compare two membership lists and build the change report of a snapshot write.
 * 对比两份成员清单，生成本次快照写入的变化报告。
 * @param {Array<object>} prevItems
 * @param {Array<object>} items
 * @param {string|null} previousFetchedAt
 */
function computeChanges(prevItems, items, previousFetchedAt) {
  const changes = {
    checkedAt: new Date().toISOString(),
    previousFetchedAt: previousFetchedAt || null,
    added: [],
    removed: [],
    versionChanged: [],
  };
  // The very first snapshot has nothing to compare with
  // 首次写入快照时没有可比对的上一份
  if (!Array.isArray(prevItems)) return changes;

  const prevById = new Map(prevItems.map((it) => [String(it.modelId), it]));
  const nextById = new Map(items.map((it) => [String(it.modelId), it]));

  for (const [modelId, item] of nextById) {
    if (!prevById.has(modelId)) changes.added.push({ modelId: item.modelId, name: item.name || null });
  }
  for (const [modelId, item] of prevById) {
    if (!nextById.has(modelId)) changes.removed.push({ modelId: item.modelId, name: item.name || null });
  }
  for (const [modelId, item] of nextById) {
    const prev = prevById.get(modelId);
    if (!prev) continue;
    const from = prev.versionId === undefined || prev.versionId === null ? null : String(prev.versionId);
    const to = item.versionId === undefined || item.versionId === null ? null : String(item.versionId);
    if (from === to) continue;
    changes.versionChanged.push({
      modelId: item.modelId,
      name: item.name || null,
      fromVersionId: prev.versionId === undefined ? null : prev.versionId,
      toVersionId: item.versionId === undefined ? null : item.versionId,
    });
  }
  return changes;
}

/**
 * Read one collection snapshot.
 * 读取某个收藏集的快照。
 * @returns {{snapshot: object|null, corrupt: StateCorruptError|null, file: string}}
 */
function readCollection(config, collectionId, opts = {}) {
  const file = collectionPath(config, collectionId);
  const r = readJsonResult(file);
  if (r.missing) return { snapshot: null, corrupt: null, file };

  const fail = (reason, cause) => {
    const backup = backupFile(file, 'corrupt');
    const err = new StateCorruptError(
      t('storage.stateCorrupt', { reason, file, backup: backup || t('storage.backupFailed') }),
      { stateFile: file, backupFile: backup, cause }
    );
    if (opts.allowCorrupt) return { snapshot: null, corrupt: err, file };
    throw err;
  };

  if (!r.ok) {
    return fail(
      r.empty ? t('storage.reasonEmpty') : (r.error && r.error.message) || t('storage.reasonUnknown'),
      r.error
    );
  }
  if (!r.data || typeof r.data !== 'object' || Array.isArray(r.data)) {
    return fail(t('storage.reasonNotObject'), null);
  }

  const items = Array.isArray(r.data.items) ? r.data.items.map(snapshotItem) : [];
  const changes =
    r.data.changes && typeof r.data.changes === 'object' ? r.data.changes : computeChanges(null, items, null);
  return {
    snapshot: {
      collectionId: String(r.data.collectionId === undefined ? collectionId : r.data.collectionId),
      fetchedAt: r.data.fetchedAt || null,
      items,
      changes,
    },
    corrupt: null,
    file,
  };
}

/**
 * Write one collection snapshot, computing the change report against the previous items.
 * 写入某个收藏集的快照，并与上一份成员清单对比算出变化报告。
 * @param {object} config
 * @param {string|number} collectionId
 * @param {{items:Array<object>, fetchedAt?:string}} input
 */
function writeCollection(config, collectionId, input) {
  const id = String(collectionId);
  const items = (Array.isArray(input && input.items) ? input.items : []).map(snapshotItem);
  let previous = null;
  try {
    previous = readCollection(config, id, { allowCorrupt: true }).snapshot;
  } catch (e) {
    previous = null;
  }
  const fetchedAt = (input && input.fetchedAt) || new Date().toISOString();
  const snapshot = {
    schemaVersion: COLLECTION_SCHEMA,
    collectionId: id,
    fetchedAt,
    items,
    changes: computeChanges(previous ? previous.items : null, items, previous ? previous.fetchedAt : null),
  };
  const file = collectionPath(config, id);
  ensureDir(path.dirname(file));
  writeJsonAtomic(file, snapshot, { backup: true });
  return snapshot;
}

// ---------------------------------------------------------------------------
// Legacy cleanup
// 旧格式清理
// ---------------------------------------------------------------------------

/**
 * Move the files of the old per-target format into .data/legacy (rename only; failures are skipped).
 * Called once, when the library does not exist yet.
 *
 * 把旧的「按目标分文件」产物移入 .data/legacy（只做 rename，失败则跳过）。
 * 只在模型库尚不存在时调用一次。
 * @param {object} config
 * @param {(message:string)=>void} [logFn]
 * @returns {number} moved file count
 */
function cleanupLegacy(config, logFn) {
  let names = [];
  try {
    names = fs.readdirSync(config.dataDir);
  } catch (e) {
    return 0;
  }
  const target = legacyDir(config);
  let moved = 0;
  for (const name of names) {
    if (!LEGACY_PATTERNS.some((re) => re.test(name))) continue;
    try {
      ensureDir(target);
      fs.renameSync(path.join(config.dataDir, name), path.join(target, name));
      moved++;
    } catch (e) {
      // A file in use (or on another device) is simply left where it is
      // 文件被占用（或跨设备）时直接留在原处
    }
  }
  if (moved && logFn) logFn(t('storage.legacyMoved', { count: moved, dir: target }));
  return moved;
}

// ---------------------------------------------------------------------------
// Concurrency lock
// 并发锁
// ---------------------------------------------------------------------------

function isProcessAlive(pid) {
  if (!pid) return false;
  try {
    process.kill(Number(pid), 0);
    return true;
  } catch (e) {
    // EPERM means the process exists but we are not allowed to signal it
    // EPERM 说明进程存在但无权限发信号
    return e && e.code === 'EPERM';
  }
}

/**
 * Take the global library lock: every model shares one file, so one lock guards them all.
 * 抢占全局模型库锁：所有模型共用一个文件，因此一把锁守护全部写入。
 * @param {object} config
 * @param {{staleMs?:number, force?:boolean}} [opts]
 * @returns {{file:string, release:()=>void}}
 */
function acquireLock(config, opts = {}) {
  const file = dataPaths(config, '').lock;
  const staleMs = opts.staleMs || 12 * 60 * 60 * 1000;
  ensureDir(path.dirname(file));

  for (let attempt = 0; attempt < 3; attempt++) {
    try {
      const fd = fs.openSync(file, 'wx');
      try {
        fs.writeFileSync(
          fd,
          JSON.stringify({ pid: process.pid, host: process.env.COMPUTERNAME || '', startedAt: new Date().toISOString() }),
          'utf8'
        );
      } finally {
        fs.closeSync(fd);
      }
      return {
        file,
        release: () => {
          try {
            fs.rmSync(file, { force: true });
          } catch (e) {
            // Ignore any failure while removing the lock file
            // 删除锁文件失败时忽略
          }
        },
      };
    } catch (e) {
      if (e.code !== 'EEXIST') throw e;
      const info = readJson(file, null);
      const age = (() => {
        try {
          return Date.now() - fs.statSync(file).mtimeMs;
        } catch (err) {
          return 0;
        }
      })();
      const owner = info && info.pid ? Number(info.pid) : null;
      const alive = owner ? isProcessAlive(owner) : false;
      const stale = age > staleMs || !alive;
      if (stale || opts.force) {
        fs.rmSync(file, { force: true });
        continue;
      }
      throw new AppError(
        t('storage.lockConflict', {
          pid: owner,
          startedAt: (info && info.startedAt) || t('storage.unknownStart'),
          file,
        })
      );
    }
  }
  throw new AppError(t('storage.lockFailed', { file }));
}

// ---------------------------------------------------------------------------
// Logging
// 日志
// ---------------------------------------------------------------------------

/**
 * Rotate the log to .1 once it passes the threshold (the old .1 is overwritten).
 * 超过阈值时把日志轮转为 .1（覆盖旧的 .1）。
 */
function rotateLog(file, maxBytes = DEFAULT_LOG_MAX_BYTES) {
  try {
    const st = fs.statSync(file);
    if (st.size < maxBytes) return false;
    const old = `${file}.1`;
    fs.rmSync(old, { force: true });
    fs.renameSync(file, old);
    return true;
  } catch (e) {
    return false;
  }
}

/**
 * Create the logger for this run: terminal output (sink) + file output (with rotation and timing stats).
 * 创建本次运行的日志器：终端输出（sink）+ 落盘（带轮转与耗时统计）。
 * @param {object} config
 * @param {string|number} collectionId job label (collection ID, or model-<id>)
 * @param {{sink?:(msg:string)=>void, maxBytes?:number, header?:string}} [opts]
 */
function createRunLogger(config, collectionId, opts = {}) {
  const file = dataPaths(config, collectionId).log;
  ensureDir(path.dirname(file));
  const rotated = rotateLog(file, opts.maxBytes || DEFAULT_LOG_MAX_BYTES);

  const startedAt = Date.now();
  let lastMark = startedAt;
  const timings = [];

  const write = (text) => {
    try {
      fs.appendFileSync(file, text, 'utf8');
    } catch (e) {
      // A failed log write must not affect the download
      // 日志写失败不应影响下载
    }
  };

  return {
    logFile: file,
    rotated,
    startedAt,
    /**
     * Log one line (also written to the terminal).
     * 记录一行日志（同时输出到终端）。
     */
    log(msg) {
      const line = `[${ts()}] ${msg}`;
      if (opts.sink) opts.sink(msg);
      else console.log(line);
      write(`${line}\n`);
    },
    /**
     * Write to the file only, without terminal output (debug details).
     * 只写文件不输出终端（调试细节）。
     */
    trace(msg) {
      write(`[${ts()}] ${msg}\n`);
    },
    mark() {
      lastMark = Date.now();
    },
    /**
     * Record one elapsed span (since the last mark).
     * 记录一段耗时（自上次 mark 起）。
     */
    phase(label) {
      const now = Date.now();
      timings.push({ label, ms: now - lastMark });
      lastMark = now;
      return now;
    },
    timings,
    elapsedMs() {
      return Date.now() - startedAt;
    },
  };
}

module.exports = {
  LIBRARY_SCHEMA,
  COLLECTION_SCHEMA,
  DEFAULT_LOG_MAX_BYTES,
  LEGACY_PATTERNS,
  SITE_TEXT_LIMIT,
  SITE_LIST_LIMIT,
  // Paths
  // 路径
  libraryPath,
  collectionPath,
  collectionsDir,
  legacyDir,
  dataPaths,
  // Job labels for single models
  // 单模型的任务标签
  singleModelKey,
  isSingleModelKey,
  modelIdFromKey,
  listCollectionIds,
  // Library
  // 模型库
  readLibrary,
  writeLibrary,
  normalizeEntry,
  normalizeFileEntry,
  normalizeVersionRecord,
  truncateText,
  trimSiteValue,
  versionDetails,
  modelDetails,
  isLegacyEntry,
  // Entry/version operations
  // 条目/版本操作
  upsertVersion,
  removeVersion,
  removeModel,
  setPinnedVersion,
  entryVersions,
  getVersion,
  newestVersion,
  currentVersionId,
  versionIds,
  // Collection snapshots
  // 收藏集快照
  snapshotItem,
  computeChanges,
  readCollection,
  writeCollection,
  // Legacy
  // 旧格式
  cleanupLegacy,
  // Lock / logging
  // 锁 / 日志
  acquireLock,
  rotateLog,
  createRunLogger,
};
