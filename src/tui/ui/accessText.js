'use strict';

/**
 * Presentation helpers for paid/restricted model versions.
 * 付费/受限模型版本的展示辅助。
 */

const { t } = require('../../i18n');
const { color, format } = require('./tokens');

/**
 * Compact label used in lists and version rows.
 * 列表与版本行使用的紧凑标签。
 */
function accessLabel(access) {
  if (!access) return '';
  if (access.kind === 'unavailable') return t('tui.access.unavailable');
  if (access.kind === 'early-access') {
    if (access.mixed) return t('tui.access.earlyFree');
    return access.earlyAccessEndsAt
      ? t('tui.access.earlyUntil', { date: format.date(access.earlyAccessEndsAt) })
      : t('tui.access.early');
  }
  if (access.kind === 'paid') {
    if (access.mixed) return t('tui.access.paidFree');
    return access.endsAt
      ? t('tui.access.paidUntil', { date: format.date(access.endsAt) })
      : t('tui.access.paid');
  }
  if (access.reason === 'paid-expired') return t('tui.access.paidExpired');
  return '';
}

/**
 * Semantic colour of an access label.
 * 访问标签的语义色。
 */
function accessColor(access) {
  if (!access) return (text) => text;
  if (access.kind === 'unavailable') return color.danger;
  if (access.requiresEntitlement) return color.warning;
  return color.muted;
}

module.exports = {
  accessLabel,
  accessColor,
};
