'use strict';

/**
 * Check for updates and verify local files against the model library.
 *
 * Two targets:
 *  - collection (`checkUpdates`): read the membership snapshot written by list/download, compare it with
 *    the library, and report membership changes plus the local file status;
 *  - single model (`checkModelUpdates`): fetch `/api/v1/models/{id}` and compare with the library entry.
 *
 * Two modes:
 *  - quick (default): version id + local file size;
 *  - deep (--verify-files): also compare online file hashes with the local SHA256 (catches re-uploads of the same version).
 *
 *
 * 对照模型库检查更新与本地校验。
 *
 * 两种对象：
 *  - 收藏集（`checkUpdates`）：读取 list/download 写下的成员快照，与模型库比对，
 *    报告成员变化与本地文件状态；
 *  - 单模型（`checkModelUpdates`）：拉 `/api/v1/models/{id}`，与模型库记录比对。
 *
 * 两种模式：
 *  - 快速（默认）：版本号 + 本地文件大小；
 *  - 深度（--verify-files）：额外比对线上文件哈希与本地 SHA256（可发现同版本重传）。
 */

const fs = require('fs');
const path = require('path');
const { log, sanitizeName, sha256File } = require('./util');
const { buildPlan, fetchModelDetail, extractFiles } = require('./api');
const {
  readLibrary,
  writeLibrary,
  libraryPath,
  readCollection,
  entryVersions,
  getVersion,
  versionIds,
  isLegacyEntry,
  setPinnedVersion,
} = require('./storage');
const { manifestDiff, sizeTolerance } = require('./manifest');
const { t } = require('./i18n');

/**
 * Directory that holds the files of one version (prefers dirName/outDir from the record).
 * 某个版本的文件所在目录（优先使用记录里的 dirName/outDir）
 */
function localDirForVersion(config, entry, versionRec) {
  const base = (versionRec && versionRec.outDir) || config.outDir;
  const dirName =
    (versionRec && versionRec.dirName) || sanitizeName((entry && entry.name) || 'unnamed');
  return path.join(base, dirName);
}

/**
 * Legacy call adapter: the directory of the model's most recently completed version.
 * 兼容旧调用：取该模型最近一次完成的版本目录
 */
function localDirFor(config, entry) {
  const newest = entryVersions(entry)[0] || null;
  return localDirForVersion(config, entry, newest);
}

/**
 * Verify the local files of one version (stat, plus SHA256 when needed).
 * 校验某个版本的本地文件（stat，必要时 SHA256）。
 * @returns {Promise<{reasons:string[], missingFiles:string[]}>}
 */
async function checkVersionFiles(config, entry, versionRec, opts = {}) {
  const dir = localDirForVersion(config, entry, versionRec);
  const reasons = [];
  const missingFiles = [];
  const files = Array.isArray(versionRec && versionRec.files) ? versionRec.files : [];

  for (const f of files) {
    const file = path.join(dir, f.name);
    let st = null;
    try {
      st = fs.statSync(file);
    } catch (e) {
      // Treat it as missing.
      // 视为缺失。
    }
    if (!st || st.size === 0) {
      reasons.push(t('updater.missingFile', { file: f.name }));
      missingFiles.push(f.name);
      continue;
    }
    if (f.bytes && Math.abs(st.size - f.bytes) > sizeTolerance(f.bytes)) {
      reasons.push(t('updater.sizeMismatch', { file: f.name }));
      missingFiles.push(f.name);
      continue;
    }
    if (opts.verifyFiles && f.sha256) {
      const h = await sha256File(file, { shouldAbort: opts.shouldAbort }).catch(() => null);
      if (h !== f.sha256) {
        reasons.push(t('updater.shaMismatch', { file: f.name }));
        missingFiles.push(f.name);
      }
    }
  }
  return { reasons, missingFiles };
}

/**
 * Verify the local files of **every** version under one model.
 * 校验一个模型下**全部**版本的本地文件。
 * @returns {Promise<{perVersion:Array, reasons:string[], missingFiles:string[]}>}
 */
async function checkModelFiles(config, entry, opts = {}) {
  const perVersion = [];
  for (const rec of entryVersions(entry)) {
    const local = await checkVersionFiles(config, entry, rec, opts);
    perVersion.push({
      versionId: String(rec.versionId),
      versionName: rec.versionName,
      dir: localDirForVersion(config, entry, rec),
      reasons: local.reasons,
      missingFiles: local.missingFiles,
      files: rec.files,
      versionRec: rec,
    });
  }
  return {
    perVersion,
    reasons: perVersion.flatMap((v) => v.reasons),
    missingFiles: perVersion.flatMap((v) => v.missingFiles),
  };
}

/**
 * Build a downloadable plan item from an online version object.
 * 由线上版本对象构造一个可下载的计划项
 */
function itemFromVersion(site, modelId, name, type, version, opts = {}) {
  const files = extractFiles(version, site, opts);
  return {
    modelId,
    name,
    type: type || null,
    versionId: version.id,
    versionName: version.name,
    baseModel: version.baseModel,
    files,
    totalBytes: files.reduce((sum, f) => sum + f.bytes, 0),
  };
}

function emptyReport(extra = {}) {
  return {
    checkedAt: new Date().toISOString(),
    deepChecked: false,
    verifyFiles: false,
    hasState: false,
    upToDate: [],
    upgraded: [],
    updated: [],
    pinned: [],
    fileChanged: [],
    missing: [],
    history: [],
    legacy: [],
    failed: [],
    removed: [],
    notDownloaded: [],
    ...extra,
  };
}

/**
 * Version id a snapshot item / library entry stands for (null when unknown).
 * 快照条目 / 库记录所代表的版本号（未知时 null）
 */
function idOf(value) {
  return value === undefined || value === null ? null : String(value);
}

// ---------------------------------------------------------------------------
// Collections
// 收藏集
// ---------------------------------------------------------------------------

/**
 * Check a collection against the model library.
 * The membership comes from .data/collections/<id>.json (written by list/download), so no browser is needed.
 *
 * 对照模型库检查一个收藏集。
 * 成员来自 .data/collections/<ID>.json（由 list/download 写入），因此不需要浏览器。
 * @param {object} config
 * @param {string|number} collectionId
 * @param {{verifyFiles?:boolean, withPlan?:boolean, concurrency?:number, shouldAbort?:Function, deps?:object}} [opts]
 * @param {{log?:Function}} [hooks]
 */
async function checkUpdates(config, collectionId, opts = {}, hooks = {}) {
  const deps = { buildPlan, ...(opts.deps || {}) };
  const logFn = hooks.log || log;
  const id = String(collectionId);
  const deep = !!opts.verifyFiles;

  const { entries } = readLibrary(config);
  const { snapshot, corrupt } = readCollection(config, id, { allowCorrupt: true });

  const report = emptyReport({
    collectionId: id,
    kind: 'collection',
    deepChecked: deep,
    verifyFiles: deep,
    hasState: Object.keys(entries).length > 0,
    hasSnapshot: !!snapshot,
    snapshotFetchedAt: snapshot ? snapshot.fetchedAt : null,
    snapshotCount: snapshot ? snapshot.items.length : 0,
    changes: snapshot ? snapshot.changes : null,
    corrupt: corrupt ? corrupt.message : null,
  });
  report.uncheckedChanges = !deep;

  if (!snapshot) {
    logFn(t('updater.snapshotMissing', { collectionId: id }));
    return { report, plan: [], libraryFile: libraryPath(config), entries };
  }

  const itemByModelId = new Map(snapshot.items.map((it) => [String(it.modelId), it]));

  // ---- Pass 1: classify without online metadata ---------------------------
  // ---- 第一轮：不依赖线上元数据的分类 ------------------------------------
  for (const [modelId, entry] of Object.entries(entries)) {
    const item = itemByModelId.get(String(modelId));
    if (!item) {
      report.removed.push({ modelId, prev: entry });
      continue;
    }
    if (isLegacyEntry(entry)) {
      report.legacy.push({ item, prev: entry });
      continue;
    }
    const pinned = entry.pinnedVersionId ? String(entry.pinnedVersionId) : null;
    const online = idOf(item.versionId);

    if (pinned && online && pinned !== online) {
      report.pinned.push({ item, prev: entry, pinnedVersionId: pinned, onlineVersionId: online });
      continue;
    }
    const recorded = getVersion(entry, online);
    if (!recorded) {
      report.updated.push({ item, prev: entry });
      continue;
    }
    const local = await checkVersionFiles(config, entry, recorded, {
      verifyFiles: deep,
      shouldAbort: opts.shouldAbort,
    });
    if (local.reasons.length) report.missing.push({ item, prev: entry, reasons: local.reasons, versionId: online });
    else report.upToDate.push({ item, prev: entry });

    const others = versionIds(entry).filter((v) => v !== online);
    if (others.length) report.history.push({ item, prev: entry, versionIds: others });
  }
  for (const item of snapshot.items) {
    if (!entries[item.modelId]) report.notDownloaded.push(item);
  }

  // ---- Pass 2: fetch online metadata on demand ----------------------------
  // ---- 第二轮：按需拉取线上元数据 ----------------------------------------
  let plan = [];
  if (deep) {
    const needMeta = [];
    for (const [modelId, entry] of Object.entries(entries)) {
      const item = itemByModelId.get(String(modelId));
      if (!item) continue;
      const pinned = entry.pinnedVersionId ? String(entry.pinnedVersionId) : null;
      const online = idOf(item.versionId);
      if (pinned && online && pinned !== online) continue;
      needMeta.push(item);
    }
    if (needMeta.length) {
      logFn(t('updater.fetchingMeta', { count: needMeta.length, concurrency: config.metaConcurrency || 4 }));
      const built = await deps.buildPlan(config.site, needMeta, config.userAgent, {
        concurrency: opts.concurrency || config.metaConcurrency,
        fileTypes: config.fileTypes,
        primaryOnly: config.primaryOnly,
        onLog: logFn,
      });
      plan = built.plan;
    }
    const planByModelId = new Map(plan.map((p) => [String(p.modelId), p]));

    // Deep mode: re-classify by file manifest (catches re-uploads of the same version).
    // 深度模式：重新按文件清单分类（可发现同版本重传）
    report.updated.length = 0;
    report.fileChanged.length = 0;
    report.upToDate.length = 0;
    report.missing.length = 0;
    report.legacy.length = 0;
    report.history.length = 0;
    report.failed.length = 0;

    for (const [modelId, entry] of Object.entries(entries)) {
      const item = itemByModelId.get(String(modelId));
      if (!item) continue;
      const pinned = entry.pinnedVersionId ? String(entry.pinnedVersionId) : null;
      const online = idOf(item.versionId);
      if (pinned && online && pinned !== online) continue;

      const planned = planByModelId.get(String(modelId));
      if (!planned || planned.error) {
        report.failed.push({ item, prev: entry, error: (planned && planned.error) || t('updater.noMetadata') });
        continue;
      }
      if (isLegacyEntry(entry)) {
        report.legacy.push({ item: planned, prev: entry });
        continue;
      }
      const recorded = getVersion(entry, online);
      if (!recorded) {
        report.updated.push({ item: planned, prev: entry });
        continue;
      }
      const local = await checkVersionFiles(config, entry, recorded, {
        verifyFiles: true,
        shouldAbort: opts.shouldAbort,
      });
      const diff = manifestDiff(recorded.files, planned.files);
      if (local.reasons.length) {
        report.missing.push({ item: planned, prev: entry, reasons: local.reasons, versionId: online });
      }
      if (!diff.same) report.fileChanged.push({ item: planned, prev: entry, diff, versionId: online });
      else if (!local.reasons.length) report.upToDate.push({ item: planned, prev: entry });

      const others = versionIds(entry).filter((v) => v !== online);
      if (others.length) report.history.push({ item: planned, prev: entry, versionIds: others });
    }
  }

  // ---- Attach file info to the items that need downloading (used by --download) ----
  // ---- 为需要下载的项补上文件信息（--download 使用） ----------------------
  if (opts.withPlan && !deep) {
    const wanted = [];
    for (const bucket of [report.updated, report.missing, report.legacy]) {
      for (const entry of bucket) wanted.push(entry.item);
    }
    const unique = new Map(wanted.map((it) => [String(it.modelId), it]));
    if (unique.size) {
      logFn(t('updater.fetchingMeta', { count: unique.size, concurrency: config.metaConcurrency || 4 }));
      const built = await deps.buildPlan(config.site, [...unique.values()], config.userAgent, {
        concurrency: opts.concurrency || config.metaConcurrency,
        fileTypes: config.fileTypes,
        primaryOnly: config.primaryOnly,
        onLog: logFn,
      });
      plan = built.plan;
      const planByModelId = new Map(plan.map((p) => [String(p.modelId), p]));
      const attach = (bucket) => {
        for (const entry of bucket) {
          const planned = planByModelId.get(String(entry.item.modelId));
          if (planned && !planned.error) entry.item = planned;
        }
      };
      attach(report.updated);
      attach(report.missing);
      attach(report.legacy);
    }
  }

  return { report, plan, libraryFile: libraryPath(config), entries, snapshot };
}

// ---------------------------------------------------------------------------
// Single model
// 单模型
// ---------------------------------------------------------------------------

/**
 * Check updates for a single model (library only; no collection involved).
 * 检查单个模型的更新（只读模型库，与收藏集无关）。
 * @param {object} config
 * @param {string|number} modelId
 * @param {{verifyFiles?:boolean, withPlan?:boolean, deps?:object}} [opts]
 * @param {{log?:Function}} [hooks]
 */
async function checkModelUpdates(config, modelId, opts = {}, hooks = {}) {
  const deps = { fetchModelDetail, ...(opts.deps || {}) };
  const logFn = hooks.log || log;
  const id = String(modelId);
  const { entries } = readLibrary(config);
  const entry = entries[id] || null;
  const deep = !!opts.verifyFiles;

  const report = emptyReport({
    kind: 'model',
    modelId: id,
    modelName: entry ? entry.name : null,
    deepChecked: deep,
    verifyFiles: deep,
    hasState: !!entry,
  });
  report.uncheckedChanges = !deep;

  logFn(t('updater.fetchingModel', { modelId: id }));
  const detail = await deps.fetchModelDetail(config.site, id, config.userAgent);
  const versions = Array.isArray(detail.modelVersions) ? detail.modelVersions : [];
  const name = detail.name || (entry && entry.name) || `modelId=${id}`;
  const type = detail.type || (entry && entry.type) || null;
  const latest = versions[0] || null;
  const latestId = latest ? String(latest.id) : null;
  report.modelName = name;
  report.latestVersionId = latestId;
  report.latestVersionName = latest ? latest.name : null;
  report.localVersionIds = entry ? versionIds(entry) : [];

  const itemOpts = { fileTypes: config.fileTypes, primaryOnly: config.primaryOnly };

  if (!latest) {
    report.failed.push({ item: { modelId: id, name, type }, prev: entry, error: t('updater.noOnlineVersions') });
    return { report, plan: [], libraryFile: libraryPath(config), entries };
  }

  if (!entry) {
    report.notDownloaded.push(itemFromVersion(config.site, id, name, type, latest, itemOpts));
    return { report, plan: [], libraryFile: libraryPath(config), entries };
  }

  const pinned = entry.pinnedVersionId ? String(entry.pinnedVersionId) : null;
  const onlineById = new Map(versions.map((v) => [String(v.id), v]));

  // Check every local version one by one.
  // 逐个本地版本核对
  for (const rec of entryVersions(entry)) {
    const versionId = String(rec.versionId);
    const online = onlineById.get(versionId);
    const item = online
      ? itemFromVersion(config.site, id, name, type, online, itemOpts)
      : { modelId: id, name, type, versionId, versionName: rec.versionName, files: rec.files, totalBytes: 0 };

    const local = await checkVersionFiles(config, entry, rec, {
      verifyFiles: deep,
      shouldAbort: opts.shouldAbort,
    });
    if (!online) {
      report.removed.push({ item, versionId, prev: entry, reasons: [t('updater.versionGoneOnline')] });
      continue;
    }
    if (local.reasons.length) {
      report.missing.push({ item, prev: entry, reasons: local.reasons, versionId });
      continue;
    }
    if (deep) {
      const diff = manifestDiff(rec.files, extractFiles(online, config.site, itemOpts));
      if (!diff.same) {
        report.fileChanged.push({ item, prev: entry, diff, versionId });
        continue;
      }
    }
    report.upToDate.push({ item, prev: entry, versionId });
  }

  // Online latest version vs local.
  // 线上最新版 vs 本地
  if (isLegacyEntry(entry)) {
    report.legacy.push({ item: itemFromVersion(config.site, id, name, type, latest, itemOpts), prev: entry });
  } else if (latestId && !report.localVersionIds.includes(latestId)) {
    if (pinned && pinned !== latestId) {
      report.pinned.push({
        item: itemFromVersion(config.site, id, name, type, latest, itemOpts),
        prev: entry,
        pinnedVersionId: pinned,
        onlineVersionId: latestId,
      });
    } else {
      report.updated.push({ item: itemFromVersion(config.site, id, name, type, latest, itemOpts), prev: entry });
    }
  }

  // Historical versions kept locally (not the latest).
  // 本地保留的历史版本（不是最新版）
  for (const rec of entryVersions(entry)) {
    if (latestId && String(rec.versionId) !== latestId) {
      const item = { modelId: id, name, type, versionId: rec.versionId, versionName: rec.versionName, files: rec.files, totalBytes: 0 };
      report.history.push({ item, prev: entry, versionIds: [String(rec.versionId)] });
    }
  }

  return { report, plan: [], libraryFile: libraryPath(config), entries };
}

// ---------------------------------------------------------------------------
// Report
// 报告
// ---------------------------------------------------------------------------

function ver(name, id) {
  return name || (id != null ? `#${id}` : t('updater.unknownVersion'));
}

function reportLines(report) {
  const lines = [];
  const title =
    report.kind === 'model'
      ? t('updater.modelCheckDone', {
          modelId: report.modelId,
          name: report.modelName || '',
          checkedAt: report.checkedAt,
          mode: report.deepChecked ? t('updater.deepCheck') : t('updater.quickCheck'),
        })
      : t('updater.checkDone', {
          collectionId: report.collectionId,
          checkedAt: report.checkedAt,
          mode: report.deepChecked ? t('updater.deepCheck') : t('updater.quickCheck'),
        });
  lines.push(title);

  if (report.corrupt) lines.push(t('updater.corruptLine', { message: report.corrupt }));
  if (report.kind !== 'model' && report.hasSnapshot) {
    lines.push(
      t('updater.snapshotLine', {
        count: report.snapshotCount || 0,
        fetchedAt: report.snapshotFetchedAt || t('updater.unknownVersion'),
      })
    );
    if (report.changes) {
      lines.push(
        t('updater.changesLine', {
          added: report.changes.added.length,
          removed: report.changes.removed.length,
          versionChanged: report.changes.versionChanged.length,
          previousFetchedAt: report.changes.previousFetchedAt || t('updater.firstSnapshot'),
        })
      );
    }
  }
  if (!report.hasState) lines.push(t('updater.noState'));

  if (report.updated.length) {
    lines.push(t('updater.updatedHeader', { count: report.updated.length }));
    for (const { item, prev } of report.updated) {
      const from = prev ? ver(prev.versionName, prev.pinnedVersionId || versionIds(prev).join('/')) : t('updater.notDownloadedShort');
      lines.push(t('updater.updatedLine', { name: item.name, from, to: ver(item.versionName, item.versionId) }));
    }
  }
  if (report.pinned && report.pinned.length) {
    lines.push(t('updater.pinnedHeader', { count: report.pinned.length }));
    for (const { item, prev, pinnedVersionId, onlineVersionId } of report.pinned) {
      lines.push(
        t('updater.pinnedLine', {
          name: item.name,
          pinned: ver(prev && prev.versionName, pinnedVersionId),
          online: ver(item.versionName, onlineVersionId),
        })
      );
    }
  }
  if (report.fileChanged.length) {
    lines.push(t('updater.fileChangedHeader', { count: report.fileChanged.length }));
    for (const { item, diff } of report.fileChanged) {
      const parts = [];
      if (diff.changed.length) {
        parts.push(
          t('updater.changePart', {
            names: diff.changed.map((c) => c.online.name || c.online.remoteName).join(t('updater.nameSeparator')),
          })
        );
      }
      if (diff.added.length) {
        parts.push(
          t('updater.addedPart', {
            names: diff.added.map((f) => f.name || f.remoteName).join(t('updater.nameSeparator')),
          })
        );
      }
      if (diff.removed.length) {
        parts.push(
          t('updater.removedPart', {
            names: diff.removed.map((f) => f.name || f.remoteName).join(t('updater.nameSeparator')),
          })
        );
      }
      if (diff.renamed.length) {
        parts.push(
          t('updater.renamedPart', {
            names: diff.renamed
              .map((r) =>
                t('updater.renamePair', {
                  from: r.from.name || r.from.remoteName,
                  to: r.to.name || r.to.remoteName,
                })
              )
              .join(t('updater.nameSeparator')),
          })
        );
      }
      lines.push(t('updater.fileChangedLine', { name: item.name, parts: parts.join(t('common.reasonSeparator')) }));
    }
  } else if (report.uncheckedChanges) {
    lines.push(t('updater.uncheckedChanges'));
  }
  if (report.missing.length) {
    lines.push(t('updater.missingHeader', { count: report.missing.length }));
    for (const { item, reasons } of report.missing) {
      lines.push(
        t('updater.missingLine', { name: item.name, reasons: reasons.join(t('common.reasonSeparator')) })
      );
    }
  }
  if (report.history && report.history.length) {
    lines.push(t('updater.historyHeader', { count: report.history.length }));
    for (const { item, versionIds: ids } of report.history) {
      lines.push(t('updater.historyLine', { name: item.name, versions: ids.join(t('updater.nameSeparator')) }));
    }
  }
  if (report.legacy.length) {
    lines.push(t('updater.legacyHeader', { count: report.legacy.length }));
    for (const { item } of report.legacy) {
      lines.push(t('updater.legacyLine', { name: item.name }));
    }
    lines.push(t('updater.legacyHint'));
  }
  if (report.upgraded.length) {
    lines.push(t('updater.upgradedHeader', { count: report.upgraded.length }));
  }
  if (report.failed.length) {
    lines.push(t('updater.failedHeader', { count: report.failed.length }));
    for (const { item, error } of report.failed) {
      lines.push(t('updater.failedLine', { name: item.name, error }));
    }
  }
  if (report.removed.length) {
    lines.push(t('updater.removedHeader', { count: report.removed.length }));
    for (const { modelId, prev, versionId } of report.removed) {
      lines.push(
        t('updater.removedLine', {
          name: (prev && prev.name) || t('updater.modelIdLabel', { modelId }),
        }) + (versionId ? t('updater.removedVersionSuffix', { versionId }) : '')
      );
    }
  }
  if (report.notDownloaded.length) {
    lines.push(t('updater.notDownloadedHeader', { count: report.notDownloaded.length }));
    if (report.kind === 'model') {
      // Pure formatting line, inlined directly (avoids registering a message key just for a symbol line).
      // 纯格式行，直接内联（避免为符号行单独登记文案键）
      for (const item of report.notDownloaded) lines.push(`  · ${item.name}`);
    }
  }
  const problemCount = report.updated.length + report.fileChanged.length + report.missing.length + report.failed.length;
  if (report.hasState && problemCount === 0) {
    lines.push(t('updater.allGood', { count: report.upToDate.length + report.upgraded.length }));
  }
  if (report.stats) {
    lines.push(
      t('updater.stats', {
        total: report.stats.total,
        updated: report.stats.updated,
        fileChanged: report.stats.fileChanged,
        missing: report.stats.missing,
        notDownloaded: report.stats.notDownloaded,
        pinned: report.stats.pinned,
      })
    );
  }
  return lines;
}

/**
 * Turn the report into the entries that "need downloading" (for a one-shot --download / TUI download).
 * 把报告整理为「需要下载」的条目（供 --download / TUI 一次性下载）
 */
function changedItems(report) {
  const seen = new Set();
  const out = [];
  for (const bucket of [report.updated, report.fileChanged, report.missing]) {
    for (const entry of bucket) {
      const item = entry.item;
      const key = `${item.modelId}:${item.versionId || ''}`;
      if (seen.has(key)) continue;
      seen.add(key);
      const prev = entry.prev;
      const rec = prev ? getVersion(prev, item.versionId) : null;
      item.outDirOverride = (rec && rec.outDir) || (prev && prev.outDir) || null;
      if (rec && rec.dirName) item.dirName = rec.dirName;
      out.push(item);
    }
  }
  // Versions missing locally: attach the direct file links recorded for that version, to allow partial repair.
  // 本地缺失的版本：补上该版本记录的文件直链，便于局部修复
  for (const entry of report.missing) {
    const prev = entry.prev;
    const rec = prev ? getVersion(prev, entry.item.versionId) : null;
    if (rec && rec.files && rec.files.length && !entry.item.files) entry.item.files = rec.files;
  }
  return out;
}

/**
 * Delete library records so the next download no longer skips them.
 * Per entry in items: a string deletes the whole model record, an object with a versionId deletes only that version (required when several versions coexist).
 *
 * 删除模型库记录，使下次下载不再跳过。
 * 传字符串 = 删除整个模型记录；传对象且带 versionId = 只删除该版本（多版本共存时必需）
 * @param {object} config
 * @param {Array<string|{modelId:string|number, versionId?:string|number|null}>} items
 * @param {{versionId?:string|number|null}} [opts] 兼容旧调用：对所有 modelId 只删该版本
 */
function markForRedownload(config, items, opts = {}) {
  const { entries } = readLibrary(config);
  let n = 0;
  for (const entry of items) {
    const modelId = typeof entry === 'object' && entry !== null ? entry.modelId : entry;
    const versionId =
      typeof entry === 'object' && entry !== null && entry.versionId !== undefined
        ? entry.versionId
        : opts.versionId;
    const record = entries[modelId];
    if (!record) continue;

    if (versionId === undefined || versionId === null) {
      delete entries[modelId];
      n++;
      continue;
    }
    const vid = String(versionId);
    if (record.versions && record.versions[vid]) {
      delete record.versions[vid];
      n++;
      if (!Object.keys(record.versions).length) delete entries[modelId];
    }
  }
  if (n) writeLibrary(config, entries);
  return n;
}

/**
 * Pin/unpin one version of a model.
 * 固定/取消固定某个模型的版本
 */
function setPin(config, modelId, versionId) {
  const { entries } = readLibrary(config);
  const ok = setPinnedVersion(entries, modelId, versionId);
  if (ok) writeLibrary(config, entries);
  return ok;
}

/**
 * Aggregate statistics (used by the report and batch checks).
 * 汇总统计（供报告与批量检查使用）
 */
function summarize(report) {
  const stats = {
    total:
      report.upToDate.length +
      report.updated.length +
      (report.pinned ? report.pinned.length : 0) +
      report.fileChanged.length +
      report.missing.length +
      report.legacy.length +
      report.failed.length +
      report.removed.length +
      report.notDownloaded.length,
    updated: report.updated.length,
    fileChanged: report.fileChanged.length,
    missing: report.missing.length,
    notDownloaded: report.notDownloaded.length,
    pinned: report.pinned ? report.pinned.length : 0,
    removed: report.removed.length,
    failed: report.failed.length,
    history: report.history ? report.history.length : 0,
  };
  stats.problems = stats.updated + stats.fileChanged + stats.missing + stats.failed;
  return stats;
}

module.exports = {
  checkUpdates,
  checkModelUpdates,
  reportLines,
  changedItems,
  markForRedownload,
  setPin,
  summarize,
  checkLocalFiles: checkModelFiles,
  checkModelFiles,
  checkVersionFiles,
  localDirFor,
  localDirForVersion,
  itemFromVersion,
  manifestDiff,
};
