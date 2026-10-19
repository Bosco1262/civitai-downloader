'use strict';

/**
 * Tests for the semantic design tokens.
 *
 * The token module is the single place where colors, glyphs, spacing, breakpoints and date formats are
 * defined. These tests pin the compatibility aliases used by Phase 1 and make sure the glyph getters
 * still follow CIVITAI_ASCII after the module has been loaded.
 *
 *
 * 语义设计令牌的测试。
 *
 * 令牌模块是颜色、字符、间距、断点与日期格式的唯一来源。这些测试固定 Phase 1 使用的兼容别名，
 * 并确认模块加载之后字符 getter 仍然跟随 CIVITAI_ASCII。
 */

const test = require('node:test');
const assert = require('node:assert/strict');

const layout = require('../src/tui/layout');
const tokens = require('../src/tui/tokens');
const { formatBytes, formatDuration } = require('../src/util');

test('tokens: 日期格式复现此前的截断行为', () => {
  const iso = '2026-10-02T03:04:05.000Z';
  assert.equal(tokens.format.date(iso), '2026-10-02');
  assert.equal(tokens.format.dateTime(iso), '2026-10-02 03:04');
  assert.equal(tokens.format.dateTimeFull(iso), '2026-10-02 03:04:05');
  assert.equal(tokens.format.date(null), '');
  assert.equal(tokens.format.dateTime(undefined), '');
  assert.equal(tokens.format.dateTimeFull(''), '');
});

test('tokens: 字节与时长复用 util 的实现', () => {
  assert.equal(tokens.format.bytes(2048), formatBytes(2048));
  assert.equal(tokens.format.duration(125), formatDuration(125));
});

test('tokens: 语义颜色保持现有视觉映射', () => {
  assert.equal(tokens.color.muted, layout.colors.dim);
  assert.equal(tokens.color.emphasis, layout.colors.bold);
  assert.equal(tokens.color.accent, layout.colors.cyan);
  assert.equal(tokens.color.success, layout.colors.green);
  assert.equal(tokens.color.warning, layout.colors.yellow);
  assert.equal(tokens.color.danger, layout.colors.red);
  assert.equal(tokens.color.cursor, layout.colors.cyan);
  assert.equal(tokens.color.selection, layout.colors.reverse);
  assert.equal(tokens.color.text('plain'), 'plain');
});

test('tokens: 任务状态颜色保持现有映射', () => {
  assert.equal(tokens.status.running, tokens.color.success);
  assert.equal(tokens.status.done, tokens.color.accent);
  assert.equal(tokens.status.queued, tokens.color.warning);
  assert.equal(tokens.status.cancelled, tokens.color.warning);
  assert.equal(tokens.status.failed, tokens.color.danger);
});

test('tokens: 字符 getter 跟随运行时字符集', () => {
  const previous = process.env.CIVITAI_ASCII;
  try {
    process.env.CIVITAI_ASCII = '1';
    assert.equal(tokens.glyph.cursor, '>');
    assert.equal(tokens.glyph.bullet, '*');
    delete process.env.CIVITAI_ASCII;
    assert.equal(tokens.glyph.cursor, layout.glyphs().cursor);
    assert.equal(tokens.glyph.bullet, layout.glyphs().bullet);
    assert.equal(tokens.glyph.failure, '!');
    assert.equal(tokens.glyph.placeholder, '--');
  } finally {
    if (previous === undefined) delete process.env.CIVITAI_ASCII;
    else process.env.CIVITAI_ASCII = previous;
  }
});

test('tokens: 间距与断点是冻结的共享常量', () => {
  assert.equal(tokens.space.rowIndent, 2);
  assert.equal(tokens.space.labelGap, 2);
  assert.equal(tokens.breakpoint.narrow, 54);
  assert.equal(tokens.breakpoint.compact, 72);
  assert.equal(tokens.breakpoint.wide, 100);
  assert.ok(Object.isFrozen(tokens.space));
  assert.ok(Object.isFrozen(tokens.breakpoint));
});
