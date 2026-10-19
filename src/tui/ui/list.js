'use strict';

/**
 * Shared list navigation policies.
 *
 * Menus and forms wrap at both ends; data tables clamp so a long result list never jumps from the
 * last row back to the first. The policy lives here instead of in every page.
 *
 *
 * 共享列表导航策略。
 *
 * 菜单与表单在两端循环；数据表夹紧，长结果列表不会从末行跳回首行。
 * 策略集中在这里，而不是每个页面各写一份。
 */

const LIST_KINDS = Object.freeze({
  menu: Object.freeze({ wrap: true, pageStep: 10 }),
  form: Object.freeze({ wrap: true, pageStep: 10 }),
  table: Object.freeze({ wrap: false, pageStep: 0 }),
});

/**
 * Resolve a policy by name, defaulting to the menu policy.
 * 按名称取策略，默认使用菜单策略。
 *
 * @param {string|object} kind
 * @returns {{wrap:boolean,pageStep:number}}
 */
function policyOf(kind) {
  if (kind && typeof kind === 'object') return kind;
  return LIST_KINDS[kind] || LIST_KINDS.menu;
}

/**
 * Move the cursor by `delta`, wrapping or clamping according to the policy.
 * 按策略移动光标：循环或夹紧。
 *
 * @param {number} cursor
 * @param {number} delta
 * @param {number} count
 * @param {string|object} [kind]
 * @returns {number}
 */
function moveCursor(cursor, delta, count, kind = 'menu') {
  const total = Math.max(0, Math.floor(Number(count) || 0));
  if (!total) return 0;
  const policy = policyOf(kind);
  const current = Math.max(0, Math.min(total - 1, Math.floor(Number(cursor) || 0)));
  if (policy.wrap) return (((current + delta) % total) + total) % total;
  return Math.max(0, Math.min(total - 1, current + delta));
}

/**
 * Page up/down. Tables use the supplied page size; menus/forms use their fixed page step.
 * 向上/向下翻页。数据表使用传入的页大小；菜单/表单使用固定步长。
 *
 * @param {number} cursor
 * @param {number} direction -1 for up, 1 for down
 * @param {number} count
 * @param {number} pageSize
 * @param {string|object} [kind]
 * @returns {number}
 */
function pageCursor(cursor, direction, count, pageSize, kind = 'menu') {
  const policy = policyOf(kind);
  const step = policy.pageStep > 0 ? policy.pageStep : Math.max(1, Math.floor(Number(pageSize) || 1));
  return moveCursor(cursor, direction * step, count, kind);
}

function homeCursor() {
  return 0;
}

function endCursor(count) {
  return Math.max(0, Math.floor(Number(count) || 0) - 1);
}

/**
 * Visible slice that keeps the cursor on screen and only scrolls when it leaves the window.
 * 让光标保持在屏幕内的可见区间，只有光标离开视窗时才滚动。
 *
 * @param {number} count
 * @param {number} cursor
 * @param {number} size
 * @param {number} [previousStart]
 * @returns {{start:number,end:number,cursor:number}}
 */
function windowOf(count, cursor, size, previousStart = 0) {
  const total = Math.max(0, Math.floor(Number(count) || 0));
  const room = Math.max(1, Math.floor(Number(size) || 1));
  const clamped = Math.max(0, Math.min(Math.max(0, total - 1), Math.floor(Number(cursor) || 0)));
  const maxStart = Math.max(0, total - room);
  let start = Math.max(0, Math.min(Math.floor(Number(previousStart) || 0), maxStart));
  if (clamped < start) start = clamped;
  else if (clamped >= start + room) start = clamped - room + 1;
  start = Math.max(0, Math.min(start, maxStart));
  return { start, end: Math.min(total, start + room), cursor: clamped };
}

module.exports = {
  LIST_KINDS,
  policyOf,
  moveCursor,
  pageCursor,
  homeCursor,
  endCursor,
  windowOf,
};
