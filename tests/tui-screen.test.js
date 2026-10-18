'use strict';

/**
 * Tests for the app shell (screen.js) and the task registry (tasks.js).
 *
 * The shell is the part users look at all the time, so it is exercised without a terminal: stdout is
 * captured, stdin is a fake TTY that can emit keypresses, and the painted frame is asserted line by
 * line. Everything is restored afterwards — the whole suite shares one process.
 *
 *
 * 应用外壳（screen.js）与任务登记表（tasks.js）的测试。
 *
 * 外壳是用户一直在看的部分，因此这里在没有终端的情况下演练它：捕获 stdout，
 * stdin 换成可以手动发按键的假 TTY，并逐行断言画出来的框架。结束后全部还原——
 * 整套测试共用一个进程。
 */

const test = require('node:test');
const assert = require('node:assert/strict');
const { EventEmitter } = require('events');

const i18n = require('../src/i18n');
const layout = require('../src/tui/layout');
const tasks = require('../src/tui/tasks');
const screen = require('../src/tui/screen');
const pages = require('../src/tui/pages');
const view = require('../src/tui/view');

const LANGUAGE_AT_LOAD = i18n.getLanguage();
test.after(() => i18n.setLanguage(LANGUAGE_AT_LOAD));

const ANSI = /\u001b\[[0-9;?]*[a-zA-Z]/g;

/**
 * Install a fake terminal for the duration of `fn`, then restore everything.
 * 在 `fn` 执行期间安装假终端，结束后全部还原。
 */
async function withFakeTerminal(fn, opts = {}) {
  const frames = [];
  const original = {
    write: process.stdout.write,
    isTTY: process.stdout.isTTY,
    columns: process.stdout.columns,
    rows: process.stdout.rows,
    stdin: process.stdin,
    cp: process.env.CIVITAI_CONSOLE_CP,
    ascii: process.env.CIVITAI_ASCII,
    plain: process.env.CIVITAI_PLAIN,
  };
  const stdin = new EventEmitter();
  stdin.isTTY = true;
  stdin.isRaw = false;
  stdin.setRawMode = (value) => {
    stdin.isRaw = !!value;
  };
  stdin.resume = () => {};
  stdin.pause = () => {};
  stdin.setEncoding = () => {};

  process.stdout.isTTY = true;
  process.stdout.columns = opts.columns || 100;
  process.stdout.rows = opts.rows || 30;
  process.stdout.write = (chunk) => {
    frames.push(String(chunk));
    return true;
  };
  Object.defineProperty(process, 'stdin', { value: stdin, configurable: true, writable: true });
  process.env.CIVITAI_CONSOLE_CP = '65001';
  delete process.env.CIVITAI_ASCII;
  delete process.env.CIVITAI_PLAIN;

  // Current frame as plain text (escape sequences stripped).
  // 当前一帧的纯文本（已去掉转义序列）。
  const frame = () => (frames[frames.length - 1] || '').split('\n').map((line) => line.replace(ANSI, ''));

  const key = (name, text) =>
    stdin.emit('keypress', text === undefined ? '' : text, { name, ctrl: false, meta: false, shift: false });

  // Let the shell's scheduled repaint run (it coalesces through setImmediate).
  // 让外壳排队的重绘跑完（它通过 setImmediate 合并多次请求）。
  const settle = () => new Promise((resolve) => setImmediate(resolve));

  try {
    return await fn({ frames, frame, key, settle, stdin });
  } finally {
    screen.stop();
    process.stdout.write = original.write;
    process.stdout.isTTY = original.isTTY;
    process.stdout.columns = original.columns;
    process.stdout.rows = original.rows;
    Object.defineProperty(process, 'stdin', { value: original.stdin, configurable: true, writable: true });
    if (original.cp === undefined) delete process.env.CIVITAI_CONSOLE_CP;
    else process.env.CIVITAI_CONSOLE_CP = original.cp;
    if (original.ascii === undefined) delete process.env.CIVITAI_ASCII;
    else process.env.CIVITAI_ASCII = original.ascii;
    if (original.plain === undefined) delete process.env.CIVITAI_PLAIN;
    else process.env.CIVITAI_PLAIN = original.plain;
  }
}

// ---------------------------------------------------------------------------
// tasks.js
// 任务登记表
// ---------------------------------------------------------------------------

test('tasks: 登记 / 更新 / 结束，运行中的排在前面', () => {
  tasks.reset();
  const a = tasks.createTask({ kind: 'download', name: '收藏集 A', total: 4, totalBytes: 100 });
  const b = tasks.createTask({ kind: 'check', name: '收藏集 B' });
  tasks.updateTask(a, { bytes: 25, done: 1, scope: 'Model A', detail: 'a.safetensors', speed: 10, eta: '00:05' });
  tasks.updateTask(b, { status: tasks.DONE });
  tasks.finishTask(b, tasks.DONE);

  const all = tasks.listTasks();
  assert.equal(all.length, 2);
  assert.equal(all[0].id, a, '运行中的任务排在最前');
  assert.equal(all[0].scope, 'Model A');
  assert.equal(all[0].status, tasks.RUNNING);
  assert.equal(tasks.runningTasks().length, 1);

  assert.equal(tasks.percentOf(tasks.getTask(a)), 25);
  tasks.updateTask(a, { bytes: 400 });
  assert.equal(tasks.percentOf(tasks.getTask(a)), 100, '百分比封顶 100');
  assert.equal(tasks.percentOf(tasks.getTask(b)), 0, '总量未知时为 0');
});

test('tasks: 未知 id 不抛错，取消只对运行中的任务生效', () => {
  tasks.reset();
  assert.equal(tasks.updateTask('nope', { bytes: 1 }), null);
  assert.equal(tasks.finishTask('nope'), null);
  assert.equal(tasks.cancelTask('nope'), false);

  const id = tasks.createTask({ kind: 'download', name: 'x' });
  let cancelled = 0;
  tasks.setTaskCancel(id, () => {
    cancelled++;
  });
  assert.equal(tasks.cancelTask(id), true);
  assert.equal(cancelled, 1);
  tasks.finishTask(id, tasks.CANCELLED);
  assert.equal(tasks.cancelTask(id), false, '已结束的任务不能再取消');
  assert.equal(tasks.runningTasks().length, 0);

  tasks.clearFinished();
  assert.equal(tasks.listTasks().length, 0);
});

test('tasks: 已用时间在结束后冻结', () => {
  tasks.reset();
  const id = tasks.createTask({ kind: 'download', name: 'x' });
  const running = tasks.getTask(id);
  assert.ok(tasks.elapsedMs(running) >= 0);
  tasks.updateTask(id, { status: 'running' });
  tasks.finishTask(id, tasks.DONE);
  const frozen = tasks.elapsedMs(tasks.getTask(id));
  return new Promise((resolve) => setTimeout(resolve, 20)).then(() => {
    assert.equal(tasks.elapsedMs(tasks.getTask(id)), frozen);
    assert.equal(typeof tasks.elapsedText(tasks.getTask(id)), 'string');
  });
});

// ---------------------------------------------------------------------------
// Pure frame pieces
// 纯渲染片段
// ---------------------------------------------------------------------------

test('screen: 信息面板包含已设置信息与任务进度，且能降级', () => {
  tasks.reset();
  screen.setInfo(() => [
    { label: '站点', value: 'https://civitai.com' },
    { label: '登录态', value: '未登录' },
    { label: '下载目录', value: 'D:\\out' },
    { label: '并发', value: '3' },
  ]);
  const id = tasks.createTask({ kind: 'download', name: '收藏集 9', total: 10, totalBytes: 1000 });
  tasks.updateTask(id, { bytes: 250, scope: 'Model A' });

  const wide = screen.infoPanel(12).lines.join('\n');
  assert.ok(wide.includes('站点'), wide);
  assert.ok(wide.includes('https://civitai.com'));
  assert.ok(wide.includes('未登录'));
  assert.ok(wide.includes('D:\\out'));
  assert.ok(wide.includes('收藏集 9'));
  assert.ok(wide.includes('Model A'));
  assert.ok(wide.includes('25.0%'), wide);

  // A short terminal keeps the facts and shrinks the panel instead of overflowing.
  // 终端很矮时保留信息行并缩小面板，而不是溢出。
  const narrow = screen.infoPanel(6).lines;
  assert.ok(narrow.length <= 3 + 2, `面板行数应受预算约束：${narrow.length}`);
  tasks.reset();
});

test('screen: 任务视图逐任务两行，空时给出提示', () => {
  tasks.reset();
  const empty = screen.taskViewLines(12).join('\n');
  assert.ok(empty.includes(i18n.t('tui.screen.taskTitle')));
  assert.ok(empty.includes(i18n.t('tui.screen.taskNone')));

  const id = tasks.createTask({ kind: 'download', name: '收藏集 9', total: 4, totalBytes: 400 });
  tasks.updateTask(id, { bytes: 100, done: 1, scope: 'Model A', speed: 2048, eta: '00:03' });
  const text = screen.taskViewLines(12).join('\n');
  assert.ok(text.includes('收藏集 9'));
  assert.ok(text.includes(i18n.t('tui.screen.statusRunning')));
  assert.ok(text.includes(i18n.t('tui.screen.taskCounts', { done: 1, skipped: 0, failed: 0, total: 4 })));
  tasks.reset();
});

// ---------------------------------------------------------------------------
// The shell itself
// 外壳本身
// ---------------------------------------------------------------------------

test('screen: 固定页眉 / 信息面板 / 页脚一直显示，Tab 切换任务视图', async () => {
  await withFakeTerminal(async ({ frame, key, settle }) => {
    tasks.reset();
    assert.equal(screen.start({ onQuit: () => {} }), true);
    screen.setInfo(() => [
      { label: '站点', value: 'https://civitai.com' },
      { label: '并发', value: '3' },
    ]);
    screen.setBase({
      title: i18n.t('tui.app.menuTitle'),
      render: () => ['▸ 第一项'],
      hints: () => [i18n.t('tui.app.menuHint')],
      onKey: () => true,
    });
    const id = tasks.createTask({ kind: 'download', name: '收藏集 9', total: 10, totalBytes: 1000 });
    tasks.updateTask(id, { bytes: 500, scope: 'Model A' });
    screen.render();

    const lines = frame();
    assert.equal(lines[0].trim(), i18n.t('tui.app.bannerTitle'));
    assert.equal(lines[1].trim(), i18n.t('tui.screen.headerHint'));
    const text = lines.join('\n');
    assert.ok(text.includes(i18n.t('tui.screen.infoTitle')), text);
    assert.ok(text.includes('https://civitai.com'));
    assert.ok(text.includes('收藏集 9'));
    assert.ok(text.includes('50.0%'));
    assert.ok(text.includes('第一项'));
    assert.ok(text.includes(i18n.t('tui.app.menuHint')), '页脚显示当前界面的按键提示');
    assert.ok(lines.length <= 30, '帧不超过终端行数');

    key('tab');
    await settle();
    screen.render();
    const taskView = frame().join('\n');
    assert.ok(taskView.includes(i18n.t('tui.screen.taskTitle')));
    assert.ok(taskView.includes(i18n.t('tui.screen.hintTaskView')));

    key('tab');
    await settle();
    screen.render();
    assert.ok(!frame().join('\n').includes(i18n.t('tui.screen.hintTaskView')), 'Tab 再按一次返回');
    tasks.reset();
  });
});

test('screen: 菜单提问渲染在框架内，回车确认、Esc 取消', async () => {
  await withFakeTerminal(async ({ frame, key, settle }) => {
    assert.equal(screen.start({ onQuit: () => {} }), true);
    screen.setBase({ title: '主菜单', render: () => ['▸ 主菜单项'], hints: () => ['主菜单提示'] });

    const answer = pages.promptMenu(
      '要下载什么？',
      [
        { title: '下载模型', value: 'model', description: '粘贴模型链接' },
        { title: '下载收藏集', value: 'collection', description: '粘贴收藏集 ID' },
      ],
      { stage: '下载' }
    );
    await settle();
    screen.render();
    const text = frame().join('\n');
    assert.ok(text.includes('主菜单'), '面包屑保留上一级');
    assert.ok(text.includes('下载'), '面包屑显示当前阶段');
    assert.ok(text.includes('要下载什么？'));
    assert.ok(text.includes('下载模型'));
    assert.ok(text.includes(i18n.t('tui.pages.hintMenu')), '页脚换成提问的按键提示');

    key('down');
    await settle();
    key('return');
    assert.equal(await answer, 'collection');
    screen.render();
    assert.ok(frame().join('\n').includes('主菜单项'), '提问结束后回到原界面');

    const cancelled = pages.promptMenu('取消我', [{ title: 'A', value: 'a' }]);
    await settle();
    key('escape');
    assert.equal(await cancelled, null);
  });
});

test('screen: 文本提问支持输入、退格与校验', async () => {
  await withFakeTerminal(async ({ key, settle, frame }) => {
    assert.equal(screen.start({ onQuit: () => {} }), true);

    const answer = pages.promptText('收藏集 ID', {
      initial: '12',
      validate: (value) => (/^\d+$/.test(value) ? true : '只能是数字'),
    });
    await settle();
    key('x', 'x');
    key('return');
    await settle();
    screen.render();
    assert.ok(frame().join('\n').includes('只能是数字'), '校验失败时给出错误而不是结束提问');

    key('backspace');
    key('3', '3');
    key('return');
    assert.equal(await answer, '123');

    const cancelled = pages.promptText('取消我', {});
    await settle();
    key('escape');
    assert.equal(await cancelled, null);
  });
});

test('screen: 确认提问默认值与危险默认值', async () => {
  await withFakeTerminal(async ({ key, settle }) => {
    assert.equal(screen.start({ onQuit: () => {} }), true);
    const yes = pages.promptConfirm('继续？', { initial: true });
    await settle();
    key('return');
    assert.equal(await yes, true);

    const danger = pages.promptConfirm('删掉它？', { danger: true });
    await settle();
    key('return');
    assert.equal(await danger, false, '危险操作默认选中「否」');
  });
});

test('screen: Esc 优先取消正在运行的任务；Ctrl+C 请求退出', async () => {
  await withFakeTerminal(async ({ key, settle }) => {
    let quit = 0;
    let cancelled = 0;
    assert.equal(screen.start({ onQuit: () => quit++ }), true);
    // The main menu has nothing above it, so an unclaimed Esc is the app's "quit".
    // 主菜单之上没有别的界面，因此没人接管的 Esc 就是应用的「退出」。
    screen.setBase({ title: '主菜单', render: () => [], hints: () => [] });
    view.setCancelHandler(() => cancelled++);

    key('escape');
    await settle();
    assert.equal(cancelled, 1, '有任务在跑时 Esc 先取消任务');
    assert.equal(quit, 0);

    view.setCancelHandler(null);
    key('escape');
    await settle();
    assert.equal(quit, 1, '没有任务时 Esc 回到应用层（主菜单 = 退出）');

    key('c', '\u0003');
    await settle();
    assert.equal(quit, 2, 'Ctrl+C 请求退出');
  });
});

test('screen: 重绘先回到左上角，新一帧不会接在上一帧末尾', async () => {
  await withFakeTerminal(async ({ frames, key, settle }) => {
    assert.equal(screen.start({ onQuit: () => {} }), true);
    let step = 0;
    screen.setBase({
      title: '主菜单',
      render: () => [`▸ 第 ${step} 项`],
      hints: () => ['提示'],
      onKey: () => {
        step += 1;
        return true;
      },
    });
    const before = frames.length;
    key('x', 'x');
    await settle();
    const painted = frames.slice(before).join('');
    assert.ok(
      painted.startsWith(layout.ansi().homeAndClear),
      '每次重绘都必须先回左上角并向下擦除，否则新帧会粘在旧帧后面'
    );
    const lines = painted.slice(layout.ansi().homeAndClear.length).split('\n');
    assert.equal(lines[0].replace(ANSI, '').trim(), i18n.t('tui.app.bannerTitle'));
    assert.equal(lines[1].replace(ANSI, '').trim(), i18n.t('tui.screen.headerHint'));
  });
});

test('screen: 按键钩子先于界面拿到按键，被消费后界面看不到', async () => {
  await withFakeTerminal(async ({ key, settle }) => {
    assert.equal(screen.start({ onQuit: () => {} }), true);
    const seen = [];
    screen.setBase({
      title: '主菜单',
      render: () => [],
      hints: () => [],
      onKey: (text) => {
        seen.push(`base:${text}`);
        return true;
      },
    });
    // A running download registers this hook for its "s skips the current model" key.
    // 运行中的下载会登记这个钩子来处理「s 跳过当前模型」。
    screen.setKeyHook((text) => {
      seen.push(`hook:${text}`);
      return text === 's';
    });

    key('s', 's');
    key('x', 'x');
    await settle();
    assert.deepEqual(seen, ['hook:s', 'hook:x', 'base:x']);
    screen.setKeyHook(null);
  });
});

test('view.note / view.log 在外壳里写进日志区，而不是控制台', async () => {
  await withFakeTerminal(async ({ frame }) => {
    assert.equal(screen.start({ onQuit: () => {} }), true);
    screen.setBase({ title: '主菜单', render: () => ['▸ 项'], hints: () => [] });
    view.note('普通一行');
    view.log('带时间戳一行');
    screen.render();
    const text = frame().join('\n');
    assert.ok(text.includes(i18n.t('tui.screen.logTitle')), text);
    assert.ok(text.includes('普通一行'));
    assert.match(text, /\[\d{4}-\d{2}-\d{2} \d{2}:\d{2}:\d{2}\] 带时间戳一行/);
    screen.clearLog();
  });
});

test('screen: 非 TTY 下不接管终端，start 返回 false', async () => {
  const original = process.stdout.isTTY;
  process.stdout.isTTY = false;
  try {
    assert.equal(screen.isActive(), false);
    assert.equal(screen.start({ onQuit: () => {} }), false);
  } finally {
    process.stdout.isTTY = original;
  }
});

test('screen: 窄终端下框架不去掉页眉，且行宽不超列数', async () => {
  await withFakeTerminal(
    async ({ frame }) => {
      assert.equal(screen.start({ onQuit: () => {} }), true);
      screen.setInfo(() => [{ label: '站点', value: 'https://civitai.com/very/long/path/that/keeps/going' }]);
      screen.setBase({
        title: '主菜单',
        render: (ctx) => ['长内容'.repeat(40), `宽度 ${ctx.width}`],
        hints: () => ['提示'],
      });
      screen.render();
      const lines = frame();
      assert.ok(lines[0].includes(i18n.t('tui.app.bannerTitle')));
      for (const line of lines) {
        assert.ok(layout.displayWidth(line) <= 60, `行宽超限：${JSON.stringify(line)}`);
      }
    },
    { columns: 60, rows: 16 }
  );
});
