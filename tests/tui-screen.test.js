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
const fs = require('fs');
const os = require('os');
const path = require('path');
const { EventEmitter } = require('events');

const i18n = require('../src/i18n');
const layout = require('../src/tui/layout');
const tasks = require('../src/tui/tasks');
const screen = require('../src/tui/screen');
const pages = require('../src/tui/pages');
const settings = require('../src/tui/settings');
const download = require('../src/tui/download');
const downloadTask = require('../src/tui/downloadTask');
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

  const key = (name, text, ctrl) =>
    stdin.emit('keypress', text === undefined ? '' : text, { name, ctrl: !!ctrl, meta: false, shift: false });

  // Let the shell's scheduled repaint run (it coalesces through setImmediate).
  // 让外壳排队的重绘跑完（它通过 setImmediate 合并多次请求）。
  const settle = () => new Promise((resolve) => setImmediate(resolve));

  try {
    return await fn({ frames, frame, key, settle, stdin });
  } finally {
    screen.stop();
    // A failed assertion can leave a prompt open; the shell is shared by every test in this file.
    // 断言失败可能留下未结束的提问；本文件里的测试共用同一个外壳。
    screen.resetState();
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

test('tasks: 排队任务按 FIFO 排序，位置与已用时间正确', () => {
  tasks.reset();
  const running = tasks.createTask({ kind: 'download', name: 'A', total: 2, totalBytes: 10 });
  const first = tasks.createTask({ kind: 'download', name: 'B', total: 3, totalBytes: 20, status: tasks.QUEUED });
  const second = tasks.createTask({ kind: 'download', name: 'C', total: 4, totalBytes: 30, status: tasks.QUEUED });

  assert.deepEqual(tasks.listTasks().map((task) => task.id), [running, first, second], '运行中在前，排队按创建顺序');
  assert.equal(tasks.queuePosition(first), 1);
  assert.equal(tasks.queuePosition(second), 2);
  assert.equal(tasks.percentOf(tasks.getTask(first)), 0, '排队中没有进度');
  assert.equal(tasks.elapsedMs(tasks.getTask(first)), 0, '排队中没有已用时间');
  assert.equal(tasks.activeTasks().length, 3, '运行中与排队中都算活动任务');

  // Cancelling a queued task removes it from the queue and marks it cancelled.
  // 取消排队任务会把它移出队列并标记为已取消。
  let removed = 0;
  tasks.setTaskCancel(first, () => {
    removed++;
  });
  assert.equal(tasks.cancelTask(first), true);
  assert.equal(removed, 1);
  assert.equal(tasks.getTask(first).status, tasks.CANCELLED);
  assert.equal(tasks.queuePosition(second), 1, '后面的任务补位');

  // Starting the queue promotes a queued task to running and starts its clock.
  // 队列启动会把排队任务提升为运行中并开始计时。
  tasks.startTask(second);
  assert.equal(tasks.getTask(second).status, tasks.RUNNING);
  assert.ok(tasks.elapsedMs(tasks.getTask(second)) >= 0);
  assert.equal(tasks.queuePosition(second), 0);
  tasks.reset();
});

test('tasks: 跳过 / 重试回调只对合适的状态生效', () => {
  tasks.reset();
  const id = tasks.createTask({ kind: 'download', name: 'x' });
  let skipped = 0;
  tasks.setTaskSkip(id, () => {
    skipped++;
  });
  assert.equal(tasks.skipTask(id), true);
  assert.equal(skipped, 1);
  tasks.finishTask(id, tasks.FAILED, { done: 1, failed: 1 });
  assert.equal(tasks.skipTask(id), false, '结束的任务不能跳过');

  let retried = 0;
  tasks.setTaskRetry(id, () => {
    retried++;
  });
  assert.equal(tasks.retryTask(id), true);
  assert.equal(retried, 1);
  tasks.reset();
});

test('screen: 任务视图显示排队位置、失败项与日志路径', () => {
  tasks.reset();
  const queued = tasks.createTask({
    kind: 'download',
    name: '收藏集 Q',
    total: 3,
    totalBytes: 300,
    status: tasks.QUEUED,
  });
  let text = screen.taskViewLines(12).join('\n');
  assert.ok(text.includes(i18n.t('tui.screen.statusQueued')), text);
  assert.ok(text.includes(i18n.t('tui.screen.taskQueuePosition', { position: tasks.queuePosition(queued) })), text);

  tasks.reset();
  const finished = tasks.createTask({ kind: 'download', name: '收藏集 F', total: 2, totalBytes: 200 });
  tasks.updateTask(finished, {
    done: 1,
    failed: 1,
    failures: [{ modelId: '9', name: 'Model E', message: 'HTTP 404' }],
    logFile: 'D:\\\\logs\\\\f.log',
  });
  tasks.finishTask(finished, tasks.FAILED, {
    done: 1,
    skipped: 0,
    failed: 1,
    metaFailed: 0,
    elapsedMs: 65000,
    logFile: 'D:\\\\logs\\\\f.log',
  });
  text = screen.taskViewLines(12).join('\n');
  assert.ok(text.includes('Model E'), text);
  assert.ok(text.includes('HTTP 404'), text);
  assert.ok(text.includes('f.log'), text);
  tasks.reset();
});

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
  assert.ok(wide.includes('任务总览'), wide);
  assert.ok(wide.includes(i18n.t('tui.screen.infoProgress')), wide);
  assert.ok(wide.includes('25.0%'), wide);
  assert.ok(wide.includes(i18n.t('tui.screen.infoDoneCount', { done: 0, total: 1 })), wide);
  assert.ok(wide.includes(i18n.t('tui.screen.infoRunningCount', { count: 1 })), wide);

  // A short terminal keeps the facts and shrinks the panel instead of overflowing.
  // 终端很矮时保留信息行并缩小面板，而不是溢出。
  const narrow = screen.infoPanel(6).lines;
  assert.ok(narrow.length <= 3 + 2, `面板行数应受预算约束：${narrow.length}`);
  tasks.reset();
});

test('screen: 任务总览固定一行，合计所有任务的进度与状态数量', () => {
  tasks.reset();
  screen.setInfo(() => [{ label: '站点', value: 'https://civitai.com' }]);
  const running = tasks.createTask({ kind: 'download', name: '运行中任务', total: 4, totalBytes: 100 });
  tasks.updateTask(running, { bytes: 25 });
  tasks.createTask({ kind: 'download', name: '排队任务', total: 2, totalBytes: 10, status: tasks.QUEUED });
  const done = tasks.createTask({ kind: 'download', name: '已完成任务', total: 1, totalBytes: 1 });
  tasks.updateTask(done, { bytes: 1 });
  tasks.finishTask(done, tasks.DONE, { done: 1, skipped: 0, failed: 0, elapsedMs: 1000 });

  const text = screen.infoPanel(20).lines.join('\n');
  assert.ok(text.includes(i18n.t('tui.screen.infoTasks')), text);
  assert.ok(text.includes('任务总览'), text);
  assert.ok(text.includes(i18n.t('tui.screen.infoProgress')), text);
  assert.ok(text.includes(i18n.t('tui.screen.infoDoneCount', { done: 1, total: 3 })), text);
  assert.ok(text.includes(i18n.t('tui.screen.infoRunningCount', { count: 1 })), text);
  assert.ok(text.includes(i18n.t('tui.screen.infoQueuedCount', { count: 1 })), text);
  assert.ok(text.includes('23.4%'), text);
  // The overview is one line: individual task names are no longer repeated in the dashboard.
  // 总览只有一行：单个任务名称不再出现在仪表盘里。
  assert.ok(!text.includes('运行中任务'), text);
  assert.ok(!text.includes('排队任务'), text);

  tasks.reset();
  for (let index = 0; index < 12; index++) {
    const id = tasks.createTask({ kind: 'download', name: `任务 ${index}`, total: 1, totalBytes: 1 });
    tasks.updateTask(id, { bytes: 1 });
    tasks.finishTask(id, tasks.DONE, { done: 1, skipped: 0, failed: 0, elapsedMs: 1 });
  }
  const many = screen.infoPanel(24).lines.join('\n');
  // No running/queued task left: the overview goes back to "idle" instead of leaving a stale bar.
  // 没有运行中/排队中的任务时，总览回到「空闲」，而不是留下一条过时的进度条。
  assert.ok(many.includes(i18n.t('tui.screen.infoIdle')), many);
  assert.ok(!many.includes('100.0%'), many);
  tasks.reset();
});

test('screen: 任务视图逐任务两行，空时给出提示', () => {
  tasks.reset();
  const empty = screen.taskViewLines(12).join('\n');
  // The heading comes from the breadcrumb ("main menu › task view"), so the content starts with the hint.
  // 标题由面包屑给出（「主菜单 › 任务视图」），因此内容从提示行开始。
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
      hints: () => ['本页额外按键'],
      onKey: () => true,
    });
    const id = tasks.createTask({ kind: 'download', name: '收藏集 9', total: 10, totalBytes: 1000 });
    tasks.setTaskSkip(id, () => {});
    tasks.updateTask(id, { bytes: 500, scope: 'Model A' });
    screen.render();

    const lines = frame();
    assert.equal(lines[0].trim(), i18n.t('tui.app.bannerTitle'));
    assert.equal(lines[1].trim(), '', '页眉只留项目名与一行空行');
    const text = lines.join('\n');
    assert.ok(text.includes(i18n.t('tui.screen.infoTitle')), text);
    assert.ok(text.includes('https://civitai.com'));
    assert.ok(text.includes(i18n.t('tui.screen.infoProgress')), text);
    assert.ok(text.includes(i18n.t('tui.screen.infoRunningCount', { count: 1 })), text);
    assert.ok(text.includes('50.0%'));
    assert.ok(text.includes('第一项'));
    // The page owns the whole footer line: exactly one line, listing its keys.
    // 页脚由页面完全拥有：只有一行，列出这一页的键。
    assert.equal(lines[lines.length - 1].trim(), '本页额外按键');
    assert.ok(lines.length <= 30, '帧不超过终端行数');

    key('tab');
    await settle();
    screen.render();
    const taskView = frame().join('\n');
    // The task view is a screen of its own: its heading is not a breadcrumb under the menu.
    // 任务视图是独立界面：标题不是「主菜单」下的一层。
    assert.ok(taskView.includes(i18n.t('tui.screen.taskTitle')));
    assert.ok(!taskView.includes(`${i18n.t('tui.app.menuTitle')} ›`), `任务视图不应挂在主菜单下：\n${taskView}`);
    assert.ok(taskView.includes(i18n.t('tui.hint.taskRunning')));

    key('tab');
    await settle();
    screen.render();
    assert.ok(!frame().join('\n').includes(i18n.t('tui.hint.taskRunning')), 'Tab 再按一次返回');
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
    const rendered = frame();
    const text = rendered.join('\n');
    assert.ok(text.includes('主菜单'), '面包屑保留上一级');
    assert.ok(text.includes('要下载什么？'));
    assert.ok(text.includes('下载模型') && text.includes('粘贴模型链接'), '选项与说明都要显示');

    // The breadcrumb is followed by a rule, like the header of a page.
    // 面包屑下方有一条横线，像一页的页头。
    const crumbIndex = rendered.findIndex((line) => line.includes('主菜单') && line.includes('下载'));
    assert.ok(crumbIndex >= 0, `面包屑应显示当前阶段：\n${text}`);
    assert.match(rendered[crumbIndex + 1].trim(), /^[-─]{10,}$/, '面包屑下方应有一条横线');
    assert.ok(!text.includes('下载 › 下载'), '路径不应重复同一段');

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
    assert.equal(lines[1].replace(ANSI, '').trim(), '', '页眉第二行留空');
    const last = painted.split('\n').filter((line) => line.trim()).pop() || '';
    assert.ok(last.includes('提示'), `最后一行应是页脚那一行按键说明：${last}`);
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

test('screen: 信息页把说明显示成页面，只有 Esc 能返回', async () => {
  await withFakeTerminal(async ({ frame, key, settle }) => {
    assert.equal(screen.start({ onQuit: () => {} }), true);
    screen.setBase({ title: i18n.t('tui.app.menuTitle'), render: () => ['▸ 主菜单项'], hints: () => [] });

    const shown = pages.promptMessage(i18n.t('tui.app.menuCollections'), ['还没有任何收藏集快照', '', '先去下载一次']);
    await settle();
    screen.render();
    const text = frame().join('\n');
    assert.ok(text.includes('还没有任何收藏集快照'), text);
    assert.ok(text.includes('先去下载一次'), '说明行要能读到，而不是被截断');
    assert.ok(text.includes(i18n.t('tui.app.menuCollections')), '信息页也有自己的页面标题');
    // Nothing to open here: Enter must do nothing (Esc is the only way back).
    // 这里没有可进入的东西：Enter 不应有反应（返回只有 Esc）。
    key('return');
    await settle();
    screen.render();
    assert.ok(frame().join('\n').includes('还没有任何收藏集快照'), 'Enter 在这一页无作用');

    key('escape');
    assert.equal(await shown, null);
    await settle();
    screen.render();
    assert.ok(frame().join('\n').includes('主菜单项'), 'Esc 返回上一页');
  });
});

test('screen: 设置页滚动且首尾循环，光标不会跑出屏幕', async () => {
  await withFakeTerminal(
    async ({ frame, key, settle }) => {
      assert.equal(screen.start({ onQuit: () => {} }), true);
      const { settingsPage } = require('../src/tui/settings');
      const config = {
        site: 'https://civitai.com',
        outDir: 'D:\\downloads',
        jobs: 3,
        fileTypes: ['Model'],
        engine: 'curl',
        dedup: 'off',
      };
      const done = settingsPage(config);
      await settle();

      const cursorLine = () => frame().findIndex((line) => line.includes('▸'));
      const listTop = () => {
        const rows = frame();
        const ruleIndex = rows.findIndex((line) => /^[-─]{20,}$/.test(line.trim()));
        return rows[ruleIndex + 2].replace('▸', ' ').trimEnd();
      };
      screen.render();
      assert.ok(cursorLine() >= 0, '一开始光标就在屏幕内');
      assert.ok(frame().join('\n').includes('第 1 /'), '位置提示显示当前序号');

      // Moving inside the window must not scroll the text; only the cursor marker changes.
      // 在视窗内移动时文字不应滚动，变的只有光标标记。
      const beforeTop = listTop();
      key('down');
      await settle();
      screen.render();
      assert.equal(listTop(), beforeTop, '光标在视窗内移动时文字不应滚动');

      // Walk past the bottom of the window: the list must scroll and keep the cursor visible.
      // 一路按到视窗之外：列表必须滚动，光标仍要留在屏幕内。
      for (let i = 0; i < 20; i++) key('down');
      await settle();
      screen.render();
      const scrolled = cursorLine();
      assert.ok(scrolled >= 0 && scrolled < 20, `光标跑出屏幕了：${scrolled}`);

      // The last row of the page is the last action, not a "save" row any more.
      // 页面最后一行是最后一个操作项（不再有「保存」行）。
      key('end');
      await settle();
      screen.render();
      assert.ok(
        frame().join('\n').includes(i18n.t('tui.settings.actionReset')),
        '滚到底部应能看到最后一个操作项'
      );

      // ↑ on the first entry wraps to the last one.
      // 在第一项按 ↑ 会跳到最后一项。
      key('home');
      await settle();
      key('up');
      await settle();
      screen.render();
      const wrapped = frame()[cursorLine()];
      assert.ok(wrapped.includes(i18n.t('tui.settings.actionReset')), `首行按 ↑ 应跳到末项：${wrapped}`);

      key('escape');
      await settle();
      key('escape');
      await settle();
      await done;
    },
    { columns: 96, rows: 20 }
  );
});

test('screen: Tab 在提问打开时也有效（页脚写了就要能用）', async () => {
  await withFakeTerminal(async ({ frame, key, settle }) => {
    assert.equal(screen.start({ onQuit: () => {} }), true);
    screen.setBase({ title: '主菜单', render: () => ['▸ 主菜单项'], hints: () => [] });

    const answer = pages.promptMenu('要下载什么？', [{ title: '下载模型', value: 'model' }]);
    await settle();
    screen.render();

    key('tab');
    await settle();
    screen.render();
    assert.ok(frame().join('\n').includes(i18n.t('tui.screen.taskTitle')), '提问期间 Tab 也能打开任务视图');

    key('tab');
    await settle();
    screen.render();
    assert.ok(frame().join('\n').includes('要下载什么？'), '再按一次回到原来的提问');

    key('return');
    assert.equal(await answer, 'model');
  });
});

test('screen: 目录字段的页脚提示出现 Ctrl+O，文本字段没有', async () => {
  await withFakeTerminal(async ({ frame, key, settle }) => {
    assert.equal(screen.start({ onQuit: () => {} }), true);
    const plain = pages.promptText('收藏集 ID', {});
    await settle();
    screen.render();
    assert.ok(!frame().join('\n').includes('Ctrl+O'), '普通输入框不提示目录选择');
    key('escape');
    await plain;

    const dir = pages.promptText('下载目录', { initial: 'D:\\out', pick: 'directory' });
    await settle();
    screen.render();
    const rows = frame();
    assert.ok(rows.join('\n').includes('Ctrl+O 选择目录'), rows.join('\n'));
    // Still one single footer line, and it is this field's line.
    // 仍然只有一行页脚，且就是这个字段自己的那一行。
    assert.equal(rows[rows.length - 1].trim(), i18n.t('tui.hint.textPick'));
    key('escape');
    assert.equal(await dir, null);
  });
});

test('fspicker: 各平台的目录对话框命令与转义', () => {
  const { pickerCommand } = require('../src/tui/fspicker');

  const win = pickerCommand('win32', 'D:\\out');
  assert.equal(win.command, 'powershell');
  const winScript = win.args.join(' ');
  assert.ok(winScript.includes('FolderBrowserDialog'), winScript);
  assert.ok(winScript.includes("'D:\\out'"), winScript);
  assert.ok(winScript.includes('ShowDialog'), winScript);

  const mac = pickerCommand('darwin', '/tmp/models');
  assert.equal(mac.command, 'osascript');
  assert.ok(mac.args.join(' ').includes('choose folder'));
  assert.ok(mac.args.join(' ').includes('/tmp/models'));

  // An unknown platform has no dialog at all, so the field stays typeable.
  // 未知平台没有可用对话框，字段仍然可以手输。
  assert.equal(pickerCommand('aix'), null);

  // Single quotes are doubled for PowerShell, double quotes escaped for AppleScript.
  // PowerShell 里单引号翻倍，AppleScript 里双引号转义。
  assert.ok(pickerCommand('win32', "D:\\it's").args.join(' ').includes("'D:\\it''s'"));
  assert.ok(pickerCommand('darwin', '/tmp/a"b').args.join(' ').includes('/tmp/a\\"b'));
});

test('screen: 设置页的分组标题与它的行绑定出现', async () => {
  // Three terminal heights: short (scrolling everywhere), medium, and tall enough that the whole
  // list fits — the status line has to be pinned to the bottom in all of them.
  //
  // 三种终端高度：很矮（处处滚动）、中等、以及整个列表放得下——三种情况下状态行都要贴着页脚。
  for (const rows of [20, 30, 56]) {
    await withFakeTerminal(
      async ({ frame, key, settle }) => {
        assert.equal(screen.start({ onQuit: () => {} }), true);
        const { settingsPage, SECTIONS } = require('../src/tui/settings');
        const config = { site: 'https://civitai.com', outDir: 'D:\\downloads', jobs: 3, fileTypes: ['Model'] };
        const titles = SECTIONS.map((section) => i18n.t(section.titleKey)).concat([
          i18n.t('tui.settings.actionSection'),
        ]);
        const done = settingsPage(config);
        await settle();

        // The list area: everything between the breadcrumb rule and the status line.
        // 列表区：面包屑横线之后、状态行之前的所有行。
        const listArea = () => {
          const frameLines = frame();
          const ruleIndex = frameLines.findIndex((line) => /^[-─]{20,}$/.test(line.trim()));
          const tail = frameLines.slice(ruleIndex + 2);
          const cut = tail.findIndex((line) => line.includes('第 ') || line.trim() === '');
          return (cut < 0 ? tail : tail.slice(0, cut)).map((line) => line.trimEnd());
        };

        // Walk the whole page: a heading may never be the last visible line, it must be visible
        // together with the first row of its section, and the status line always hugs the footer.
        //
        // 走完整页：标题永远不能是最后一行；它必须和本组第一行一起可见；状态行始终贴着页脚。
        screen.render();
        let firstRowSeen = false;
        for (let i = 0; i < 24; i++) {
          const area = listArea();
          const last = area[area.length - 1] || '';
          assert.ok(!titles.includes(last.trim()), `${rows} 行：标题被单独留在最后一行：${last}`);
          const frameLines = frame();
          assert.ok(
            frameLines[frameLines.length - 2].includes('第 '),
            `${rows} 行：状态行与页脚之间不应有空行：${frameLines.slice(-3).join(' | ')}`
          );
          const cursorIndex = area.findIndex((line) => line.includes('▸'));
          if (cursorIndex > 0 && titles.includes((area[cursorIndex - 1] || '').trim())) firstRowSeen = true;
          key('down');
          await settle();
          screen.render();
        }
        assert.ok(firstRowSeen, `${rows} 行：沿路应经过「某组第一行」的位置`);

        // Back to the top: the first section's heading must come with its first row.
        // 回到顶部：第一组的标题必须和它的第一行一起出现。
        key('home');
        await settle();
        screen.render();
        const top = listArea().join('\n');
        assert.ok(top.includes(i18n.t('tui.settings.sectionBasic')), `${rows} 行：回到第一行时看不到分组标题`);
        assert.ok(top.includes('站点地址'), top);
        key('escape');
        await settle();
        key('escape');
        await settle();
        await done;
      },
      { columns: 96, rows }
    );
  }
});

test('screen: 设置页的修改立刻写入 config.json', async () => {
  const file = path.join(fs.mkdtempSync(path.join(os.tmpdir(), 'civitai-settings-')), 'config.json');
  await withFakeTerminal(async ({ frame, key, settle }) => {
    assert.equal(screen.start({ onQuit: () => {} }), true);
    const { settingsPage } = require('../src/tui/settings');
    const config = {
      configFile: file,
      site: 'https://civitai.com',
      outDir: 'D:\\downloads',
      jobs: 3,
      fileTypes: ['Model'],
      debugPort: 9222,
      engine: 'curl',
      dedup: 'off',
    };
    const done = settingsPage(config);
    await settle();

    // Enter on the first row opens the editor of "site"; Ctrl+U clears it, then a new value is typed.
    // 在第一行按 Enter 打开站点地址的编辑器；Ctrl+U 清空后输入新值。
    key('return');
    await settle();
    key('u', '\u0015', true);
    for (const ch of 'https://new.example') key(ch, ch);
    key('return');
    await settle();
    await settle();

    // Written immediately: no second confirmation, no "save" step.
    // 立即写入：没有第二次确认，也没有「保存」这一步。
    const saved = JSON.parse(fs.readFileSync(file, 'utf8'));
    assert.equal(saved.site, 'https://new.example');
    assert.equal(config.site, 'https://new.example', '内存里的配置也同步更新');

    screen.render();
    const text = frame().join('\n');
    assert.ok(text.includes('https://new.example'), `设置行应显示新值：\n${text}`);
    // Editing the site has a follow-up (re-login), so its toast replaces the generic "saved" line.
    // 改站点有后续动作（需要重新登录），因此它顶替通用的「已保存」提示。
    assert.ok(text.includes(i18n.t('tui.settings.siteChanged')), text);

    // Leaving the page no longer asks anything: every edit is already saved.
    // 离开本页不再追问：每次修改都已经保存。
    key('escape');
    assert.equal(await done, true);
  });
});

test('screen: 设置支持恢复默认值（Ctrl+R 与整页恢复）', async () => {
  const file = path.join(fs.mkdtempSync(path.join(os.tmpdir(), 'civitai-settings-')), 'config.json');
  const { DEFAULTS } = require('../src/config');
  await withFakeTerminal(
    async ({ frame, key, settle }) => {
      assert.equal(screen.start({ onQuit: () => {} }), true);
      const { settingsPage } = require('../src/tui/settings');
      const config = {
        configFile: file,
        site: 'https://custom.example',
        outDir: 'D:\\mine',
        jobs: 5,
        fileTypes: ['Model'],
        debugPort: 9222,
        engine: 'curl',
        dedup: 'off',
      };
      const done = settingsPage(config);
      await settle();

      // 1) Ctrl+R in the site editor fills the default value; Enter still applies it.
      // 1) 站点编辑器里 Ctrl+R 填入默认值；仍然由 Enter 提交。
      key('return');
      await settle();
      key('r', '\u0012', true);
      await settle();
      screen.render();
      assert.ok(frame().join('\n').includes(DEFAULTS.site), `Ctrl+R 应填入默认站点：\n${frame().join('\n')}`);
      key('return');
      await settle();
      await settle();
      assert.equal(JSON.parse(fs.readFileSync(file, 'utf8')).site, DEFAULTS.site);

      // 2) The last row restores every setting at once, after a confirmation.
      // 2) 最后一行一次性恢复所有设置，先确认。
      key('end');
      await settle();
      key('return');
      await settle();
      assert.match(frame().join('\n'), /把 \d+ 项设置恢复为默认值/, '应弹出恢复确认');
      // The confirmation is a destructive default: the highlighted answer is "no".
      // 这是破坏性默认：高亮项是「否」。
      assert.ok(frame()[frame().findIndex((line) => line.includes('▸'))].includes(i18n.t('common.no')));
      key('y', 'y');
      await settle();
      await settle();
      const saved = JSON.parse(fs.readFileSync(file, 'utf8'));
      assert.equal(saved.jobs, DEFAULTS.jobs);
      assert.equal(saved.outDir, DEFAULTS.outDir);
      assert.equal(config.jobs, DEFAULTS.jobs, '内存里的配置也同步');

      key('escape');
      assert.equal(await done, true);
    },
    { columns: 96, rows: 30 }
  );
});

test('settings: 分组标题只在光标停在该组第一行时才被拉进视窗', () => {
  const { scrollToSection } = require('../src/tui/settings');
  // Two sections: heading 0 + rows 1-5, blank 6, heading 7 + rows 8-10.
  // 两组：标题 0 + 行 1-5，空行 6，标题 7 + 行 8-10。
  const lines = ['H1', 'r1', 'r2', 'r3', 'r4', 'r5', '', 'H2', 'r6', 'r7', 'r8'];
  const headingOfLine = new Map([
    [0, 0], [1, 0], [2, 0], [3, 0], [4, 0], [5, 0],
    [7, 7], [8, 7], [9, 7], [10, 7],
  ]);
  const headingLines = new Set([0, 7]);
  const body = 4;

  // Scrolled inside section 1: the window must stay where it is (this is the "jumps back to the
  // section start" regression).
  //
  // 在组内滚动后：视窗应停在原处（这是「一下跳回分组开头」的回归用例）。
  const inside = scrollToSection({ start: 4, end: 8, cursor: 4 }, lines, body, 4, headingOfLine, headingLines);
  assert.equal(inside.start, 4, '组内移动不应把视窗拉回分组开头');

  // Cursor on the first row of section 1 with its heading scrolled off: pull exactly one line.
  // 光标停在第 1 组第一行、标题刚好被滚出去时：只前移一行把标题带进来。
  const first = scrollToSection({ start: 1, end: 5, cursor: 1 }, lines, body, 1, headingOfLine, headingLines);
  assert.equal(first.start, 0, '停在第一行时分组标题必须可见');

  // A heading alone at the bottom is dropped, together with the blank line above it.
  // 单独留在最后一行的标题（连同其上的空行）会被丢掉。
  const orphan = scrollToSection({ start: 3, end: 7, cursor: 3 }, lines, body, 3, headingOfLine, headingLines);
  assert.ok(!headingLines.has(orphan.end - 1), '标题不能单独留在最后一行');
  assert.notEqual(lines[orphan.end - 1], '', '最后一行应是内容行');
});

test('tui: 惰性 require 到的入口函数都存在', () => {
  // Several flows are pulled in lazily (`require('./models').downloadFlow`), which the compiler cannot
  // check: a missing export only shows up as "is not a function" after the user clicks the menu item.
  //
  // 几个流程是惰性引入的（`require('./models').downloadFlow`），编译器查不出来：
  // 漏掉导出时，只有用户点了那个菜单才会看到「is not a function」。这里把它们全查一遍。
  const root = path.join(__dirname, '..', 'src', 'tui');
  const pattern = /require\('(\.[^']+)'\)\.([A-Za-z_$][\w$]*)/g;
  const missing = [];
  for (const name of fs.readdirSync(root).filter((file) => file.endsWith('.js'))) {
    const text = fs.readFileSync(path.join(root, name), 'utf8');
    for (const match of text.matchAll(pattern)) {
      const target = require(path.resolve(root, match[1]));
      if (typeof target[match[2]] !== 'function') missing.push(`${name}: require('${match[1]}').${match[2]}`);
    }
  }
  assert.deepEqual(missing, [], `惰性 require 的函数不存在：\n${missing.join('\n')}`);
});

test('view.note / view.log 进入日志页（L），页面上不再有常驻日志条', async () => {
  await withFakeTerminal(async ({ frame, key, settle }) => {
    assert.equal(screen.start({ onQuit: () => {} }), true);
    screen.setBase({ title: '主菜单', render: () => ['▸ 项'], hints: () => [] });
    view.note('普通一行');
    view.log('带时间戳一行');
    screen.render();
    // The frame is a UI again: the raw log is not a strip under the page.
    // 框架重新像个界面：原始日志不再是页面下方的一条常驻区域。
    const plain = frame().join('\n');
    assert.ok(!plain.includes(i18n.t('tui.screen.logTitle')), plain);
    assert.ok(!plain.includes('普通一行'), plain);

    // `L` opens it as a page, with both lines.
    // `L` 把它作为一页打开，两行都在。
    key('l', 'l');
    await settle();
    screen.render();
    const opened = frame().join('\n');
    assert.ok(opened.includes(i18n.t('tui.screen.logTitle')), opened);
    assert.ok(opened.includes('普通一行'), opened);
    assert.match(opened, /\[\d{4}-\d{2}-\d{2} \d{2}:\d{2}:\d{2}\] 带时间戳一行/);
    assert.ok(opened.includes(i18n.t('tui.hint.logView')), '页脚换成日志页的按键说明');

    // The same key closes it and the page comes back.
    // 同一个键关闭，原页面回来。
    key('l', 'l');
    await settle();
    screen.render();
    assert.ok(frame().join('\n').includes('▸ 项'));
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

test('settings: 下载分组包含请求超时、重试、目录布局、底模分层与 primary', () => {
  const fields = settings.buildRows()
    .filter((row) => row.kind === 'field')
    .map((row) => row.field.key);
  for (const key of ['requestTimeoutMs', 'retries', 'layout', 'baseModelLayer', 'primaryOnly']) {
    assert.ok(fields.includes(key), `设置页缺少 ${key}：${fields.join(',')}`);
  }
  assert.ok(settings.VALIDATORS.timeout('1000') === true);
  assert.notEqual(settings.VALIDATORS.timeout('999'), true);
  assert.ok(settings.VALIDATORS.retries('0') === true);
  assert.notEqual(settings.VALIDATORS.retries('11'), true);
});

test('download: 计划行以「模型 + 版本」为键，同一模型可保留多个版本', () => {
  const config = {
    site: 'https://example.invalid',
    fileTypes: ['Model'],
    primaryOnly: true,
  };
  const versionMeta = (id, name) => ({
    id,
    name,
    baseModel: 'SDXL',
    files: [
      {
        id,
        name: `${name}.bin`,
        sizeKB: 1,
        type: 'Model',
        primary: true,
        downloadUrl: `https://example.invalid/${name}.bin`,
      },
    ],
  });
  const item = {
    modelId: '5',
    versionId: '1',
    versionName: 'v1',
    name: 'Twin',
    type: 'LORA',
    baseVersionId: '1',
    files: [{ name: 'v1.bin', bytes: 10 }],
    totalBytes: 10,
  };
  const other = { ...item, versionId: '2', versionName: 'v2', files: [{ name: 'v2.bin', bytes: 20 }], totalBytes: 20 };
  assert.notEqual(download.planRowKey(item), download.planRowKey(other), '版本不同则键不同');

  const plan = [item];
  const state = { selected: new Set([download.planRowKey(item)]) };
  const rows = [
    { versionId: '1', name: 'v1', baseModel: 'SDXL', raw: versionMeta(1, 'v1') },
    { versionId: '2', name: 'v2', baseModel: 'SDXL', raw: versionMeta(2, 'v2') },
  ];
  download.replacePlanRows(config, plan, item, { modelVersions: rows.map((row) => row.raw) }, rows, state);

  assert.deepEqual(plan.map((row) => String(row.versionId)), ['1', '2'], '两个版本各占一行');
  assert.equal(String(plan[0].totalBytes), '10', '已有行保留原对象');
  assert.equal(String(plan[1].totalBytes), String(1024), '新行按线上大小构造');
  assert.ok(state.selected.has('5:1') && state.selected.has('5:2'), '原行被勾选时新组版本也勾选');
});

test('download: 计划页 → 确认页 → Esc 回到计划页（不发起下载）', async () => {
  const root = fs.mkdtempSync(path.join(os.tmpdir(), 'civitai-dl-plan-'));
  const config = {
    site: 'https://example.invalid',
    root,
    outDir: root,
    dataDir: path.join(root, '.data'),
    cookiesFile: path.join(root, '.data', 'cookies.txt'),
    configFile: path.join(root, 'config.json'),
    fileTypes: ['Model'],
    primaryOnly: true,
    engine: 'curl',
    dedup: 'off',
    jobs: 1,
    downloadAttempts: 1,
    metaConcurrency: 1,
    userAgent: 'test',
  };
  const plan = [
    {
      modelId: '101',
      name: 'Alpha',
      type: 'LORA',
      baseModel: 'SDXL',
      versionId: '1001',
      versionName: 'v1',
      files: [{ name: 'a.safetensors', bytes: 1024, downloadUrl: 'https://example.invalid/a' }],
      totalBytes: 1024,
    },
  ];
  try {
    await withFakeTerminal(async ({ frame, key, settle }) => {
      assert.equal(screen.start({ onQuit: () => {} }), true);
      screen.setInfo(() => [{ label: '站点', value: 'https://example.invalid' }]);
      screen.setBase({ title: '下载', render: () => ['▸ 下载'], hints: () => ['提示'] });

      let finished = null;
      const flow = download
        .runDownloadPlan(config, {
          plan,
          collectionId: 'plan-test',
          name: '收藏集 plan-test',
          sourceLine: '收藏集 plan-test · 1 项 · 1.00 KiB',
          outDir: root,
          jobs: 1,
        })
        .then((value) => {
          finished = value;
        });
      await settle();
      const planPage = frame().join('\n');
      assert.ok(planPage.includes('收藏集 plan-test'), planPage);
      assert.ok(planPage.includes('Alpha'), planPage);
      assert.ok(planPage.includes(i18n.t('tui.download.statusNew')), planPage);
      assert.ok(planPage.includes(i18n.t('tui.hint.downloadPlan')), planPage);

      key('return');
      await settle();
      const confirmPage = frame().join('\n');
      assert.ok(confirmPage.includes(i18n.t('tui.download.confirmTitle')), confirmPage);
      assert.ok(confirmPage.includes(i18n.t('tui.download.optionDir')), confirmPage);
      assert.ok(confirmPage.includes(i18n.t('tui.download.optionStart')), confirmPage);

      key('escape');
      await settle();
      assert.ok(frame().join('\n').includes(i18n.t('tui.hint.downloadPlan')), 'Esc 回到计划页');

      key('escape');
      await settle();
      await flow;
      assert.equal(finished, false, 'Esc 计划页取消整个流程');
    });
  } finally {
    fs.rmSync(root, { recursive: true, force: true });
  }
});

test('download: 同一模型的两个版本各占一行，并一起进入确认页', async () => {
  const root = fs.mkdtempSync(path.join(os.tmpdir(), 'civitai-dl-multi-'));
  const config = {
    site: 'https://example.invalid',
    root,
    outDir: root,
    dataDir: path.join(root, '.data'),
    cookiesFile: path.join(root, '.data', 'cookies.txt'),
    configFile: path.join(root, 'config.json'),
    fileTypes: ['Model'],
    primaryOnly: true,
    jobs: 1,
    downloadAttempts: 1,
    metaConcurrency: 1,
    userAgent: 'test',
  };
  const base = {
    modelId: '55',
    name: 'Twin',
    type: 'LORA',
    baseModel: 'SDXL',
    baseVersionId: '1',
  };
  const plan = [
    {
      ...base,
      versionId: '1',
      versionName: 'v1',
      files: [{ name: 'v1.bin', bytes: 1024, downloadUrl: 'https://example.invalid/v1' }],
      totalBytes: 1024,
    },
    {
      ...base,
      versionId: '2',
      versionName: 'v2',
      files: [{ name: 'v2.bin', bytes: 1024, downloadUrl: 'https://example.invalid/v2' }],
      totalBytes: 1024,
    },
  ];
  try {
    await withFakeTerminal(async ({ frame, key, settle }) => {
      assert.equal(screen.start({ onQuit: () => {} }), true);
      let finished = null;
      const flow = download
        .runDownloadPlan(config, {
          plan,
          collectionId: 'model-55',
          name: 'Twin',
          sourceLine: 'Twin · 2 项',
          outDir: root,
          jobs: 1,
        })
        .then((value) => {
          finished = value;
        });
      await settle();
      const text = frame().join('\n');
      assert.ok((text.match(/Twin/g) || []).length >= 2, '同一模型出现两行');
      assert.ok(text.includes('已选 2/2 项'), text);

      key('return');
      await settle();
      assert.ok(frame().join('\n').includes('本次下载 2 项'), frame().join('\n'));

      key('escape');
      await settle();
      key('escape');
      await settle();
      await flow;
      assert.equal(finished, false);
    });
  } finally {
    fs.rmSync(root, { recursive: true, force: true });
  }
});

test('downloadTask: 第二个下载排队，前一个完成后自动开始', async () => {
  const root = fs.mkdtempSync(path.join(os.tmpdir(), 'civitai-dl-queue-'));
  const previousBell = process.env.NO_BELL;
  process.env.NO_BELL = '1';
  const config = {
    site: 'https://example.invalid',
    root,
    outDir: root,
    dataDir: path.join(root, '.data'),
    cookiesFile: path.join(root, '.data', 'cookies.txt'),
    fileTypes: ['Model'],
    primaryOnly: true,
    jobs: 1,
    downloadAttempts: 1,
  };
  const makePlan = (id) => [
    {
      modelId: id,
      name: `Model ${id}`,
      versionId: id,
      versionName: 'v1',
      files: [{ name: `${id}.bin`, bytes: 1, downloadUrl: 'https://example.invalid/file' }],
      totalBytes: 1,
    },
  ];
  let releaseFirst = null;
  let firstStarted = () => {};
  const started = new Promise((resolve) => {
    firstStarted = resolve;
  });
  const runner = (cfg, opts, hooks) => {
    const item = opts.plan[0];
    if (String(item.modelId) === 'a') {
      firstStarted();
      return new Promise((resolve) => {
        releaseFirst = () => {
          hooks.onItemDone(item, true, 'done');
          resolve({ done: 1, skipped: 0, failed: 0, metaFailed: 0, cancelled: false, elapsedMs: 1, logFile: 'log' });
        };
      });
    }
    hooks.onItemDone(item, true, 'done');
    return Promise.resolve({ done: 1, skipped: 0, failed: 0, metaFailed: 0, cancelled: false, elapsedMs: 1, logFile: 'log' });
  };
  try {
    tasks.reset();
    const first = downloadTask.startDownloadTask(config, {
      collectionId: 'a',
      name: 'A',
      plan: makePlan('a'),
      outDir: root,
      jobs: 1,
      runner,
    });
    assert.equal(first.queued, false);
    await started;

    const second = downloadTask.startDownloadTask(config, {
      collectionId: 'b',
      name: 'B',
      plan: makePlan('b'),
      outDir: root,
      jobs: 1,
      runner,
    });
    assert.equal(second.queued, true, '已有下载在跑时第二个任务应排队');
    assert.equal(second.position, 1);
    assert.equal(tasks.getTask(second.taskId).status, tasks.QUEUED);
    assert.equal(tasks.queuePosition(second.taskId), 1);

    releaseFirst();
    // Let the finish handler, the queue pump and the second job settle.
    // 让结束处理、队列泵与第二个任务依次跑完。
    for (let i = 0; i < 8; i++) await new Promise((resolve) => setImmediate(resolve));
    assert.equal(tasks.getTask(first.taskId).status, tasks.DONE);
    assert.notEqual(tasks.getTask(second.taskId).status, tasks.QUEUED, '前一个结束后第二个自动开始');
    assert.equal(tasks.queuePosition(second.taskId), 0);
  } finally {
    tasks.reset();
    if (previousBell === undefined) delete process.env.NO_BELL;
    else process.env.NO_BELL = previousBell;
    fs.rmSync(root, { recursive: true, force: true });
  }
});

test('download: 确认页开始后进入回执页，Esc 退出而任务继续', async () => {
  const root = fs.mkdtempSync(path.join(os.tmpdir(), 'civitai-dl-receipt-'));
  const previousBell = process.env.NO_BELL;
  process.env.NO_BELL = '1';
  const config = {
    site: 'https://example.invalid',
    root,
    outDir: root,
    dataDir: path.join(root, '.data'),
    cookiesFile: path.join(root, '.data', 'cookies.txt'),
    configFile: path.join(root, 'config.json'),
    fileTypes: ['Model'],
    primaryOnly: true,
    engine: 'curl',
    dedup: 'off',
    jobs: 1,
    downloadAttempts: 1,
    metaConcurrency: 1,
    userAgent: 'test',
  };
  const plan = [
    {
      modelId: '202',
      name: 'Beta',
      type: 'LORA',
      baseModel: 'SDXL',
      versionId: '2002',
      versionName: 'v1',
      files: [{ name: 'b.safetensors', bytes: 1024, downloadUrl: 'https://example.invalid/b' }],
      totalBytes: 1024,
    },
  ];
  const runner = (cfg, opts, hooks) => {
    hooks.onItemDone(opts.plan[0], true, 'done');
    return Promise.resolve({ done: 1, skipped: 0, failed: 0, metaFailed: 0, cancelled: false, elapsedMs: 1, logFile: 'log' });
  };
  try {
    await withFakeTerminal(async ({ frame, key, settle }) => {
      tasks.reset();
      assert.equal(screen.start({ onQuit: () => {} }), true);
      screen.setInfo(() => [{ label: '站点', value: 'https://example.invalid' }]);
      screen.setBase({ title: '下载', render: () => ['▸ 下载'], hints: () => ['提示'] });
      let finished = null;
      const flow = download
        .runDownloadPlan(config, {
          plan,
          collectionId: 'receipt-test',
          name: '收藏集 receipt-test',
          sourceLine: '收藏集 receipt-test · 1 项 · 1.00 KiB',
          outDir: root,
          jobs: 1,
          runner,
        })
        .then((value) => {
          finished = value;
        });
      await settle();
      key('return');
      await settle();
      // cursor: dir → jobs → force → start
      // 光标：输出目录 → 并发 → 已完成项 → 开始下载
      key('down');
      key('down');
      key('down');
      key('return');
      await settle();
      const receipt = frame().join('\n');
      assert.ok(receipt.includes(i18n.t('tui.download.receiptTitle')), receipt);
      assert.ok(receipt.includes(i18n.t('tui.download.receiptJoined')), receipt);
      assert.ok(receipt.includes(i18n.t('tui.hint.receipt')), receipt);

      // The receipt is only a receipt: Esc leaves the download screen, the task stays in the registry.
      // 回执页只是回执：Esc 离开下载界面，任务仍留在登记表里。
      key('escape');
      await settle();
      await flow;
      assert.equal(finished, true);
      for (let i = 0; i < 8; i++) await new Promise((resolve) => setImmediate(resolve));
      const task = tasks.listTasks()[0];
      assert.ok(task, '任务仍在任务列表里');
      assert.notEqual(task.status, tasks.QUEUED);
      tasks.reset();
    });
  } finally {
    if (previousBell === undefined) delete process.env.NO_BELL;
    else process.env.NO_BELL = previousBell;
    fs.rmSync(root, { recursive: true, force: true });
  }
});

test('downloadTask: 进度按 job 给出的最终目录与文件名计算，expected 不为 0', async () => {
  const root = fs.mkdtempSync(path.join(os.tmpdir(), 'civitai-dl-progress-'));
  const previousBell = process.env.NO_BELL;
  process.env.NO_BELL = '1';
  const config = {
    site: 'https://example.invalid',
    root,
    outDir: root,
    dataDir: path.join(root, '.data'),
    cookiesFile: path.join(root, '.data', 'cookies.txt'),
    fileTypes: ['Model'],
    primaryOnly: true,
    jobs: 1,
    downloadAttempts: 1,
  };
  const item = {
    modelId: 'm1',
    name: 'Model',
    versionId: 'v1',
    versionName: 'v1',
    files: [{ name: 'a.bin', bytes: 10, downloadUrl: 'https://example.invalid/a' }],
    totalBytes: 10,
  };
  // The real layout puts the file somewhere below outDir, not in outDir/<model>.
  // 真实布局会把文件放在 outDir 下面的某个子目录，而不是 outDir/<模型>。
  const dir = path.join(root, 'loras', 'Model');
  fs.mkdirSync(dir, { recursive: true });
  fs.writeFileSync(path.join(dir, 'a.bin'), Buffer.alloc(5));
  let release = () => {};
  let ready = () => {};
  const started = new Promise((resolve) => {
    ready = resolve;
  });
  const runner = (cfg, opts, hooks) => {
    hooks.onItemFiles(item, dir, [{ diskName: 'a.bin' }]);
    hooks.onFileStart(item, { name: 'a.bin', diskName: 'a.bin', bytes: 10 }, dir);
    ready();
    return new Promise((resolve) => {
      release = () => {
        hooks.onItemDone(item, true, 'done');
        resolve({ done: 1, skipped: 0, failed: 0, metaFailed: 0, cancelled: false, elapsedMs: 1, logFile: 'log' });
      };
    });
  };
  try {
    tasks.reset();
    const { taskId } = downloadTask.startDownloadTask(config, {
      collectionId: 'progress-test',
      name: 'progress',
      plan: [item],
      outDir: root,
      jobs: 1,
      runner,
    });
    await started;
    await new Promise((resolve) => setImmediate(resolve));
    const task = tasks.getTask(taskId);
    assert.equal(task.totalBytes, 10);
    assert.equal(task.current.length, 1);
    assert.equal(task.current[0].expected, 10, 'expected 应来自计划文件，而不是猜错的目录');
    assert.equal(task.current[0].bytes, 5, '已下载字节应来自真实落盘位置');
    release();
    for (let i = 0; i < 6; i++) await new Promise((resolve) => setImmediate(resolve));
  } finally {
    tasks.reset();
    if (previousBell === undefined) delete process.env.NO_BELL;
    else process.env.NO_BELL = previousBell;
    fs.rmSync(root, { recursive: true, force: true });
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
