'use strict';

/**
 * Tests for the shared list navigation policies.
 * 共享列表导航策略的测试。
 */

const test = require('node:test');
const assert = require('node:assert/strict');

const list = require('../src/tui/ui/list');

test('list: 菜单循环、表格夹紧', () => {
  assert.equal(list.moveCursor(0, -1, 3, 'menu'), 2);
  assert.equal(list.moveCursor(2, 1, 3, 'menu'), 0);
  assert.equal(list.moveCursor(0, -1, 3, 'table'), 0);
  assert.equal(list.moveCursor(2, 1, 3, 'table'), 2);
});

test('list: 翻页步长与夹紧', () => {
  assert.equal(list.pageCursor(0, 1, 100, 15, 'menu'), 10);
  assert.equal(list.pageCursor(0, 1, 100, 15, 'table'), 15);
  assert.equal(list.pageCursor(98, 1, 100, 15, 'table'), 99);
});

test('list: 首尾与视窗', () => {
  assert.equal(list.homeCursor(), 0);
  assert.equal(list.endCursor(5), 4);
  assert.deepEqual(list.windowOf(20, 0, 5, 0), { start: 0, end: 5, cursor: 0 });
  assert.deepEqual(list.windowOf(20, 6, 5, 0), { start: 2, end: 7, cursor: 6 });
  assert.deepEqual(list.windowOf(20, 19, 5, 10), { start: 15, end: 20, cursor: 19 });
  assert.deepEqual(list.windowOf(0, 0, 5, 0), { start: 0, end: 0, cursor: 0 });
});
