'use strict';

/**
 * Business actions of the web UI.
 *
 * Every function here is a plain async API call: it talks to the existing core modules (enumerate,
 * plan, download job, update check, verify, library, config, login) and returns JSON-friendly data.
 * The HTTP layer only does routing, so the same actions can be unit-tested without sockets.
 *
 * Long operations run as jobs (see `jobs.js`) and return `{job}` immediately; short ones answer
 * directly.
 *
 *
 * Web UI 的业务动作。
 *
 * 这里每个函数都是一次普通的异步 API 调用：它调用既有的核心模块（枚举、计划、下载任务、检查更新、
 * 校验、模型库、配置、登录）并返回可序列化的数据。HTTP 层只负责路由，因此这些动作可以在没有 socket
 * 的情况下单测。
 *
 * 耗时操作以任务形式运行（见 `jobs.js`）并立刻返回 `{job}`；短操作直接返回结果。
 */

const fs = require('fs');
const path = require('path');
const { spawn } = require('child_process');

const { loadConfig, saveConfig, validateConfig, resolveOutDir, KNOWN_KEYS } = require('../config');
const { configureRuntime, createSiteLimiter } = require('../runtime');
const { dataPaths, readLibrary, getVersion, listCollectionIds, readCollection, writeCollection } = require('../storage');
const { collectModels, filterModels, sortModels, forgetModels } = require('../commands/models');
const { verifyModels } = require('../commands/verify');
const { refToTarget } = require('../commands/download');
const doctor = require('../commands/doctor');
const {
  checkUpdates,
  checkModelUpdates,
  changedItems,
  applyPinsToItems,
  reportLines,
  summarize,
  markForRedownload,
  setPin,
} = require('../updater');
const { ensureBrowser } = require('../browser');
const { fetchCollectionItems } = require('../collection');
const { buildPlan, fetchModelDetail, extractFiles, versionToItem } = require('../api');
const { runDownloadJob, freeSpaceBytes } = require('../job');
const { cancelCurrentDownload } = require('../downloader');
const { performLogin, checkLogin } = require('../loginFlow');
const { writeJson } = require('../util');
const { t, setLanguage, getLanguage, availableLanguages } = require('../i18n');
const { createTracker } = require('./progress');

/**
 * Fields the settings page may write (a subset of the known keys: derived paths stay out).
 * 设置页允许写入的字段（已知键的子集：派生路径不在此列）。
 */
const SETTINGS_KEYS = [
  'site',
  'outDir',
  'chromePath',
  'debugPort',
  'userAgent',
  'jobs',
  'metaConcurrency',
  'apiRateLimit',
  'requestTimeoutMs',
  'retries',
  'downloadAttempts',
  'logMaxBytes',
  'proxy',
  'fileTypes',
  'engine',
  'dedup',
  'layout',
  'baseModelLayer',
  'primaryOnly',
  'notifyWebhook',
  'notifyToast',
  'language',
  'headless',
];

/**
 * Build an error the router can turn into a status code.
 * 构造一个路由层能转成状态码的错误。
 */
function httpError(status, message) {
  const error = new Error(message);
  error.status = status;
  return error;
}

/**
 * Normalise "one or many" into an array of non-empty strings.
 * 把「单个或多个」归一化成非空字符串数组。
 */
function toArray(value) {
  if (value === undefined || value === null) return [];
  const list = Array.isArray(value) ? value : [value];
  return list.map((v) => String(v).trim()).filter(Boolean);
}

/**
 * Split pasted model references: one per line or comma separated, `#` starts a comment, duplicates
 * are dropped (the same model+version twice would download the same file twice).
 *
 * 拆分粘贴进来的模型引用：一行一个或用逗号分隔，`#` 起注释，重复项会被去掉
 * （同一个模型+版本写两遍只会重复下载同一份文件）。
 *
 * @param {string|string[]|undefined} value
 * @returns {string[]}
 */
function normalizeRefs(value) {
  const raw = Array.isArray(value) ? value.join('\n') : String(value === undefined || value === null ? '' : value);
  const seen = new Set();
  const out = [];
  for (const piece of raw.split(/[\r\n,]+/)) {
    const ref = piece.replace(/#.*$/, '').trim();
    if (!ref || seen.has(ref)) continue;
    seen.add(ref);
    out.push(ref);
  }
  return out;
}

/**
 * Sum of one version's file sizes.
 * 某个版本的文件总大小。
 */
function versionBytes(version) {
  return (version.files || []).reduce((sum, file) => sum + (Number(file.bytes) || 0), 0);
}

/**
 * Create the action set.
 * 创建业务动作集合。
 *
 * @param {{
 *   config?:object,
 *   jobs:object,
 *   now?:() => number,
 *   log?:(line:string)=>void
 * }} opts
 * @returns {object}
 */
function createActions(opts = {}) {
  // The mutable current config: `/api/settings` replaces it after a reload.
  // 可变的当前配置：`/api/settings` 保存后会替换它。
  let config = opts.config || loadConfig();
  const jobs = opts.jobs;
  if (!jobs) throw new Error('createActions requires a jobs manager');
  const now = typeof opts.now === 'function' ? opts.now : () => Date.now();
  /**
   * Reloading after a settings write is injectable so tests can point at a temporary config.json
   * instead of the one in the working directory.
   *
   * 设置写回后的重新加载是可注入的，测试可以指向临时 config.json 而不是工作目录里的那份。
   */
  const loadConfigImpl = typeof opts.loadConfig === 'function' ? opts.loadConfig : () => loadConfig();

  // Resolver of the pending "I finished logging in" button.
  // 「我已完成登录」按钮对应的待决回调。
  let loginResolve = null;

  /**
   * Start a job or fail with 409 when another one is still running.
   * 启动任务；已有任务在跑时以 409 失败。
   */
  function startJob(meta, task) {
    const job = jobs.start(meta, task);
    if (!job) throw httpError(409, t('web.error.jobRunning'));
    return { job };
  }

  /**
   * Reload config.json after a settings write and re-apply runtime settings (language, API).
   * 设置写回后重新读取 config.json，并重新应用运行时设置（语言、API）。
   */
  function reload() {
    config = loadConfigImpl();
    configureRuntime(config);
    return config;
  }

  /**
   * Only the keys known to config.json (never the derived paths such as configFile/root).
   * 只取 config.json 认识的键（绝不包含 configFile/root 这类派生路径）。
   */
  function knownSubset(source) {
    const out = {};
    for (const key of KNOWN_KEYS) {
      if (source[key] !== undefined) out[key] = source[key];
    }
    return out;
  }

  /**
   * Light row for the library table (no file lists).
   * 模型库表格的轻量行（不含文件列表）。
   */
  function libraryRow(model) {
    const lastVerifiedAt = model.versions.reduce(
      (newest, v) => (String(v.verifiedAt || '') > newest ? String(v.verifiedAt || '') : newest),
      ''
    );
    return {
      modelId: model.modelId,
      name: model.name,
      type: model.type,
      baseModel: model.baseModel,
      versions: model.versions.length,
      totalBytes: model.totalBytes,
      pinnedVersionId: model.pinnedVersionId,
      dir: model.dir,
      lastVerifiedAt: lastVerifiedAt || null,
      corrupt: model.corrupt,
    };
  }

  /**
   * Shape of one version for the detail panel.
   * 详情面板里一个版本的结构。
   */
  function versionRow(version) {
    return {
      versionId: version.versionId,
      versionName: version.versionName,
      dir: version.outDir ? path.join(version.outDir, version.dirName || '') : null,
      files: (version.files || []).map((file) => ({
        name: file.name,
        bytes: file.bytes,
        sha256: file.sha256 || null,
      })),
      bytes: versionBytes(version),
      verifiedAt: version.verifiedAt || null,
    };
  }

  /**
   * Find one library model or fail with 404.
   * 找到模型库里的一个模型，否则以 404 失败。
   */
  function requireModel(modelId) {
    const wanted = String(modelId);
    const model = collectModels(config).find((m) => m.modelId === wanted);
    if (!model) throw httpError(404, t('web.error.modelNotFound', { modelId: wanted }));
    return model;
  }

  /**
   * Resolve a list of `{modelId, versionId}` references into full download plan items.
   *
   * Items that already carry a file list (coming from an update-check report) are used as they are,
   * so a "download what changed" click does not re-fetch metadata.
   *
   *
   * 把 `{modelId, versionId}` 引用补全成完整的下载计划项。
   *
   * 已带文件清单的项（来自检查更新报告）原样使用，因此「下载变化项」不会重复拉元数据。
   */
  async function resolvePlanItems(items, onLog) {
    const out = [];
    for (const item of items) {
      if (!item || item.modelId === undefined || item.modelId === null) continue;
      if (Array.isArray(item.files) && item.files.length) {
        out.push(item);
        continue;
      }
      const detail = await fetchModelDetail(config.site, item.modelId, config.userAgent);
      const versions = Array.isArray(detail.modelVersions) ? detail.modelVersions : [];
      const version =
        versions.find((v) => String(v.id) === String(item.versionId)) ||
        (item.versionId ? null : versions[0]);
      if (!version) {
        if (onLog) onLog(t('web.error.versionNotFound', { modelId: item.modelId, versionId: item.versionId }));
        continue;
      }
      const built = versionToItem(config.site, version, {
        fileTypes: config.fileTypes,
        primaryOnly: config.primaryOnly,
      });
      if (!built.files.length) {
        if (onLog) onLog(t('web.error.noFiles', { modelId: item.modelId }));
        continue;
      }
      out.push({
        ...built,
        modelId: detail.id,
        name: detail.name,
        type: detail.type,
        baseModel: version.baseModel,
        modelMeta: detail,
      });
    }
    return out;
  }

  /**
   * Turn pasted references (model URL / model:<id> / version:<id>) into `{modelId, versionId}`.
   *
   * The same resolver the CLI and TUI use, so a reference behaves identically in all three places;
   * a reference that cannot be recognised is logged and skipped instead of failing the whole batch.
   *
   *
   * 把粘贴进来的引用（模型页链接 / model:<id> / version:<id>）转成 `{modelId, versionId}`。
   *
   * 用的是 CLI 与 TUI 同一个解析器，因此同一条引用在三个入口行为一致；
   * 无法识别的引用会记一条日志后跳过，而不是让整批失败。
   */
  async function refsToItems(refs, onLog) {
    const out = [];
    for (const raw of refs) {
      let target = null;
      try {
        target = await refToTarget(config, raw);
      } catch (e) {
        if (onLog) onLog(t('web.error.badRef', { value: raw }));
        continue;
      }
      if (!target || target.kind !== 'model' || !target.ref || target.ref.modelId === undefined) {
        if (onLog) onLog(t('web.error.badRef', { value: raw }));
        continue;
      }
      out.push({ modelId: String(target.ref.modelId), versionId: target.ref.versionId || null });
    }
    return out;
  }

  /**
   * Detail of one collection snapshot: when it was enumerated, its members and what changed since
   * the previous enumeration.
   *
   * 某个收藏集快照的详情：枚举时间、成员，以及与上次枚举相比的变化。
   */
  function collectionDetail(collectionId) {
    const id = String(collectionId || '').trim();
    if (!/^\d+$/.test(id) || !listCollectionIds(config).includes(id)) {
      throw httpError(404, t('web.error.collectionNotFound', { id }));
    }
    const { snapshot } = readCollection(config, id, { allowCorrupt: true });
    if (!snapshot) throw httpError(404, t('web.error.collectionNotFound', { id }));
    const changes = snapshot.changes || { added: [], removed: [], versionChanged: [] };
    const pick = (item) => ({
      modelId: String(item.modelId),
      name: item.name || null,
      versionId: item.versionId === undefined || item.versionId === null ? null : String(item.versionId),
    });
    return {
      id,
      fetchedAt: snapshot.fetchedAt || null,
      count: snapshot.items.length,
      previousFetchedAt: changes.previousFetchedAt || null,
      members: snapshot.items.map(pick),
      changes: {
        added: (changes.added || []).map(pick),
        removed: (changes.removed || []).map(pick),
        versionChanged: (changes.versionChanged || []).map((item) => ({
          ...pick(item),
          // For a version change the useful target is the *new* version.
          // 版本变化的条目里，有意义的目标是「新版本」。
          versionId:
            item.toVersionId === undefined || item.toVersionId === null ? null : String(item.toVersionId),
        })),
      },
    };
  }

  // -------------------------------------------------------------------------
  // Read-only state
  // 只读状态
  // -------------------------------------------------------------------------

  /**
   * Everything the dashboard needs in one call.
   * 仪表盘需要的一切，一次调用返回。
   */
  function state() {
    const { entries, corrupt } = readLibrary(config, { allowCorrupt: true });
    const models = Object.keys(entries).length;
    let versions = 0;
    let bytes = 0;
    for (const entry of Object.values(entries)) {
      const list = entry && entry.versions && typeof entry.versions === 'object' ? Object.values(entry.versions) : [];
      versions += list.length;
      for (const version of list) bytes += versionBytes(version);
    }

    const collections = listCollectionIds(config).map((id) => {
      const { snapshot } = readCollection(config, id, { allowCorrupt: true });
      const changes = (snapshot && snapshot.changes) || { added: [], removed: [], versionChanged: [] };
      return {
        id: String(id),
        members: snapshot ? snapshot.items.length : 0,
        fetchedAt: (snapshot && snapshot.fetchedAt) || null,
        changes: {
          added: changes.added.length,
          removed: changes.removed.length,
          versionChanged: changes.versionChanged.length,
        },
      };
    });

    const outDir = resolveOutDir(config, config.outDir);
    return {
      site: config.site,
      outDir,
      root: config.root,
      configFile: config.configFile || null,
      loggedIn: fs.existsSync(config.cookiesFile),
      jobs: Number(config.jobs) || 1,
      metaConcurrency: Number(config.metaConcurrency) || 1,
      engine: config.engine,
      dedup: config.dedup,
      layout: config.layout,
      language: getLanguage(),
      platform: `${process.platform} ${process.arch}`,
      node: process.version,
      appVersion: version(),
      library: { models, versions, bytes, corrupt: corrupt ? corrupt.message : null },
      collections,
      disk: { dir: outDir, free: freeSpaceBytes(outDir) },
      warnings: config.warnings || [],
      activeJob: jobs.active(),
    };
  }

  /**
   * Package version, read once (shown in the header).
   * 包版本，只读一次（显示在标题栏）。
   */
  let cachedVersion = null;
  function version() {
    if (cachedVersion !== null) return cachedVersion;
    try {
      const pkg = JSON.parse(fs.readFileSync(path.join(__dirname, '..', '..', 'package.json'), 'utf8'));
      cachedVersion = String(pkg.version || '');
    } catch (e) {
      cachedVersion = '';
    }
    return cachedVersion;
  }

  /**
   * The `web.*` dictionary for the active language (the client interpolates placeholders itself).
   * 当前语言下 `web.*` 的文案表（占位符由客户端自己插值）。
   */
  function i18nBundle() {
    const zh = require('../i18n/web/zh-CN.json');
    const dict = {};
    for (const key of Object.keys(zh)) dict[key] = t(key);
    return { language: getLanguage(), languages: availableLanguages(), dict };
  }

  /**
   * Library rows, optionally filtered by keyword and collection snapshot.
   * 模型库行，可按关键字与收藏集快照过滤。
   */
  function library(payload = {}) {
    const all = collectModels(config);
    let scoped = all;
    const collectionId = payload.collectionId ? String(payload.collectionId) : null;
    if (collectionId) {
      const { snapshot } = readCollection(config, collectionId, { allowCorrupt: true });
      const allowed = new Set(snapshot ? snapshot.items.map((item) => String(item.modelId)) : []);
      scoped = all.filter((model) => allowed.has(model.modelId));
    }
    const rows = sortModels(filterModels(scoped, payload.q || ''), payload.sort || 'recent');
    return { items: rows.map(libraryRow), total: all.length, shown: rows.length };
  }

  /**
   * One model with its versions and files.
   * 一个模型及其版本与文件。
   */
  function modelDetail(modelId) {
    const model = requireModel(modelId);
    return {
      ...libraryRow(model),
      versions: model.versions.map((v) => ({ ...versionRow(v), versionId: String(v.versionId) })),
    };
  }

  /**
   * Pin one version (or clear the pin).
   * 固定某个版本（或取消固定）。
   */
  function pinModel(modelId, versionId) {
    const model = requireModel(modelId);
    if (versionId !== null && versionId !== undefined && versionId !== '') {
      const wanted = String(versionId);
      if (!model.versions.some((v) => String(v.versionId) === wanted)) {
        throw httpError(400, t('web.error.versionNotFound', { modelId, versionId: wanted }));
      }
      setPin(config, model.modelId, wanted);
    } else {
      setPin(config, model.modelId, null);
    }
    return modelDetail(model.modelId);
  }

  /**
   * Delete one library record (optionally with its files).
   * 删除一条模型库记录（可选连同文件）。
   */
  function forget(modelId, opts2 = {}) {
    const model = requireModel(modelId);
    const result = forgetModels(config, model.modelId, { deleteFiles: !!opts2.deleteFiles });
    return { modelId: model.modelId, ...(result || {}) };
  }

  /**
   * Online version list of several models (for the version picker).
   * 多个模型的线上版本列表（供版本选择器使用）。
   */
  async function versions(payload = {}) {
    const ids = toArray(payload.modelIds);
    if (!ids.length) throw httpError(400, t('web.error.badRequest'));
    const out = [];
    for (const modelId of ids) {
      const detail = await fetchModelDetail(config.site, modelId, config.userAgent);
      out.push({
        modelId: String(detail.id),
        name: detail.name,
        type: detail.type,
        versions: (detail.modelVersions || []).map((v) => {
          const files = extractFiles(v, config.site, {
            fileTypes: config.fileTypes,
            primaryOnly: config.primaryOnly,
          });
          return {
            versionId: String(v.id),
            versionName: v.name || null,
            baseModel: v.baseModel || null,
            publishedAt: v.publishedAt || null,
            files: files.length,
            bytes: files.reduce((sum, file) => sum + (Number(file.bytes) || 0), 0),
          };
        }),
      });
    }
    return { models: out };
  }

  // -------------------------------------------------------------------------
  // Collection enumeration + plan
  // 收藏集枚举与计划
  // -------------------------------------------------------------------------

  /**
   * Enumerate a collection and build the download plan as a job (it can take tens of seconds).
   * 以任务形式枚举收藏集并生成下载计划（可能要几十秒）。
   */
  function startPlan(payload = {}) {
    const collectionId = String(payload.collectionId || '').trim();
    if (!/^\d+$/.test(collectionId)) throw httpError(400, t('web.error.badCollectionId'));
    return startJob({ kind: 'plan', title: t('web.job.plan', { collectionId }) }, async (ctx) => {
      ctx.log(t('web.log.connectingBrowser'));
      const browser = await ensureBrowser(config);
      try {
        const items = await fetchCollectionItems(browser, config.site, collectionId, {
          trpcPath: config.trpcPath,
          trpcInput: config.trpcInput,
          requestTimeoutMs: config.requestTimeoutMs,
          limit: createSiteLimiter(config),
          onLog: ctx.log,
        });
        if (!items.length) throw new Error(t('web.error.collectionEmpty'));
        try {
          writeCollection(config, collectionId, { items });
        } catch (e) {
          ctx.log(t('web.log.snapshotFailed', { message: e.message }));
        }

        // Pins decide the target version before metadata is fetched, so the plan shown in the UI
        // and the version the job downloads agree.
        //
        // 在拉元数据之前先按固定版本决定目标版本，界面展示的计划与实际下载的版本才会一致。
        const { entries } = readLibrary(config, { allowCorrupt: true });
        const pinnedCount = applyPinsToItems(entries, items);
        if (pinnedCount) ctx.log(t('web.log.pinsApplied', { count: pinnedCount }));

        ctx.log(t('web.log.fetchMeta', { count: items.length }));
        const { plan, totalBytes, failed } = await buildPlan(config.site, items, config.userAgent, {
          concurrency: config.metaConcurrency,
          fileTypes: config.fileTypes,
          primaryOnly: config.primaryOnly,
          onLog: ctx.log,
        });
        try {
          writeJson(dataPaths(config, collectionId).plan, {
            collectionId,
            totalBytes,
            count: plan.length,
            failed,
            plan: plan.map((item) => ({ ...item, versions: undefined })),
          });
        } catch (e) {
          ctx.log(t('web.log.planWriteFailed', { message: e.message }));
        }

        const rows = plan.map((item) => {
          const entry = entries[String(item.modelId)];
          return {
            ...item,
            versions: undefined,
            // Whether this exact version already has a record: the UI preselects only new ones.
            // 该版本是否已有记录：UI 默认只勾选还没下载的。
            recorded: !!(entry && getVersion(entry, item.versionId)),
            hasRecord: !!entry,
            pinned: !!(entry && entry.pinnedVersionId && String(entry.pinnedVersionId) === String(item.versionId)),
          };
        });
        return { collectionId, totalBytes, failed, items: rows };
      } finally {
        await browser.disconnect().catch(() => {});
      }
    });
  }

  // -------------------------------------------------------------------------
  // Downloads
  // 下载
  // -------------------------------------------------------------------------

  /**
   * Download the selected plan items, or models pasted as references.
   *
   * `items` may be full plan items (from the plan job or an update report) or bare
   * `{modelId, versionId}` references, which are resolved first. `refs` takes pasted
   * model URLs / `model:<id>` / `version:<id>` and is resolved with the same parser as the CLI.
   *
   *
   * 下载选中的计划项，或粘贴引用来的模型。
   *
   * `items` 可以是完整计划项（来自计划任务或检查报告），也可以是 `{modelId, versionId}` 引用，
   * 后者会先补全。`refs` 接收粘贴的模型链接 / `model:<id>` / `version:<id>`，
   * 用与 CLI 相同的解析器处理。
   */
  function startDownload(payload = {}) {
    const items = Array.isArray(payload.items) ? payload.items.filter(Boolean) : [];
    const refs = normalizeRefs(payload.refs);
    if (!items.length && !refs.length) throw httpError(400, t('web.error.noItems'));
    const firstModelId = items.length ? items[0].modelId : null;
    const collectionId = payload.collectionId
      ? String(payload.collectionId)
      : firstModelId !== null && firstModelId !== undefined
        ? `model-${firstModelId}`
        : `refs-${Date.now()}`;
    const outDir = resolveOutDir(config, payload.outDir || config.outDir);
    const concurrency = Math.max(1, Math.min(Number(payload.jobs) || Number(config.jobs) || 1, 8));
    const count = items.length + refs.length;

    return startJob({ kind: 'download', title: t('web.job.download', { count }) }, async (ctx) => {
      const raw = items.concat(await refsToItems(refs, ctx.log));
      if (!raw.length) throw new Error(t('web.error.noItems'));
      const plan = await resolvePlanItems(raw, ctx.log);
      if (!plan.length) throw new Error(t('web.error.noItems'));
      const tracker = createTracker({ plan, now });
      ctx.onCancel(() => cancelCurrentDownload());
      ctx.progress({ phase: 'download', ...tracker.snapshot() });
      const timer = setInterval(() => {
        ctx.progress({ phase: 'download', ...tracker.snapshot() });
      }, 600);
      if (typeof timer.unref === 'function') timer.unref();
      try {
        const summary = await runDownloadJob(
          config,
          {
            collectionId,
            plan,
            outDir,
            force: !!payload.force,
            jobs: concurrency,
            isCancelled: () => ctx.isCancelled(),
          },
          {
            log: ctx.log,
            onFileStart: (item, file, dir) => tracker.fileStarted(item, file, dir),
            onAttempt: (info) => tracker.attempt(info),
            onItemDone: (item, ok, status) => tracker.itemDone(item, ok, status),
          }
        );
        ctx.progress({ phase: 'download', ...tracker.snapshot() });
        return {
          collectionId,
          outDir,
          done: summary.done,
          skipped: summary.skipped,
          failed: summary.failed,
          metaFailed: summary.metaFailed,
          cancelled: summary.cancelled,
          elapsedMs: summary.elapsedMs,
          logFile: summary.logFile,
          remaining: summary.remaining,
        };
      } finally {
        clearInterval(timer);
      }
    });
  }

  // -------------------------------------------------------------------------
  // Update check / verification
  // 检查更新 / 校验
  // -------------------------------------------------------------------------

  /**
   * Check collections and/or single models for updates (deep = hash local files).
   *
   * Each report carries the affected plan items, so the UI can offer "download what changed"
   * without another round trip.
   *
   *
   * 检查收藏集和/或单个模型是否有更新（深度 = 计算本地文件哈希）。
   *
   * 每份报告都带上受影响的计划项，UI 就能直接「下载变化项」，不必再来一次请求。
   */
  function startCheck(payload = {}) {
    const collectionIds = toArray(payload.collections);
    const modelIds = toArray(payload.models);
    if (!collectionIds.length && !modelIds.length) throw httpError(400, t('web.error.badRequest'));
    const deep = !!payload.deep;

    return startJob({ kind: 'check', title: t('web.job.check', { count: collectionIds.length + modelIds.length }) }, async (ctx) => {
      const reports = [];
      for (const id of collectionIds) {
        ctx.log(t('web.log.checkCollection', { collectionId: id }));
        const { report } = await checkUpdates(
          config,
          id,
          { verifyFiles: deep, withPlan: true },
          { log: ctx.log }
        );
        report.stats = summarize(report);
        const items = changedItems(report);
        reports.push({
          target: { kind: 'collection', id },
          collectionId: id,
          stats: report.stats,
          lines: reportLines(report),
          changed: items.length,
          items,
        });
      }
      for (const id of modelIds) {
        ctx.log(t('web.log.checkModel', { modelId: id }));
        const { report } = await checkModelUpdates(config, id, { verifyFiles: deep }, { log: ctx.log });
        report.stats = summarize(report);
        const items = changedItems(report);
        reports.push({
          target: { kind: 'model', id },
          collectionId: `model-${id}`,
          stats: report.stats,
          lines: reportLines(report),
          changed: items.length,
          items,
        });
      }
      return { deep, reports, changed: reports.reduce((sum, r) => sum + r.changed, 0) };
    });
  }

  /**
   * Verify local files and report what is broken.
   * 校验本地文件并报告异常项。
   */
  function startVerify(payload = {}) {
    let ids = toArray(payload.modelIds);
    if (!ids.length) ids = collectModels(config).map((m) => m.modelId);
    if (!ids.length) throw httpError(400, t('web.error.noModels'));
    const noHash = !!payload.noHash;

    return startJob({ kind: 'verify', title: t('web.job.verify', { count: ids.length }) }, async (ctx) => {
      const result = await verifyModels(config, ids, {
        noHash,
        onProgress: (info) => {
          ctx.log(t('web.log.verifyProgress', { index: info.index, total: info.total, name: info.name }));
          ctx.progress({ phase: 'verify', index: info.index, total: info.total, name: info.name });
        },
      });
      return {
        label: result.label,
        total: result.total,
        versions: result.versions,
        totalBytes: result.totalBytes,
        ok: result.ok.length,
        broken: result.broken.map((item) => ({
          modelId: String(item.modelId),
          versionId: item.versionId === undefined || item.versionId === null ? null : String(item.versionId),
          name: item.name,
          dir: item.dir,
          reasons: item.reasons,
        })),
        corrupt: result.corrupt,
      };
    });
  }

  /**
   * Reset the records of the given items so the next download fetches them again.
   * 重置指定条目的记录，让下次下载重新拉取。
   */
  function resetRecords(payload = {}) {
    const items = Array.isArray(payload.items) ? payload.items : [];
    const targets = items
      .filter((item) => item && item.modelId !== undefined)
      .map((item) => ({
        modelId: String(item.modelId),
        versionId:
          item.versionId === undefined || item.versionId === null ? null : String(item.versionId),
      }));
    if (!targets.length) throw httpError(400, t('web.error.badRequest'));
    const count = markForRedownload(config, targets);
    return { reset: count };
  }

  // -------------------------------------------------------------------------
  // Login
  // 登录
  // -------------------------------------------------------------------------

  /**
   * Start the browser login flow; it waits for the user to confirm in the web UI.
   * 启动浏览器登录流程；它会等用户在 Web UI 里点「已完成登录」。
   */
  function startLogin() {
    if (loginResolve) throw httpError(409, t('web.error.loginPending'));
    return startJob({ kind: 'login', title: t('web.job.login') }, async (ctx) => {
      const saved = await performLogin(config, {
        log: ctx.log,
        waitConfirm: () =>
          new Promise((resolve) => {
            loginResolve = resolve;
            ctx.onCancel(() => {
              if (loginResolve) {
                loginResolve = null;
                resolve(false);
              }
            });
          }),
      });
      loginResolve = null;
      return { saved: !!saved, loggedIn: fs.existsSync(config.cookiesFile) };
    });
  }

  /**
   * Tell the waiting login job that the user finished in the browser.
   * 通知等待中的登录任务：用户已在浏览器里完成登录。
   */
  function confirmLogin() {
    if (!loginResolve) throw httpError(409, t('web.error.loginNotPending'));
    const resolve = loginResolve;
    loginResolve = null;
    resolve(true);
    return { ok: true };
  }

  /**
   * Probe the saved session without opening a browser.
   * 不打开浏览器，探测已保存的会话是否有效。
   */
  async function sessionCheck() {
    const probe = await checkLogin(config, { log: () => {} });
    return { ok: !!probe.ok, reason: probe.reason || '' };
  }

  // -------------------------------------------------------------------------
  // Settings / environment
  // 设置 / 环境
  // -------------------------------------------------------------------------

  /**
   * Current settings for the form.
   * 设置表单的当前值。
   */
  function settings() {
    const values = {};
    for (const key of SETTINGS_KEYS) values[key] = config[key];
    return {
      values,
      configFile: config.configFile || null,
      root: config.root,
      languages: availableLanguages(),
      warnings: config.warnings || [],
      keys: SETTINGS_KEYS,
    };
  }

  /**
   * Validate and persist a settings patch.
   *
   * The patch is merged over the *known* current values and validated first, so a typo is rejected
   * with a readable message instead of writing a config.json that cannot be loaded next time.
   *
   *
   * 校验并保存设置补丁。
   *
   * 补丁会覆盖在当前「已知字段」上先做校验，因此写错的值会以可读的信息被拒绝，
   * 而不会写出一份下次启动读不进来的 config.json。
   */
  function saveSettings(patch = {}) {
    const clean = {};
    for (const key of SETTINGS_KEYS) {
      if (patch[key] !== undefined) clean[key] = patch[key];
    }
    if (!Object.keys(clean).length) throw httpError(400, t('web.error.badRequest'));

    const merged = { ...knownSubset(config), ...clean };
    try {
      validateConfig(merged, { warnings: [] });
    } catch (e) {
      const error = new Error(e.message);
      error.status = 400;
      throw error;
    }
    saveConfig(config, clean);
    reload();
    return settings();
  }

  /**
   * Environment check as structured items.
   * 结构化环境体检结果。
   */
  async function doctorReport(payload = {}) {
    const items = await doctor.collect(config, { deep: !!payload.deep });
    return { items };
  }

  /**
   * Free space of the output directory (or of a given directory inside it).
   * 输出目录（或其内部某目录）的剩余空间。
   */
  function disk(dir) {
    const target = dir ? resolveOutDir(config, dir) : resolveOutDir(config, config.outDir);
    return { dir: target, free: freeSpaceBytes(target) };
  }

  /**
   * Open a directory in the file manager.
   *
   * Only paths inside the configured output directory are accepted: a local web UI should not be
   * able to launch the file manager anywhere on the disk just because a request asked it to.
   *
   *
   * 在文件管理器里打开目录。
   *
   * 只接受配置的输出目录内部的路径：本地 Web UI 不应该因为一个请求就去打开磁盘上任意位置。
   */
  function openDirectory(target) {
    const outDir = resolveOutDir(config, config.outDir);
    const wanted = target ? resolveOutDir(config, target) : outDir;
    const root = path.resolve(outDir);
    const resolved = path.resolve(wanted);
    if (resolved !== root && !resolved.startsWith(root + path.sep)) {
      throw httpError(403, t('web.error.outsideOutDir'));
    }
    if (!fs.existsSync(resolved)) throw httpError(404, t('web.error.dirMissing', { dir: resolved }));
    const command =
      process.platform === 'win32' ? 'explorer.exe' : process.platform === 'darwin' ? 'open' : 'xdg-open';
    try {
      const child = spawn(command, [resolved], { detached: true, stdio: 'ignore' });
      child.unref();
    } catch (e) {
      throw httpError(500, e.message);
    }
    return { opened: resolved };
  }

  return {
    // Read-only actions
    // 只读动作
    state,
    i18n: i18nBundle,
    library,
    modelDetail,
    versions,
    collectionDetail,
    settings,
    disk,
    doctorReport,
    // Library mutations
    // 模型库写操作
    pinModel,
    forget,
    resetRecords,
    // Long-running jobs
    // 耗时任务
    startPlan,
    startDownload,
    startCheck,
    startVerify,
    startLogin,
    confirmLogin,
    sessionCheck,
    // Settings and shell integration
    // 设置与系统集成
    saveSettings,
    openDirectory,
    // Exposed for tests
    // 供测试使用
    reload,
    getConfig: () => config,
    jobList: () => jobs.list(),
    jobGet: (id) => jobs.get(id),
    jobCancel: (id) => jobs.cancel(id),
  };
}

module.exports = {
  createActions,
  SETTINGS_KEYS,
  httpError,
  toArray,
  normalizeRefs,
  versionBytes,
};
