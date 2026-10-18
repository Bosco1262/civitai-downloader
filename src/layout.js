'use strict';

/**
 * Directory layout rules of the model library: which folder a model type belongs to, how the
 * relative directory of a model is composed, and how file names of one version are resolved when
 * several versions share that directory.
 *
 * Everything here is a pure function, so the rules are unit-testable and the download job only has
 * to combine the result with the absolute download root and the long-path shortening.
 *
 *
 * 模型库的目录布局规则：某个类型落在哪个目录、某个模型的相对目录怎么拼，
 * 以及多个版本共用同一目录时文件名如何确定。
 *
 * 这里全部是纯函数，便于单测；下载流程只负责把结果与下载根目录、长路径缩短拼起来。
 */

const path = require('path');
const { sanitizeName, diskDirName, diskFileName } = require('./util');

/**
 * Supported layout presets (custom uses config.typeFolders).
 * 支持的布局预设（custom 使用 config.typeFolders）。
 */
const LAYOUTS = ['a1111', 'comfy', 'custom'];
/**
 * Layout used when the config does not say otherwise.
 * 配置未指定时使用的布局。
 */
const DEFAULT_LAYOUT = 'a1111';
/**
 * Folder used for unknown types and for types missing from a custom map.
 * 未知类型、以及 custom 映射里缺失的类型所用目录。
 */
const FALLBACK_FOLDER = 'other';
/**
 * Second-level folder used when the base model cannot be recognized.
 * 底模无法识别时使用的二级目录。
 */
const UNKNOWN_BASE_MODEL = 'unknown';

/**
 * Site type (lowercased) → first-level folder for each preset.
 * 站点类型（小写）→ 各预设的一级目录。
 */
const TYPE_FOLDERS = {
  a1111: {
    lora: 'Lora',
    locon: 'Lora',
    checkpoint: 'Stable-diffusion',
    textualinversion: 'embeddings',
    vae: 'VAE',
    controlnet: 'ControlNet',
    upscaler: 'ESRGAN',
    motionmodule: 'AnimateDiff',
    workflows: 'workflows',
  },
  comfy: {
    lora: 'loras',
    locon: 'loras',
    checkpoint: 'checkpoints',
    textualinversion: 'embeddings',
    vae: 'vae',
    controlnet: 'controlnet',
    upscaler: 'upscale_models',
    motionmodule: 'animatediff_models',
    workflows: 'workflows',
  },
};

/**
 * Normalize the layout name (unknown values fall back to the default preset).
 * 归一化布局名（未知值回落到默认预设）。
 */
function normalizeLayout(layout) {
  const value = String(layout === undefined || layout === null ? '' : layout)
    .trim()
    .toLowerCase();
  return LAYOUTS.includes(value) ? value : DEFAULT_LAYOUT;
}

/**
 * First-level folder of a model type.
 * 某个模型类型的一级目录。
 * @param {string} type site type, e.g. LORA / Checkpoint
 * @param {string} layout a1111 | comfy | custom
 * @param {Record<string,string>} [customMap] config.typeFolders (used by custom only)
 * @returns {string} a single directory segment
 */
function typeFolderFor(type, layout, customMap) {
  const name = String(type === undefined || type === null ? '' : type).trim();
  const mode = normalizeLayout(layout);

  if (mode === 'custom') {
    const map = customMap && typeof customMap === 'object' && !Array.isArray(customMap) ? customMap : {};
    let value = map[name];
    if (value === undefined) {
      const key = Object.keys(map).find((k) => String(k).toLowerCase() === name.toLowerCase());
      if (key !== undefined) value = map[key];
    }
    if (typeof value === 'string' && value.trim()) return sanitizeName(value.trim(), 0);
    return FALLBACK_FOLDER;
  }

  return TYPE_FOLDERS[mode][name.toLowerCase()] || FALLBACK_FOLDER;
}

/**
 * Second-level folder of a base model: the value exactly as the site reports it (case and spaces
 * preserved, illegal characters replaced), so one base model always maps to one folder name.
 * An empty or unusable value becomes "unknown": with baseModelLayer on the layer is always inserted.
 *
 * 底模的二级目录：直接使用站点给出的原值（保留大小写与空格，只替换非法字符），
 * 让同一个底模始终对应同一个目录名。空值或无法使用时记为 "unknown"：开启 baseModelLayer 时这一层始终存在。
 *
 * @param {string} baseModel
 * @returns {string}
 */
function baseModelFolder(baseModel) {
  const raw = String(baseModel === undefined || baseModel === null ? '' : baseModel).trim();
  if (!raw) return UNKNOWN_BASE_MODEL;

  const cleaned = sanitizeName(raw.replace(/\s+/g, ' '), 0);
  if (!cleaned || cleaned === 'unnamed') return UNKNOWN_BASE_MODEL;
  return cleaned;
}

/**
 * Normalize an arbitrary key the same way base-model names are normalized.
 * 用与底模名相同的方式归一化任意键。
 */
function normalizeKey(value) {
  return String(value === undefined || value === null ? '' : value)
    .toLowerCase()
    .replace(/[^a-z0-9]+/g, '-')
    .replace(/^-+|-+$/g, '');
}

/**
 * Compose the relative directory of a model (every version of that model lives here).
 * 拼出某个模型的相对目录（该模型的所有版本都放在这里）。
 * @param {{name?:string, type?:string, baseModel?:string, layout?:string, customMap?:object, baseModelLayer?:boolean}} input
 * @returns {string} relative path using "/" as separator
 */
function composeDirName(input = {}) {
  const segments = [typeFolderFor(input.type, input.layout, input.customMap)];
  if (input.baseModelLayer) segments.push(baseModelFolder(input.baseModel));
  segments.push(sanitizeName(input.name || 'unnamed'));
  return segments.join('/');
}

/**
 * Label of a version used for conflict renames: the sanitized version name, or v<versionId>.
 * 冲突重命名时使用的版本标签：清理后的版本名，缺省为 v<版本ID>。
 * @param {string} [versionName]
 * @param {string|number} [versionId]
 */
function versionLabel(versionName, versionId) {
  const fallback = versionId === undefined || versionId === null ? 'version' : `v${versionId}`;
  return sanitizeName(versionName || fallback, 0);
}

/**
 * Insert a version label before the last extension: model.safetensors becomes model-v2.safetensors,
 * a.b.ckpt becomes a.b-v2.ckpt. A name that already carries the label is returned unchanged (idempotent).
 *
 * 在最后一个扩展名前插入版本标签：model.safetensors 变为 model-v2.safetensors，
 * a.b.ckpt 变为 a.b-v2.ckpt；已带该标签的名字原样返回（幂等）。
 */
function withVersionSuffix(name, label) {
  const ext = path.extname(name);
  const stem = ext ? name.slice(0, name.length - ext.length) : name;
  if (String(stem).toLowerCase().endsWith(`-${String(label).toLowerCase()}`)) return name;
  return `${stem}-${label}${ext}`;
}

/**
 * Short tag of a version ID (last four digits) used to tell two identical version labels apart.
 * 版本 ID 的短标签（后 4 位），用于区分两个相同的版本标签。
 */
function shortVersionTag(versionId) {
  const digits = String(versionId).replace(/\D/g, '');
  return (digits.length > 4 ? digits.slice(-4) : digits) || String(versionId).slice(-4);
}

function fileKey(name) {
  return String(name === undefined || name === null ? '' : name).toLowerCase();
}

function shaOf(file) {
  return file && file.sha256 ? String(file.sha256).toUpperCase() : null;
}

/**
 * Whether two file records hold the same bytes: equal hashes, or equal sizes when a hash is missing.
 * 两条文件记录是否为同一份内容：哈希相同，或缺少哈希时大小相同。
 */
function sameFileContent(a, b) {
  const sa = shaOf(a);
  const sb = shaOf(b);
  if (sa && sb) return sa === sb;
  return Number.isFinite(a && a.bytes) && Number.isFinite(b && b.bytes) && a.bytes === b.bytes;
}

/**
 * Plan the on-disk names of one version's files inside the shared model directory.
 *
 * Rules:
 *  - a target name already used by another version with different content is a conflict;
 *  - on a conflict both sides are renamed: every file of the involved older versions, and every file
 *    of the incoming version, gets a "-<version label>" suffix (so a file name always maps to a version);
 *  - once the directory is in suffix mode (a sibling already carries its suffix), later versions keep
 *    the suffix even without a clash, so the naming style stays consistent inside one model folder;
 *  - same content means no conflict at all (the existing file is reused, see "verify when present");
 *  - already suffixed names are left alone (idempotent).
 *
 *
 * 规划某个版本的文件在共用的模型目录里的磁盘名。
 *
 * 规则：
 *  - 目标名已被「内容不同的其它版本」占用即为冲突；
 *  - 冲突时双方都改名：涉及的旧版本的全部文件、以及本次版本的全部文件，
 *    统一加 "-<版本标签>" 后缀（让文件名能对应到版本）；
 *  - 内容相同则不算冲突（直接复用已存在的文件，走「已存在则校验」）；
 *  - 已带后缀的名字不再重复追加（幂等）。
 * @param {{dir?:string, version?:{versionId:string|number, versionName?:string, files?:Array<object>}, entries?:Array<object>}} input
 * @returns {{names:Array<{remoteName:string,diskName:string,renamed:boolean}>, renames:Array<{versionId:string,from:string,to:string}>, conflict:boolean, suffixMode:boolean, labels:Record<string,string>}}
 */
function planFileNames(input = {}) {
  const dir = input.dir || '';
  const version = input.version || {};
  const files = Array.isArray(version.files) ? version.files : [];
  const others = (Array.isArray(input.entries) ? input.entries : []).filter(
    (entry) => entry && String(entry.versionId) !== String(version.versionId)
  );

  const wanted = files.map((f) => {
    const remoteName = f.remoteName || f.name || 'unnamed';
    return {
      remoteName,
      diskName: diskFileName(dir, f.name || remoteName),
      sha256: shaOf(f),
      bytes: Number.isFinite(f.bytes) ? f.bytes : null,
    };
  });

  // Which other versions own a name this version wants, with different content?
  // 哪些其它版本占用了本次想要的名字，且内容不同？
  const involved = new Map();
  for (const w of wanted) {
    for (const other of others) {
      for (const f of other.files || []) {
        if (fileKey(f.name) !== fileKey(w.diskName)) continue;
        if (sameFileContent(f, w)) continue;
        involved.set(String(other.versionId), other);
      }
    }
  }

  // Once a directory is in "suffix mode" (some sibling already carries its version suffix), later
  // versions keep the same style even when their own names do not clash, so every file stays traceable.
  //
  // 目录一旦进入「后缀模式」（某个同级版本的文件已带自己的版本后缀），
  // 之后的新版本即使不撞名也沿用同样风格，保证每个文件都能对应到版本。
  const alreadySuffixed = others.some((other) =>
    (other.files || []).some((f) => {
      const name = f.name || f.remoteName;
      // A file already carrying its own version label makes the whole directory "suffix mode".
      // 文件已经带上自己的版本标签，说明该目录已进入「后缀模式」。
      return withVersionSuffix(name, versionLabel(other.versionName, other.versionId)) === name;
    })
  );
  const suffixMode = involved.size > 0 || alreadySuffixed;

  if (!suffixMode) {
    return {
      names: wanted.map((w) => ({ remoteName: w.remoteName, diskName: w.diskName, renamed: false })),
      renames: [],
      conflict: false,
      suffixMode: false,
      labels: {},
    };
  }

  // Labels of every involved version (the incoming one included); identical labels get a numeric tag
  // 所有涉及版本的标签（含本次版本）；标签相同时追加数字短标签
  const participants = [
    ...involved.values(),
    { versionId: version.versionId, versionName: version.versionName },
  ];
  const bases = participants.map((v) => [String(v.versionId), versionLabel(v.versionName, v.versionId)]);
  const labels = {};
  for (const [id, label] of bases) {
    const clash = bases.some(([otherId, otherLabel]) => otherId !== id && otherLabel.toLowerCase() === label.toLowerCase());
    labels[id] = clash ? `${label}-${shortVersionTag(id)}` : label;
  }

  const renames = [];
  for (const other of involved.values()) {
    const label = labels[String(other.versionId)];
    for (const f of other.files || []) {
      const from = f.name || f.remoteName;
      const to = withVersionSuffix(from, label);
      if (to !== from) renames.push({ versionId: String(other.versionId), from, to });
    }
  }

  return {
    names: wanted.map((w) => ({
      remoteName: w.remoteName,
      diskName: withVersionSuffix(w.diskName, labels[String(version.versionId)]),
      renamed: true,
    })),
    renames,
    conflict: involved.size > 0,
    suffixMode: true,
    labels,
  };
}

/**
 * Shorten a relative directory segment by segment until it fits the Windows path limit.
 * Segment-wise on purpose: sanitizing the whole string would turn the separators into "_".
 *
 * 逐段缩短相对目录，使其不超过 Windows 路径上限。
 * 必须逐段处理：整体 sanitize 会把分隔符变成 "_"。
 * @param {string} parentDir absolute parent directory
 * @param {string} dirName relative directory using "/" as separator
 * @param {string|number} [uniqueKey] used for the short hash when a segment is truncated
 * @returns {string}
 */
function fitDirName(parentDir, dirName, uniqueKey) {
  const parts = String(dirName)
    .split('/')
    .filter(Boolean);
  const out = [];
  let current = parentDir;
  for (let i = 0; i < parts.length; i++) {
    const last = i === parts.length - 1;
    const key = last ? uniqueKey : `${uniqueKey}:${parts[i]}`;
    // Only the last segment needs headroom for the file name inside it
    // 只有最后一段需要为里面的文件名预留空间
    const fitted = diskDirName(current, parts[i], key, last ? 60 : 0);
    out.push(fitted);
    current = path.join(current, fitted);
  }
  return out.join('/');
}

module.exports = {
  LAYOUTS,
  DEFAULT_LAYOUT,
  FALLBACK_FOLDER,
  UNKNOWN_BASE_MODEL,
  TYPE_FOLDERS,
  normalizeLayout,
  typeFolderFor,
  baseModelFolder,
  composeDirName,
  versionLabel,
  withVersionSuffix,
  planFileNames,
  sameFileContent,
  fitDirName,
};
