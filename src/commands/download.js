'use strict';

const fs = require('fs');
const { log, resolveUserPath, readJson } = require('../util');
const { runDownloadJob, readQueue } = require('../job');
const { fetchModelDetail, fetchVersionMeta } = require('../api');
const { resolveOutDir } = require('../config');
const { dataPaths } = require('../storage');
const { parseCollectionId, parseModelRef, parseIdList } = require('../urls');
const { NotFoundError, ConfigError } = require('../errors');
const { t } = require('../i18n');

function usage() {
  console.error(t('download.usage'));
  process.exitCode = 1;
}

function parseVersionOverrides(raw) {
  if (!raw || raw === true) return null;
  const out = {};
  for (const pair of String(raw).split(',')) {
    const [modelId, versionId] = pair.split('=').map((s) => s && s.trim());
    if (!modelId || !versionId) {
      console.error(t('download.versionFormat', { pair }));
      process.exitCode = 1;
      return null;
    }
    out[modelId] = versionId;
  }
  return out;
}

function splitTypes(raw) {
  if (!raw || raw === true) return null;
  return String(raw)
    .split(',')
    .map((s) => s.trim())
    .filter(Boolean);
}

function commonOpts(config, args) {
  const versionOverrides = parseVersionOverrides(args.flags.version);
  if (versionOverrides === null && args.flags.version) return null;
  return {
    outDir: args.flags.out ? resolveOutDir(config, String(args.flags.out)) : config.outDir,
    force: !!args.flags.force,
    dryRun: !!args.flags['dry-run'],
    only: parseIdList(args.flags.only),
    versionOverrides: versionOverrides || {},
    jobs: args.flags.jobs ? Number(args.flags.jobs) : config.jobs,
    refreshMeta: !!args.flags['refresh-meta'],
    fileTypes: splitTypes(args.flags['file-types']) || config.fileTypes,
    primaryOnly: args.flags['no-primary'] ? false : config.primaryOnly,
    ignoreSpace: !!args.flags['ignore-space'],
    forceLock: !!args.flags['force-lock'],
    attempts: args.flags.attempts ? Number(args.flags.attempts) : config.downloadAttempts,
    quiet: !!args.flags.quiet,
    offline: !!args.flags.offline,
    resetState: !!args.flags['reset-state'],
    engine: args.flags.engine ? String(args.flags.engine) : undefined,
    dedup: args.flags.dedup ? String(args.flags.dedup) : undefined,
    notifyWebhook: args.flags.notify ? String(args.flags.notify) : undefined,
    notifyToast: args.flags.toast ? true : undefined,
  };
}

async function downloadCollection(config, args, collectionId, opts) {
  let items = null;
  if (args.flags.resume) {
    const queue = readQueue(config, collectionId);
    if (queue && queue.items.length) {
      items = queue.items;
      log(t('download.resumeRestored', { count: items.length, savedAt: queue.savedAt }));
    } else {
      log(t('download.resumeMissing'));
    }
  } else if (args.flags['from-cache']) {
    const cacheFile = dataPaths(config, collectionId).items;
    const cached = readJson(cacheFile, null);
    if (!cached || !Array.isArray(cached.items) || !cached.items.length) {
      throw new ConfigError(t('download.noCache', { file: cacheFile, id: collectionId }));
    }
    items = cached.items;
    log(t('download.usingCache', { count: items.length, fetchedAt: cached.fetchedAt || t('common.unknown') }));
  }
  return runDownloadJob(config, {
    ...opts,
    collectionId,
    items,
    resume: !!args.flags.resume,
  });
}

async function downloadModel(config, args, ref, opts) {
  const detail = await fetchModelDetail(config.site, ref.modelId, config.userAgent);
  const versions = detail.modelVersions || [];
  if (!versions.length) throw new NotFoundError(t('download.modelNoVersions', { modelId: ref.modelId }));

  const override = opts.versionOverrides[String(detail.id)];
  const wanted = ref.versionId || override || versions[0].id;
  const version = versions.find((v) => String(v.id) === String(wanted));
  if (!version) {
    throw new NotFoundError(t('download.modelVersionNotFound', { modelId: ref.modelId, versionId: wanted }));
  }

  const item = {
    modelId: detail.id,
    name: detail.name,
    type: detail.type,
    baseModel: version.baseModel,
    versionId: version.id,
    versionName: version.name,
    // Raw site objects: the job mirrors them into the library ("record everything")
    // 站点原始对象：下载流程会把它镜像进模型库（「记录所有信息」）
    versionMeta: version,
    modelMeta: detail,
  };
  const collectionId = `model-${detail.id}`;
  log(t('download.singleModel', { name: detail.name, version: version.name || version.id }));
  return runDownloadJob(config, { ...opts, collectionId, items: [item] });
}

/**
 * Reverse-lookup the model from a version ID (inputs such as version:<id> / ?modelVersionId=).
 * 由版本号反查模型（version:<id> / ?modelVersionId= 这类只给版本号的输入）
 */
async function resolveVersionRef(config, versionId) {
  const meta = await fetchVersionMeta(config.site, versionId, config.userAgent);
  const fromMeta = meta && meta.modelId !== undefined && meta.modelId !== null ? meta.modelId : null;
  const rawModelId = meta && meta.model ? meta.model.id : null;
  const fromModel = rawModelId !== undefined && rawModelId !== null ? rawModelId : null;
  const modelId = fromMeta !== null ? String(fromMeta) : fromModel !== null ? String(fromModel) : null;
  if (!modelId) throw new NotFoundError(t('download.versionNoModel', { versionId }));
  const name = (meta && meta.model && meta.model.name) || modelId;
  log(t('download.versionResolved', { versionId, name, modelId }));
  return { modelId, versionId: String(versionId) };
}

/**
 * One reference → one target (collection / single model); null when it cannot be recognized.
 * 单个引用 → 目标（收藏集 / 单模型），无法识别返回 null
 */
async function refToTarget(config, raw) {
  const collectionId = parseCollectionId(raw);
  if (collectionId) return { kind: 'collection', id: collectionId };
  const ref = parseModelRef(raw);
  if (!ref) return null;
  if (ref.modelId) {
    return { kind: 'model', ref: { modelId: String(ref.modelId), versionId: ref.versionId || null } };
  }
  if (ref.versionId) return { kind: 'model', ref: await resolveVersionRef(config, ref.versionId) };
  return null;
}

/**
 * --from-file: one reference per line; blank lines and # comments are ignored
 * (everything after # counts as a comment).
 *
 * --from-file：一行一个引用；忽略空行与 # 注释（# 之后的内容也算注释）
 */
function readRefsFromFile(config, file) {
  const full = resolveUserPath(String(file), config.root);
  let text;
  try {
    text = fs.readFileSync(full, 'utf8');
  } catch (e) {
    throw new ConfigError(t('download.fromFileError', { file: full, message: e.message }));
  }
  return text
    .split(/\r?\n/)
    .map((line) => line.replace(/#.*$/, '').trim())
    .filter(Boolean);
}

/**
 * Collect all targets: positional arguments, --collections, --model, --models, --from-file.
 * 汇总全部目标：位置参数、--collections、--model、--models、--from-file。
 * @returns {Promise<Array<object>|null>} null 表示参数有误（已打印提示）
 */
async function collectTargets(config, args) {
  const targets = [];
  const seen = new Set();
  const push = (target) => {
    const key =
      target.kind === 'collection'
        ? `c:${target.id}`
        : `m:${target.ref.modelId}:${target.ref.versionId || ''}`;
    if (seen.has(key)) return;
    seen.add(key);
    targets.push(target);
  };

  for (const positional of args.positionals) {
    const target = await refToTarget(config, positional);
    if (!target) {
      console.error(t('download.unrecognizedArg', { value: positional }));
      return null;
    }
    push(target);
  }

  for (const extra of parseIdList(args.flags.collections) || []) {
    const collectionId = parseCollectionId(extra);
    if (!collectionId) {
      console.error(t('download.badCollectionItem', { value: extra }));
      return null;
    }
    push({ kind: 'collection', id: collectionId });
  }

  if (args.flags.model) {
    const target = await refToTarget(config, args.flags.model);
    if (!target) {
      console.error(t('download.badModelFlag', { value: args.flags.model }));
      return null;
    }
    push(target);
  }

  if (args.flags.models) {
    const refs = parseIdList(args.flags.models) || [];
    for (const raw of refs) {
      const target = await refToTarget(config, raw);
      if (!target) {
        console.error(t('download.modelsBadItem', { value: raw }));
        return null;
      }
      push(target);
    }
  }

  if (args.flags['from-file']) {
    const refs = readRefsFromFile(config, args.flags['from-file']);
    if (!refs.length) {
      console.error(t('download.fromFileEmpty', { file: String(args.flags['from-file']) }));
      return null;
    }
    log(t('download.fromFileLoaded', { file: String(args.flags['from-file']), count: refs.length }));
    for (const raw of refs) {
      const target = await refToTarget(config, raw);
      if (!target) {
        console.error(t('download.modelsBadItem', { value: raw }));
        return null;
      }
      push(target);
    }
  }

  return targets;
}

async function main(config, args) {
  const targets = await collectTargets(config, args);
  if (!targets) return usage();
  if (!targets.length) return usage();

  const opts = commonOpts(config, args);
  if (!opts) return;

  let failed = 0;
  for (const target of targets) {
    const summary =
      target.kind === 'collection'
        ? await downloadCollection(config, args, target.id, opts)
        : await downloadModel(config, args, target.ref, opts);
    if (summary.error || summary.failed) failed++;
    if (summary.metaFailed) {
      log(t('download.metaFailedHint', { count: summary.metaFailed }));
    }
  }
  if (failed) process.exitCode = 1;
}

module.exports = {
  main,
  usage,
  parseVersionOverrides,
  collectTargets,
  readRefsFromFile,
  resolveVersionRef,
  refToTarget,
};
