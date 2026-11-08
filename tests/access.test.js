'use strict';

const test = require('node:test');
const assert = require('node:assert/strict');

const {
  classifyVersionAccess,
  summarizeAccess,
  requiresEntitlement,
  isUnavailable,
} = require('../src/access');

const MODEL = { hasActivePaidAccess: true };
const NOW = Date.parse('2026-11-07T00:00:00.000Z');

test('access: 同一模型按版本区分免费与永久付费', () => {
  const free = classifyVersionAccess({ id: 1, status: 'Published', paidAccess: null }, MODEL, { now: NOW });
  assert.equal(free.kind, 'public');
  assert.equal(free.requiresEntitlement, false);
  assert.equal(free.defaultSelected, true);
  assert.equal(free.modelHasPaidVersions, true);

  const paid = classifyVersionAccess(
    {
      id: 2,
      status: 'Published',
      availability: 'Public',
      usageControl: 'Download',
      paidAccess: { permanent: true, endsAt: null },
    },
    MODEL,
    { now: NOW }
  );
  assert.equal(paid.kind, 'paid');
  assert.equal(paid.paid, true);
  assert.equal(paid.permanent, true);
  assert.equal(paid.requiresEntitlement, true);
  assert.equal(paid.defaultSelected, false);
  assert.equal(requiresEntitlement({ access: paid }), true);
});

test('access: 限时付费、已结束付费期与 Early Access', () => {
  const future = classifyVersionAccess(
    { paidAccess: { permanent: false, endsAt: '2026-12-01T00:00:00.000Z' } },
    MODEL,
    { now: NOW }
  );
  assert.equal(future.kind, 'paid');
  assert.equal(future.reason, 'paid-window');
  assert.equal(future.endsAt, '2026-12-01T00:00:00.000Z');

  const expired = classifyVersionAccess(
    { paidAccess: { permanent: false, endsAt: '2026-01-01T00:00:00.000Z' } },
    MODEL,
    { now: NOW }
  );
  assert.equal(expired.kind, 'public');
  assert.equal(expired.reason, 'paid-expired');
  assert.equal(expired.requiresEntitlement, false);

  const early = classifyVersionAccess(
    { availability: 'EarlyAccess', earlyAccessEndsAt: '2026-12-01T00:00:00.000Z' },
    MODEL,
    { now: NOW }
  );
  assert.equal(early.kind, 'early-access');
  assert.equal(early.requiresEntitlement, true);
});

test('access: 不可下载状态优先于付费标记', () => {
  const disabled = classifyVersionAccess(
    {
      status: 'Published',
      usageControl: 'GenerationOnly',
      paidAccess: { permanent: true },
    },
    MODEL,
    { now: NOW }
  );
  assert.equal(disabled.kind, 'unavailable');
  assert.equal(disabled.reason, 'download-disabled');
  assert.equal(isUnavailable({ access: disabled }), true);
  assert.equal(disabled.defaultSelected, false);
});

test('access: summarizeAccess 按 kind 计数并给出 mixed', () => {
  const list = [
    { kind: 'public' },
    { kind: 'paid' },
    { kind: 'early-access' },
    { kind: 'unavailable' },
  ];
  assert.deepEqual(summarizeAccess(list), {
    total: 4,
    free: 1,
    paid: 1,
    early: 1,
    unavailable: 1,
    restricted: 2,
    mixed: true,
  });
  assert.deepEqual(summarizeAccess([]), {
    total: 0,
    free: 0,
    paid: 0,
    early: 0,
    unavailable: 0,
    restricted: 0,
    mixed: false,
  });
  assert.equal(summarizeAccess([{ kind: 'paid' }, { kind: 'early-access' }]).mixed, false, '全受限不算混合');
  assert.equal(summarizeAccess([{ kind: 'public' }, null]).free, 2, '未知状态按免费计');
});

test('access: 真实字段形态（缺失 / permanent / endsAt）汇总成预期构成', () => {
  const now = '2026-11-08T00:00:00.000Z';
  // Case 1: four versions, two free (field absent) and two permanently paid.
  // 案例 1：4 个版本，2 免费（字段缺失）+ 2 永久付费。
  const case1 = [
    { id: 3456657 },
    { id: 3443533, paidAccess: { permanent: true, endsAt: null } },
    { id: 3435059, paidAccess: { permanent: true, endsAt: null } },
    { id: 3413227 },
  ];
  assert.deepEqual(
    summarizeAccess(case1.map((version) => classifyVersionAccess(version, MODEL, { now }))),
    { total: 4, free: 2, paid: 2, early: 0, unavailable: 0, restricted: 2, mixed: true }
  );

  // Case 5: one time-limited paid version (future endsAt) plus one free.
  // 案例 5：1 个限时付费（endsAt 未来）+ 1 免费。
  const case5 = [
    { id: 3440660, paidAccess: { permanent: false, endsAt: '2026-11-15T03:10:19.433Z' } },
    { id: 3424997 },
  ];
  const before = summarizeAccess(case5.map((version) => classifyVersionAccess(version, null, { now })));
  assert.equal(before.paid, 1);
  assert.equal(before.free, 1);
  assert.equal(before.mixed, true);

  // After 11-15 the same payload becomes all free, purely from the current clock.
  // 11-15 之后同一份数据自动变成全免费（只看当前时间，不需要重新拉配置）。
  const after = summarizeAccess(
    case5.map((version) => classifyVersionAccess(version, null, { now: '2026-11-16T00:00:00.000Z' }))
  );
  assert.equal(after.restricted, 0);
  assert.equal(after.free, 2);
  assert.equal(after.mixed, false);
});
