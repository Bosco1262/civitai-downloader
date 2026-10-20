'use strict';

/**
 * One place that chooses between the shell presentation and the plain fallback.
 *
 * Flows should call `present({ shell, plain })` instead of branching on `screen.isActive()`. The two
 * presenters may still share a data model; this helper only centralizes the mode decision.
 *
 *
 * 选择外壳呈现或普通回退的唯一位置。
 *
 * 流程应调用 `present({ shell, plain })`，而不是各自判断 `screen.isActive()`。
 * 两个呈现器仍可共享数据模型；本助手只集中模式选择。
 */

const screen = require('./screen');

/**
 * Run the shell or plain presenter.
 * 运行外壳或普通呈现器。
 *
 * @param {{shell:Function, plain:Function}} presenters
 * @returns {any}
 */
function present(presenters) {
  return (screen.isActive() ? presenters.shell : presenters.plain)();
}

module.exports = { present };
