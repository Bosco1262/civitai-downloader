'use strict';

/**
 * Unit tests for src/manifest.js.
 * Run directly: node tests/manifest.test.js
 *
 * src/manifest.js 单元测试。
 * 直接运行：node tests/manifest.test.js
 * （本会话沙箱禁止管道/重定向，因此不使用 `node --test`。）
 */

const test = require('node:test');
const assert = require('node:assert/strict');

const {
  manifestDiff,
  manifestDiffers,
  sameManifest,
  sizeTolerance,
  sizeDiffers,
  keyOf,
} = require('../src/manifest');
const { sanitizeName } = require('../src/util');

/**
 * Build a manifest file entry (sha256 null/undefined means there is no hash).
 * 构造一个清单文件项（sha256 传 null/undefined 表示没有哈希）
 */
function file(name, sha256, bytes, extra = {}) {
  const f = { name, remoteName: name, bytes };
  if (sha256 !== null && sha256 !== undefined) f.sha256 = sha256;
  return Object.assign(f, extra);
}

/**
 * Assert that all four arrays are empty.
 * 断言四个数组都为空
 */
function assertEmptyDiff(d) {
  assert.deepEqual(d.changed, [], 'changed 应为空');
  assert.deepEqual(d.added, [], 'added 应为空');
  assert.deepEqual(d.removed, [], 'removed 应为空');
  assert.deepEqual(d.renamed, [], 'renamed 应为空');
}

const near = (actual, expected) => Math.abs(actual - expected) < 1e-6;

// ---------------------------------------------------------------------------
// 1. Fully identical
// 1. 完全一致
// ---------------------------------------------------------------------------

test('manifestDiff: 完全相同的清单 → same 为 true 且四个数组为空', () => {
  const prev = [
    file('a.safetensors', 'AA11', 1024),
    file('b.pt', 'BB22', 2048),
    file('sub/c.ckpt', 'CC33', 4096),
  ];
  // Copy item by item so nothing depends on object identity
  // 逐项复制，避免依赖对象引用
  const online = prev.map((f) => ({ ...f }));

  const d = manifestDiff(prev, online);
  assert.equal(d.same, true);
  assertEmptyDiff(d);

  assert.equal(sameManifest(prev, online), true);
  assert.equal(sameManifest(prev, prev), true);
  assert.deepEqual(manifestDiffers(prev, online), []);

  // The input must not be modified
  // 输入不应被修改
  assert.deepEqual(prev[0], { name: 'a.safetensors', remoteName: 'a.safetensors', bytes: 1024, sha256: 'AA11' });
});

// ---------------------------------------------------------------------------
// 2. Content changes
// 2. 内容变化
// ---------------------------------------------------------------------------

test('manifestDiff: 同名同大小但 sha256 不同 → 进入 changed（{prev, online} 结构）', () => {
  const prev = [file('a.safetensors', 'AAAA', 1000)];
  const online = [file('a.safetensors', 'BBBB', 1000)];

  const d = manifestDiff(prev, online);
  assert.equal(d.changed.length, 1);
  assert.equal(d.changed[0].prev, prev[0], 'changed[0].prev 应是本地那一项');
  assert.equal(d.changed[0].online, online[0], 'changed[0].online 应是线上那一项');
  assert.equal(d.changed[0].prev.sha256, 'AAAA');
  assert.equal(d.changed[0].online.sha256, 'BBBB');
  assert.deepEqual(d.added, []);
  assert.deepEqual(d.removed, []);
  assert.deepEqual(d.renamed, []);
  assert.equal(d.same, false);
  assert.equal(sameManifest(prev, online), false);
  assert.deepEqual(manifestDiffers(prev, online), ['a.safetensors']);
});

test('manifestDiff: sha256 比较大小写不敏感', () => {
  const prev = [file('a.safetensors', 'AbCdEf', 1000)];
  // Size differs a lot, but the same hash means identical
  // 大小差很多，但哈希相同即视为相同
  const online = [file('a.safetensors', 'abcdef', 999999)];
  const d = manifestDiff(prev, online);
  assert.equal(d.same, true);
  assertEmptyDiff(d);
});

// ---------------------------------------------------------------------------
// 3. Renames
// 3. 改名
// ---------------------------------------------------------------------------

test('manifestDiff: 同哈希的「新增+移除」识别为改名，且从 added/removed 中剔除', () => {
  const prev = [file('old-name.safetensors', 'abc123', 5000)];
  // Hash case differs and still has to match
  // 哈希大小写不同也应匹配
  const online = [file('new-name.safetensors', 'ABC123', 5000)];

  const d = manifestDiff(prev, online);
  assert.equal(d.renamed.length, 1);
  assert.equal(d.renamed[0].from, prev[0]);
  assert.equal(d.renamed[0].to, online[0]);
  assert.deepEqual(d.added, [], '改名项不应留在 added');
  assert.deepEqual(d.removed, [], '改名项不应留在 removed');
  assert.deepEqual(d.changed, []);
  assert.equal(d.same, false, '改名仍视为清单发生变化');
  assert.equal(sameManifest(prev, online), false);
  assert.deepEqual(manifestDiffers(prev, online), [], '改名不是内容变化');
});

test('manifestDiff: 多个同哈希改名逐一配对', () => {
  const prev = [file('a.bin', 'H1', 10), file('b.bin', 'H2', 20)];
  const online = [file('x.bin', 'H1', 10), file('y.bin', 'H2', 20)];

  const d = manifestDiff(prev, online);
  assert.equal(d.renamed.length, 2);
  const pairs = d.renamed.map((r) => `${r.from.name}->${r.to.name}`).sort();
  assert.deepEqual(pairs, ['a.bin->x.bin', 'b.bin->y.bin']);
  assert.deepEqual(d.added, []);
  assert.deepEqual(d.removed, []);
  assert.equal(d.same, false);
});

test('manifestDiff: 改名同时内容也变了 → 只能算 added + removed，不识别为改名', () => {
  const prev = [file('old.bin', 'H1', 10)];
  const online = [file('new.bin', 'H2', 10)];

  const d = manifestDiff(prev, online);
  assert.deepEqual(d.renamed, [], '哈希不同不应识别为改名');
  assert.deepEqual(d.added, [online[0]]);
  assert.deepEqual(d.removed, [prev[0]]);
  assert.equal(d.same, false);
});

test('manifestDiff: 缺少哈希时不识别为改名', () => {
  const prev = [file('old.bin', null, 10)];
  const online = [file('new.bin', null, 10)];

  const d = manifestDiff(prev, online);
  assert.deepEqual(d.renamed, []);
  assert.deepEqual(d.added, [online[0]]);
  assert.deepEqual(d.removed, [prev[0]]);
});

// ---------------------------------------------------------------------------
// 4/5. Additions and removals
// 4/5. 新增与移除
// ---------------------------------------------------------------------------

test('manifestDiff: 线上新增文件 → 进入 added', () => {
  const prev = [file('a.bin', 'H1', 10)];
  const online = [file('a.bin', 'H1', 10), file('fresh.bin', 'H9', 99)];

  const d = manifestDiff(prev, online);
  assert.deepEqual(d.added, [online[1]]);
  assert.deepEqual(d.removed, []);
  assert.deepEqual(d.changed, []);
  assert.deepEqual(d.renamed, []);
  assert.equal(d.same, false);
  assert.deepEqual(manifestDiffers(prev, online), [], '纯新增不算内容变化');
});

test('manifestDiff: 本地有线上没有 → 进入 removed', () => {
  const prev = [file('a.bin', 'H1', 10), file('gone.bin', 'H9', 99)];
  const online = [file('a.bin', 'H1', 10)];

  const d = manifestDiff(prev, online);
  assert.deepEqual(d.removed, [prev[1]]);
  assert.deepEqual(d.added, []);
  assert.deepEqual(d.changed, []);
  assert.deepEqual(d.renamed, []);
  assert.equal(d.same, false);
  assert.deepEqual(manifestDiffers(prev, online), []);
});

// ---------------------------------------------------------------------------
// 6. Size comparison when there is no hash
// 6. 无哈希时按大小比较
// ---------------------------------------------------------------------------

test('sizeTolerance: max(1024, bytes * 0.001)', () => {
  assert.equal(sizeTolerance(0), 1024);
  assert.equal(sizeTolerance(1000), 1024);
  assert.ok(near(sizeTolerance(1024 * 1024), 1048.576), '1MiB 的 0.1% 已大于下限，取 1048.576');
  assert.ok(near(sizeTolerance(10 * 1024 * 1024), 10485.76), '大文件按 0.1% 计算');
  assert.equal(sizeTolerance(undefined), 1024);
  assert.equal(sizeTolerance(null), 1024);
  assert.equal(sizeTolerance(NaN), 1024);
  assert.equal(sizeTolerance('abc'), 1024);
});

test('sizeDiffers: 差值需「大于」容差', () => {
  // Small file: the tolerance is the 1024 lower bound
  // 小文件：容差为下限 1024
  assert.equal(sizeDiffers(1000, 2024), false, '差 1024，未超过容差');
  assert.equal(sizeDiffers(1000, 2025), true, '差 1025，超过容差');
  assert.equal(sizeDiffers(1000, 2000), false);
  assert.equal(sizeDiffers(0, 1000), false, '0 与 1000 的差未超过 1024');
  // Large file: the tolerance is 0.1% of the second argument
  // 大文件：容差为第二参的 0.1%
  assert.equal(sizeDiffers(10_000_000, 10_010_000), false, '差 10000 ≤ 容差 10010');
  assert.equal(sizeDiffers(10_000_000, 10_011_000), true, '差 11000 > 容差 10011');
});

test('manifestDiff: 两边都没有 sha256 时按大小比较（容差内不算变化）', () => {
  const prev = [file('big.bin', null, 10_000_000)];

  const nearSame = [file('big.bin', null, 10_005_000)];
  // Diff 5000 < tolerance 10005
  // 差 5000 < 容差 10005
  const d1 = manifestDiff(prev, nearSame);
  assert.equal(d1.same, true);
  assertEmptyDiff(d1);

  const different = [file('big.bin', null, 10_500_000)];
  // Diff 500000 > tolerance 10500
  // 差 500000 > 容差 10500
  const d2 = manifestDiff(prev, different);
  assert.equal(d2.same, false);
  assert.equal(d2.changed.length, 1);
  assert.equal(d2.changed[0].prev, prev[0]);
  assert.equal(d2.changed[0].online, different[0]);

  // Small file: the 1024 tolerance lower bound
  // 小文件：容差下限 1024
  const small = [file('small.bin', null, 1000)];
  assert.equal(manifestDiff(small, [file('small.bin', null, 1500)]).same, true, '差 500 在容差内');
  assert.equal(manifestDiff(small, [file('small.bin', null, 3000)]).same, false, '差 2000 超容差');
});

test('manifestDiff: 只有一边有 sha256 时回退到大小比较', () => {
  const prev = [file('mixed.bin', 'AA', 1000)];
  const online = [file('mixed.bin', null, 3000)];

  const d = manifestDiff(prev, online);
  assert.equal(d.changed.length, 1);
  assert.equal(d.changed[0].online, online[0]);
  assert.equal(d.same, false);

  assert.equal(manifestDiff(prev, [file('mixed.bin', null, 1500)]).same, true);
});

// ---------------------------------------------------------------------------
// 7. Name comparison
// 7. 名字比较
// ---------------------------------------------------------------------------

test('keyOf: 小写化并支持 remoteName 回退', () => {
  assert.equal(keyOf({ name: 'ABC.bin' }), 'abc.bin');
  assert.equal(keyOf({ remoteName: 'X.Y' }), 'x.y');
  assert.equal(keyOf({ name: '', remoteName: 'X.Y' }), 'x.y');
  assert.equal(keyOf({ name: 'A', remoteName: 'B' }), 'a', 'name 优先');
  assert.equal(keyOf({}), '');
  assert.equal(keyOf(null), '');
  assert.equal(keyOf(undefined), '');
  assert.equal(keyOf({ name: 123 }), '123');
});

test('manifestDiff: 名字大小写不同视为同一个文件', () => {
  const prev = [file('Model-A.safetensors', 'AA', 10)];
  const online = [file('model-a.SAFETENSORS', 'AA', 10)];

  const d = manifestDiff(prev, online);
  assert.equal(d.same, true);
  assertEmptyDiff(d);

  // Case differs and content differs → changed
  // 大小写不同 + 内容不同 → changed
  const d2 = manifestDiff(prev, [file('MODEL-A.safetensors', 'ZZ', 10)]);
  assert.equal(d2.changed.length, 1);
  assert.equal(d2.same, false);
});

test('manifestDiff: 本地用 name、线上只有 remoteName 时也能匹配', () => {
  const prev = [{ name: 'Y.bin', sha256: 'BB', bytes: 10 }];
  const online = [{ remoteName: 'y.BIN', sha256: 'BB', bytes: 10 }];
  assert.equal(manifestDiff(prev, online).same, true);

  const prev2 = [{ remoteName: 'X.BIN', sha256: 'AA', bytes: 10 }];
  const online2 = [{ remoteName: 'x.bin', sha256: 'CC', bytes: 10 }];
  const d = manifestDiff(prev2, online2);
  assert.equal(d.changed.length, 1);
  assert.equal(d.same, false);
});

// ---------------------------------------------------------------------------
// 8. Empty / invalid input
// 8. 空 / 非法输入
// ---------------------------------------------------------------------------

test('manifestDiff: 空数组与 undefined 输入不抛异常', () => {
  const cases = [
    [undefined, undefined],
    [null, null],
    [[], []],
    [undefined, []],
    [[], undefined],
    [null, []],
  ];
  for (const [p, o] of cases) {
    const d = manifestDiff(p, o);
    assert.equal(d.same, true);
    assertEmptyDiff(d);
  }

  // null/undefined items inside the arrays are filtered out
  // 数组内的 null/undefined 项被过滤
  const d = manifestDiff([null, undefined], [null]);
  assert.equal(d.same, true);
  assertEmptyDiff(d);

  assert.equal(sameManifest(undefined, []), true);
  assert.deepEqual(manifestDiffers(undefined, undefined), []);
});

// ---------------------------------------------------------------------------
// 9. Name sanitizing in manifestDiffers
// 9. manifestDiffers 的名字清理
// ---------------------------------------------------------------------------

test('manifestDiffers: 返回 sanitizeName 处理后的文件名', () => {
  assert.equal(sanitizeName('a/b:c'), 'a_b_c', '前置条件：sanitizeName 会把非法字符换成下划线');

  const prev = [file('a/b:c', 'AAAA', 100)];
  const online = [file('a/b:c', 'BBBB', 100)];

  const d = manifestDiff(prev, online);
  assert.equal(d.changed.length, 1);

  const names = manifestDiffers(prev, online);
  assert.deepEqual(names, ['a_b_c']);
  assert.deepEqual(names, [sanitizeName('a/b:c')]);

  // Invalid characters must not appear in the returned value
  // 非法字符不能出现在返回值里
  for (const bad of ['/', '\\', ':', '*', '?', '"', '<', '>', '|']) {
    assert.equal(names[0].includes(bad), false, `结果不应含 ${bad}`);
  }
});

test('manifestDiffers: 线上只有 remoteName 时回退取 remoteName', () => {
  const prev = [{ name: 'm?.bin', sha256: 'AAAA', bytes: 10 }];
  const online = [{ remoteName: 'm?.bin', sha256: 'BBBB', bytes: 10 }];
  assert.equal(keyOf(online[0]), 'm?.bin', '前置条件：keyOf 会回退到 remoteName');
  assert.equal(manifestDiff(prev, online).changed.length, 1);
  assert.deepEqual(manifestDiffers(prev, online), ['m_.bin']);
});

// ---------------------------------------------------------------------------
// 10. Mixed scenarios
// 10. 混合场景
// ---------------------------------------------------------------------------

test('manifestDiff: 混合场景（changed + added + removed + renamed）', () => {
  const keep = file('keep.safetensors', 'K1', 100);
  const changePrev = file('change.safetensors', 'C1', 100);
  const changeOnline = file('change.safetensors', 'C2', 100);
  const gone = file('gone.safetensors', 'G1', 100);
  const oldName = file('old-name.safetensors', 'R1', 100);
  const newName = file('new-name.safetensors', 'R1', 100);
  const fresh = file('fresh.safetensors', 'F1', 100);

  const prev = [keep, changePrev, gone, oldName];
  const online = [keep, changeOnline, newName, fresh];

  const d = manifestDiff(prev, online);
  assert.deepEqual(d.changed, [{ prev: changePrev, online: changeOnline }]);
  assert.deepEqual(d.added, [fresh]);
  assert.deepEqual(d.removed, [gone]);
  assert.deepEqual(d.renamed, [{ from: oldName, to: newName }]);
  assert.equal(d.same, false);

  assert.deepEqual(manifestDiffers(prev, online), ['change.safetensors']);
  assert.equal(sameManifest(prev, online), false);

  // Swap the order: exchanging local and online keeps the same structure (rename direction flips)
  // 交换顺序：本地↔线上互换后结论结构一致（改名方向相反）
  const rev = manifestDiff(online, prev);
  assert.deepEqual(rev.changed, [{ prev: changeOnline, online: changePrev }]);
  assert.deepEqual(rev.added, [gone]);
  assert.deepEqual(rev.removed, [fresh]);
  assert.deepEqual(rev.renamed, [{ from: newName, to: oldName }]);
  assert.equal(rev.same, false);
});
