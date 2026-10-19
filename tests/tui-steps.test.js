'use strict';

/**
 * Tests for linear flow steps.
 * 线性流程步骤的测试。
 */

const test = require('node:test');
const assert = require('node:assert/strict');

const steps = require('../src/tui/ui/steps');

test('steps: 创建、前进、后退与窄屏退化', () => {
  const flow = steps.createSteps([
    { key: 'select', label: '选择' },
    { key: 'confirm', label: '确认' },
    { key: 'receipt', label: '回执' },
  ]);
  assert.equal(flow.current.key, 'select');
  flow.next();
  assert.equal(flow.current.key, 'confirm');
  flow.previous();
  assert.equal(flow.current.key, 'select');
  assert.ok(steps.stepLine(flow, 100).includes('选择'));
  assert.ok(steps.stepLine(flow, 50).includes('步骤 1/3 选择'));
});
