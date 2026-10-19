'use strict';

/**
 * Tests for the desired-state version diff.
 * 期望状态版本差异的测试。
 */

const test = require('node:test');
const assert = require('node:assert/strict');

const selection = require('../src/tui/ui/versionSelection');

test('versionSelection: 保留/下载/删除/跳过', () => {
  const installed = [
    { versionId: '1', versionName: 'v1', files: [{ name: 'a', bytes: 10 }] },
    { versionId: '2', versionName: 'v2', files: [{ name: 'b', bytes: 20 }] },
    { versionId: '3', versionName: 'v3', files: [] },
  ];
  const diff = selection.versionDiff(installed, ['1', '3', '9']);
  assert.deepEqual(diff.keep.map((version) => version.versionId), ['1']);
  assert.deepEqual(diff.delete.map((version) => version.versionId), ['2']);
  assert.deepEqual(diff.download.map((version) => version.versionId), ['3']);
  assert.deepEqual(diff.skip.map((version) => version.versionId), []);
  assert.equal(diff.deleteBytes, 20);
});
