'use strict';

/**
 * Unit tests for the pure logic of src/tui/select.js.
 * Run directly: node tests/select.test.js
 * This sandbox forbids pipes/redirection, so `node --test` is not used.
 * Only functions without terminal side effects are covered here (filter / sort / paging /
 * selection sets / cursor / row rendering); the interactive selectItems() layer needs a real TTY
 * and is out of scope for the unit tests.
 *
 * src/tui/select.js 的纯逻辑层测试。
 * 直接运行：node tests/select.test.js
 * （本会话沙箱禁止管道/重定向，因此不使用 `node --test`。）
 * 这里只覆盖无终端副作用的函数（过滤 / 排序 / 分页 / 选择集合 / 光标 / 行渲染），
 * 交互层 selectItems() 需要真实 TTY，不在单测范围内。
 */

const test = require('node:test');
const assert = require('node:assert/strict');

const select = require('../src/tui/select');
const view = require('../src/tui/view');

function item(over = {}) {
  return {
    modelId: 1,
    name: 'model',
    type: 'Checkpoint',
    baseModel: 'SD 1.5',
    totalBytes: 1024,
    ...over,
  };
}

/**
 * List rows are padded to the terminal column count, which makes assertions easier.
 * 列表行会补齐到终端列数，方便断言用
 */
function pad(text, columns) {
  return text + ' '.repeat(Math.max(0, columns - view.displayWidth(text)));
}

/**
 * Same truncation as the in-row "right-side info": keep the tail when too wide (status sits at the end, so keep it).
 * 与行内“右侧信息”一致的截断方式：超宽时保留尾部（状态在末尾，优先保住）
 */
function clipTail(text, width) {
  const s = String(text);
  if (view.displayWidth(s) <= width) return s;
  const chars = Array.from(s);
  let out = '';
  let used = 0;
  for (let i = chars.length - 1; i >= 0; i--) {
    const w = view.displayWidth(chars[i]);
    if (used + w > width - 1) break;
    out = chars[i] + out;
    used += w;
  }
  return `…${out}`;
}

const FIXTURES = [
  item({ modelId: 101, name: 'Alpha 模型', type: 'Checkpoint', baseModel: 'SD 1.5', totalBytes: 300 }),
  item({ modelId: 202, name: 'beta LoRA', type: 'LORA', baseModel: 'SDXL 1.0', totalBytes: 100 }),
  item({ modelId: 303, name: 'Gamma', type: 'Checkpoint', baseModel: 'SDXL 1.0', totalBytes: 200 }),
  item({ modelId: 404, name: 'delta', type: 'TextualInversion', baseModel: null, totalBytes: null }),
];

// ---------------------------------------------------------------------------
// filterItems
// filterItems（过滤）
// ---------------------------------------------------------------------------

test('filterItems: 无过滤条件时返回全部（新数组，元素不变）', () => {
  const out = select.filterItems(FIXTURES, {});
  assert.equal(out.length, 4);
  assert.notEqual(out, FIXTURES);
  assert.equal(out[0], FIXTURES[0]);
});

test('filterItems: 关键字忽略大小写匹配 name', () => {
  assert.deepEqual(select.filterItems(FIXTURES, { keyword: 'BETA' }).map((p) => p.modelId), [202]);
  assert.deepEqual(select.filterItems(FIXTURES, { keyword: 'a' }).map((p) => p.modelId), [101, 202, 303, 404]);
  assert.deepEqual(select.filterItems(FIXTURES, { keyword: '  gamma  ' }).map((p) => p.modelId), [303]);
});

test('filterItems: 关键字同时匹配 String(modelId)', () => {
  assert.deepEqual(select.filterItems(FIXTURES, { keyword: '30' }).map((p) => p.modelId), [303]);
  assert.deepEqual(select.filterItems(FIXTURES, { keyword: '404' }).map((p) => p.modelId), [404]);
  assert.deepEqual(select.filterItems(FIXTURES, { keyword: '999' }), []);
});

test('filterItems: type 过滤，null / __all__ 表示不过滤', () => {
  assert.deepEqual(select.filterItems(FIXTURES, { type: 'LORA' }).map((p) => p.modelId), [202]);
  assert.equal(select.filterItems(FIXTURES, { type: null }).length, 4);
  assert.equal(select.filterItems(FIXTURES, { type: '__all__' }).length, 4);
  assert.deepEqual(select.filterItems(FIXTURES, { type: '不存在' }), []);
});

test('filterItems: baseModel 过滤，null / __all__ 表示不过滤', () => {
  assert.deepEqual(select.filterItems(FIXTURES, { baseModel: 'SDXL 1.0' }).map((p) => p.modelId), [202, 303]);
  assert.equal(select.filterItems(FIXTURES, { baseModel: null }).length, 4);
  assert.equal(select.filterItems(FIXTURES, { baseModel: '__all__' }).length, 4);
});

test('filterItems: 关键字 + 类型 + 基础模型组合过滤', () => {
  assert.deepEqual(
    select.filterItems(FIXTURES, { keyword: 'a', type: 'Checkpoint', baseModel: 'SDXL 1.0' }).map((p) => p.modelId),
    [303]
  );
  assert.deepEqual(select.filterItems(FIXTURES, { keyword: 'beta', type: 'Checkpoint' }), []);
});

test('filterItems: 非法输入不抛错（非数组 / null 元素 / 缺字段）', () => {
  assert.deepEqual(select.filterItems(null, { keyword: 'x' }), []);
  assert.deepEqual(select.filterItems(undefined), []);
  assert.deepEqual(select.filterItems([null, undefined], { keyword: 'x' }), []);
  const sparse = select.filterItems([{ modelId: 7 }], { keyword: '7' });
  assert.equal(sparse.length, 1);
});

// ---------------------------------------------------------------------------
// sortItems
// sortItems（排序）
// ---------------------------------------------------------------------------

test('sortItems: default 保持原顺序且不改动入参', () => {
  const input = FIXTURES.slice();
  const out = select.sortItems(input, 'default');
  assert.deepEqual(out.map((p) => p.modelId), input.map((p) => p.modelId));
  assert.notEqual(out, input);
  // An unrecognized mode is also returned as a copy in the original order
  // 未识别的 mode 也按原顺序返回副本
  assert.deepEqual(select.sortItems(input, 'nope').map((p) => p.modelId), [101, 202, 303, 404]);
});

test('sortItems: size 从大到小（缺失 totalBytes 按 0）', () => {
  assert.deepEqual(select.sortItems(FIXTURES, 'size').map((p) => p.modelId), [101, 303, 202, 404]);
});

test('sortItems: size-asc 从小到大（缺失 totalBytes 排最前）', () => {
  assert.deepEqual(select.sortItems(FIXTURES, 'size-asc').map((p) => p.modelId), [404, 202, 303, 101]);
});

test('sortItems: size 排序稳定（同值项保持原相对顺序）', () => {
  const list = [
    item({ modelId: 'a', totalBytes: 100 }),
    item({ modelId: 'b', totalBytes: 500 }),
    item({ modelId: 'c', totalBytes: 100 }),
    item({ modelId: 'd', totalBytes: 500 }),
    item({ modelId: 'e', totalBytes: 100 }),
    item({ modelId: 'f', totalBytes: undefined }), // missing → treated as 0 / 缺失 → 按 0
    item({ modelId: 'g', totalBytes: null }), // null → treated as 0 / null → 按 0
  ];
  assert.deepEqual(select.sortItems(list, 'size').map((p) => p.modelId), ['b', 'd', 'a', 'c', 'e', 'f', 'g']);
  assert.deepEqual(select.sortItems(list, 'size-asc').map((p) => p.modelId), ['f', 'g', 'a', 'c', 'e', 'b', 'd']);
  assert.deepEqual(list.map((p) => p.modelId), ['a', 'b', 'c', 'd', 'e', 'f', 'g']);
});

test('sortItems: name 按名称排序且稳定', () => {
  const list = [item({ modelId: 1, name: 'b' }), item({ modelId: 2, name: 'a' }), item({ modelId: 3, name: 'c' })];
  assert.deepEqual(select.sortItems(list, 'name').map((p) => p.modelId), [2, 1, 3]);
  const dup = [item({ modelId: 1, name: 'same' }), item({ modelId: 2, name: 'same' }), item({ modelId: 3, name: 'aaa' })];
  assert.deepEqual(select.sortItems(dup, 'name').map((p) => p.modelId), [3, 1, 2]);
});

// ---------------------------------------------------------------------------
// paginate
// paginate（分页）
// ---------------------------------------------------------------------------

test('paginate: 分页切分与页数计算', () => {
  const list = Array.from({ length: 25 }, (_, i) => i);
  const p0 = select.paginate(list, 0, 10);
  assert.deepEqual(p0.pageItems, [0, 1, 2, 3, 4, 5, 6, 7, 8, 9]);
  assert.equal(p0.pageCount, 3);
  assert.equal(p0.page, 0);
  const p2 = select.paginate(list, 2, 10);
  assert.deepEqual(p2.pageItems, [20, 21, 22, 23, 24]);
  assert.equal(p2.page, 2);
});

test('paginate: 页码越界夹紧到有效区间', () => {
  const list = Array.from({ length: 25 }, (_, i) => i);
  assert.equal(select.paginate(list, 99, 10).page, 2);
  assert.deepEqual(select.paginate(list, 99, 10).pageItems, [20, 21, 22, 23, 24]);
  assert.equal(select.paginate(list, -5, 10).page, 0);
  assert.equal(select.paginate(list, NaN, 10).page, 0);
});

test('paginate: 空列表与非法 pageSize 的边界处理', () => {
  const empty = select.paginate([], 0, 15);
  assert.deepEqual(empty.pageItems, []);
  assert.equal(empty.pageCount, 1);
  assert.equal(empty.page, 0);
  const small = select.paginate([1, 2, 3], 0, 0);
  assert.deepEqual(small.pageItems, [1]);
  assert.equal(small.pageCount, 3);
});

// ---------------------------------------------------------------------------
// Selection sets
// 选择集合
// ---------------------------------------------------------------------------

test('toggleSelection: 勾选/取消并返回新 Set（不修改入参）', () => {
  const original = new Set(['1']);
  const added = select.toggleSelection(original, 2);
  assert.deepEqual([...original], ['1']);
  assert.deepEqual([...added].sort(), ['1', '2']);
  const removed = select.toggleSelection(added, '1');
  assert.deepEqual([...added].sort(), ['1', '2']);
  assert.deepEqual([...removed], ['2']);
  // Ids are always compared as strings: a string id and a number argument are equivalent
  // id 一律按字符串比较：字符串型 id 与 number 入参等价
  assert.deepEqual([...select.toggleSelection(new Set(['1']), 1)], []);
  assert.deepEqual([...select.toggleSelection(new Set(['1', '2']), 2)], ['1']);
  // A Set containing number keys must be normalized through toSet first (that is what the interactive layer does)
  // 混入 number 键的 Set 需要先经 toSet 归一化（交互层就是这么做的）
  assert.deepEqual([...select.toggleSelection(new Set(['1', 1]), 1)], [1]);
});

test('selectAll: 全选与全不选（不修改入参，只影响传入的 items）', () => {
  const original = new Set(['999']);
  const all = select.selectAll(original, FIXTURES, true);
  assert.deepEqual([...original], ['999']);
  assert.deepEqual([...all].sort(), ['101', '202', '303', '404', '999']);
  const none = select.selectAll(all, FIXTURES.slice(0, 2), false);
  assert.deepEqual([...none].sort(), ['303', '404', '999']);
});

test('invertSelection: 反选返回新 Set（不修改入参）', () => {
  const original = new Set(['101', '404']);
  const inverted = select.invertSelection(original, FIXTURES);
  assert.deepEqual([...original].sort(), ['101', '404']);
  assert.deepEqual([...inverted].sort(), ['202', '303']);
  assert.deepEqual([...select.invertSelection(inverted, FIXTURES)].sort(), ['101', '404']);
});

// ---------------------------------------------------------------------------
// clampCursor / ensureVisible
// clampCursor / ensureVisible（光标夹紧与可见性）
// ---------------------------------------------------------------------------

test('clampCursor: 夹紧到 [0, length-1]，空列表返回 0', () => {
  assert.equal(select.clampCursor(5, 10), 5);
  assert.equal(select.clampCursor(-3, 10), 0);
  assert.equal(select.clampCursor(99, 10), 9);
  assert.equal(select.clampCursor(NaN, 10), 0);
  assert.equal(select.clampCursor(2, 0), 0);
  assert.equal(select.clampCursor(3.7, 10), 3);
});

test('ensureVisible: 光标与页码保持一致', () => {
  const list = Array.from({ length: 100 }, (_, i) => i);
  assert.deepEqual(select.ensureVisible(list, 0, 15), { cursor: 0, page: 0 });
  assert.deepEqual(select.ensureVisible(list, 20, 15), { cursor: 20, page: 1 });
  assert.deepEqual(select.ensureVisible(list, 999, 15), { cursor: 99, page: 6 });
  assert.deepEqual(select.ensureVisible([], 5, 15), { cursor: 0, page: 0 });
});

// ---------------------------------------------------------------------------
// Row rendering: must be constrained by column count using display width (CJK counts as 2 columns)
// 行渲染：必须按显示宽度受列数约束（CJK 算 2 列）
// ---------------------------------------------------------------------------

test('buildRowText: 长中文名按显示宽度截断，不超过终端列数', () => {
  const long = item({ modelId: 1, name: '这是一个非常非常长的中文模型名称用来测试截断行为'.repeat(3), totalBytes: 1536 });
  for (const columns of [40, 60, 80, 120]) {
    const line = select.buildRowText(long, {
      columns,
      number: 1,
      indexWidth: 3,
      nameWidth: 40,
      detailWidth: 20,
      sizeWidth: 9,
      selected: true,
      cursor: true,
      sizeFormatter: (n) => `${n}B`,
    });
    assert.ok(view.displayWidth(line) <= columns, `${columns} 列时行宽 ${view.displayWidth(line)} 超限`);
    assert.ok(line.endsWith('1536B'), `大小列应在行尾：${line}`);
  }
});

test('renderListLines: 每行宽度不超列数，且补齐到 minRows', () => {
  const columns = 72;
  const pageItems = [
    item({ modelId: 1, name: '短名', totalBytes: 1024 }),
    item({ modelId: 2, name: '名称稍微长一点点的模型', totalBytes: 2048, type: 'LORA', baseModel: 'SDXL 1.0' }),
    item({ modelId: 3, name: 'No bytes', totalBytes: 0 }),
  ];
  const lines = select.renderListLines(pageItems, {
    columns,
    indexWidth: 2,
    nameWidth: 30,
    detailWidth: 22,
    sizeWidth: 9,
    selected: new Set(['2']),
    cursor: 1,
    firstNumber: 21,
    minRows: 8,
    colorize: false,
    describe: (it, state) => [it.type, it.baseModel, state && state[it.modelId] ? '已下载' : null].filter(Boolean).join(' · '),
    state: { 2: { versionId: 5 } },
    sizeFormatter: (n) => `${n}B`,
  });
  assert.equal(lines.length, 8);
  // The row starts with the cursor marker (blank for the other rows), the name is clipped by display width,
  // and over-long right-side info keeps its tail, so statuses such as "downloaded" come first
  //
  // 行首是光标标记（非当前行留空），名称按显示宽度裁剪，右侧信息过长时保留尾部（“已下载”等状态优先）
  assert.equal(lines[0], '  [ ] 21 短名  Checkpoint · SD 1.5 1024B');
  assert.equal(
    lines[1],
    `▸ [×] 22 ${select.clipDisplay('名称稍微长一点点的模型', 24)}  ${clipTail('LORA · SDXL 1.0 · 已下载', 22)} 2048B`
  );
  assert.equal(lines[1].includes('已下载'), true);
  assert.equal(lines[2], '  [ ] 23 No bytes  Checkpoint · SD 1.5 0B');
  assert.equal(lines[3], ' ');
  for (const line of lines) {
    assert.ok(view.displayWidth(line) <= columns, `行宽 ${view.displayWidth(line)} 超限：${line}`);
  }
});

test('renderListLines: colorize 时光标行加反显且不影响显示宽度', () => {
  const pageItems = [item({ modelId: 1, name: 'a' }), item({ modelId: 2, name: 'b' })];
  const plain = select.renderListLines(pageItems, {
    columns: 60,
    indexWidth: 2,
    nameWidth: 20,
    detailWidth: 10,
    sizeWidth: 7,
    cursor: 0,
    minRows: 2,
    colorize: false,
    sizeFormatter: () => '1B',
  });
  const colored = select.renderListLines(pageItems, {
    columns: 60,
    indexWidth: 2,
    nameWidth: 20,
    detailWidth: 10,
    sizeWidth: 7,
    cursor: 0,
    minRows: 2,
    colorize: true,
    sizeFormatter: () => '1B',
  });
  assert.equal(colored.length, plain.length);
  assert.ok(colored[0].includes('\u001b[7m'));
  assert.equal(view.displayWidth(colored[0]), view.displayWidth(plain[0]));
  assert.equal(view.displayWidth(colored[1]), view.displayWidth(plain[1]));
});

test('buildHeaderLines: 标题 / 过滤排序状态 / 已选与合计 / 分页', () => {
  const lines = select.buildHeaderLines({
    title: '选择要下载的条目',
    search: 'lora',
    type: 'LORA',
    baseModel: 'SDXL 1.0',
    sort: 'size',
    selectedCount: 3,
    itemCount: 40,
    visibleCount: 12,
    selectedBytes: 2048,
    visibleBytes: 4096,
    page: 1,
    pageCount: 4,
    sizeFormatter: (n) => `${n}B`,
  });
  assert.equal(lines.length, 3);
  assert.equal(lines[0], '选择要下载的条目');
  assert.ok(lines[1].includes('搜索：“lora”'));
  assert.ok(lines[1].includes('类型：LORA'));
  assert.ok(lines[1].includes('基础模型：SDXL 1.0'));
  assert.ok(lines[1].includes('排序：按大小↓'));
  assert.ok(lines[1].includes('第 2/4 页'));
  assert.ok(lines[2].includes('已选 3 项 / 共 40 项'));
  assert.ok(lines[2].includes('过滤后 12 项'));
  assert.ok(lines[2].includes('合计 2048B（全部 4096B）'));
});

test('layoutColumns: 列宽加起来不超过终端列数', () => {
  for (const columns of [30, 45, 80, 160]) {
    const cols = select.layoutColumns(FIXTURES, columns, FIXTURES.length, (n) => `${n}B`);
    assert.ok(cols.nameWidth >= 6, `名称列过窄：${cols.nameWidth}`);
    assert.ok(cols.sizeWidth >= 1);
    assert.ok(cols.detailWidth >= 0);
    assert.ok(
      cols.nameWidth + (cols.detailWidth ? cols.detailWidth + 2 : 0) + cols.sizeWidth + 1 <= cols.columns,
      `${columns} 列时列宽合计溢出`
    );
  }
});

test('layoutColumns + buildRowText: 各宽度组合下实际渲染都不超列', () => {
  const long = item({
    modelId: 42,
    name: '超长中文模型名称'.repeat(4),
    type: 'Checkpoint',
    baseModel: 'SDXL 1.0',
    // 5.00 GiB, wide enough to stretch the "size" column
    // 5.00 GiB，撑出较宽的“大小”列
    totalBytes: 5368709120,
  });
  for (const columns of [24, 30, 40, 60, 80, 100, 200]) {
    const cols = select.layoutColumns([long], columns, 1234);
    const line = select.buildRowText(long, {
      ...cols,
      number: 1234,
      cursor: true,
      selected: true,
      describe: () => 'Checkpoint · SDXL 1.0 · 版本有更新 · 已固定版本',
    });
    assert.ok(
      view.displayWidth(line) <= cols.columns,
      `${columns} 列时行宽 ${view.displayWidth(line)} 超限：${line}`
    );
    assert.ok(cols.sizeWidth >= 1 && cols.nameWidth >= 6);
  }
});

// ---------------------------------------------------------------------------
// Status text / non-TTY behaviour
// 状态文案 / 非 TTY 行为
// ---------------------------------------------------------------------------

test('describeStatus: 已下载 / 版本有更新 / 已固定版本', () => {
  const it = item({ modelId: 1, versionId: 100 });
  assert.equal(select.describeStatus(it, {}), '');
  assert.equal(select.describeStatus(it, { 1: { versions: { 100: { versionName: 'v100' } } } }), '已下载');
  assert.equal(select.describeStatus(it, { 1: { versions: { 99: { versionName: 'v99' } } } }), '版本有更新');
  assert.equal(
    select.describeStatus(it, { 1: { versions: { 100: {} }, pinnedVersionId: 100 } }),
    '已下载 已固定版本'
  );
  assert.equal(select.describeStatus(it, { 1: { versions: { 100: {} }, pinnedVersionId: 99 } }), '已下载');
  assert.equal(select.describeStatus(it, { 1: { versions: {} } }), '版本有更新');
});

test('selectItems: 非 TTY 直接返回 null（不抛错）', async () => {
  const out = await select.selectItems(FIXTURES, { pageSize: 5 });
  if (process.stdout.isTTY && process.stdin.isTTY) {
    assert.ok(out === null || (out && out.selected instanceof Set));
    return;
  }
  assert.equal(out, null);
});

test('selectItems: 空列表返回 null', async () => {
  assert.equal(await select.selectItems([], {}), null);
  assert.equal(await select.selectItems(null, {}), null);
});

test('displayWidth: 与 view.displayWidth 一致（CJK 算 2 列）', () => {
  assert.equal(select.displayWidth('abc'), 3);
  assert.equal(select.displayWidth('中文'), 4);
  assert.equal(select.displayWidth('中a'), 3);
  assert.equal(select.displayWidth('\u001b[31m红\u001b[0m'), 2);
  assert.equal(select.displayWidth('红'), view.displayWidth('红'));
});
