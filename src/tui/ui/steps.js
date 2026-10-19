'use strict';

/**
 * Linear flow steps shown next to the breadcrumb, e.g. select -> confirm -> receipt.
 * 当前步骤高亮，已完成步骤 dim，未开始步骤更暗；窄终端折叠为编号步骤。
 */

const layout = require('../layout');
const tokens = require('../tokens');

const { color } = tokens;

/**
 * Create a step flow. `steps` is an ordered list of `{key, label}`.
 * 创建步骤流。`steps` 是有序的 `{key, label}` 列表。
 *
 * @param {Array<{key:string,label:string}>} steps
 * @param {number} [initialIndex]
 */
function createSteps(steps, initialIndex = 0) {
  const list = Array.isArray(steps) ? steps.filter(Boolean) : [];
  let index = Math.max(0, Math.min(list.length - 1, Math.floor(Number(initialIndex) || 0)));

  return {
    get steps() {
      return list;
    },
    get index() {
      return index;
    },
    get current() {
      return list[index] || null;
    },
    goto(nextIndex) {
      index = Math.max(0, Math.min(list.length - 1, Math.floor(Number(nextIndex) || 0)));
      return index;
    },
    next() {
      return this.goto(index + 1);
    },
    previous() {
      return this.goto(index - 1);
    },
  };
}

/**
 * Render the step trail for a terminal width.
 * 按终端宽度渲染步骤条。
 *
 * @param {object} flow
 * @param {number} width
 * @returns {string}
 */
function stepLine(flow, width) {
  const list = Array.isArray(flow) ? flow : flow && flow.steps ? flow.steps : [];
  const index = Array.isArray(flow) ? 0 : flow.index;
  if (!list.length || !list[index]) return '';
  const narrow = Math.floor(Number(width) || 0) < tokens.breakpoint.compact;
  if (narrow) {
    return color.accent(`步骤 ${index + 1}/${list.length} ${list[index].label}`);
  }
  const parts = list.map((step, position) => {
    if (position < index) return color.muted(step.label);
    if (position > index) return color.muted(step.label);
    return color.accent(step.label);
  });
  return `[${parts.join(layout.glyphs().separator)}]`;
}

module.exports = {
  createSteps,
  stepLine,
};
