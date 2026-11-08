'use strict';

/**
 * Paid, restricted and public access classification for model versions.
 *
 * Civitai marks paid versions with a version-level `paidAccess` object. Model-level
 * `hasActivePaidAccess` only says that some version of the model is paid; it must not be used to
 * lock every version. `status: Published` and `availability: Public` are also not proof that a
 * version is free.
 *
 *
 * 模型版本的付费、受限与公开访问分类。
 *
 * C 站用版本级 `paidAccess` 标记付费版本。模型级 `hasActivePaidAccess` 只表示该模型包含付费
 * 版本，不能据此锁住所有版本；`status: Published` 与 `availability: Public` 同样不能证明免费。
 */

const PAID = 'paid';
const EARLY_ACCESS = 'early-access';
const UNAVAILABLE = 'unavailable';
const PUBLIC = 'public';

/**
 * Parse a timestamp; null when the value is missing or invalid.
 * 解析时间戳；缺失或非法时返回 null。
 */
function parseTime(value) {
  if (!value) return null;
  const time = new Date(value).getTime();
  return Number.isFinite(time) ? time : null;
}

/**
 * Classify one online model version.
 *
 * The result separates static access requirements from runtime entitlement. The public API does not
 * expose whether the current account purchased the version, so `requiresEntitlement` means "the site
 * may require purchase", not "the user has not purchased".
 *
 *
 * 分类一个线上模型版本。
 *
 * 结果把静态访问要求与运行时权限分开。公开 API 不提供“当前账号是否已购买”的信息，因此
 * `requiresEntitlement` 表示“站点可能要求购买”，不是“用户尚未购买”。
 *
 * @param {object|null} version model-version object
 * @param {object|null} [model] parent model (kept for future fields; not used for per-version access)
 * @param {{now?:Date|number|string}} [opts]
 * @returns {{
 *   kind:'public'|'paid'|'early-access'|'unavailable',
 *   reason:string,
 *   paid:boolean,
 *   permanent:boolean,
 *   endsAt:string|null,
 *   earlyAccessEndsAt:string|null,
 *   requiresEntitlement:boolean,
 *   defaultSelected:boolean,
 *   modelHasPaidVersions:boolean
 * }}
 */
function classifyVersionAccess(version, model = null, opts = {}) {
  const nowRaw = opts.now === undefined ? Date.now() : opts.now;
  const now = nowRaw instanceof Date ? nowRaw.getTime() : parseTime(nowRaw) || Date.now();
  const src = version || {};
  const paidAccess = src.paidAccess && typeof src.paidAccess === 'object' ? src.paidAccess : null;
  const base = {
    paid: false,
    permanent: false,
    endsAt: null,
    earlyAccessEndsAt: null,
    requiresEntitlement: false,
    defaultSelected: true,
    modelHasPaidVersions: !!(model && model.hasActivePaidAccess),
  };

  if (src.status && String(src.status) !== 'Published') {
    return {
      ...base,
      kind: UNAVAILABLE,
      reason: 'unpublished',
      defaultSelected: false,
    };
  }
  if (src.usageControl && String(src.usageControl) !== 'Download') {
    return {
      ...base,
      kind: UNAVAILABLE,
      reason: 'download-disabled',
      defaultSelected: false,
    };
  }

  if (paidAccess) {
    const permanent = paidAccess.permanent === true;
    const endsAt = paidAccess.endsAt || null;
    const endsAtMs = parseTime(endsAt);
    if (permanent || !endsAt) {
      return {
        ...base,
        kind: PAID,
        reason: 'paid',
        paid: true,
        permanent,
        endsAt,
        requiresEntitlement: true,
        defaultSelected: false,
      };
    }
    if (endsAtMs !== null && endsAtMs > now) {
      return {
        ...base,
        kind: PAID,
        reason: 'paid-window',
        paid: true,
        permanent: false,
        endsAt,
        requiresEntitlement: true,
        defaultSelected: false,
      };
    }
    return {
      ...base,
      kind: PUBLIC,
      reason: 'paid-expired',
      paid: true,
      permanent: false,
      endsAt,
    };
  }

  const earlyEndsAt = src.earlyAccessEndsAt || null;
  const earlyEndMs = parseTime(earlyEndsAt);
  const availability = String(src.availability || '');
  if (
    availability === 'EarlyAccess' ||
    (earlyEndMs !== null && earlyEndMs > now)
  ) {
    return {
      ...base,
      kind: EARLY_ACCESS,
      reason: 'early-access',
      earlyAccessEndsAt: earlyEndsAt,
      requiresEntitlement: true,
      defaultSelected: false,
    };
  }

  return { ...base, kind: PUBLIC, reason: 'public' };
}

/**
 * Summarize the access states of every known version of one model.
 *
 * Used for the row badge only: `mixed` says "this model has both restricted and free versions",
 * while the default selection of a row follows its default version, never this summary.
 *
 *
 * 汇总一个模型全部已知版本的访问状态。
 *
 * 只用于行徽标：`mixed` 表示「既有受限版本又有免费版本」；行的默认勾选跟随本行默认版本，
 * 与这份汇总无关。
 *
 * @param {Array<object|null|undefined>} accessList
 * @returns {{
 *   total:number,
 *   free:number,
 *   paid:number,
 *   early:number,
 *   unavailable:number,
 *   restricted:number,
 *   mixed:boolean
 * }}
 */
function summarizeAccess(accessList) {
  const list = Array.isArray(accessList) ? accessList : [];
  let free = 0;
  let paid = 0;
  let early = 0;
  let unavailable = 0;
  for (const access of list) {
    const kind = access && access.kind;
    if (kind === PAID) paid++;
    else if (kind === EARLY_ACCESS) early++;
    else if (kind === UNAVAILABLE) unavailable++;
    // `public` and an expired paid window are both downloadable without entitlement today.
    // `public` 与「付费期已结束」当下都不需要权限，一律算免费。
    else free++;
  }
  const restricted = paid + early;
  return {
    total: list.length,
    free,
    paid,
    early,
    unavailable,
    restricted,
    mixed: restricted > 0 && free > 0,
  };
}

/**
 * Whether a plan item is known to require purchase/access.
 * 判断计划项是否已知需要购买或访问权限。
 */
function requiresEntitlement(item) {
  return !!(item && item.access && item.access.requiresEntitlement);
}

/**
 * Whether a plan item is statically unavailable (not merely paid).
 * 判断计划项是否静态不可下载（不仅仅是付费）。
 */
function isUnavailable(item) {
  return !!(item && item.access && item.access.kind === UNAVAILABLE);
}

module.exports = {
  PAID,
  EARLY_ACCESS,
  UNAVAILABLE,
  PUBLIC,
  classifyVersionAccess,
  summarizeAccess,
  requiresEntitlement,
  isUnavailable,
  parseTime,
};
