'use strict';

const { log, readJson, writeJsonAtomic, resolveUserPath } = require('../util');
const {
  checkUpdates,
  checkModelUpdates,
  reportLines,
  changedItems,
  markForRedownload,
  summarize,
} = require('../updater');
const { runDownloadJob } = require('../job');
const { dataPaths, readLibrary, listCollectionIds } = require('../storage');
const { parseCollectionId, parseModelRef } = require('../urls');
const { t } = require('../i18n');

function usage() {
  console.error(t('check.usage'));
  process.exitCode = 1;
}

/**
 * Report fingerprint: modelId → issue type (used to compare with the previous check).
 * 报告指纹：modelId → 问题类型（用于与上次检查结果对比）
 */
function fingerprint(report) {
  const map = {};
  for (const { item } of report.updated) map[String(item.modelId)] = `updated:${item.versionId}`;
  for (const { item } of report.fileChanged) map[String(item.modelId)] = 'fileChanged';
  for (const { item } of report.missing) map[String(item.modelId)] = 'missing';
  for (const { item, error } of report.failed) map[String(item.modelId)] = `failed:${error}`;
  return map;
}

function diffWithPrevious(previousFingerprint, current) {
  const prev = previousFingerprint || {};
  const newly = Object.keys(current).filter((k) => !prev[k] || prev[k] !== current[k]);
  const fixed = Object.keys(prev).filter((k) => !current[k]);
  return { newly, fixed };
}

/**
 * Parse positional arguments: a collection ID/URL takes the collection path, while model:<id> / a model URL
 * takes the single-model path (a single model never enumerates collections).
 *
 * 解析位置参数：收藏集 ID/URL 走收藏集路径，model:<id> / 模型 URL 走单模型路径
 * （单模型不会去枚举收藏集）。
 * @returns {{targets?:Array<{kind:string,id:string}>, error?:string, versionOnly?:boolean}}
 */
function parseTargets(positionals) {
  const targets = [];
  for (const positional of positionals) {
    const collectionId = parseCollectionId(positional);
    if (collectionId) {
      targets.push({ kind: 'collection', id: collectionId });
      continue;
    }
    const ref = parseModelRef(positional);
    if (ref && ref.modelId) {
      targets.push({ kind: 'model', id: String(ref.modelId) });
      continue;
    }
    // Inputs such as version:<id> / ?modelVersionId= carry only a version and cannot locate the model.
    // version:<id> / ?modelVersionId= 这类只有版本号的输入无法定位模型
    return { error: String(positional), versionOnly: !!(ref && ref.versionId) };
  }
  return { targets };
}

/**
 * Check one target (a collection snapshot or a single model), cache the report and compare it with the last result.
 * 检查一个目标（收藏集快照或单模型），并写入报告缓存 + 与上次结果对比
 */
async function checkOne(config, target, opts) {
  const isModel = target.kind === 'model';
  const id = isModel ? `model-${target.id}` : target.id;
  const paths = dataPaths(config, id);

  const { report } = isModel
    ? await checkModelUpdates(config, target.id, { verifyFiles: opts.verifyFiles, deps: opts.deps })
    : await checkUpdates(config, id, {
        verifyFiles: opts.verifyFiles,
        withPlan: opts.download,
        deps: opts.deps,
      });
  report.stats = summarize(report);

  const previous = readJson(paths.report, null);
  const currentFp = fingerprint(report);
  const delta = diffWithPrevious(previous && previous.fingerprint, currentFp);
  report.delta = {
    previousCheckedAt: (previous && previous.checkedAt) || null,
    newlyProblem: delta.newly.length,
    fixed: delta.fixed.length,
    newlyIds: delta.newly,
    fixedIds: delta.fixed,
  };
  writeJsonAtomic(paths.report, {
    checkedAt: report.checkedAt,
    deepChecked: report.deepChecked,
    stats: report.stats,
    fingerprint: currentFp,
  });

  return report;
}

/**
 * Title label of a single-model report: the name (when recorded) + modelId.
 * 单模型报告的标题标签：名称（有记录时）+ modelId
 */
function modelLabel(config, modelId) {
  const entry = readLibrary(config, { allowCorrupt: true }).entries[String(modelId)];
  return entry && entry.name ? entry.name : t('check.modelIdLabel', { modelId });
}

function printReport(report, opts) {
  if (opts.json) return;
  if (opts.quiet) {
    const s = report.stats;
    console.log(
      report.kind === 'model'
        ? t('check.modelQuietSummary', {
            label: report.modelName || t('check.modelIdLabel', { modelId: report.modelId }),
            total: s.total,
            updated: s.updated,
            fileChanged: s.fileChanged,
            missing: s.missing,
            notDownloaded: s.notDownloaded,
            pinned: s.pinned,
          })
        : t('check.quietSummary', {
            collectionId: report.collectionId,
            total: s.total,
            updated: s.updated,
            fileChanged: s.fileChanged,
            missing: s.missing,
            notDownloaded: s.notDownloaded,
            pinned: s.pinned,
          })
    );
  } else {
    for (const line of reportLines(report)) console.log(line);
  }
  if (report.delta && report.delta.previousCheckedAt) {
    const parts = [];
    if (report.delta.newlyProblem) parts.push(t('check.deltaNew', { count: report.delta.newlyProblem }));
    if (report.delta.fixed) parts.push(t('check.deltaFixed', { count: report.delta.fixed }));
    if (parts.length) {
      console.log(
        t('check.deltaSummary', {
          checkedAt: report.delta.previousCheckedAt,
          parts: parts.join(t('common.listSeparator')),
        })
      );
    }
  }
}

async function main(config, args) {
  const verifyFiles = !!(args.flags['verify-files'] || args.flags.deep);
  const doDownload = !!args.flags.download;
  const json = !!args.flags.json;
  const quiet = !!args.flags.quiet;

  const parsed = parseTargets(args.positionals);
  if (parsed.error) {
    console.error(
      t(parsed.versionOnly ? 'check.modelVersionHint' : 'check.unrecognizedCollection', {
        value: parsed.error,
      })
    );
    return usage();
  }
  const targets = [...parsed.targets];

  if (args.flags.all) {
    for (const id of listCollectionIds(config)) {
      if (!targets.some((x) => x.kind === 'collection' && x.id === id)) {
        targets.push({ kind: 'collection', id });
      }
    }
  }
  if (args.flags.models) {
    const modelIds = Object.keys(readLibrary(config, { allowCorrupt: true }).entries);
    if (!modelIds.length) log(t('check.modelsNone'));
    for (const modelId of modelIds) {
      if (!targets.some((x) => x.kind === 'model' && x.id === modelId)) {
        targets.push({ kind: 'model', id: modelId });
      }
    }
  }
  if (!targets.length) {
    // --all / --models only means "there are no records yet"; it is not a usage error.
    // --all / --models 只是「当前没有任何记录」，不是用法错误
    if (args.flags.all || args.flags.models) return;
    return usage();
  }

  const reports = [];
  for (const target of targets) {
    if (targets.length > 1) {
      log(
        target.kind === 'model'
          ? t('check.modelHeader', { label: modelLabel(config, target.id) })
          : t('check.collectionHeader', { collectionId: target.id })
      );
    }
    const report = await checkOne(config, target, { verifyFiles, download: doDownload });
    reports.push(report);
    printReport(report, { json, quiet });
  }

  if (json) {
    console.log(JSON.stringify(reports.length === 1 ? reports[0] : reports, null, 2));
  }

  if (args.flags.out) {
    const file = resolveUserPath(String(args.flags.out), config.root);
    writeJsonAtomic(file, reports.length === 1 ? reports[0] : reports);
    log(t('check.reportWritten', { file }));
  }

  const totalChanges = reports.reduce((sum, r) => sum + changedItems(r).length, 0);
  if (!doDownload) {
    if (totalChanges) log(t('check.changesFound', { count: totalChanges }));
    else log(t('check.noChanges'));
    return;
  }
  if (!totalChanges) {
    log(t('check.noDownloadChanges'));
    return;
  }

  let failed = 0;
  for (const report of reports) {
    const items = changedItems(report);
    if (!items.length) continue;
    // Versions whose files changed or are missing locally must have their record reset, otherwise the
    // download job skips them as already completed.
    //
    // 文件变化/本地缺失的版本必须重置记录，否则下载任务会把它当成「已完成」跳过
    const redownload = [...report.fileChanged, ...report.missing].map((r) => ({
      modelId: String(r.item.modelId),
      versionId: r.item.versionId === undefined || r.item.versionId === null ? null : String(r.item.versionId),
    }));
    const n = markForRedownload(config, redownload);
    if (n) log(t('check.stateReset', { count: n }));
    const summary = await runDownloadJob(config, {
      // Single-model reports use the model-<id> job label, collection reports their collection ID
      // 单模型报告用 model-<ID> 作为任务标签，收藏集报告用收藏集 ID
      collectionId: report.kind === 'model' ? `model-${report.modelId}` : report.collectionId,
      plan: items,
      outDir: config.outDir,
      force: false,
      jobs: config.jobs,
      attempts: config.downloadAttempts,
    });
    if (summary.error || summary.failed) failed++;
  }
  if (failed) process.exitCode = 1;
}

module.exports = { main, usage, fingerprint, diffWithPrevious, parseTargets, checkOne };
