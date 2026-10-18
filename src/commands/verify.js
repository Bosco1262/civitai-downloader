'use strict';

/**
 * verify: it does not enumerate collections but checks directly whether the locally downloaded files
 * are complete/intact (version by version) against the model library.
 *
 * It works from the library records (which hold the SHA256 and the download URLs), therefore:
 *  - fast: dozens of items are decided within seconds (with --no-hash it only compares sizes);
 *  - offline-capable: together with --repair --offline it repairs broken files using only the
 *    existing cookie file.
 *
 *
 * verify：不枚举收藏集，直接按模型库校验本地已下载文件是否齐全/完好（按版本逐条校验）。
 *
 * 依据是模型库记录（含 SHA256 与下载直链），所以：
 *  - 快：几十项也能秒级给出结论（--no-hash 时只比大小）；
 *  - 可离线：配合 --repair --offline 可以只用已有 Cookie 文件修复坏文件。
 */

const { log, formatBytes } = require('../util');
const { readLibrary, readCollection, singleModelKey, getVersion } = require('../storage');
const { checkModelFiles, localDirFor } = require('../updater');
const { runDownloadJob } = require('../job');
const { parseCollectionId, parseModelRef } = require('../urls');
const { t } = require('../i18n');

function usage() {
  console.error(t('verify.usage'));
  process.exitCode = 1;
}

/**
 * Verify every version of the given models.
 * 校验给定模型的全部版本。
 * @param {object} config
 * @param {Array<string|number>} modelIds
 * @param {{noHash?:boolean, label?:string}} [opts]
 * @returns {Promise<object>}
 */
async function verifyModels(config, modelIds, opts = {}) {
  const { entries, corrupt } = readLibrary(config, { allowCorrupt: true });
  const result = {
    label: opts.label || t('verify.allLabel'),
    modelIds: modelIds.map(String),
    corrupt: corrupt ? corrupt.message : null,
    checkedAt: new Date().toISOString(),
    total: 0,
    versions: 0,
    totalBytes: 0,
    ok: [],
    broken: [],
  };

  for (const modelId of result.modelIds) {
    const entry = entries[String(modelId)];
    if (!entry) continue;
    result.total++;
    const per = await checkModelFiles(config, entry, { verifyFiles: !opts.noHash });
    result.versions += per.perVersion.length;

    if (!per.perVersion.length) {
      // A record without version information: nothing to verify, so it is flagged separately.
      // 没有版本信息的记录：无从校验，单独标注
      result.ok.push({
        modelId: String(modelId),
        versionId: null,
        legacy: true,
        name: entry.name,
        dir: localDirFor(config, entry),
        files: 0,
        bytes: 0,
      });
      continue;
    }

    for (const v of per.perVersion) {
      const bytes = (v.files || []).reduce((sum, f) => sum + (f.bytes || 0), 0);
      result.totalBytes += bytes;
      const rec = {
        modelId: String(modelId),
        versionId: v.versionId,
        versionName: v.versionName,
        name: entry.name,
        dir: v.dir,
        files: (v.files || []).length,
        bytes,
        reasons: v.reasons,
        brokenFiles: (v.files || []).filter((f) => v.missingFiles.includes(f.name)),
      };
      if (v.reasons.length) result.broken.push(rec);
      else result.ok.push(rec);
    }
  }
  return result;
}

function printResult(result, json) {
  if (json) return;
  console.log('');
  console.log(
    t('verify.summary', {
      label: result.label,
      total: result.total,
      versions: result.versions,
      size: formatBytes(result.totalBytes),
    })
  );
  if (result.corrupt) console.log(t('verify.corruptLine', { message: result.corrupt }));
  console.log(t('verify.counts', { ok: result.ok.length, broken: result.broken.length }));
  for (const b of result.broken) {
    const label = b.versionName ? `${b.name}（${b.versionName}）` : b.name;
    console.log(t('verify.brokenLine', { name: label, reasons: b.reasons.join(t('common.reasonSeparator')) }));
    console.log(t('verify.brokenDir', { dir: b.dir }));
  }
}

/**
 * Model IDs of a collection snapshot (the membership list written by list/download).
 * 某个收藏集快照里的模型 ID（list/download 写下的成员清单）。
 */
function collectionModelIds(config, collectionId) {
  const { snapshot } = readCollection(config, collectionId, { allowCorrupt: true });
  if (!snapshot) return null;
  return snapshot.items.map((it) => String(it.modelId));
}

/**
 * Parse positional arguments into model IDs (a collection ID, or a model reference).
 * 解析位置参数为若干模型 ID（收藏集 ID，或模型引用）。
 * @returns {{modelIds?:string[], label?:string, error?:string}}
 */
function parseTargets(config, positionals) {
  const modelIds = [];
  const labels = [];
  for (const positional of positionals) {
    const collectionId = parseCollectionId(positional);
    if (collectionId) {
      const ids = collectionModelIds(config, collectionId);
      if (ids === null) return { error: positional, missingSnapshot: true };
      for (const id of ids) if (!modelIds.includes(id)) modelIds.push(id);
      labels.push(t('verify.collectionLabel', { collectionId }));
      continue;
    }
    const ref = parseModelRef(positional);
    if (ref && ref.modelId) {
      const id = String(ref.modelId);
      if (!modelIds.includes(id)) modelIds.push(id);
      labels.push(t('verify.modelLabel', { label: id }));
      continue;
    }
    return { error: positional };
  }
  return { modelIds, label: labels.length ? labels.join(t('common.listSeparator')) : t('verify.allLabel') };
}

async function main(config, args) {
  const noHash = !!args.flags['no-hash'];
  const repair = !!args.flags.repair;

  const parsed = parseTargets(config, args.positionals);
  if (parsed.error) {
    console.error(
      t(parsed.missingSnapshot ? 'verify.snapshotMissing' : 'verify.unrecognizedCollection', {
        value: parsed.error,
      })
    );
    return usage();
  }

  const { entries } = readLibrary(config, { allowCorrupt: true });
  const allIds = Object.keys(entries);
  const ids = [...(parsed.modelIds || [])];
  if (args.flags.all || args.flags.models) {
    for (const id of allIds) if (!ids.includes(id)) ids.push(id);
  }
  if (!ids.length) {
    // --all / --models with an empty library only means "nothing recorded yet"; not a usage error.
    // --all / --models 遇上空模型库只是「还没有记录」，不是用法错误
    if (args.flags.all || args.flags.models) {
      log(t('verify.libraryEmpty'));
      return;
    }
    return usage();
  }

  const label = args.flags.all || args.flags.models ? t('verify.allLabel') : parsed.label;
  const result = await verifyModels(config, ids, { noHash, label });
  printResult(result, !!args.flags.json);

  if (args.flags.json) {
    console.log(JSON.stringify(result, null, 2));
  }

  if (!repair) {
    if (result.broken.length) {
      log(t('verify.brokenTotal', { count: result.broken.length }));
      process.exitCode = 1;
    } else {
      log(t('verify.allPassed'));
    }
    return;
  }

  if (!result.broken.length) {
    log(t('verify.nothingToRepair'));
    return;
  }

  let failed = 0;
  for (const item of result.broken) {
    const { entries: fresh } = readLibrary(config, { allowCorrupt: true });
    const entry = fresh[item.modelId];
    if (!entry) continue;
    const versionRec = getVersion(entry, item.versionId);
    if (!versionRec) continue;

    const files = (item.brokenFiles || []).filter((f) => f.downloadUrl);
    const skipped = (item.brokenFiles || []).length - files.length;
    if (skipped) {
      log(t('verify.missingDownloadUrl', { name: entry.name, count: skipped }));
    }
    if (!files.length) continue;

    log(t('verify.repairing', { name: entry.name, count: files.length }));
    const summary = await runDownloadJob(config, {
      collectionId: singleModelKey(item.modelId),
      plan: [
        {
          modelId: item.modelId,
          name: entry.name,
          type: entry.type,
          baseModel: entry.baseModel,
          versionId: item.versionId,
          versionName: versionRec.versionName,
          outDirOverride: versionRec.outDir || null,
          dirName: versionRec.dirName || null,
          files,
          totalBytes: files.reduce((sum, f) => sum + (f.bytes || 0), 0),
        },
      ],
      outDir: versionRec.outDir || config.outDir,
      force: true,
      jobs: 1,
      attempts: config.downloadAttempts,
      offline: !!args.flags.offline,
    });
    if (summary.error || summary.failed) failed++;
  }
  if (failed) process.exitCode = 1;
}

module.exports = { main, usage, verifyModels, parseTargets, collectionModelIds };
