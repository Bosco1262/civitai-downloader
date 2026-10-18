'use strict';

const test = require('node:test');
const assert = require('node:assert/strict');
const fs = require('fs');
const os = require('os');
const path = require('path');
const crypto = require('crypto');

const util = require('../src/util');
const { RateLimitError, CancelError } = require('../src/errors');

function tempDir(tag) {
  return fs.mkdtempSync(path.join(os.tmpdir(), `civitai-${tag}-`));
}

function sha256Of(buf) {
  return crypto.createHash('sha256').update(buf).digest('hex').toUpperCase();
}

// ---------------------------------------------------------------------------
// parseArgs
// parseArgs（命令行参数解析）
// ---------------------------------------------------------------------------

test('parseArgs: 布尔旗标不吞掉后面的位置参数', () => {
  const a = util.parseArgs(['--json', '161131']);
  assert.deepEqual(a.positionals, ['161131']);
  assert.equal(a.flags.json, true);

  const b = util.parseArgs(['--dry-run', '161131', '--force']);
  assert.deepEqual(b.positionals, ['161131']);
  assert.equal(b.flags['dry-run'], true);
  assert.equal(b.flags.force, true);

  const c = util.parseArgs(['list', '--json', '161131']);
  assert.deepEqual(c.positionals, ['list', '161131']);
});

test('parseArgs: 取值旗标照常消费下一个参数', () => {
  const a = util.parseArgs(['161131', '--only', '1,2', '--force']);
  assert.deepEqual(a.positionals, ['161131']);
  assert.equal(a.flags.only, '1,2');
  assert.equal(a.flags.force, true);

  const b = util.parseArgs(['--out', 'D:/models', '5']);
  assert.deepEqual(b.positionals, ['5']);
  assert.equal(b.flags.out, 'D:/models');

  const c = util.parseArgs(['--jobs', '4']);
  assert.equal(c.flags.jobs, '4');
});

test('parseArgs: --k=v、-- 终止符与未知旗标', () => {
  const a = util.parseArgs(['--only=1,2', '--json']);
  assert.equal(a.flags.only, '1,2');
  assert.equal(a.flags.json, true);

  const b = util.parseArgs(['--', '--json', '7']);
  assert.deepEqual(b.positionals, ['--json', '7']);
  assert.equal(b.flags.json, undefined);

  const c = util.parseArgs(['--nope', 'x', '1'], { knownFlags: ['json'] });
  assert.deepEqual(c.unknown, ['nope']);
  assert.deepEqual(c.positionals, ['x', '1'], '未知旗标按布尔处理，不消费后面的参数');
  assert.equal(c.flags.nope, true);

  const d = util.parseArgs(['--json=']);
  assert.equal(d.flags.json, '');
});

test('parseArgs: 未知旗标不会吞掉位置参数（回归：pin --list 161106）', () => {
  const a = util.parseArgs(['--list', '161106']);
  assert.deepEqual(a.positionals, ['161106']);
  assert.equal(a.flags.list, true);

  const b = util.parseArgs(['--no-primary', '161131']);
  assert.deepEqual(b.positionals, ['161131']);
  assert.equal(b.flags['no-primary'], true);

  const c = util.parseArgs(['--totally-unknown', '161131', '--force']);
  assert.deepEqual(c.positionals, ['161131']);
  assert.equal(c.flags['totally-unknown'], true);
  assert.equal(c.flags.force, true);
});

test('parseArgs: 命令级 valueFlags 可让同名旗标按取值处理', () => {
  // `download --models` must consume a value
  // download --models 需要吃值
  const a = util.parseArgs(['--models', 'model:1,model:2'], { valueFlags: ['models'] });
  assert.equal(a.flags.models, 'model:1,model:2');
  assert.deepEqual(a.positionals, []);

  // `verify --models` is boolean (no valueFlags declared)
  // verify --models 是布尔（未声明 valueFlags）
  const b = util.parseArgs(['--models', '161131']);
  assert.equal(b.flags.models, true);
  assert.deepEqual(b.positionals, ['161131']);
});

test('parseArgs: 位置参数可以出现在旗标之间', () => {
  const a = util.parseArgs(['--jobs', '2', '161131', '--force']);
  assert.deepEqual(a.positionals, ['161131']);
  assert.equal(a.flags.jobs, '2');
  assert.equal(a.flags.force, true);

  const b = util.parseArgs(['161131', '161132', '--all']);
  assert.deepEqual(b.positionals, ['161131', '161132']);
});

// ---------------------------------------------------------------------------
// Atomic JSON read/write
// 原子 JSON 读写
// ---------------------------------------------------------------------------

test('writeJsonAtomic: 原子写入、可备份、可读回', () => {
  const dir = tempDir('json');
  const file = path.join(dir, 'state.json');

  util.writeJsonAtomic(file, { a: 1 });
  assert.deepEqual(util.readJsonResult(file).data, { a: 1 });
  assert.ok(!fs.existsSync(`${file}.bak`), '首次写入无需备份');

  util.writeJsonAtomic(file, { a: 2 }, { backup: true });
  assert.deepEqual(util.readJsonResult(file).data, { a: 2 });
  assert.deepEqual(util.readJson(file + '.bak', null), { a: 1 });

  const leftover = fs.readdirSync(dir).filter((f) => f.includes('.tmp'));
  assert.deepEqual(leftover, [], '不应残留临时文件');
});

test('readJsonResult: 区分不存在 / 为空 / 损坏', () => {
  const dir = tempDir('read');
  const missing = util.readJsonResult(path.join(dir, 'nope.json'));
  assert.equal(missing.missing, true);
  assert.equal(missing.ok, false);

  const empty = path.join(dir, 'empty.json');
  fs.writeFileSync(empty, '   \n');
  const r1 = util.readJsonResult(empty);
  assert.equal(r1.ok, false);
  assert.equal(r1.missing, false);
  assert.equal(r1.empty, true);

  const broken = path.join(dir, 'broken.json');
  fs.writeFileSync(broken, '{"a":');
  const r2 = util.readJsonResult(broken);
  assert.equal(r2.ok, false);
  assert.equal(r2.missing, false);
  assert.ok(r2.error instanceof Error);

  assert.deepEqual(util.readJson(broken, { fallback: true }), { fallback: true });
});

// ---------------------------------------------------------------------------
// Hashing
// 哈希
// ---------------------------------------------------------------------------

test('sha256File: worker 与主线程结果一致，且支持进度', async () => {
  const dir = tempDir('hash');
  const file = path.join(dir, 'data.bin');
  const buf = crypto.randomBytes(3 * 1024 * 1024 + 17);
  fs.writeFileSync(file, buf);
  const expected = sha256Of(buf);

  assert.equal(await util.sha256File(file), expected, 'worker 计算');
  assert.equal(await util.sha256File(file, { worker: false }), expected, '主线程计算');

  let last = 0;
  let calls = 0;
  const h = await util.sha256File(file, {
    worker: false,
    chunkSize: 512 * 1024,
    onProgress: (bytes) => {
      assert.ok(bytes >= last, '进度单调递增');
      last = bytes;
      calls++;
    },
  });
  assert.equal(h, expected);
  assert.ok(calls >= 6, `进度回调次数应足够（实际 ${calls}）`);
  assert.equal(last, buf.length);
});

test('sha256File: 支持取消与文件不存在', async () => {
  const dir = tempDir('hashcancel');
  const file = path.join(dir, 'big.bin');
  fs.writeFileSync(file, crypto.randomBytes(2 * 1024 * 1024));

  await assert.rejects(
    () => util.sha256File(file, { worker: false, shouldAbort: () => true }),
    (e) => e instanceof CancelError
  );

  await assert.rejects(() => util.sha256File(path.join(dir, 'nope.bin')), /ENOENT/);
});

// ---------------------------------------------------------------------------
// Names / paths
// 名称 / 路径
// ---------------------------------------------------------------------------

test('sanitizeName: 替换非法字符、去掉结尾点空格、截断', () => {
  assert.equal(util.sanitizeName('a<b>c:d"e/f\\g|h?i*j'), 'a_b_c_d_e_f_g_h_i_j');
  assert.equal(util.sanitizeName('trailing.  '), 'trailing');
  assert.equal(util.sanitizeName(''), 'unnamed');
  assert.equal(util.sanitizeName('x'.repeat(300)).length, 120);
  assert.equal(util.sanitizeName('x'.repeat(300), 10).length, 10);
});

test('diskFileName / diskDirName: 超长时缩短且不超上限', () => {
  const longDir = `C:/${'a'.repeat(180)}`;
  const longName = `${'x'.repeat(200)}.safetensors`;
  const fitted = util.diskFileName(longDir, longName);
  assert.ok(path.join(longDir, fitted).length <= util.MAX_PATH_WIN, '文件名路径不超上限');
  assert.ok(fitted.endsWith('.safetensors'), '保留扩展名');

  const dirName = util.diskDirName(longDir, 'y'.repeat(200), 12345);
  assert.ok(path.join(longDir, dirName).length <= util.MAX_PATH_WIN, '目录名路径不超上限');

  let tooLong = true;
  if (process.platform !== 'win32') tooLong = false;
  if (!tooLong) {
    assert.equal(util.diskFileName('C:/x', 'normal.safetensors'), 'normal.safetensors');
    assert.equal(util.diskDirName('C:/x', 'Normal Model', 1), 'Normal Model');
  } else {
    assert.equal(util.diskFileName('C:/x', 'normal.safetensors'), 'normal.safetensors');
  }
});

test('uniqueName: 冲突时追加序号', () => {
  const used = ['Model', 'Model-2'];
  assert.equal(util.uniqueName('Other', used), 'Other');
  assert.equal(util.uniqueName('Model', used), 'Model-3');
  assert.equal(util.uniqueName('model', used), 'model-3', '大小写不敏感');
});

test('resolveUserPath: 相对路径相对项目根', () => {
  const root = process.platform === 'win32' ? 'C:\\proj' : '/proj';
  assert.equal(util.resolveUserPath('downloads', root), path.resolve(root, 'downloads'));
  assert.equal(util.resolveUserPath('', root), root);
  const abs = process.platform === 'win32' ? 'D:\\models' : '/models';
  assert.equal(util.resolveUserPath(abs, root), path.normalize(abs));
});

test('pathTooLong: 仅 Windows 生效', () => {
  const long = `C:/${'a'.repeat(400)}`;
  assert.equal(util.pathTooLong(long), process.platform === 'win32');
  assert.equal(util.pathTooLong('C:/x'), false);
});

// ---------------------------------------------------------------------------
// Concurrency / retries
// 并发 / 重试
// ---------------------------------------------------------------------------

test('mapPool: 保持顺序且并发不超限', async () => {
  const items = Array.from({ length: 20 }, (_, i) => i);
  let running = 0;
  let peak = 0;
  const out = await util.mapPool(items, 4, async (n) => {
    running++;
    peak = Math.max(peak, running);
    await util.sleep(5);
    running--;
    return n * 2;
  });
  assert.deepEqual(out, items.map((n) => n * 2));
  assert.ok(peak <= 4, `并发峰值 ${peak} 应 <= 4`);
  assert.ok(peak > 1, '应确实并发执行');

  assert.deepEqual(await util.mapPool([], 3, async () => 1), []);
});

test('mapPool: onError 时错误不中断整体', async () => {
  const errors = [];
  const out = await util.mapPool(
    [1, 2, 3],
    2,
    async (n) => {
      if (n === 2) throw new Error('boom');
      return n;
    },
    (e) => errors.push(e.message)
  );
  assert.deepEqual(out, [1, undefined, 3]);
  assert.deepEqual(errors, ['boom']);
});

test('withRetry: 退避重试、尊重 retryAfterMs、非重试错误立即抛出', async () => {
  let attempts = 0;
  const value = await util.withRetry(
    async () => {
      attempts++;
      if (attempts < 3) throw new Error('temporary');
      return 'ok';
    },
    { attempts: 5, baseDelayMs: 1, maxDelayMs: 2 }
  );
  assert.equal(value, 'ok');
  assert.equal(attempts, 3);

  let rateAttempts = 0;
  const t0 = Date.now();
  await util.withRetry(
    async () => {
      rateAttempts++;
      if (rateAttempts === 1) throw new RateLimitError('slow down', 30);
      return 'ok';
    },
    { attempts: 3, baseDelayMs: 5000, maxDelayMs: 10000 }
  );
  assert.ok(Date.now() - t0 < 4000, '应使用 retryAfterMs 而不是指数退避');

  await assert.rejects(
    () =>
      util.withRetry(async () => {
        throw new Error('fatal');
      }, { attempts: 3, baseDelayMs: 1, shouldRetry: () => false }),
    /fatal/
  );
});

test('formatDuration / formatBytes / truncate', () => {
  assert.equal(util.formatDuration(30), '30 秒');
  assert.equal(util.formatDuration(90), '1 分 30 秒');
  assert.equal(util.formatDuration(-1), '--');
  assert.equal(util.formatBytes(0), '0 B');
  assert.equal(util.formatBytes(1536), '1.50 KiB');
  assert.equal(util.truncate('abcdef', 4), 'abc…');
  assert.equal(util.truncate('ab', 4), 'ab');
});
