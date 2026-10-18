'use strict';

/**
 * pin: pin a model to a given version (by default the newest recorded one).
 *
 * The library is the only source of truth, so a model is addressed directly:
 *  - pin <modelId> [versionId]        (model:<modelId> is accepted as well)
 *  - pin <modelId> --list / --unpin
 *  - pin --list                       every pinned model of the library
 *
 *
 * pin：把某个模型固定在指定（默认当前最新记录的）版本。
 *
 * 模型库是唯一事实源，因此直接按模型定位：
 *  - pin <模型ID> [版本ID]        （也接受 model:<模型ID> 写法）
 *  - pin <模型ID> --list / --unpin
 *  - pin --list                   模型库里全部已固定的模型
 */

const { log } = require('../util');
const { readLibrary, entryVersions, newestVersion, getVersion } = require('../storage');
const { setPin } = require('../updater');
const { parseModelRef } = require('../urls');
const { t } = require('../i18n');

function usage() {
  console.error(t('pin.usage'));
  process.exitCode = 1;
}

/**
 * Resolve a positional argument into a model ID (a bare number is a model ID now).
 * 把位置参数解析为模型 ID（现在纯数字就是模型 ID）。
 * @returns {{modelId:string}|null}
 */
function resolveTarget(input) {
  const m = /^(?:model[:\-])?(\d+)$/i.exec(String(input === undefined || input === null ? '' : input).trim());
  if (m) return { modelId: m[1] };
  const ref = parseModelRef(input);
  if (ref && ref.modelId) return { modelId: String(ref.modelId) };
  return null;
}

function pinnedEntries(entries) {
  return Object.entries(entries).filter(([, v]) => v && v.pinnedVersionId);
}

/**
 * List the pinned models of the library (one model, or the whole library).
 * 列出模型库中已固定的模型（单个模型，或整个模型库）。
 */
function listPins(config, modelId) {
  const { entries } = readLibrary(config, { allowCorrupt: true });
  const all = Object.entries(entries);
  const selected = modelId ? all.filter(([id]) => String(id) === String(modelId)) : all;
  const pins = pinnedEntries(entries).filter(([id]) => !modelId || String(id) === String(modelId));

  console.log('');
  if (modelId) {
    const versions = selected.reduce((sum, [, v]) => sum + entryVersions(v).length, 0);
    console.log(t('pin.modelListHeader', { modelId, versions, pinned: pins.length }));
  } else {
    console.log(t('pin.listHeader', { total: all.length, pinned: pins.length }));
  }
  for (const [id, v] of pins) {
    const rec = getVersion(v, v.pinnedVersionId);
    console.log(
      t('pin.listItem', {
        name: v.name || t('pin.modelIdLabel', { modelId: id }),
        version: (rec && rec.versionName) || v.pinnedVersionId,
      })
    );
  }
  if (!pins.length) console.log(t('pin.emptyHint'));
  return pins.length;
}

async function main(config, args) {
  const positionals = args.positionals || [];

  if (!positionals.length) {
    if (!args.flags.list) return usage();
    return listPins(config, null);
  }

  const target = resolveTarget(positionals[0]);
  if (!target) {
    console.error(t('pin.invalidTarget', { value: positionals[0] }));
    return usage();
  }
  const modelId = target.modelId;
  // positionals[1] is the versionId (the collection prefix is gone)
  // positionals[1] 就是版本号（收藏集前缀已取消）
  const explicitVersion = positionals[1] !== undefined ? String(positionals[1]) : null;

  if (args.flags.list) return listPins(config, modelId);

  const { entries } = readLibrary(config);
  const entry = entries[modelId];
  if (!entry) {
    console.error(t('pin.modelNoRecord', { modelId }));
    process.exitCode = 1;
    return;
  }

  if (args.flags.unpin) {
    setPin(config, modelId, null);
    log(t('pin.unpinned', { name: entry.name || modelId }));
    return;
  }

  const newest = newestVersion(entry);
  const versionId = explicitVersion || (newest && String(newest.versionId)) || entry.pinnedVersionId;
  if (!versionId) {
    console.error(t('pin.noVersion'));
    process.exitCode = 1;
    return;
  }
  const rec = getVersion(entry, versionId);
  setPin(config, modelId, versionId);
  log(
    t('pin.pinned', {
      name: entry.name || modelId,
      version: (rec && rec.versionName) || versionId,
    })
  );
}

module.exports = { main, usage, resolveTarget, listPins };
