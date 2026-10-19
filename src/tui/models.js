'use strict';

/**
 * TUI flow for the model library (one model with several versions, one record per model).
 *
 * Unlike "download a collection": no collection enumeration happens here; models are located either
 * by pasting model URL / model:<ID> / version:<ID> or by picking them from the library, then each
 * model picks its version and output directory and gets downloaded; every record lives in
 * .data/library.json. A collection is only a membership snapshot used as an optional filter.
 *
 * Every list is navigable with the same keys (search / filter / sort / help), and Esc always steps
 * back one level instead of ending the flow.
 *
 *
 * 模型库（一个模型多个版本、一模型一记录）的 TUI 流程。
 *
 * 与「下载收藏集」的区别：这里不做收藏集枚举；模型既可以粘贴
 * 模型 URL / model:<ID> / version:<ID> 定位，也可以直接从模型库里挑选，
 * 然后逐模型选版本、选目录、下载；记录统一落在 .data/library.json。
 * 收藏集只是成员快照，用作可选的筛选条件。
 *
 * 所有列表用的都是同一套按键（搜索 / 过滤 / 排序 / 帮助），Esc 永远只退回上一层，不会中断整个流程。
 */

const path = require('path');
const { formatBytes } = require('../util');
const { readLibrary, readCollection, listCollectionIds, entryVersions, getVersion } = require('../storage');
// The updater is looked up per call (through this module object) instead of being destructured:
// a test or an embedder can swap one of its functions without reloading the TUI.
//
// 更新器通过模块对象按调用时查找，而不是解构：测试或嵌入方可以直接替换其中某个函数，
// 不必重新加载 TUI。
const updater = require('../updater');
const { fetchModelDetail, versionToItem, extractFiles } = require('../api');
const { resolveOutDir } = require('../config');
const { collectModels, filterModels, sortModels, printList, forgetModels } = require('../commands/models');
const { verifyModels } = require('../commands/verify');
const { refToTarget } = require('../commands/download');
const { t } = require('../i18n');
const view = require('./view');
const pages = require('./pages');
const screen = require('./screen');
const layout = require('./layout');
const { runWithProgress } = require('./run');

/**
 * Parse pasted batch input: split on lines and commas, ignoring empty entries and # comments.
 * 解析粘贴的批量输入：按行/逗号切分，忽略空项与 # 注释
 */
function parseRefs(text) {
  return String(text === undefined || text === null ? '' : text)
    .split(/[\r\n,]+/)
    .map((s) => s.replace(/#.*$/, '').trim())
    .filter(Boolean);
}

/**
 * Library entries keyed by model ID.
 * 模型库记录（按模型 ID 索引）。
 */
function libraryEntries(config) {
  return readLibrary(config, { allowCorrupt: true }).entries;
}

function readEntry(config, modelId) {
  return libraryEntries(config)[String(modelId)] || null;
}

function libraryModelIds(config) {
  return Object.keys(libraryEntries(config)).sort();
}

function entryBytes(entry) {
  return entryVersions(entry).reduce(
    (sum, v) => sum + (v.files || []).reduce((s, f) => s + (Number(f.bytes) || 0), 0),
    0
  );
}

function modelLabel(config, modelId) {
  const entry = readEntry(config, modelId);
  return (entry && entry.name) || t('tui.manage.modelIdLabel', { modelId });
}

function versionSummary(entry) {
  const versions = entryVersions(entry);
  return {
    count: versions.length,
    size: formatBytes(entryBytes(entry)),
    pinned: entry && entry.pinnedVersionId ? t('tui.manage.pinnedVersion') : t('tui.models.notPinned'),
  };
}

/**
 * One row of the library picker: the record plus the fields the shared picker needs
 * (modelId / name / totalBytes / type / baseModel). The model id is passed in explicitly, because
 * library entries are stored *by* id and the record itself has no modelId field to read.
 *
 * 模型库选择器的一行：模型库记录，外加公共选择器需要的字段；模型 ID 必须显式传入，
 * 因为模型库是「按 ID 索引」存的，记录本身没有 modelId 字段可读。
 */
function libraryRow(entry, modelId) {
  const versions = entryVersions(entry);
  const done = versions.filter((v) => (v.files || []).length);
  return {
    modelId: String(modelId === undefined || modelId === null ? entry.modelId : modelId),
    name: entry.name || t('tui.manage.modelIdLabel', { modelId }),
    type: entry.type || '',
    baseModel: done.length ? done[0].baseModel || entry.baseModel || '' : entry.baseModel || '',
    totalBytes: entryBytes(entry),
    versionId: entry.pinnedVersionId || (versions[0] && versions[0].versionId) || null,
    versionCount: versions.length,
    pinnedVersionId: entry.pinnedVersionId || null,
  };
}

/**
 * Every library record as picker rows, optionally limited to one collection snapshot.
 * 模型库记录（可选按收藏集成员快照限定）转成选择器行。
 */
function libraryRows(config, collectionIds) {
  const entries = libraryEntries(config);
  let ids = Object.keys(entries);
  if (Array.isArray(collectionIds)) {
    const allowed = new Set(collectionIds.map(String));
    ids = ids.filter((id) => allowed.has(String(id)));
  }
  return ids
    .map((id) => libraryRow(entries[id], id))
    .sort((a, b) => String(a.name).localeCompare(String(b.name), 'zh-Hans-CN'));
}

/**
 * Picker description of one library row: versions, size, pin state.
 * 选择器里一行的说明：版本数、体积、固定状态。
 */
function describeRow(row, state) {
  const parts = [
    t('tui.models.rowVersions', { count: row.versionCount || 0 }),
    formatBytes(row.totalBytes || 0),
  ];
  if (row.pinnedVersionId) parts.push(t('tui.manage.pinnedVersion'));
  if (row.baseModel) parts.push(row.baseModel);
  if (state && state[row.modelId]) parts.push(t('tui.select.statusDownloaded'));
  return parts.join(view.separator());
}

/**
 * One-line recap of the library rows, printed as a picker takes over the screen.
 * 模型库列表的一行摘要，在选择器接管屏幕时显示。
 */
function librarySummary(rows) {
  const bytes = rows.reduce((sum, row) => sum + (row.totalBytes || 0), 0);
  const pinned = rows.filter((row) => row.pinnedVersionId).length;
  return t('tui.models.pickerSummary', {
    count: rows.length,
    size: formatBytes(bytes),
    pinned: pinned ? t('tui.models.pickerPinned', { count: pinned }) : '',
  }).trim();
}

/**
 * Pick one model from the library.
 * 从模型库中选择一个模型。
 *
 * @param {{title?:string, initialCursor?:number, recap?:boolean}} [opts]
 */
async function pickModel(config, message, opts = {}) {
  const rows = libraryRows(config);
  if (!rows.length) {
    view.log(t('tui.models.noRecords'));
    return null;
  }
  const chosen = await pages.pickOne(rows, {
    message,
    title: opts.title || message,
    describe: describeRow,
    state: libraryEntries(config),
    initialCursor: opts.initialCursor,
    onEnter:
      opts.recap === false ? undefined : () => view.note(view.colors.dim(`  ${librarySummary(rows)}`)),
  });
  return chosen ? String(chosen.modelId) : null;
}

// ---------------------------------------------------------------------------
// Version picking
// 版本选择
// ---------------------------------------------------------------------------

/**
 * Version rows of one online model (used by the download flow and the pin flow).
 * 线上模型的版本行（下载流程与固定流程共用）。
 */
function versionRows(config, detail) {
  const entry = readEntry(config, detail.id);
  const localIds = new Set(entryVersions(entry).map((v) => String(v.versionId)));
  const pinnedId = entry && entry.pinnedVersionId ? String(entry.pinnedVersionId) : null;
  return (Array.isArray(detail.modelVersions) ? detail.modelVersions : []).map((v) => {
    const files = extractFiles(v, config.site, {
      fileTypes: config.fileTypes,
      primaryOnly: config.primaryOnly,
    });
    return {
      modelId: String(v.id),
      name: String(v.name || v.id),
      type: detail.type || '',
      baseModel: v.baseModel || '',
      totalBytes: files.reduce((sum, f) => sum + (Number(f.bytes) || 0), 0),
      fileCount: files.length,
      versionId: String(v.id),
      publishedAt: v.publishedAt || null,
      downloaded: localIds.has(String(v.id)),
      pinned: pinnedId === String(v.id),
      raw: v,
    };
  });
}

/**
 * Explain one version row inside the picker.
 * 选择器里一行版本信息的说明。
 */
function describeVersion(row) {
  const parts = [
    row.baseModel || t('common.unknown'),
    t('tui.download.fileCount', { count: row.fileCount }),
    formatBytes(row.totalBytes || 0),
    row.publishedAt ? String(row.publishedAt).slice(0, 10) : t('tui.download.unknownDate'),
  ];
  if (row.downloaded) parts.push(t('tui.select.statusDownloaded'));
  if (row.pinned) parts.push(t('tui.manage.pinnedMark'));
  return parts.join(view.separator());
}

/**
 * One model, one page: its facts on top, its versions underneath, one Enter to pick one.
 *
 * The generic multi-select picker is right for collection items (search, filters, hundreds of rows),
 * but wrong for "you just pasted one model": there the user wants to see what the model *is* and
 * which versions exist, in the same window, without losing the frame.
 *
 *
 * 一个模型一页：上面是模型信息，下面是它的版本，回车选一个。
 *
 * 通用多选选择器适合收藏集条目（搜索、筛选、几百行），但不适合「你刚粘了一个模型」：
 * 这时用户想看的是这个模型**是什么**、有哪些版本，而且要在同一个窗口里，不丢框架。
 *
 * @param {object} detail site model object
 * @param {Array<object>} rows rows from `versionRows`
 * @param {number} initialCursor
 * @returns {Promise<string|null>} chosen version id, or null
 */
async function modelVersionPage(detail, rows, initialCursor) {
  const state = { cursor: initialCursor, windowStart: 0 };
  const name = String(detail.name || detail.id || '');
  const baseModels = [...new Set(rows.map((row) => row.baseModel).filter(Boolean))];
  const facts = [];
  if (detail.type) facts.push(String(detail.type));
  if (baseModels.length) facts.push(baseModels.join(' / '));
  const author = detail.creator && detail.creator.username ? String(detail.creator.username) : '';
  if (author) facts.push(t('tui.models.pageAuthor', { author }));
  const downloads = detail.stats && Number(detail.stats.downloadCount);
  if (Number.isFinite(downloads) && downloads > 0) {
    facts.push(t('tui.models.pageDownloads', { count: String(downloads) }));
  }
  const downloaded = rows.filter((row) => row.downloaded).length;
  if (downloaded) facts.push(t('tui.models.pageDownloaded', { count: downloaded }));

  const nameWidth = Math.min(
    30,
    rows.reduce((max, row) => Math.max(max, view.displayWidth(row.name)), 0)
  );

  return screen.prompt({
    title: t('tui.app.menuDownload'),
    crumb: true,
    hints: () => [t('tui.hint.modelVersion')],
    render(_state, ctx) {
      const width = Math.max(20, Math.floor(ctx.width) || 80);
      const room = Math.max(3, Math.floor(ctx.rows) || 3);
      const lines = [view.colors.bold(view.truncateTo(name, width))];
      if (facts.length) {
        lines.push(view.colors.dim(view.truncateTo(facts.join(` ${layout.glyphs().bullet} `), width)));
      }
      lines.push('');
      lines.push(view.colors.dim(t('tui.models.pageVersions', { count: rows.length })));

      // Name + facts + blank + "versions" heading + status line stay put; the rest scrolls.
      // 名称 + 信息 + 空行 + 「版本」小标题 + 状态行固定，其余滚动。
      const listRoom = Math.max(1, room - lines.length - 1);
      const win = pages.windowOf(rows.length, state.cursor, listRoom, state.windowStart);
      state.windowStart = win.start;
      for (let index = win.start; index < win.end; index++) {
        const row = rows[index];
        const active = index === state.cursor;
        const marker = active ? view.colors.cyan(layout.glyphs().cursor) : ' ';
        const label = view.padTo(row.name, nameWidth);
        const rest = view.truncateTo(describeVersion(row), Math.max(8, width - nameWidth - 4));
        lines.push(`${marker} ${active ? view.colors.bold(label) : label}  ${view.colors.dim(rest)}`);
      }
      if (rows.length > win.end - win.start) {
        lines.push(
          view.colors.dim(t('tui.pages.listPosition', { index: state.cursor + 1, total: rows.length }))
        );
      }
      return lines;
    },
    onKey(text, key, entry) {
      const name_ = key && key.name;
      const typed = String(text === undefined || text === null ? '' : text);
      const step = (delta) => {
        const next = state.cursor + delta;
        state.cursor = Math.max(0, Math.min(rows.length - 1, next));
      };
      if (name_ === 'up' || typed === 'k') step(-1);
      else if (name_ === 'down' || typed === 'j') step(1);
      else if (name_ === 'pageup') step(-8);
      else if (name_ === 'pagedown') step(8);
      else if (name_ === 'home') state.cursor = 0;
      else if (name_ === 'end') state.cursor = rows.length - 1;
      else if (name_ === 'return') entry.settle(rows[state.cursor] && rows[state.cursor].modelId);
      else return;
      // Keep the window still until the cursor would leave it.
      // 光标离开视窗之前，视窗保持不动。
    },
    onEscape(entry) {
      entry.settle(null);
      return true;
    },
  });
}

/**
 * Choose the version to download for one model: its own page inside the shell, the picker or the
 * single version otherwise.
 *
 * `wanted` is the version requested on the command line (or the pinned one); the page opens on it.
 *
 *
 * 为一个模型选择要下载的版本：外壳里是它自己的一页，其它情况用选择器或直接取唯一版本。
 *
 * `wanted` 是命令行指定（或已固定）的版本，页面默认停在该行。
 */
async function chooseVersion(config, detail, wanted, opts = {}) {
  const rows = versionRows(config, detail);
  if (!rows.length) return null;
  const initialId = String(wanted || (rows[0] && rows[0].modelId) || '');
  const initialCursor = Math.max(0, rows.findIndex((r) => r.modelId === initialId));

  // Inside the shell the model gets a page of its own: facts + versions, no separate window.
  // 外壳里模型有自己的页面：信息 + 版本，不再另开一个窗口。
  if (screen.isActive()) {
    const pickedId = await modelVersionPage(detail, rows, initialCursor);
    if (!pickedId) return null;
    return detail.modelVersions.find((v) => String(v.id) === String(pickedId)) || null;
  }

  if (rows.length === 1 && opts.alwaysAsk !== true) {
    return detail.modelVersions.find((v) => String(v.id) === rows[0].modelId) || detail.modelVersions[0];
  }

  const chosen = await pages.pickOne(rows, {
    message: t('tui.models.chooseVersion', { name: view.truncate(String(detail.name), 56) }),
    title: t('tui.models.chooseVersion', { name: view.truncate(String(detail.name), 56) }),
    describe: describeVersion,
    initialCursor,
  });
  if (!chosen) return null;
  return detail.modelVersions.find((v) => String(v.id) === chosen.modelId) || null;
}

// ---------------------------------------------------------------------------
// Download single models
// 下载单个模型
// ---------------------------------------------------------------------------

/**
 * Resolve user input into [{modelId, versionId}] (version:<id> looks up modelId online).
 * 把用户输入解析为 [{modelId, versionId}]（version:<id> 会联网反查 modelId）
 */
async function resolveRefs(config, raws) {
  const picks = [];
  const seen = new Set();
  for (const raw of raws) {
    let target = null;
    try {
      target = await refToTarget(config, raw);
    } catch (e) {
      view.log(view.colors.red(t('tui.models.fetchFailed', { name: raw, error: e.message })));
      continue;
    }
    if (!target || target.kind !== 'model') {
      view.log(t('tui.models.refInvalid', { value: raw }));
      continue;
    }
    const key = `${target.ref.modelId}:${target.ref.versionId || ''}`;
    if (seen.has(key)) continue;
    seen.add(key);
    picks.push(target.ref);
  }
  return picks;
}

/**
 * Ask where the models come from: pasted references or the existing library.
 * 询问模型来源：粘贴引用，或直接从模型库里挑选。
 */
async function askRefs(config) {
  const rows = libraryRows(config);
  const source = await pages.promptMenu(t('tui.models.sourcePrompt'), [
    {
      title: t('tui.models.sourcePaste'),
      value: 'paste',
      description: t('tui.models.sourcePasteDesc'),
    },
    ...(rows.length
      ? [
          {
            title: t('tui.models.sourceLibrary'),
            value: 'library',
            description: t('tui.models.sourceLibraryDesc'),
          },
        ]
      : []),
  ]);
  if (source === null) return null;

  if (source === 'library') {
    view.log(t('tui.models.sourceLibraryHint'));
    const chosen = await pages.pickMany(rows, {
      message: t('tui.models.pickForDownload'),
      title: t('tui.models.pickForDownload'),
      describe: describeRow,
      state: libraryEntries(config),
    });
    if (chosen === null) return null;
    if (!chosen.length) {
      view.log(t('tui.models.nonePicked'));
      return null;
    }
    return chosen.map((row) => `model:${row.modelId}`);
  }

  const text = await pages.promptText(t('tui.models.downloadPrompt'), {
    validate: (v) => (parseRefs(v).length ? true : t('tui.models.notEmpty')),
  });
  if (text === null) return null;
  const raws = parseRefs(text);
  return raws.length ? raws : null;
}

/**
 * Build the download items of the given references, asking for a version when a model has several.
 * Returns null when the user cancelled.
 *
 * 根据引用构建下载条目：模型有多个版本时逐个询问。用户取消时返回 null。
 */
async function buildItems(config, refs) {
  const picks = await resolveRefs(config, refs);
  if (!picks.length) {
    view.log(t('tui.models.noRefs'));
    return null;
  }

  const items = [];
  for (const ref of picks) {
    view.log(t('tui.models.fetchingModel', { modelId: ref.modelId }));
    let detail = null;
    try {
      detail = await fetchModelDetail(config.site, ref.modelId, config.userAgent);
    } catch (e) {
      view.log(view.colors.red(t('tui.models.fetchFailed', { name: ref.modelId, error: e.message })));
      continue;
    }
    const versions = Array.isArray(detail.modelVersions) ? detail.modelVersions : [];
    if (!versions.length) {
      view.log(t('tui.models.noVersionsOnline', { name: detail.name }));
      continue;
    }
    const version = await chooseVersion(config, detail, ref.versionId);
    if (!version) {
      view.log(t('tui.manage.cancelled'));
      return null;
    }
    const item = Object.assign(
      {
        modelId: detail.id,
        name: detail.name,
        type: detail.type,
        baseModel: version.baseModel,
        // Raw site object: mirrored into the library so every known field is recorded
        // 站点原始对象：镜像进模型库，完整记录已知字段
        modelMeta: detail,
      },
      versionToItem(config.site, version, {
        fileTypes: config.fileTypes,
        primaryOnly: config.primaryOnly,
      })
    );
    if (!item.files.length) {
      view.log(t('tui.models.noFiles', { name: detail.name, version: version.name || version.id }));
      continue;
    }
    items.push(item);
  }
  return items.length ? items : null;
}

/**
 * Download the prepared items one model at a time (they share the global library record).
 * 逐个模型下载已准备好的条目（它们共用全局模型库记录）。
 */
async function runItems(config, items, outDir, force) {
  let failed = 0;
  for (const item of items) {
    const summary = await runWithProgress(config, {
      collectionId: `model-${item.modelId}`,
      name: item.name || modelLabel(config, item.modelId),
      plan: [item],
      outDir,
      force,
      totalBytes: item.totalBytes || 0,
      jobs: 1,
      attempts: config.downloadAttempts,
    });
    if (summary.failed) failed++;
    const stats = { done: summary.done, skipped: summary.skipped, failed: summary.failed };
    view.log(summary.cancelled ? t('tui.download.summaryCancelled', stats) : t('tui.download.summaryDone', stats));
  }
  view.bell();
  if (failed) view.log(view.colors.red(t('tui.models.downloadFailed')));
  return failed;
}

/**
 * Download one or more models by reference.
 * 按引用下载一个或多个模型。
 *
 * @param {{refs?:string[]}} [opts] preset references (used by a model's own page)
 */
async function downloadFlow(config, opts = {}) {
  if (screen.isActive()) return downloadModelsShell(config, opts);
  const refs = Array.isArray(opts.refs) && opts.refs.length ? opts.refs : await askRefs(config);
  if (!refs) return;

  const items = await buildItems(config, refs);
  if (!items) return;

  let outDir = resolveOutDir(config, config.outDir);
  const totalBytes = items.reduce((sum, item) => sum + (item.totalBytes || 0), 0);
  const doneCount = items.filter((item) => getVersion(readEntry(config, item.modelId), item.versionId)).length;

  // One confirmation screen instead of a chain of questions: the output directory can still be
  // changed from it, which is the only extra decision that used to interrupt the flow.
  //
  // 用一屏确认代替连环追问：目录仍然可以在这里改，它是原先唯一会打断流程的额外决定。
  for (;;) {
    const choice = await pages.promptMenu(
      t('tui.download.startConfirm', { count: items.length, size: formatBytes(totalBytes), dir: outDir }),
      [
        {
          title: t('tui.download.startNow'),
          value: 'go',
          description: t('tui.download.startNowDesc', { count: items.length }),
        },
        {
          title: t('tui.download.changeDir'),
          value: 'dir',
          description: t('tui.download.changeDirDesc', { root: config.root, dir: outDir }),
        },
        {
          title: t('tui.manage.back'),
          value: 'back',
        },
      ],
      { stage: t('tui.app.menuDownload') }
    );
    if (choice === null || choice === 'back') {
      view.log(t('tui.manage.cancelled'));
      return;
    }
    if (choice === 'dir') {
      const text = await pages.promptOutDir(config, outDir);
      if (text === null) continue;
      outDir = resolveOutDir(config, text);
      continue;
    }
    break;
  }

  let force = false;
  if (doneCount) {
    const decision = await pages.askRedownload(doneCount);
    if (decision === null) {
      view.log(t('tui.manage.cancelled'));
      return;
    }
    force = decision === 'force';
  }

  await runItems(config, items, outDir, force);

  const openIt = await pages.promptConfirm(t('tui.download.openDirConfirm'), { initial: false });
  if (openIt && view.openDir(outDir)) view.log(t('tui.download.opened', { dir: outDir }));
}

// ---------------------------------------------------------------------------
// Shell flow: model references → shared plan pages
// 外壳流程：模型引用 → 共享计划页面
// ---------------------------------------------------------------------------

/**
 * Build the plan for a set of pasted references without asking for a version one by one: the plan
 * page owns the per-item version picker, so the whole selection stays visible and reversible.
 *
 * 为一组粘贴的引用生成计划，不再逐个追问版本：版本选择归计划页，
 * 因此整个选择过程可见、可回退。
 */
async function buildModelPlanShell(config, raws) {
  const picks = await resolveRefs(config, raws);
  if (!picks.length) {
    view.log(t('tui.models.noRefs'));
    return null;
  }
  const items = [];
  for (const ref of picks) {
    view.log(t('tui.models.fetchingModel', { modelId: ref.modelId }));
    let detail = null;
    try {
      detail = await fetchModelDetail(config.site, ref.modelId, config.userAgent);
    } catch (e) {
      view.log(view.colors.red(t('tui.models.fetchFailed', { name: ref.modelId, error: e.message })));
      continue;
    }
    const versions = Array.isArray(detail.modelVersions) ? detail.modelVersions : [];
    if (!versions.length) {
      view.log(t('tui.models.noVersionsOnline', { name: detail.name }));
      continue;
    }
    const entry = readEntry(config, ref.modelId);
    const pinned = entry && entry.pinnedVersionId ? String(entry.pinnedVersionId) : null;
    const wanted = ref.versionId || pinned || String(versions[0].id);
    const version = versions.find((item) => String(item.id) === String(wanted)) || versions[0];
    const built = versionToItem(config.site, version, {
      fileTypes: config.fileTypes,
      primaryOnly: config.primaryOnly,
    });
    if (!built.files.length) {
      view.log(t('tui.models.noFiles', { name: detail.name, version: version.name || version.id }));
      continue;
    }
    items.push({
      ...built,
      modelId: detail.id,
      name: detail.name,
      type: detail.type,
      baseModel: version.baseModel,
      modelMeta: detail,
      versionId: version.id,
      versionName: version.name,
      baseVersionId: String(version.id),
      manual: false,
    });
  }
  return items.length ? items : null;
}

/**
 * Shell entry of "download models": references → shared plan → confirm → receipt.
 * 「下载模型」的外壳入口：引用 → 共享计划 → 确认 → 回执。
 */
async function downloadModelsShell(config, opts = {}) {
  const refs =
    Array.isArray(opts.refs) && opts.refs.length ? opts.refs : await askRefs(config);
  if (!refs) return;
  const items = await pages.withSpinner(t('tui.download.fetchVersions'), () =>
    buildModelPlanShell(config, refs)
  );
  if (!items || !items.length) {
    view.notice(t('tui.download.noDownloadable'), view.colors.yellow);
    return;
  }
  const collectionId =
    items.length === 1 ? `model-${items[0].modelId}` : `refs-${Date.now()}`;
  const name =
    items.length === 1
      ? items[0].name
      : t('tui.download.modelsName', { count: items.length });
  const totalBytes = items.reduce((sum, item) => sum + (Number(item.totalBytes) || 0), 0);
  return require('./download').runDownloadPlan(config, {
    plan: items,
    collectionId,
    name,
    sourceLine: t('tui.download.planSourceModels', {
      count: items.length,
      size: formatBytes(totalBytes),
    }),
    outDir: resolveOutDir(config, config.outDir),
    jobs: config.jobs,
  });
}

// ---------------------------------------------------------------------------
// Library listing and details
// 模型库列表与详情
// ---------------------------------------------------------------------------

/**
 * Optional collection filter: the membership snapshot decides which models are shown.
 * 可选的收藏集筛选：由成员快照决定显示哪些模型。
 */
async function askCollectionFilter(config) {
  const ids = listCollectionIds(config);
  if (!ids.length) return { ids: null };
  const value = await pages.promptMenu(t('tui.models.filterCollection'), [
    { title: t('tui.models.allCollections'), value: '__all__' },
    ...ids.map((id) => {
      const { snapshot } = readCollection(config, id, { allowCorrupt: true });
      return {
        title: t('tui.models.collectionItem', { id, count: snapshot ? snapshot.items.length : 0 }),
        value: id,
      };
    }),
  ]);
  if (value === null) return null;
  if (value === '__all__') return { ids: null };
  const { snapshot } = readCollection(config, String(value), { allowCorrupt: true });
  return { ids: snapshot ? snapshot.items.map((it) => String(it.modelId)) : [] };
}

/**
 * Print the detail page of one model: identity, versions and disk locations.
 * 打印某个模型的详情页：标识、版本与磁盘位置。
 */
function printModelDetail(config, modelId) {
  const entry = readEntry(config, modelId);
  if (!entry) {
    view.log(t('tui.models.recordMissing', { modelId }));
    return;
  }
  const versions = entryVersions(entry);
  const facts = [
    { label: t('tui.models.factModelId'), value: String(modelId) },
    { label: t('tui.models.factType'), value: entry.type || t('common.unknown') },
    { label: t('tui.models.factVersions'), value: String(versions.length) },
    {
      label: t('tui.models.factSize'),
      value: formatBytes(entryBytes(entry)),
    },
    {
      label: t('tui.models.factPinned'),
      value: entry.pinnedVersionId
        ? t('tui.models.pinnedTo', {
            version:
              (getVersion(entry, entry.pinnedVersionId) || {}).versionName || entry.pinnedVersionId,
          })
        : t('tui.manage.notPinned'),
    },
  ];
  pages.printBlock(modelLabel(config, modelId), pages.describeFacts(facts));
  if (!versions.length) {
    view.log(`  ${view.colors.dim(t('tui.models.noVersionsOnline', { name: modelLabel(config, modelId) }))}`);
    return;
  }
  for (const v of versions) {
    const bytes = (v.files || []).reduce((sum, f) => sum + (Number(f.bytes) || 0), 0);
    const pinned = String(v.versionId) === String(entry.pinnedVersionId) ? ` ${t('tui.manage.pinnedMark')}` : '';
    view.note(
      `  ${view.colors.dim('·')} ${view.truncateTo(String(v.versionName || v.versionId), 40)}${pinned}  ` +
        view.colors.dim(
          [
            `v${v.versionId}`,
            formatBytes(bytes),
            v.verifiedAt ? String(v.verifiedAt).slice(0, 10) : t('tui.manage.unknownTime'),
          ].join(view.separator())
        )
    );
    const dir = v.outDir || config.outDir;
    if (v.dirName || dir) {
      view.note(`      ${view.colors.dim(t('tui.manage.dirLine', { dir: path.join(dir, v.dirName || '') }))}`);
    }
  }
}

/**
 * Menu shown after picking one model in the library: everything that can be done to a single model.
 *
 * This is the "one project" page of the TUI: it maps to one Civitai model link, so every action here
 * is about that model — update it, verify its files, pin a version, open its folder, forget it.
 *
 *
 * 在模型库里选中一个模型后显示的菜单：针对单个模型能做的一切。
 *
 * 这是 TUI 里的「单个项目」页：它对应 Civitai 上的一个模型链接，
 * 因此这里的每个动作都围绕这个模型——更新、校验文件、固定版本、打开目录、删除记录。
 */
async function modelActions(config, modelId) {
  // The detail page is printed once; re-printing it after every action used to push the page up by
  // a full screen each time. The menu title carries the model name so the context is never lost.
  //
  // 详情页只打印一次：每次操作后重印会把整页往上顶一屏。菜单标题带着模型名，上下文不会丢。
  printModelDetail(config, modelId);

  for (;;) {
    const entry = readEntry(config, modelId);
    if (!entry) {
      view.log(t('tui.models.recordMissing', { modelId }));
      return;
    }
    const firstDir = entryVersions(entry)
      .map((v) => path.join(v.outDir || config.outDir, v.dirName || ''))
      .find(Boolean);
    const action = await pages.promptMenu(
      t('tui.models.actionPrompt', { name: modelLabel(config, modelId) }),
      [
        {
          title: t('tui.models.actionCheck'),
          value: 'update',
          description: t('tui.models.actionCheckDesc'),
        },
        {
          title: t('tui.app.menuVerify'),
          value: 'verify',
          description: t('tui.app.menuVerifyDesc'),
        },
        {
          title: t('tui.models.actionDownload'),
          value: 'download',
          description: t('tui.models.actionDownloadDesc'),
        },
        {
          title: entry.pinnedVersionId ? t('tui.manage.unpinAction') : t('tui.manage.pinAction'),
          value: 'pin',
          description: entry.pinnedVersionId ? t('tui.manage.unpinActionDesc') : t('tui.manage.pinActionDesc'),
        },
        {
          title: t('tui.models.actionOpenDir'),
          value: 'open',
          description: t('tui.models.actionOpenDirDesc', { dir: firstDir || config.outDir }),
        },
        {
          title: t('tui.models.menuForget'),
          value: 'forget',
          description: t('tui.models.menuForgetDesc'),
        },
        { title: t('tui.manage.back'), value: 'back' },
      ],
      { stage: t('tui.app.menuModels') }
    );
    if (action === null || action === 'back') return;
    if (action === 'update') {
      await checkFlow(config, { modelIds: [String(modelId)] });
      printModelDetail(config, modelId);
      continue;
    }
    if (action === 'verify') {
      await verifyFlow(config, { modelIds: [String(modelId)] });
      continue;
    }
    if (action === 'download') {
      await downloadFlow(config, { refs: [`model:${modelId}`] });
      printModelDetail(config, modelId);
      continue;
    }
    if (action === 'pin') {
      await togglePin(config, modelId);
      printModelDetail(config, modelId);
      continue;
    }
    if (action === 'open') {
      const dir = firstDir || config.outDir;
      if (view.openDir(dir)) view.log(t('tui.app.opened', { dir }));
      else view.log(t('tui.app.openFailed'));
      continue;
    }
    if (action === 'forget') return forgetFlow(config, { preset: [String(modelId)] });
  }
}

/**
 * Interactive library browser: list → detail page → action.
 * 交互式模型库浏览：列表 → 详情页 → 操作。
 *
 * @param {{skipFilter?:boolean}} [opts] `skipFilter` jumps straight to the library (used by the
 *   "本地模型管理" main-menu entry, where the picker's own search replaces the collection filter)
 */
async function browseFlow(config, opts = {}) {
  if (!opts.skipFilter) {
    const filter = await askCollectionFilter(config);
    if (!filter) return;
    return browseRows(config, filter.ids);
  }
  return browseRows(config, null);
}

/**
 * Library browser over an already-resolved row set.
 * 在已解析好的行集上浏览模型库。
 */
async function browseRows(config, collectionIds) {
  const rows = libraryRows(config, collectionIds);
  if (!rows.length) {
    // An empty library still gets a page: a log line alone looks like the key press did nothing.
    // 模型库为空时也给一页说明：只在日志里回一行会让人以为按键没生效。
    await pages.promptMessage(t('tui.app.menuModels'), [t('tui.models.noRecords'), '', t('tui.models.noRecordsHint')]);
    return;
  }
  view.log(t('tui.models.browseHint'));
  const chosen = await pages.pickOne(rows, {
    message: t('tui.models.browsePick'),
    title: t('tui.app.menuModels'),
    describe: describeRow,
    state: libraryEntries(config),
    onEnter: () => view.note(view.colors.dim(`  ${librarySummary(rows)}`)),
  });
  if (!chosen) return;
  return modelActions(config, String(chosen.modelId));
}

/**
 * Entry point of the local-model-management section: the model list, then one model's page.
 * 本地模型管理分区的入口：先看模型列表，再进入某个模型的页面。
 */
async function libraryFlow(config) {
  return browseFlow(config, { skipFilter: true });
}

// ---------------------------------------------------------------------------
// Check for updates
// 检查更新
// ---------------------------------------------------------------------------

/**
 * Check one or more models and offer to download the changes.
 * 检查一个或多个模型，并询问是否下载变化项。
 *
 * @param {{modelIds?:string[]}} [opts] preset targets (used by the detail page)
 */
async function checkFlow(config, opts = {}) {
  const ids = libraryModelIds(config);
  if (!ids.length) {
    view.log(t('tui.models.noRecords'));
    return;
  }

  let targets = Array.isArray(opts.modelIds) && opts.modelIds.length ? opts.modelIds.map(String) : null;
  if (!targets) {
    const scope = await pages.promptMenu(t('tui.models.checkScope'), [
      { title: t('tui.models.checkAll', { count: ids.length }), value: '__all__' },
      { title: t('tui.models.checkOne'), value: '__one__' },
    ]);
    if (scope === null) return;
    if (scope === '__all__') {
      targets = ids;
    } else {
      const picked = await pickModel(config, t('tui.models.checkPick'));
      if (!picked) return;
      targets = [picked];
    }
  }

  const mode = await pages.promptMenu(t('tui.check.modeTitle'), [
    { title: t('tui.check.modeQuick'), value: 'quick', description: t('tui.check.modeQuickDesc') },
    { title: t('tui.check.modeDeep'), value: 'deep', description: t('tui.check.modeDeepDesc') },
  ]);
  if (mode === null) return;

  const reports = [];
  for (const modelId of targets) {
    // Deep checks hash the local files: name the model being checked so a slow one is not "frozen".
    // 深度检查会计算本地文件哈希：把正在检查的模型报出来，慢的时候才不像卡死。
    view.log(t('tui.models.checkingModel', { label: view.truncateTo(modelLabel(config, modelId), 48) }));
    const { report } = await updater.checkModelUpdates(
      config,
      modelId,
      { verifyFiles: mode === 'deep' },
      { log: view.log }
    );
    report.stats = updater.summarize(report);
    reports.push(report);
    for (const line of updater.reportLines(report)) view.log(line);
  }

  const changes = reports.flatMap((report) => updater.changedItems(report));
  if (!changes.length) {
    view.bell();
    return;
  }

  const go = await pages.promptConfirm(t('tui.check.downloadConfirm', { count: changes.length }));
  if (!go) return;

  let failed = 0;
  for (const report of reports) {
    const plan = updater.changedItems(report);
    if (!plan.length) continue;
    const redownload = [...report.fileChanged, ...report.missing].map((r) => ({
      modelId: String(r.item.modelId),
      versionId:
        r.item.versionId === undefined || r.item.versionId === null ? null : String(r.item.versionId),
    }));
    const n = updater.markForRedownload(config, redownload);
    if (n) view.log(t('tui.check.stateReset', { count: n }));

    const totalBytes = plan.reduce((sum, item) => sum + (item.totalBytes || 0), 0);
    view.log(
      t('tui.models.startUpdate', {
        label: modelLabel(config, report.modelId),
        count: plan.length,
        size: formatBytes(totalBytes),
      })
    );
    const summary = await runWithProgress(config, {
      collectionId: `model-${report.modelId}`,
      name: modelLabel(config, report.modelId),
      plan,
      outDir: config.outDir,
      force: false,
      totalBytes,
      jobs: config.jobs,
      attempts: config.downloadAttempts,
    });
    if (summary.failed) failed++;
    const stats = { done: summary.done, skipped: summary.skipped, failed: summary.failed };
    view.log(summary.cancelled ? t('tui.check.summaryCancelled', stats) : t('tui.check.summaryDone', stats));
  }
  view.bell();
  if (failed) view.log(view.colors.red(t('tui.check.failedNotice')));
}

// ---------------------------------------------------------------------------
// Verify / repair
// 校验 / 修复
// ---------------------------------------------------------------------------

/**
 * Verify the local files of the library (or of the models a caller preset).
 * 校验模型库（或调用方预先指定的模型）的本地文件。
 *
 * @param {{modelIds?:string[]}} [opts] preset targets (used by the per-model page)
 */
async function verifyFlow(config, opts = {}) {
  const ids = libraryModelIds(config);
  if (!ids.length) {
    view.log(t('tui.models.noRecords'));
    return;
  }
  let targets = Array.isArray(opts.modelIds) && opts.modelIds.length ? opts.modelIds.map(String) : null;
  if (!targets) {
    const scope = await pages.promptMenu(t('tui.models.verifyPick'), [
      { title: t('tui.models.verifyAll', { count: ids.length }), value: '__all__' },
      { title: t('tui.models.checkOne'), value: '__one__' },
    ]);
    if (scope === null) return;
    targets = ids;
    if (scope === '__one__') {
      const picked = await pickModel(config, t('tui.models.checkPick'));
      if (!picked) return;
      targets = [picked];
    }
  }

  const deep = await pages.promptConfirm(t('tui.manage.hashConfirm'));
  if (deep === null) return;

  // Verification hashes every file, which can take minutes: report each model as it starts and let
  // the heartbeat keep the screen alive in between.
  //
  // 校验要逐个文件算哈希，可能好几分钟：每开始一个模型就报一行，中间的沉默由心跳补上。
  const result = await pages.withSpinner(
    t('tui.manage.verifying'),
    () =>
      verifyModels(config, targets, {
        noHash: !deep,
        onProgress: (info) =>
          view.log(
            t('tui.manage.verifyProgress', {
              index: info.index,
              total: info.total,
              name: view.truncateTo(info.name, 48),
            })
          ),
      }),
    { intervalMs: 15000 }
  );
  view.note('');
  view.note(
    t('tui.manage.verifySummary', {
      label: result.label,
      total: result.total,
      size: formatBytes(result.totalBytes),
    })
  );
  if (result.corrupt) view.note(`  ! ${result.corrupt}`);
  view.note(`  ${t('tui.manage.verifyCounts', { ok: result.ok.length, broken: result.broken.length })}`);
  for (const b of result.broken) {
    view.note(
      `  ! ${t('tui.manage.brokenLine', {
        name: b.name,
        reasons: b.reasons.join(t('tui.manage.reasonSeparator')),
      })}`
    );
    view.note(`    ${t('tui.manage.dirLine', { dir: b.dir })}`);
  }
  if (!result.broken.length) {
    view.notice(t('tui.manage.verifyAllOk'), view.colors.green);
    return;
  }

  const repair = await pages.promptConfirm(t('tui.manage.repairConfirm', { count: result.broken.length }));
  if (!repair) return;

  let failed = 0;
  for (const item of result.broken) {
    // Re-read the library every time: the previous repair already rewrote it
    // 每次都重读模型库：上一次修复已经改写过它
    const prev = readEntry(config, item.modelId);
    const versionRec = getVersion(prev, item.versionId);
    if (!prev || !versionRec) continue;
    const files = (item.brokenFiles || []).filter((f) => f.downloadUrl);
    if (!files.length) {
      view.log(t('tui.manage.skipNoUrl', { name: item.name }));
      continue;
    }
    const summary = await runWithProgress(config, {
      collectionId: `model-${item.modelId}`,
      name: prev.name || modelLabel(config, item.modelId),
      plan: [
        {
          modelId: item.modelId,
          name: prev.name,
          type: prev.type,
          baseModel: prev.baseModel,
          versionId: versionRec.versionId,
          versionName: versionRec.versionName,
          outDirOverride: versionRec.outDir || null,
          dirName: versionRec.dirName || null,
          files,
          totalBytes: files.reduce((sum, f) => sum + (f.bytes || 0), 0),
        },
      ],
      outDir: versionRec.outDir || config.outDir,
      force: true,
      totalBytes: files.reduce((sum, f) => sum + (f.bytes || 0), 0),
      jobs: 1,
      attempts: config.downloadAttempts,
    });
    if (summary.failed) failed++;
  }
  view.bell();
  if (failed) view.notice(t('tui.manage.repairFailed'), view.colors.red);
}

// ---------------------------------------------------------------------------
// Pin / unpin
// 固定 / 取消固定
// ---------------------------------------------------------------------------

/**
 * Toggle the pin of one library record: pick a version to pin, or clear the existing pin.
 * 切换一条记录的固定状态：选择要固定的版本，或取消已有固定。
 */
async function togglePin(config, modelId) {
  const entry = readEntry(config, modelId);
  const versions = entryVersions(entry);
  if (!versions.length) {
    view.log(t('tui.manage.noVersionId'));
    return;
  }
  const pinnedId = entry && entry.pinnedVersionId ? String(entry.pinnedVersionId) : null;

  if (pinnedId) {
    const unpin = await pages.promptConfirm(t('tui.models.unpinConfirm', { name: entry.name || modelId }), {
      initial: false,
    });
    if (!unpin) return;
    updater.setPin(config, modelId, null);
    view.notice(t('pin.unpinned', { name: entry.name || modelId }), view.colors.green);
    return;
  }

  const rows = versions.map((v) => {
    const files = v.files || [];
    return {
      modelId: String(v.versionId),
      name: String(v.versionName || v.versionId),
      type: entry.type || '',
      baseModel: v.baseModel || entry.baseModel || '',
      totalBytes: files.reduce((sum, f) => sum + (Number(f.bytes) || 0), 0),
      versionId: String(v.versionId),
      verifiedAt: v.verifiedAt || null,
      pinned: false,
    };
  });
  const chosen = await pages.pickOne(rows, {
    message: t('tui.models.pinVersionPick'),
    title: t('tui.models.pinVersionPick'),
    describe: (row) =>
      [
        t('tui.models.versionIdShort', { versionId: row.versionId }),
        formatBytes(row.totalBytes || 0),
        row.verifiedAt ? String(row.verifiedAt).slice(0, 10) : t('tui.manage.unknownTime'),
      ].join(view.separator()),
  });
  if (!chosen) return;

  const rec = getVersion(entry, chosen.versionId);
  updater.setPin(config, modelId, chosen.versionId);
  view.notice(
    t('pin.pinned', {
      name: entry.name || modelId,
      version: (rec && rec.versionName) || chosen.versionId,
    }),
    view.colors.green
  );
}

async function pinFlow(config) {
  const modelId = await pickModel(config, t('tui.models.pinPick'));
  if (!modelId) return;
  return togglePin(config, modelId);
}

// ---------------------------------------------------------------------------
// Delete records
// 删除记录
// ---------------------------------------------------------------------------

/**
 * Delete library records (optionally with their files).
 * 删除模型库记录（可选择同时删除文件）。
 *
 * @param {{preset?:string[]}} [opts] models preselected by the detail page
 */
async function forgetFlow(config, opts = {}) {
  const rows = libraryRows(config);
  if (!rows.length) {
    view.log(t('tui.models.noRecords'));
    return;
  }
  const preset = Array.isArray(opts.preset) ? opts.preset.map(String) : null;
  const chosen = preset
    ? rows.filter((row) => preset.includes(String(row.modelId)))
    : await pages.pickMany(rows, {
        message: t('tui.models.forgetPick'),
        title: t('tui.models.forgetPick'),
        describe: describeRow,
        state: libraryEntries(config),
      });
  if (chosen === null) return;
  if (!chosen.length) {
    view.log(t('tui.manage.noChanges'));
    return;
  }

  const confirm = await pages.promptConfirm(t('tui.models.forgetConfirm', { count: chosen.length }), {
    danger: true,
  });
  if (!confirm) {
    view.log(t('tui.manage.cancelled'));
    return;
  }
  const withFiles = await pages.promptConfirm(t('tui.models.forgetFilesConfirm'), { initial: false });
  if (withFiles === null) return;

  for (const row of chosen) {
    forgetModels(config, row.modelId, { deleteFiles: !!withFiles });
  }
}

// ---------------------------------------------------------------------------
// Entry point
// 入口
// ---------------------------------------------------------------------------

/**
 * Section home of local model management.
 *
 * The list is the important part (one row per locally known model, Enter opens that model's page),
 * and the two library-wide passes stay reachable next to it.
 *
 *
 * 「本地模型管理」的分区首页。
 *
 * 重点是那张列表（每个本地已知模型一行，回车进入该模型的页面），
 * 两个针对整个模型库的操作放在旁边，仍然可达。
 */
async function modelsFlow(config) {
  const action = await pages.promptMenu(
    t('tui.models.menuTitle'),
    [
      { title: t('tui.models.menuBrowse'), value: 'browse', description: t('tui.models.menuBrowseDesc') },
      { title: t('tui.models.menuCheck'), value: 'check', description: t('tui.models.menuCheckDesc') },
      { title: t('tui.models.menuVerify'), value: 'verify', description: t('tui.models.menuVerifyDesc') },
      { title: t('tui.manage.back'), value: 'back' },
    ],
    { stage: t('tui.app.menuModels') }
  );
  if (action === null || action === 'back') return;

  if (action === 'browse') return libraryFlow(config);
  if (action === 'check') return checkFlow(config);
  if (action === 'verify') return verifyFlow(config);
  return undefined;
}

module.exports = {
  modelsFlow,
  libraryFlow,
  // The "download models" entry of the download submenu calls this one through a lazy require.
  // 「下载」子菜单里的「下载模型」通过惰性 require 调用它。
  downloadFlow,
  modelActions,
  browseFlow,
  parseRefs,
  resolveRefs,
  chooseVersion,
  pickModel,
  libraryEntries,
  libraryModelIds,
  libraryRows,
  libraryRow,
  librarySummary,
  describeRow,
  describeVersion,
  versionRows,
  printModelDetail,
  togglePin,
  verifyFlow,
};
