'use strict';

/**
 * Main download job loop (shared by the CLI and the TUI).
 *
 * Key changes compared with the old implementation:
 *  - lazy metadata: completed entries are skipped instead of pulling metadata for the whole collection item by item;
 *  - concurrency: --jobs controls how many models are processed at once (files inside one model stay sequential);
 *  - one record per model: everything lives in .data/library.json (global lock + atomic writes + corruption protection);
 *  - collection snapshots: an enumeration writes .data/collections/<id>.json and reports membership changes;
 *  - layout directories: the folder comes from src/layout.js (preset + optional base-model layer), recorded dirName is always reused;
 *  - long paths: directory and file names are shortened to the Windows limit;
 *  - expired login: cookies are exported again automatically and the request is retried once;
 *  - resume list: on cancel a queue-<id>.json is saved so --resume can continue.
 *
 *
 * 下载任务主循环（CLI 与 TUI 共用）。
 *
 * 相比旧实现的关键变化：
 *  - 惰性元数据：已完成的条目直接跳过，不再为整个收藏集逐个拉元数据；
 *  - 并发：--jobs 控制同时处理的模型数（每个模型内部文件仍串行）；
 *  - 一模型一记录：全部落在 .data/library.json（全局锁 + 原子写 + 损坏保护）；
 *  - 收藏集快照：枚举后写入 .data/collections/<ID>.json 并报告成员变化；
 *  - 布局目录：目录由 src/layout.js 决定（预设 + 可选底模层），已记录的 dirName 永远复用；
 *  - 长路径：目录名与文件名按 Windows 上限自动缩短；
 *  - 登录态过期：自动重新导出 Cookie 并重试一次；
 *  - 断点清单：取消时保存 queue-<id>.json，便于 --resume 续跑。
 */

const fs = require('fs');
const path = require('path');
const {
  log,
  formatBytes,
  formatDuration,
  diskFileName,
  uniqueName,
  resolveUserPath,
  mapPool,
  readJson,
  writeJsonAtomic,
  ensureDir,
  applyRenames,
} = require('./util');
const { ensureBrowser, findSitePage, openUrl } = require('./browser');
const { fetchCollectionItems } = require('./collection');
const { buildPlan, fetchModelDetail, versionToItem } = require('./api');
const { exportCookies } = require('./cookies');
const { checkCurl, downloadFile, resetCancel, isCancelError } = require('./downloader');
const {
  dataPaths,
  readLibrary,
  writeLibrary,
  writeCollection,
  cleanupLegacy,
  upsertVersion,
  getVersion,
  versionIds,
  entryVersions,
  acquireLock,
  createRunLogger,
} = require('./storage');
const layout = require('./layout');
const { sameManifest } = require('./manifest');
const { createDedupIndex } = require('./dedup');
const { notifyFinished } = require('./notify');
const { AuthError } = require('./errors');
const { t } = require('./i18n');

/**
 * Free space on the volume holding the directory, in bytes; null when it cannot be determined.
 * 目录所在卷的剩余空间（字节），无法判断时返回 null。
 */
function freeSpaceBytes(dir) {
  try {
    if (typeof fs.statfsSync === 'function') {
      const st = fs.statfsSync(dir);
      return Number(st.bavail) * Number(st.bsize);
    }
  } catch (e) {
    // Old Node version or an unusual file system
    // 老版本 Node 或异常文件系统
  }
  return null;
}

/**
 * Read the resume list (the remaining items saved at the last cancel).
 * 读取断点清单（上次取消时保存的剩余项）。
 */
function readQueue(config, collectionId) {
  const file = dataPaths(config, collectionId).queue;
  const data = readJson(file, null);
  if (!data || !Array.isArray(data.items) || !data.items.length) return null;
  return data;
}

function clearQueue(config, collectionId) {
  try {
    fs.rmSync(dataPaths(config, collectionId).queue, { force: true });
  } catch (e) {
    // Ignore any failure while deleting the queue file
    // 删除队列文件失败时忽略
  }
}

/**
 * Run one download job.
 * 执行一次下载任务。
 * @param {object} config
 * @param {object} opts
 * @param {object} [hooks]
 */
async function runDownloadJob(config, opts, hooks = {}) {
  /**
   * Dependency injection point: real implementations by default; tests may replace them wholesale (browser, curl, network).
   * 依赖注入点：默认使用真实实现；测试可整体替换（浏览器、curl、网络）。
   */
  const deps = {
    ensureBrowser,
    fetchCollectionItems,
    buildPlan,
    fetchModelDetail,
    versionToItem,
    exportCookies,
    checkCurl,
    downloadFile,
    findSitePage,
    openUrl,
    notify: notifyFinished,
    ...(opts.deps || {}),
  };
  const collectionId = String(opts.collectionId);
  const force = !!opts.force;
  const dryRun = !!opts.dryRun;
  const refreshMeta = !!opts.refreshMeta;
  const jobs = Math.max(1, Math.min(Number(opts.jobs) || Number(config.jobs) || 1, 8));
  const isCancelled = opts.isCancelled || (() => false);
  const fileTypes = opts.fileTypes && opts.fileTypes.length ? opts.fileTypes : undefined;
  const primaryOnly = opts.primaryOnly !== false;

  deps.checkCurl();
  resetCancel();

  const logger = createRunLogger(config, collectionId, {
    sink: hooks.log || log,
    maxBytes: Number(config.logMaxBytes) || undefined,
  });
  const logFn = (m) => logger.log(m);

  const outDir = resolveUserPath(opts.outDir || config.outDir, config.root);
  const paths = dataPaths(config, collectionId);
  const summary = {
    collectionId,
    logFile: logger.logFile,
    outDir,
    cancelled: false,
    empty: false,
    error: null,
    done: 0,
    skipped: 0,
    failed: 0,
    metaFailed: 0,
    plan: [],
    totalBytes: 0,
    remaining: 0,
    elapsedMs: 0,
  };

  const lock = acquireLock(config, { force: !!opts.forceLock });
  let browser = null;
  let libraryRead;
  try {
    libraryRead = readLibrary(config, { allowCorrupt: !!opts.resetState });
  } catch (e) {
    lock.release();
    throw e;
  }

  const entries = libraryRead.entries;
  const completedIds = new Set();

  try {
    logFn(t('job.start', { collectionId, outDir }));
    if (libraryRead.corrupt) {
      logFn(t('job.corruptWarning', { message: libraryRead.corrupt.message }));
      logFn(t('job.resetStateNotice'));
    } else if (!libraryRead.exists) {
      // First run of the new format: the old per-target files are ignored and parked in .data/legacy
      // 新格式首次运行：旧的「按目标分文件」产物一律忽略，移入 .data/legacy
      cleanupLegacy(config, logFn);
    }

    // A browser is only needed to enumerate a collection or to (re-)export cookies. When the caller
    // already provides the items/plan and a cookie file exists, downloads run browser-free.
    //
    // 只有在「需要枚举收藏集」或「需要导出 Cookie」时才启动浏览器；
    // 调用方已给出条目/计划且 Cookie 文件存在时，下载全程不碰浏览器。
    const hasCookies = fs.existsSync(config.cookiesFile);
    const needsEnumerate = !(opts.plan || opts.items);
    const needsBrowser = !opts.offline && (needsEnumerate || !hasCookies);
    if (needsBrowser) {
      browser = await deps.ensureBrowser(config);
    } else {
      logFn(t('job.browserSkipped'));
    }

    // ---------------------------------------------------------------------
    // 1) Decide which version to download for each item (no network needed)
    // 1) 决定每一项要下载哪个版本（无需网络）
    // ---------------------------------------------------------------------
    let items = opts.plan || opts.items;
    if (!items && opts.offline) {
      throw new AppError(t('job.offlineNeedsPlan'));
    }
    if (!items) {
      items = await deps.fetchCollectionItems(browser, config.site, collectionId, {
        trpcPath: config.trpcPath,
        trpcInput: config.trpcInput,
        onLog: logFn,
      });
      // A collection is only a membership list: remember it (with the change report) as soon as
      // the enumeration succeeded, so `check <id>` can compare against it without a browser.
      //
      // 收藏集只是成员清单：枚举成功就立刻记下来（含变化报告），
      // 这样 `check <收藏集ID>` 不必开浏览器即可比对。
      const snapshot = writeCollection(config, collectionId, { items });
      const changes = snapshot.changes || { added: [], removed: [], versionChanged: [] };
      logFn(
        t('job.snapshotSaved', {
          collectionId,
          count: snapshot.items.length,
          added: changes.added.length,
          removed: changes.removed.length,
          versionChanged: changes.versionChanged.length,
        })
      );
      if (opts.only && opts.only.length) {
        const before = items.length;
        items = items.filter((it) => opts.only.some((v) => String(it.modelId) === v || String(it.versionId) === v));
        logFn(t('job.onlyFiltered', { before, after: items.length }));
        if (!items.length) {
          logFn(t('job.onlyNoMatch'));
          summary.error = 'no-only-match';
          return summary;
        }
      }
    }
    if (!items.length) {
      logFn(t('job.emptyCollection'));
      summary.empty = true;
      return summary;
    }

    const overrides = opts.versionOverrides || {};
    const skippedItems = [];
    const needDefault = [];
    const needOverride = [];
    const prePlanned = [];

    for (const item of items) {
      const prev = entries[item.modelId];
      const pin = prev && prev.pinnedVersionId ? String(prev.pinnedVersionId) : null;
      const overrideId = overrides[String(item.modelId)] ? String(overrides[String(item.modelId)]) : null;
      const wanted = overrideId || pin;
      const collectionVersion =
        item.versionId === undefined || item.versionId === null ? null : String(item.versionId);
      const effectiveVersionId = wanted || collectionVersion;

      // Completion is judged per version; other versions of the same model are unaffected
      // 按「版本」判断是否已完成；同一模型的其它版本不受影响
      const recorded = getVersion(prev, effectiveVersionId);
      const upToDate = !force && !refreshMeta && !dryRun && !!recorded && recorded.files.length > 0;

      if (upToDate) {
        skippedItems.push({ ...item, skipped: true, files: [], totalBytes: 0 });
        continue;
      }
      if (prev && effectiveVersionId && !recorded) {
        const known = versionIds(prev);
        if (known.length) {
          logFn(
            t('job.versionAdded', {
              name: item.name,
              to: effectiveVersionId,
              from: known.join('/'),
            })
          );
        }
      }

      // When the caller already supplied a full plan (TUI / check --download / verify --repair),
      // the item carries its own file list, so use it directly and do not fetch metadata again.
      //
      // 调用方已给出完整计划（TUI / check --download / verify --repair）时，
      // 条目自带文件清单，直接使用，不再重复拉元数据。
      const hasFiles = Array.isArray(item.files) && item.files.length > 0;
      const versionMatches =
        !wanted || !item.versionId || String(item.versionId) === String(wanted);
      if (hasFiles && versionMatches) {
        prePlanned.push(item);
        continue;
      }

      if (wanted && wanted !== collectionVersion) {
        needOverride.push({ item, versionId: wanted, source: overrideId ? '--version' : 'pin' });
      } else {
        needDefault.push(item);
      }
    }

    // ---------------------------------------------------------------------
    // 2) Fetch metadata only for the items that need downloading (concurrent)
    // 2) 只为需要下载的条目获取元数据（并发）
    // ---------------------------------------------------------------------
    let defaultPlan = prePlanned.slice();
    if (needDefault.length) {
      logFn(
        t('job.fetchingMeta', {
          count: needDefault.length,
          concurrency: config.metaConcurrency || 4,
        })
      );
      const built = await deps.buildPlan(config.site, needDefault, config.userAgent, {
        concurrency: config.metaConcurrency,
        fileTypes,
        primaryOnly,
        onLog: logFn,
      });
      defaultPlan = built.plan;
    }

    let overridePlan = [];
    if (needOverride.length) {
      logFn(t('job.resolvingVersions', { count: needOverride.length }));
      overridePlan = await mapPool(needOverride, config.metaConcurrency || 4, async ({ item, versionId, source }) => {
        try {
          const detail = await deps.fetchModelDetail(config.site, item.modelId, config.userAgent);
          const version = (detail.modelVersions || []).find((v) => String(v.id) === String(versionId));
          if (!version) throw new Error(t('job.versionNotFound', { versionId }));
          const mapped = deps.versionToItem(config.site, version, { fileTypes, primaryOnly });
          if (!mapped.files.length) throw new Error(t('job.versionNoFiles'));
          logFn(
            t('job.versionOverride', {
              source,
              name: item.name,
              version: mapped.versionName || mapped.versionId,
            })
          );
          const totalBytes = mapped.files.reduce((sum, f) => sum + f.bytes, 0);
          return { ...item, ...mapped, totalBytes };
        } catch (e) {
          return { ...item, error: t('job.versionOverrideFailed', { message: e.message }) };
        }
      });
      for (const key of Object.keys(overrides)) {
        if (!items.some((it) => String(it.modelId) === key)) {
          logFn(t('job.versionOverrideIgnored', { modelId: key }));
        }
      }
    }

    // Merge back into the original order
    // 合并回原始顺序
    const byModelId = new Map();
    for (const p of defaultPlan) byModelId.set(String(p.modelId), p);
    for (const p of overridePlan) byModelId.set(String(p.modelId), p);
    const skippedById = new Map(skippedItems.map((s) => [String(s.modelId), s]));
    const plan = items.map(
      (it) =>
        byModelId.get(String(it.modelId)) || skippedById.get(String(it.modelId)) || { ...it, error: t('job.noMetadata') }
    );

    // ---------------------------------------------------------------------
    // 3) --refresh-meta: after metadata is fetched, still skip when the content really is unchanged (avoid pointless re-downloads)
    // 3) --refresh-meta：元数据取回后，内容确实没变就仍然跳过（避免无谓重下）
    // ---------------------------------------------------------------------
    if (refreshMeta && !force && !dryRun) {
      for (const p of plan) {
        if (p.error || p.skipped) continue;
        const recorded = getVersion(entries[p.modelId], p.versionId);
        if (recorded && recorded.files.length && sameManifest(recorded.files, p.files)) {
          p.skipped = true;
          logFn(t('job.contentUnchanged', { name: p.name }));
        }
      }
    }

    summary.plan = plan;
    summary.skipped = plan.filter((p) => p.skipped).length;
    summary.metaFailed = plan.filter((p) => p.error).length;
    summary.totalBytes = plan
      .filter((p) => !p.error && !p.skipped)
      .reduce((sum, p) => sum + (p.totalBytes || 0), 0);

    logFn(
      t('job.planSummary', {
        todo: plan.filter((p) => !p.error && !p.skipped).length,
        skipped: summary.skipped,
        total: formatBytes(summary.totalBytes),
      })
    );
    for (const p of plan.filter((p) => p.error)) {
      logFn(t('job.metaFailedItem', { name: p.name, error: p.error }));
    }
    if (hooks.onPlan) hooks.onPlan(plan, summary.totalBytes);

    if (dryRun) {
      for (const p of plan) {
        if (p.error) continue;
        for (const f of p.files) {
          logFn(t('job.planLine', { name: p.name, file: f.name, size: formatBytes(f.bytes) }));
        }
      }
      logFn(t('job.dryRunDone'));
      return summary;
    }

    const todo = plan.filter((p) => !p.error && !p.skipped);
    if (!todo.length) {
      logFn(t('job.nothingToDownload'));
      summary.elapsedMs = logger.elapsedMs();
      logFn(
        t('job.summary', {
          head: t('job.headDone'),
          done: 0,
          skipped: summary.skipped,
          failed: summary.failed,
          metaFailed: summary.metaFailed ? t('job.summaryMetaSuffix', { count: summary.metaFailed }) : '',
          elapsed: formatDuration(summary.elapsedMs / 1000),
        })
      );
      if (!summary.metaFailed) clearQueue(config, collectionId);
      return summary;
    }

    // ---------------------------------------------------------------------
    // 4) Disk space pre-check
    // 4) 磁盘空间预检
    // ---------------------------------------------------------------------
    ensureDir(outDir);
    const free = freeSpaceBytes(outDir);
    if (free !== null && summary.totalBytes > free) {
      logFn(
        t('job.insufficientSpace', {
          total: formatBytes(summary.totalBytes),
          dir: outDir,
          free: formatBytes(free),
        })
      );
      logFn(t('job.insufficientSpaceHint'));
      if (!opts.ignoreSpace) {
        summary.error = 'insufficient-space';
        return summary;
      }
    }

    // ---------------------------------------------------------------------
    // 5) Export cookies (used for downloads)
    // 5) 导出 Cookie（下载用）
    // ---------------------------------------------------------------------
    let cookies;
    if (opts.offline || !browser) {
      if (!fs.existsSync(config.cookiesFile)) {
        throw new AuthError(t('job.offlineNoCookies', { file: config.cookiesFile }));
      }
      logFn(t('job.offlineUsingCookies', { file: config.cookiesFile }));
      cookies = { length: t('job.unknownCookieCount') };
    } else {
      const sitePage =
        (await deps.findSitePage(browser, config.site)) ||
        (await deps.openUrl(browser, `${config.site}/collections/${collectionId}`));
      cookies = await deps.exportCookies(sitePage, config.cookiesFile, { site: config.site });
      logFn(t('job.cookiesExported', { count: cookies.length, file: config.cookiesFile }));
    }

    let authRefreshed = false;
    async function refreshCookies() {
      authRefreshed = true;
      const page = (await deps.findSitePage(browser, config.site)) || (await deps.openUrl(browser, config.site));
      cookies = await deps.exportCookies(page, config.cookiesFile, { site: config.site });
      return cookies.length;
    }

    // Cross-collection content dedup (off by default; enable through config.dedup or --dedup)
    // 跨收藏集内容去重（默认 off，可通过 config.dedup 或 --dedup 开启）
    const dedupRequested = String(opts.dedup || config.dedup || 'off').toLowerCase();
    const dedupMode = ['hardlink', 'copy'].includes(dedupRequested) ? dedupRequested : 'off';
    const dedupIndex = dedupMode === 'off' ? null : createDedupIndex(config);
    if (dedupMode !== 'off') {
      logFn(
        t('job.dedupEnabled', {
          mode: dedupMode === 'hardlink' ? t('job.modeHardlink') : t('job.modeCopy'),
        })
      );
    }

    // ---------------------------------------------------------------------
    // 6) Directory name allocation (stable + collision-free + long paths)
    // 6) 目录名分配（稳定 + 防碰撞 + 长路径）
    // ---------------------------------------------------------------------

    // Directory names already taken per download root (with the owner), so a new model never lands
    // on another model's directory while every model keeps sharing one directory across its versions.
    //
    // 每个下载根下已占用的目录名（含归属），既避免新模型占用别人的目录，
    // 又保证同一模型的所有版本共用同一个目录。
    const allocations = new Map();
    for (const [ownerId, entry] of Object.entries(entries)) {
      for (const v of entryVersions(entry)) {
        if (v && v.dirName && v.outDir) {
          const key = String(v.outDir).toLowerCase();
          if (!allocations.has(key)) allocations.set(key, new Map());
          allocations.get(key).set(String(v.dirName).toLowerCase(), { name: String(v.dirName), owner: String(ownerId) });
        }
      }
    }

    /**
     * Decide which directory a version goes into:
     *  - the version was recorded before → reuse the original directory (stable, no move just because a new version appeared);
     *  - otherwise the layout path (type folder + optional base-model layer + model title); versions that share a
     *    base model also share the directory, and a name clash between them is solved per file (see planFileNames);
     *  - versions whose base model differs get one directory per base model, so tools pick up the right files.
     *
     * 决定某个版本落在哪个目录：
     *  - 该版本已记录过 → 复用原目录（稳定，不会因为新增版本而搬家）
     *  - 否则用布局路径（类型目录 + 可选底模层 + 模型标题）；同一底模的版本共用该目录，
     *    它们之间的文件名冲突按文件解决（见 planFileNames）
     *  - 底模不同的版本会按底模各放一处，便于工具按底模取用
     */
    function dirFor(item, versionId) {
      const parent = item.outDirOverride ? resolveUserPath(item.outDirOverride, config.root) : outDir;
      const prev = entries[item.modelId];
      const recorded = getVersion(prev, versionId);
      if (recorded && recorded.dirName) return { parent: recorded.outDir || parent, dirName: recorded.dirName };

      const key = parent.toLowerCase();
      if (!allocations.has(key)) allocations.set(key, new Map());
      const taken = allocations.get(key);

      const wantBase = config.baseModelLayer ? layout.baseModelFolder(item.baseModel) : '';
      const siblings = entryVersions(prev).filter(
        (v) =>
          v.dirName &&
          v.outDir &&
          String(v.outDir).toLowerCase() === key &&
          // Only a sibling with the same base-model folder may donate its directory.
          // 只有「同一底模层」的同级版本可以复用目录。
          (config.baseModelLayer ? layout.baseModelFolder(v.baseModel) === wantBase : true)
      );
      // A sibling already recorded the shared directory of this model (same base model), so keep using it
      // 同级目录已经记录了该模型（同一底模）的共用目录，继续沿用
      const baseDir = siblings.length
        ? siblings.map((v) => String(v.dirName)).sort((a, b) => a.length - b.length)[0]
        : layout.composeDirName({
            name: item.name,
            type: item.type,
            baseModel: item.baseModel,
            layout: config.layout,
            customMap: config.typeFolders,
            baseModelLayer: config.baseModelLayer,
          });
      const fitted = layout.fitDirName(parent, baseDir, item.modelId);
      // Only *other* models block a directory name; the model's own directory must stay reusable
      // 只有「别的模型」会占用目录名；本模型自己的目录始终可复用
      const others = [...taken.values()].filter((info) => info.owner !== String(item.modelId)).map((info) => info.name);
      const chosen = others.some((name) => name.toLowerCase() === fitted.toLowerCase())
        ? uniqueName(fitted, others)
        : fitted;
      taken.set(chosen.toLowerCase(), { name: chosen, owner: String(item.modelId) });
      return { parent, dirName: chosen };
    }

    /**
     * Version records of the *other* versions that already live in the same directory (used to detect
     * name clashes between versions of one model).
     *
     * 同一目录里「其它版本」的版本记录（用于判断同模型不同版本之间的文件名冲突）。
     */
    function siblingVersionsFor(item, parent, dirName) {
      const prev = entries[item.modelId];
      const out = [];
      for (const [versionId, rec] of Object.entries((prev && prev.versions) || {})) {
        if (String(versionId) === String(item.versionId)) continue;
        if (String(rec.outDir || '').toLowerCase() !== String(parent).toLowerCase()) continue;
        if (String(rec.dirName || '') !== String(dirName)) continue;
        out.push({ versionId, versionName: rec.versionName, files: rec.files || [] });
      }
      return out;
    }

    // ---------------------------------------------------------------------
    // 7) Download item by item (concurrency = jobs)
    // 7) 逐项下载（并发 = jobs）
    // ---------------------------------------------------------------------
    let writeChain = Promise.resolve();
    function persistState() {
      writeChain = writeChain
        .then(() => writeLibrary(config, entries))
        .catch((e) => logFn(t('job.stateWriteFailed', { message: e.message })));
      return writeChain;
    }

    async function downloadItem(item, index, total) {
      if (isCancelled()) return;
      // Takes effect when the user pressed s in the TUI to request a skip (an unconsumed request skips the whole model)
      // 用户在 TUI 中按 s 请求跳过时生效（未消费的请求会跳过整个模型）
      if (opts.shouldSkipItem && opts.shouldSkipItem(item)) {
        summary.skipped++;
        logFn(t('job.itemSkipped', { name: item.name }));
        if (hooks.onItemDone) hooks.onItemDone(item, false, 'skipped');
        return;
      }
      const { parent, dirName } = dirFor(item, item.versionId);
      const dir = path.join(parent, dirName);
      ensureDir(dir);
      if (hooks.onItemStart) hooks.onItemStart(item, index, total);

      const startedAt = Date.now();
      const fileManifest = [];
      let itemOk = true;
      let skippedByUser = false;
      let cancelledBeforeStart = false;

      // One directory per model: when a file name is already taken by another version with different
      // content, BOTH sides are renamed with their own "-<version>" suffix, so a file name always
      // maps to a version. Same content is not a clash (the existing file is verified and reused).
      //
      // 一个模型一个目录：若某个文件名已被「内容不同的其它版本」占用，
      // 则双方都加上各自的 "-<版本>" 后缀，让文件名能对应到版本；
      // 内容相同不算冲突（复用已存在的文件并校验）。
      const planned = layout.planFileNames({
        dir,
        version: { versionId: item.versionId, versionName: item.versionName, files: item.files },
        entries: siblingVersionsFor(item, parent, dirName),
      });
      if (planned.renames.length) {
        // Rename the old files first (and update their records) so the plain names are free again
        // 先改旧文件（并同步记录），把原始文件名释放出来
        const applied = applyRenames({ dir, renames: planned.renames });
        const prevEntry = entries[item.modelId];
        for (const rename of applied) {
          const rec = prevEntry && prevEntry.versions && prevEntry.versions[String(rename.versionId)];
          if (!rec) continue;
          for (const f of rec.files) if (f.name === rename.from) f.name = rename.to;
        }
        if (applied.length) {
          logFn(t('job.filesRenamed', { count: applied.length, name: item.name }));
          await persistState();
        }
      }
      const names = planned.names;
      if (planned.suffixMode) {
        logFn(t('job.versionSuffix', { name: item.name, version: layout.versionLabel(item.versionName, item.versionId) }));
      }

      for (let fileIndex = 0; fileIndex < item.files.length; fileIndex++) {
        const f = item.files[fileIndex];
        if (isCancelled()) {
          // The cancel happened before this model started: count neither done nor failed, leave it to the resume list
          // 取消发生在本模型开始之前：不计完成也不计失败，留给断点清单
          cancelledBeforeStart = true;
          itemOk = false;
          break;
        }
        if (opts.shouldSkipItem && opts.shouldSkipItem(item)) {
          skippedByUser = true;
          itemOk = false;
          break;
        }
        const resolved = names[fileIndex] || {
          remoteName: f.name || null,
          diskName: diskFileName(dir, f.name),
          renamed: false,
        };
        const diskName = resolved.diskName;
        try {
          logFn(
            t('job.downloadLine', {
              index,
              total,
              name: item.name,
              file: f.name,
              size: formatBytes(f.bytes),
            })
          );
          if (hooks.onFileStart) hooks.onFileStart(item, f, dir);

          const targetPath = path.join(dir, diskName);
          let status;
          let deduped = false;

          // Content dedup: when the same content already exists locally, link/copy it instead of downloading again
          // 内容去重：本机已有同样的内容就直接链接/复制，省一次下载
          if (dedupIndex && !force && f.sha256 && !fs.existsSync(targetPath)) {
            const source = await dedupIndex.findSource(f.sha256, f.bytes, targetPath);
            if (source) {
              try {
                const how = dedupIndex.materialize(source, targetPath, dedupMode);
                deduped = true;
                logFn(
                  t('job.dedupLine', {
                    mode: how === 'hardlink' ? t('job.modeHardlink') : t('job.modeCopy'),
                    file: f.name,
                    source,
                  })
                );
              } catch (e) {
                logFn(t('job.dedupFailed', { message: e.message, file: f.name }));
              }
            }
          }

          try {
            if (deduped) {
              status = 'deduped';
            } else {
              const runOnce = () =>
                deps.downloadFile({
                  url: f.downloadUrl,
                  cookieFile: config.cookiesFile,
                  dir,
                  fileName: diskName,
                  expectedSha256: f.sha256,
                  expectedBytes: f.bytes,
                  userAgent: config.userAgent,
                  force,
                  quiet: opts.quiet,
                  proxy: config.proxy,
                  attempts: opts.attempts,
                  engine: opts.engine || config.engine,
                  onAttempt: hooks.onAttempt,
                });

              try {
                status = await runOnce();
              } catch (e) {
                // Refreshing cookies needs a browser; in browser-free mode the error surfaces as is.
                // 重新导出 Cookie 需要浏览器；无浏览器模式下直接抛出原始错误。
                if (e instanceof AuthError && !authRefreshed && browser) {
                  logFn(t('job.authRefreshing'));
                  const n = await refreshCookies();
                  logFn(t('job.cookiesRefreshed', { count: n }));
                  status = await runOnce();
                } else {
                  throw e;
                }
              }
            }
          } catch (e) {
            if (isCancelError(e)) {
              summary.cancelled = true;
              itemOk = false;
              logFn(t('job.cancelNotice'));
              break;
            }
            itemOk = false;
            logFn(t('job.fileFailed', { file: f.name, message: e.message }));
            if (hooks.onFileDone) hooks.onFileDone(item, f, 'failed');
            break;
          }

          if (dedupIndex && f.sha256) dedupIndex.remember(targetPath, f.sha256, f.bytes);
          logFn(
            status === 'verified'
              ? t('job.fileVerified', { file: f.name })
              : status === 'deduped'
                ? t('job.fileDeduped', { file: f.name })
                : t('job.fileDownloaded', { file: f.name })
          );
          fileManifest.push({
            fileId: f.fileId === undefined ? null : f.fileId,
            name: diskName,
            remoteName: resolved.remoteName,
            sha256: f.sha256 || null,
            bytes: f.bytes || null,
            downloadUrl: f.downloadUrl || null,
          });
          if (hooks.onFileDone) hooks.onFileDone(item, f, status);
        } catch (e) {
          if (isCancelError(e)) {
            summary.cancelled = true;
            itemOk = false;
            logFn(t('job.cancelNotice'));
            break;
          }
          itemOk = false;
          logFn(t('job.fileFailed', { file: f.name, message: e.message }));
          if (hooks.onFileDone) hooks.onFileDone(item, f, 'failed');
          break;
        }
      }

      // The current file was killed (summary.cancelled) or the model was cancelled before it started:
      // record no completion and no failure, and let the resume list continue next time.
      // Note: when only isCancelled() is true but every file has already been downloaded, completion must still be recorded to avoid wasted downloads.
      //
      // 当前文件被 kill（summary.cancelled）或该模型还没开始就被取消：
      // 不记录完成也不计为失败，交给断点清单下次继续。
      // 注意：仅 isCancelled() 为真但文件已全部下完时，仍应记录完成，避免白下。
      if (summary.cancelled || cancelledBeforeStart) return;

      const prev = entries[item.modelId];
      if (itemOk) {
        // Merge the file list inside one version (e.g. a partial "repair broken files only" download must not drop the records of other files);
        // different versions are recorded separately and never overwrite each other.
        //
        // 同一版本内合并文件清单（例如「只修复坏文件」的局部下载不应丢掉其它文件的记录）；
        // 不同版本各自独立记录，互不覆盖。
        const recorded = getVersion(prev, item.versionId);
        const byName = new Map();
        if (recorded && Array.isArray(recorded.files)) {
          for (const f of recorded.files) byName.set(f.name, f);
        }
        for (const f of fileManifest) byName.set(f.name, f);
        upsertVersion(entries, item.modelId, {
          name: item.name,
          type: item.type,
          baseModel: item.baseModel,
          model: item.modelMeta || null,
          site: item.versionMeta || null,
          versionId: item.versionId,
          versionName: item.versionName,
          dirName,
          outDir: parent,
          files: [...byName.values()],
          pinnedVersionId: prev ? prev.pinnedVersionId : null,
        });
        completedIds.add(String(item.modelId));
        summary.done++;
        await persistState();
        logger.trace(`完成 ${item.name}，用时 ${formatDuration((Date.now() - startedAt) / 1000)}`);
        logFn(
          t('job.itemDone', {
            name: item.name,
            done: summary.done,
            skipped: summary.skipped,
            failed: summary.failed,
          })
        );
        if (hooks.onItemDone) hooks.onItemDone(item, true, 'done');
      } else if (skippedByUser) {
        completedIds.add(String(item.modelId));
        summary.skipped++;
        logFn(t('job.itemSkipped', { name: item.name }));
        if (hooks.onItemDone) hooks.onItemDone(item, false, 'skipped');
      } else {
        completedIds.add(String(item.modelId));
        summary.failed++;
        if (hooks.onItemDone) hooks.onItemDone(item, false, 'failed');
      }
    }

    const ordered = todo.map((item, i) => ({ item, index: i + 1 }));
    await mapPool(ordered, jobs, async ({ item, index }) => {
      if (isCancelled()) return;
      await downloadItem(item, index, ordered.length);
    });

    // A cancel may happen between two models (no CancelError is thrown then), so mark it here,
    // otherwise the run would look like a normal finish and the resume list would be deleted.
    //
    // 取消可能发生在两个模型之间（此时不会抛 CancelError），这里补上标记，
    // 否则会被当成正常结束而清掉断点清单。
    if (isCancelled()) summary.cancelled = true;

    await writeChain;
    if (dedupIndex) dedupIndex.save();

    // ---------------------------------------------------------------------
    // 8) Wrap-up: resume list + summary
    // 8) 收尾：断点清单 + 汇总
    // ---------------------------------------------------------------------
    const remaining = todo.filter((p) => !completedIds.has(String(p.modelId)));
    summary.remaining = remaining.length;
    if (summary.cancelled && remaining.length) {
      try {
        writeJsonAtomic(paths.queue, {
          collectionId,
          savedAt: new Date().toISOString(),
          outDir,
          items: remaining.map((p) => ({
            modelId: p.modelId,
            name: p.name,
            type: p.type,
            baseModel: p.baseModel,
            versionId: p.versionId,
            versionName: p.versionName,
            files: p.files,
            totalBytes: p.totalBytes,
          })),
        });
        logFn(t('job.queueSaved', { count: remaining.length, file: paths.queue }));
      } catch (e) {
        logFn(t('job.queueSaveFailed', { message: e.message }));
      }
    } else if (!summary.cancelled) {
      clearQueue(config, collectionId);
    }

    summary.elapsedMs = logger.elapsedMs();
    const head = summary.cancelled ? t('job.headCancelled') : t('job.headDone');
    logFn(
      t('job.summary', {
        head,
        done: summary.done,
        skipped: summary.skipped,
        failed: summary.failed,
        metaFailed: summary.metaFailed ? t('job.summaryMetaSuffix', { count: summary.metaFailed }) : '',
        elapsed: formatDuration(summary.elapsedMs / 1000),
      })
    );
    logFn(t('job.logFile', { file: logger.logFile }));
    return summary;
  } finally {
    // Job-finished notification (bell / system notification / webhook); a failure does not affect the result
    // 任务结束通知（响铃 / 系统通知 / Webhook），失败不影响结果
    if (!dryRun && (summary.done || summary.failed || summary.cancelled)) {
      try {
        await deps.notify(config, { ...summary, elapsedMs: summary.elapsedMs || logger.elapsedMs() }, {
          webhook: opts.notifyWebhook,
          toast: opts.notifyToast,
          log: logFn,
        });
      } catch (e) {
        logger.trace(`通知发送失败: ${e.message}`);
      }
    }
    lock.release();
    if (browser) await browser.disconnect().catch(() => {});
  }
}

module.exports = { runDownloadJob, freeSpaceBytes, readQueue, clearQueue };
