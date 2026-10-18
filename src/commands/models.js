'use strict';

/**
 * models: listing and managing the model library (one model with several versions).
 *
 * Division of labor with download/check/verify:
 *  - download does the downloading; this command only reads/maintains .data/library.json;
 *  - the list is sorted by "most recently completed" by default, to confirm what was just downloaded;
 *  - --forget removes records (optionally only one version); only --delete-files touches files on disk
 *    (only the file names listed in the record, then empty directories are cleaned bottom-up).
 *
 *
 * models：模型库（一个模型多个版本）的列表与管理。
 *
 * 与 download/check/verify 的分工：
 *  - download 负责「下载」，本命令只读/维护 .data/library.json；
 *  - 列表默认按「最近完成」排序，便于确认刚刚下过什么；
 *  - --forget 删记录（可只删某个版本），--delete-files 才动磁盘上的文件
 *    （只删记录里列出的文件名，随后自下而上清理空目录）。
 */

const fs = require('fs');
const path = require('path');
const { log, formatBytes, resolveUserPath, writeJsonAtomic, ensureDir, uniqueName, moveFile } = require('../util');
const {
  readLibrary,
  writeLibrary,
  entryVersions,
  getVersion,
  removeVersion,
  removeModel,
} = require('../storage');
const layout = require('../layout');
const { setPin, localDirForVersion } = require('../updater');
const { t } = require('../i18n');

function usage() {
  console.error(t('models.usage'));
  process.exitCode = 1;
}

/**
 * CSV column order (kept in sync with the usage text).
 * CSV 列顺序（与 usage 文案保持一致）
 */
const CSV_COLUMNS = [
  'modelId',
  'name',
  'type',
  'versionId',
  'versionName',
  'files',
  'bytes',
  'outDir',
  'dirName',
  'pinned',
  'verifiedAt',
];

function sumBytes(files) {
  return (files || []).reduce((sum, f) => sum + (Number(f.bytes) || 0), 0);
}

/**
 * Accepts 1191424 / model:1191424 / model-1191424.
 * 接受 1191424 / model:1191424 / model-1191424
 */
function normalizeModelId(raw) {
  const m = /^(?:model[:\-])?(\d+)$/.exec(String(raw === undefined || raw === null ? '' : raw).trim());
  return m ? m[1] : null;
}

function versionLabel(versionName, versionId) {
  return versionName ? `${versionName}` : String(versionId);
}

// ---------------------------------------------------------------------------
// Reading and organizing
// 读取与整理
// ---------------------------------------------------------------------------

/**
 * Summarize one library entry (shared by the list / JSON / export paths).
 * 汇总一条模型库记录（列表 / JSON / 导出共用）。
 * @returns {object}
 */
function modelFromEntry(config, modelId, entry, corrupt) {
  const versions = entry ? entryVersions(entry) : [];
  const newest = versions[0] || null;
  return {
    modelId: String(modelId),
    name: entry ? entry.name || null : null,
    type: entry ? entry.type || null : null,
    baseModel: entry ? entry.baseModel || null : null,
    pinnedVersionId:
      entry && entry.pinnedVersionId !== undefined && entry.pinnedVersionId !== null
        ? String(entry.pinnedVersionId)
        : null,
    versions: versions.map((v) => ({
      versionId: String(v.versionId),
      versionName: v.versionName || null,
      dirName: v.dirName || null,
      outDir: v.outDir || null,
      files: (v.files || []).map((f) => ({
        name: f.name || null,
        sha256: f.sha256 || null,
        bytes: Number.isFinite(f.bytes) ? f.bytes : null,
      })),
      bytes: sumBytes(v.files),
      verifiedAt: v.verifiedAt || null,
    })),
    hasEntry: !!entry,
    totalBytes: versions.reduce((sum, v) => sum + sumBytes(v.files), 0),
    dir: newest ? localDirForVersion(config, entry, newest) : null,
    corrupt: corrupt || null,
  };
}

/**
 * Collect one model of the library.
 * 汇总模型库里的一个模型。
 */
function collectModel(config, modelId) {
  const { entries, corrupt } = readLibrary(config, { allowCorrupt: true });
  const entry = entries[String(modelId)] || null;
  return modelFromEntry(config, modelId, entry, corrupt ? corrupt.message : null);
}

function collectModels(config) {
  const { entries, corrupt } = readLibrary(config, { allowCorrupt: true });
  return Object.keys(entries)
    .sort()
    .map((modelId) => modelFromEntry(config, modelId, entries[modelId], corrupt ? corrupt.message : null));
}

/**
 * Keyword filter: the name (case-insensitive) or a model ID substring.
 * 关键字过滤：名称（大小写不敏感）或模型 ID 子串
 */
function filterModels(models, keyword) {
  const kw = String(keyword === undefined || keyword === null ? '' : keyword)
    .trim()
    .toLowerCase();
  if (!kw) return models;
  return models.filter(
    (m) => String(m.name || '').toLowerCase().includes(kw) || m.modelId.includes(kw)
  );
}

function lastVerifiedAt(model) {
  return model.versions.reduce((newest, v) => {
    const at = String(v.verifiedAt || '');
    return at > newest ? at : newest;
  }, '');
}

/**
 * recent (default) = newest completion time first; name = by name; size = largest first.
 * recent（默认）= 最近完成时间倒序；name = 名称；size = 体积倒序
 */
function sortModels(models, mode = 'recent') {
  const list = [...models];
  if (mode === 'name') {
    list.sort((a, b) => String(a.name || a.modelId).localeCompare(String(b.name || b.modelId)));
  } else if (mode === 'size') {
    list.sort((a, b) => b.totalBytes - a.totalBytes);
  } else {
    list.sort((a, b) => lastVerifiedAt(b).localeCompare(lastVerifiedAt(a)));
  }
  return list;
}

/**
 * Shape of --json / --export .json.
 * --json / --export .json 的结构
 */
function buildExport(models) {
  return {
    exportedAt: new Date().toISOString(),
    count: models.length,
    models: models.map((m) => ({
      modelId: m.modelId,
      name: m.name,
      type: m.type,
      baseModel: m.baseModel,
      versions: m.versions.map((v) => ({
        versionId: v.versionId,
        versionName: v.versionName,
        outDir: v.outDir,
        dirName: v.dirName,
        files: v.files.map((f) => ({ name: f.name, sha256: f.sha256, bytes: f.bytes })),
        bytes: v.bytes,
        verifiedAt: v.verifiedAt,
      })),
      pinnedVersionId: m.pinnedVersionId,
      totalBytes: m.totalBytes,
    })),
  };
}

function csvCell(value) {
  const s = value === undefined || value === null ? '' : String(value);
  return /[",\r\n]/.test(s) ? `"${s.replace(/"/g, '""')}"` : s;
}

/**
 * One row per version; a record without versions also gets a row so it is easy to spot.
 * 一行一个版本；没有版本的记录也占一行，便于发现
 */
function buildCsv(models) {
  const rows = [CSV_COLUMNS.join(',')];
  for (const m of models) {
    const base = [m.modelId, m.name, m.type];
    if (!m.versions.length) {
      rows.push([...base, '', '', 0, 0, '', '', m.pinnedVersionId ? 'yes' : '', ''].map(csvCell).join(','));
      continue;
    }
    for (const v of m.versions) {
      rows.push(
        [
          ...base,
          v.versionId,
          v.versionName,
          v.files.length,
          v.bytes,
          v.outDir,
          v.dirName,
          m.pinnedVersionId === v.versionId ? 'yes' : '',
          v.verifiedAt,
        ]
          .map(csvCell)
          .join(',')
      );
    }
  }
  return rows.join('\n') + '\n';
}

// ---------------------------------------------------------------------------
// List output
// 列表输出
// ---------------------------------------------------------------------------

function printList(models, opts = {}) {
  if (!models.length) {
    console.log(t(opts.filtered ? 'models.noMatch' : 'models.listEmpty'));
    return;
  }
  console.log('');
  console.log(t('models.listHeader', { count: models.length }));
  for (const m of models) {
    const name = m.name || t('models.modelIdLabel', { modelId: m.modelId });
    const pinned = m.pinnedVersionId
      ? t('models.pinnedTag', {
          version: versionLabel(
            (m.versions.find((v) => v.versionId === m.pinnedVersionId) || {}).versionName,
            m.pinnedVersionId
          ),
        })
      : t('models.notPinnedTag');
    console.log(
      t('models.listLine', {
        name,
        modelId: m.modelId,
        count: m.versions.length,
        size: formatBytes(m.totalBytes),
        pinned,
      })
    );
    const items = m.versions.length
      ? m.versions.map((v) =>
          t(v.versionId === m.pinnedVersionId ? 'models.versionItemPinned' : 'models.versionItem', {
            name: versionLabel(v.versionName, v.versionId),
            versionId: v.versionId,
            size: formatBytes(v.bytes),
          })
        )
      : [t('models.noVersions')];
    // Pure formatting line (indent + join) is inlined; no dedicated message key is registered.
    // 纯格式行（缩进 + 拼接）直接内联，不单独登记文案键
    console.log(`      ${t('models.versionLine', { versions: items.join(t('models.separator')) })}`);
    if (m.dir) console.log(`      ${t('models.dirLine', { dir: m.dir })}`);
    if (m.corrupt) console.log(t('models.corruptLine', { message: m.corrupt }));
  }
}

// ---------------------------------------------------------------------------
// --export
// 导出
// ---------------------------------------------------------------------------

function exportModels(file, models) {
  const ext = path.extname(file).toLowerCase();
  if (ext === '.json') {
    writeJsonAtomic(file, buildExport(models));
  } else if (ext === '.csv') {
    ensureDir(path.dirname(file));
    fs.writeFileSync(file, buildCsv(models), 'utf8');
  } else {
    console.error(t('models.exportBadExt', { file }));
    usage();
    return false;
  }
  log(t('models.exportWritten', { count: models.length, file }));
  return true;
}

// ---------------------------------------------------------------------------
// --forget
// 删除记录
// ---------------------------------------------------------------------------

/**
 * Remove empty directories bottom-up (up to but not including stopDir).
 * Only directories that held recorded files are removed, and only when they are empty.
 *
 * 自下而上删除空目录（到 stopDir 为止，不动 stopDir 本身）。
 * 只删除「记录里的文件所在目录」，且仅在为空时删除。
 */
function removeEmptyDirs(startDir, stopDir) {
  const stop = path.resolve(stopDir);
  let current = path.resolve(startDir);
  let removed = 0;
  for (;;) {
    const rel = path.relative(stop, current);
    if (!rel || rel.startsWith('..') || path.isAbsolute(rel)) break;
    let entries;
    try {
      entries = fs.readdirSync(current);
    } catch (e) {
      break;
    }
    if (entries.length) break;
    try {
      fs.rmdirSync(current);
    } catch (e) {
      break;
    }
    removed++;
    current = path.dirname(current);
  }
  return removed;
}

/**
 * Delete the files of one version record (by the recorded file names only, then clean up empty directories).
 * 删除某个版本记录里的文件（只按记录中的文件名，随后清理空目录）
 */
function deleteVersionFiles(config, entry, versionRec) {
  const dir = localDirForVersion(config, entry, versionRec);
  let files = 0;
  let missing = 0;
  for (const f of versionRec.files || []) {
    const name = String(f.name || '');
    if (!name) continue;
    const file = path.join(dir, path.basename(name));
    let st = null;
    try {
      st = fs.statSync(file);
    } catch (e) {
      st = null;
    }
    if (!st || !st.isFile()) {
      missing++;
      continue;
    }
    fs.rmSync(file, { force: true });
    files++;
  }
  const dirs = removeEmptyDirs(dir, versionRec.outDir || config.outDir);
  return { files, missing, dirs };
}

function forgetModels(config, raw, opts = {}) {
  const ids = String(raw === true ? '' : raw || '')
    .split(',')
    .map((s) => s.trim())
    .filter(Boolean);
  if (!ids.length) {
    console.error(t('models.forgetNoId'));
    return usage();
  }

  const versionId = opts.version ? String(opts.version) : null;
  const { entries } = readLibrary(config, { allowCorrupt: true });
  let removedModels = 0;
  let removedVersions = 0;
  let missingRecords = 0;
  let files = 0;
  let missingFiles = 0;
  let dirs = 0;
  let changed = false;

  for (const rawId of ids) {
    const modelId = normalizeModelId(rawId);
    if (!modelId) {
      log(t('models.forgetNoRecord', { modelId: rawId }));
      missingRecords++;
      continue;
    }
    const entry = entries[modelId];
    if (!entry) {
      log(t('models.forgetNoRecord', { modelId }));
      missingRecords++;
      continue;
    }

    const versions = entryVersions(entry);
    const targets = versionId ? versions.filter((v) => String(v.versionId) === versionId) : versions;
    if (versionId && !targets.length) {
      log(t('models.forgetNoVersion', { modelId, versionId }));
      missingRecords++;
      continue;
    }

    if (opts.deleteFiles) {
      if (!versions.length) {
        log(t('models.legacyNoFiles', { modelId }));
      }
      for (const rec of targets) {
        const r = deleteVersionFiles(config, entry, rec);
        files += r.files;
        missingFiles += r.missing;
        dirs += r.dirs;
      }
    }

    if (versionId) {
      if (removeVersion(entries, modelId, versionId)) removedVersions++;
    } else {
      removeModel(entries, modelId);
      removedModels++;
    }
    changed = true;
  }

  if (changed) writeLibrary(config, entries);
  if (removedModels) log(t('models.forgetModelsDone', { count: removedModels }));
  if (removedVersions) log(t('models.forgetVersionsDone', { count: removedVersions }));
  if (opts.deleteFiles) {
    log(t('models.filesDeleted', { files, dirs }));
    if (missingFiles) log(t('models.filesMissing', { count: missingFiles }));
  }
  if (!removedModels && !removedVersions) log(t('models.forgetNothing'));
  else if (!opts.deleteFiles) log(t('models.deleteFilesHint'));
  return true;
}

// ---------------------------------------------------------------------------
// --pin / --unpin
// 固定 / 取消固定
// ---------------------------------------------------------------------------

function pinModel(config, raw) {
  const m = /^(?:model[:\-])?(\d+)(?:=(.+))?$/.exec(String(raw === true ? '' : raw || '').trim());
  if (!m) {
    console.error(t('models.pinFormat', { value: raw }));
    return usage();
  }
  const modelId = m[1];
  const wanted = m[2] ? String(m[2]).trim() : null;
  const entry = readLibrary(config, { allowCorrupt: true }).entries[modelId];
  if (!entry) {
    console.error(t('models.noRecord', { modelId }));
    process.exitCode = 1;
    return false;
  }

  const versions = entryVersions(entry);
  const target = wanted || (versions[0] ? String(versions[0].versionId) : null);
  if (!target) {
    console.error(t('models.pinNoVersion', { modelId }));
    process.exitCode = 1;
    return false;
  }
  const rec = getVersion(entry, target);
  if (!rec) {
    console.error(
      t('models.pinVersionNotFound', {
        modelId,
        versionId: target,
        versions: versions.map((v) => String(v.versionId)).join(t('models.separator')),
      })
    );
    process.exitCode = 1;
    return false;
  }

  setPin(config, modelId, target);
  log(
    t('models.pinDone', {
      name: entry.name || modelId,
      version: versionLabel(rec.versionName, target),
    })
  );
  return true;
}

function unpinModel(config, raw) {
  const modelId = normalizeModelId(raw);
  if (!modelId) {
    console.error(t('models.pinFormat', { value: raw }));
    return usage();
  }
  const entry = readLibrary(config, { allowCorrupt: true }).entries[modelId];
  if (!entry) {
    console.error(t('models.noRecord', { modelId }));
    process.exitCode = 1;
    return false;
  }
  setPin(config, modelId, null);
  log(t('models.unpinDone', { name: entry.name || modelId }));
  return true;
}

// ---------------------------------------------------------------------------
// --relayout
// 重排目录布局
// ---------------------------------------------------------------------------

/**
 * Recompute the directory of every recorded version from the current layout config and move the
 * files there. Name clashes inside the new directory are resolved with the same "both sides get
 * their version suffix" rule as a download.
 *
 * With dryRun nothing is moved and the library is not written.
 *
 *
 * 按当前布局配置重新计算每个版本的目录，并把文件移动过去。
 * 新目录里的同名冲突沿用与下载相同的「双方都加版本后缀」规则。
 *
 * dryRun 时不移动文件、也不写模型库。
 * @param {object} config
 * @param {{dryRun?:boolean}} [opts]
 * @returns {object} summary
 */
function relayoutModels(config, opts = {}) {
  const dryRun = !!opts.dryRun;
  const { entries } = readLibrary(config, { allowCorrupt: true });
  const modelIds = Object.keys(entries).sort();
  const summary = {
    dryRun,
    models: 0,
    versions: 0,
    files: 0,
    moved: 0,
    copied: 0,
    renamed: 0,
    missing: 0,
    dirs: 0,
  };

  // 1) Target directory of every model; two models that would land on the same name are separated
  // 1) 每个模型的目标目录；会撞名的模型自动区分开
  const desired = [];
  for (const modelId of modelIds) {
    const entry = entries[modelId];
    const versions = entryVersions(entry);
    if (!versions.length) continue;
    const parent = versions[0].outDir || config.outDir;
    const base = layout.composeDirName({
      name: entry.name,
      type: entry.type,
      baseModel: entry.baseModel,
      layout: config.layout,
      customMap: config.typeFolders,
      baseModelLayer: config.baseModelLayer,
    });
    desired.push({ modelId, parent, base: layout.fitDirName(parent, base, modelId) });
  }
  const usedByParent = new Map();
  const targets = new Map();
  for (const item of desired) {
    const key = String(item.parent).toLowerCase();
    if (!usedByParent.has(key)) usedByParent.set(key, new Set());
    const used = usedByParent.get(key);
    const chosen = uniqueName(item.base, used);
    used.add(chosen);
    targets.set(item.modelId, { parent: item.parent, dirName: chosen });
  }

  // 2) Plan the final file names of every model, then move
  // 2) 规划每个模型的最终文件名，然后移动
  for (const modelId of modelIds) {
    const entry = entries[modelId];
    const versions = entryVersions(entry);
    if (!versions.length) continue;
    const target = targets.get(modelId);
    const dir = path.join(target.parent, target.dirName);
    summary.models++;

    // Oldest first: the earliest version keeps the plain name, later ones take the suffix
    // 由旧到新：最早的版本保留原名，后续版本加后缀
    const ordered = [...versions]
      .map((v) => ({ ...v, rec: entry.versions[String(v.versionId)] }))
      .filter((v) => v.rec)
      .sort((a, b) => String(a.verifiedAt || '').localeCompare(String(b.verifiedAt || '')));
    const accepted = [];
    const finalNames = new Map();
    for (const v of ordered) {
      const planned = layout.planFileNames({
        dir,
        version: { versionId: v.versionId, versionName: v.versionName, files: v.rec.files },
        entries: accepted,
      });
      for (const rename of planned.renames) {
        const acc = accepted.find((a) => String(a.versionId) === String(rename.versionId));
        if (acc) for (const f of acc.files) if (f.name === rename.from) f.name = rename.to;
        const plannedNames = finalNames.get(String(rename.versionId)) || [];
        for (const n of plannedNames) if (n.diskName === rename.from) n.diskName = rename.to;
      }
      finalNames.set(String(v.versionId), planned.names);
      accepted.push({
        versionId: v.versionId,
        versionName: v.versionName,
        files: (v.rec.files || []).map((f, i) => ({
          name: planned.names[i] ? planned.names[i].diskName : f.name,
          remoteName: f.remoteName || f.name,
          sha256: f.sha256 || null,
          bytes: Number.isFinite(f.bytes) ? f.bytes : null,
        })),
      });
      summary.versions++;
    }

    // Move every version into the target directory with its planned name
    // 把每个版本按规划好的名字移入目标目录
    const oldDirs = new Set();
    const oldRoots = new Set();
    for (const v of ordered) {
      const names = finalNames.get(String(v.versionId)) || [];
      const fromDir = path.join(v.rec.outDir || config.outDir, v.rec.dirName || '');
      if (v.rec.dirName) oldDirs.add(fromDir);
      oldRoots.add(v.rec.outDir || config.outDir);
      for (let i = 0; i < (v.rec.files || []).length; i++) {
        const f = v.rec.files[i];
        const wanted = names[i] ? names[i].diskName : f.name;
        summary.files++;
        if (wanted !== f.name) summary.renamed++;
        if (dryRun) continue;
        const from = path.join(fromDir, f.name);
        const to = path.join(dir, wanted);
        if (path.resolve(from) !== path.resolve(to)) {
          const how = moveFile(from, to);
          if (!how) summary.missing++;
          else if (how === 'copied') summary.copied++;
          if (how) summary.moved++;
        }
        f.name = wanted;
      }
      if (!dryRun) {
        v.rec.dirName = target.dirName;
        v.rec.outDir = target.parent;
      }
    }

    // Clean up the directories that were left behind (empty ones only)
    // 清理搬走后留下的空目录（仅限空目录）
    if (!dryRun) {
      for (const oldDir of oldDirs) {
        const root = [...oldRoots].find((r) => path.resolve(oldDir).startsWith(path.resolve(r))) || config.outDir;
        summary.dirs += removeEmptyDirs(oldDir, root);
      }
    }
  }

  if (!dryRun && (summary.moved || summary.models)) writeLibrary(config, entries);
  return summary;
}

/**
 * Print the result of --relayout.
 * 打印 --relayout 的结果。
 */
function printRelayout(summary) {
  if (summary.dryRun) {
    log(
      t('models.relayoutPlanned', {
        models: summary.models,
        versions: summary.versions,
        files: summary.files,
        renamed: summary.renamed,
      })
    );
    log(t('models.relayoutDryRun'));
    return;
  }
  log(
    t('models.relayoutDone', {
      models: summary.models,
      versions: summary.versions,
      files: summary.files,
      dirs: summary.dirs,
      renamed: summary.renamed,
      copied: summary.copied,
    })
  );
  if (summary.missing) log(t('models.relayoutMissing', { count: summary.missing }));
}

// ---------------------------------------------------------------------------
// main
// 主流程
// ---------------------------------------------------------------------------

async function main(config, args) {
  const flags = args.flags || {};

  if (flags.relayout) {
    const summary = relayoutModels(config, { dryRun: !!flags['dry-run'] });
    printRelayout(summary);
    return true;
  }

  if (flags.forget) {
    return forgetModels(config, flags.forget, {
      version: flags.version && flags.version !== true ? String(flags.version) : null,
      deleteFiles: !!flags['delete-files'],
    });
  }
  if (flags.pin) return pinModel(config, flags.pin);
  if (flags.unpin) return unpinModel(config, flags.unpin);

  const sortMode = flags.sort && flags.sort !== true ? String(flags.sort) : 'recent';
  if (!['name', 'size', 'recent'].includes(sortMode)) {
    console.error(t('models.sortInvalid', { value: sortMode }));
    return usage();
  }

  const all = collectModels(config);
  const models = sortModels(
    flags.search && flags.search !== true ? filterModels(all, flags.search) : all,
    sortMode
  );

  if (flags.export) {
    if (flags.export === true) return usage();
    const file = resolveUserPath(String(flags.export), config.root);
    return exportModels(file, models);
  }

  if (flags.json) {
    console.log(JSON.stringify(buildExport(models), null, 2));
    return;
  }

  printList(models, { filtered: !!flags.search });
}

module.exports = {
  main,
  usage,
  // Shared by the tests and the TUI.
  // 供测试与 TUI 复用
  collectModel,
  collectModels,
  modelFromEntry,
  filterModels,
  sortModels,
  buildExport,
  buildCsv,
  printList,
  exportModels,
  forgetModels,
  relayoutModels,
  printRelayout,
  pinModel,
  unpinModel,
  removeEmptyDirs,
  deleteVersionFiles,
  normalizeModelId,
  CSV_COLUMNS,
};
