'use strict';

/**
 * TUI (terminal user interface) layer i18n regression tests.
 *
 * Four things matter here:
 *  1. under the default language (zh-CN) the TUI wording matches the pre-extraction text word for word
 *     (including full-width punctuation, ·, ↑↓, …, and inline symbols such as []);
 *  2. after switching to en those messages really become English and non-empty, while technical terms
 *     (Chrome / Civitai / SHA256 / Webhook / aria2c / curl / Ctrl+C / URL) stay as is;
 *  3. placeholders (counts, names, paths, sizes…) really get substituted and no `{name}` leaks out;
 *  4. the constants select.js exports (SORT_LABELS / KEY_HINTS) work in both languages and follow the
 *     language switch live (lazy lookup), and t() never returns a bare key name.
 *
 * Note: this file switches language temporarily, so it must restore it in try/finally (run-tests.js runs
 * every test file in order within the same process, and select.test.js later relies on the zh-CN wording).
 *
 *
 * TUI（终端交互界面）层 i18n 回归测试。
 *
 * 关注四件事：
 *  1. 默认语言（zh-CN）下，TUI 的界面文案与抽取前逐字一致（含全角标点、·、
 *     ↑↓、…，以及 [] 之类的行内符号）；
 *  2. 切到 en 后这些文案确实变成英文、非空，且技术名词（Chrome / Civitai /
 *     SHA256 / Webhook / aria2c / curl / Ctrl+C / URL）保留原样；
 *  3. 占位符（数量、名称、路径、大小…）确实被替换，不会漏出 `{name}`；
 *  4. select.js 的导出常量（SORT_LABELS / KEY_HINTS）在两种语言下都可用，
 *     且随语言切换实时变化（惰性取词），t() 不返回裸键名。
 *
 * 注意：本文件会临时切换语言，必须用 try/finally 恢复（run-tests.js 在同一进程里
 * 顺序执行全部测试文件，后面的 select.test.js 依赖 zh-CN 文案）。
 */

const test = require('node:test');
const assert = require('node:assert/strict');
const fs = require('fs');
const path = require('path');

const i18n = require('../src/i18n');
const zh = require('../src/i18n/zh-CN');
const en = require('../src/i18n/en');
const util = require('../src/util');
const view = require('../src/tui/view');
const select = require('../src/tui/select');
const pages = require('../src/tui/pages');
const app = require('../src/tui/app');

/**
 * CJK characters and full-width punctuation: used to tell whether a message contains Chinese.
 * 中日韩文字与全角标点：用来判断文案是否带中文
 */
const CJK = /[\u3000-\u303f\u3400-\u4dbf\u4e00-\u9fff\uf900-\ufaff\uff00-\uffef]/;
/**
 * Language at load time, used to confirm this file does not leak language state to other test files.
 * 载入时的语言，用于确认本文件没有把语言状态泄漏给其它测试文件
 */
const LANGUAGE_AT_LOAD = i18n.getLanguage();
/**
 * TUI files covered by this extraction. Only files that emit user-visible text belong here:
 * keys.js / layout.js are pure key-handling and layout helpers with no catalog entries.
 *
 * 本次抽取涉及的 TUI 文件。这里只列会输出用户可见文案的文件：
 * keys.js / layout.js 是纯按键处理与布局助手，不含文案表条目。
 */
const TUI_FILES = [
  'app.js',
  'screen.js',
  'view.js',
  'select.js',
  'run.js',
  'download.js',
  'downloadTask.js',
  'models.js',
  'check.js',
  'login.js',
  'manage.js',
  'settings.js',
  'pages.js',
  'report.js',
  'ui/page.js',
  'ui/planWorkspace.js',
  'ui/taskView.js',
  'ui/versionPage.js',
];
/**
 * Keys added by this change.
 * 本次新增的键
 */
const TUI_KEYS = Object.keys(zh).filter((key) => key.startsWith('tui.'));
/**
 * Allowed key-name modules (tui.<module>.<scenario>).
 * 允许的键名模块（tui.<模块>.<场景>）
 */
const TUI_MODULES = new Set([
  'app',
  'screen',
  'hint',
  'view',
  'select',
  'run',
  'download',
  'models',
  'check',
  'login',
  'manage',
  'settings',
  'pages',
  'help',
  'report',
  'verify',
  'doctor',
  'workspace',
]);
/**
 * Keys whose English and Chinese text is identical (pure format strings / proper nouns / language endonyms);
 * every other key must differ from zh and contain no Chinese once switched to en.
 *
 * 中英文本就相同（纯格式串 / 专有名词 / 语言名自称）的键，
 * 其余键切到 en 必须与 zh 不同且不含中文。
 */
const SAME_IN_BOTH = new Set([
  'tui.app.bannerTitle',
  'tui.screen.nameSeparator',
  'tui.download.versionDescription',
  'tui.manage.modelIdLabel',
  'tui.manage.brokenLine',
  'tui.settings.userAgent',
  'tui.settings.languageZh',
  'tui.settings.languageEn',
  // Pure format strings: an arrow between two version labels is the same in both languages.
  // 纯格式串：两个版本标签之间的箭头在两种语言下相同。
  'tui.report.fromTo',
]);

const tr = i18n.t;

/**
 * Switch language temporarily and restore it afterwards.
 * 临时切换语言，结束后恢复
 */
function withLanguage(lang, fn) {
  const prev = i18n.getLanguage();
  i18n.setLanguage(lang);
  try {
    return fn();
  } finally {
    i18n.setLanguage(prev);
  }
}

/**
 * Capture console.log output.
 * 捕获 console.log 输出
 */
function captureLog(fn) {
  const lines = [];
  const orig = console.log;
  console.log = (...args) => lines.push(args.map(String).join(' '));
  try {
    fn();
  } finally {
    console.log = orig;
  }
  return lines;
}

function readTui(file) {
  return fs.readFileSync(path.join(__dirname, '..', 'src', 'tui', file), 'utf8');
}

/**
 * Code with trailing comments stripped (used by the "no hard-coded Chinese left" check).
 * 去掉行尾注释后的代码（用于「不残留硬编码中文」检查）
 */
function stripLineComment(line) {
  const trimmed = line.trim();
  if (trimmed.startsWith('*') || trimmed.startsWith('/*')) return '';
  return line.replace(/\/\/.*$/, '');
}

function assertNoPlaceholder(lang, key, text) {
  assert.ok(!text.includes('{'), `${lang}: ${key} 仍有未替换的占位符：${text}`);
}

test.after(() => {
  i18n.setLanguage(LANGUAGE_AT_LOAD);
});

// ---------------------------------------------------------------------------
// zh-CN verbatim regression
// zh-CN 逐字回归
// ---------------------------------------------------------------------------

test('i18n-tui: view.log 保留 [时间] 前缀，再见文案走文案表', (t) => {
  util.setLogSink(null); // 确保走默认 console 输出（run-tests 会复用同一进程） / Keep the default console output (run-tests reuses the same process)
  t.after(() => util.setLogSink(null));

  const lines = captureLog(() => view.log('中文消息'));
  assert.equal(lines.length, 1);
  assert.match(lines[0], /^\[\d{4}-\d{2}-\d{2} \d{2}:\d{2}:\d{2}\] 中文消息$/);
  assert.equal(tr('tui.app.goodbye'), '再见。');
});

test('i18n-tui: 全屏界面退出后的决定回显（非 TTY 静默、文案逐字一致）', () => {
  // The decision echo belongs to the alternate screen buffer: it must stay silent when there is no
  // TTY (the plain prompt path prints its own answer).
  //
  // 决定回显属于备用缓冲区场景：非 TTY 下必须保持静默（简易提问路径自己会打印答案）。
  assert.equal(view.beginFullScreen(), false);
  const lines = captureLog(() => {
    view.decision('tui.view.decisionPicked', { count: 3 });
    view.beginFullScreen();
    view.endFullScreen();
  });
  assert.deepEqual(lines, []);

  assert.equal(tr('tui.view.decisionCancelled'), '已取消选择');
  assert.equal(tr('tui.view.decisionSelected', { name: 'Model A' }), '已选择：Model A');
  assert.equal(tr('tui.view.decisionPicked', { count: 3 }), '已勾选 3 项');
  assert.equal(tr('tui.check.selected', { id: 777 }), '已选择收藏集：777');
  assert.equal(tr('tui.download.prefilterSummary', { count: 12, size: '3.00 MiB', done: '' }).trim(), '共 12 项 | 合计 3.00 MiB');
  assert.equal(tr('tui.models.pickerSummary', { count: 4, size: '2.00 MiB', pinned: '' }).trim(), '模型库 4 项 | 合计 2.00 MiB');
});

test('i18n-tui: select.js 排序标签与键位提示逐字一致', () => {
  assert.deepEqual(select.SORT_MODES, ['default', 'name', 'size', 'size-asc']);
  assert.deepEqual(Object.keys(select.SORT_LABELS), ['default', 'name', 'size', 'size-asc']);
  assert.equal(select.SORT_LABELS.default, '默认排序');
  assert.equal(select.SORT_LABELS.name, '按名称');
  assert.equal(select.SORT_LABELS.size, '按大小↓');
  assert.equal(select.SORT_LABELS['size-asc'], '按大小↑');
  // One line for the whole picker: every key it lists works there.
  // 整个选择器只有一行：列出的每个键在这里都有效。
  assert.equal(select.KEY_HINTS.length, 1);
  assert.equal(select.KEY_HINTS[0], '↑↓ 选择 | 空格 勾选 | / 搜索 | t/b/s 筛选 | Enter 确认 | Esc 返回 | ? 帮助');
  assert.equal(select.hintLines({}).length, 1);
});

test('i18n-tui: select.js 按键提示随状态切换（输入中 / 帮助浮层）', () => {
  assert.deepEqual(select.hintLines({}), select.KEY_HINTS);
  const typing = select.hintLines({ searching: true });
  assert.equal(typing.length, 1);
  assert.ok(typing[0].includes('Enter 结束输入'), typing[0]);
  const help = select.hintLines({ help: true });
  assert.equal(help.length, 1);
  assert.ok(help[0].includes('任意键返回'), help[0]);
  // The help overlay itself carries a readable key reference in both languages
  // 帮助浮层本身在两种语言下都给出可读的按键速查
  assert.equal(select.HELP_ITEMS.length, 10);
  for (const item of select.HELP_ITEMS) assert.ok(item.trim().length > 0, item);
  withLanguage('en', () => {
    for (const item of select.HELP_ITEMS) assert.ok(!CJK.test(item), `en: 帮助行不应含中文：${item}`);
  });
});

test('i18n-tui: select.js 状态文案与表头/页脚逐字一致', () => {
  const item = { modelId: 1, name: 'model', versionId: 100 };
  assert.equal(select.describeStatus(item, {}), '');
  assert.equal(select.describeStatus(item, { 1: { versions: { 100: {} } } }), '已下载');
  assert.equal(select.describeStatus(item, { 1: { versions: { 99: {} } } }), '版本有更新');
  assert.equal(
    select.describeStatus(item, { 1: { versions: { 100: {} }, pinnedVersionId: 100 } }),
    '已下载 已固定版本'
  );

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
  const sep = view.separator();
  assert.equal(
    lines[1],
    ['搜索：“lora”', '类型：LORA', '基础模型：SDXL 1.0', '排序：按大小↓', '第 2/4 页'].join(sep)
  );
  assert.equal(lines[2], '已选 3 项 / 共 40 项 | 过滤后 12 项 | 合计 2048B（全部 4096B）');

  // Default title and status when nothing is searched or filtered
  // 未搜索 / 未过滤时的默认标题与状态
  const plain = select.buildHeaderLines({ sizeFormatter: (n) => `${n}B` });
  assert.equal(plain[0], '选择要下载的条目');
  assert.equal(plain[1], ['搜索：未启用', '排序：默认排序', '第 1/1 页'].join(sep));
  assert.equal(plain[2], '已选 0 项 / 共 0 项 | 过滤后 0 项 | 合计 0B（全部 0B）');

  // The scrolling window replaces the page counter once the caller passes a position
  // 调用方传入可见区间后，行号区间取代页码
  const windowed = select.buildHeaderLines({ position: { start: 4, end: 14, size: 10 }, visibleCount: 40 });
  assert.ok(windowed[1].includes('第 5-14/40 行'), windowed[1]);

  // A transient message is appended to the summary line and never adds a line
  // 临时消息追加在汇总行，不会多出一行
  const noticed = select.withNotice(plain, 200, '已勾选');
  assert.equal(noticed.length, 3);
  assert.ok(noticed[2].endsWith('已勾选'));

  assert.equal(tr('tui.select.footer', { page: 2, pageCount: 4, count: 15, selected: 3, total: 40 }),
    '第 2/4 页 | 本页 15 项 | 已选 3/40');
  assert.equal(tr('tui.select.columnIndex'), '序号');
  assert.equal(tr('tui.select.columnName'), '名称');
  assert.equal(tr('tui.select.columnDetail'), '状态 / 类型 / 基础模型');
  assert.equal(tr('tui.select.columnSize'), '大小');
});

test('i18n-tui: 滚动视窗 / 单选模式 / 快捷跳行等新增纯逻辑可用', () => {
  // scrollWindow keeps the cursor visible while leaving the window still whenever possible
  // 滚动视窗保证光标可见，同时尽量不动视窗
  assert.deepEqual(select.scrollWindow(100, 0, 10, 0), { start: 0, end: 10, size: 10, cursor: 0 });
  assert.deepEqual(select.scrollWindow(100, 9, 10, 0), { start: 0, end: 10, size: 10, cursor: 9 });
  assert.deepEqual(select.scrollWindow(100, 10, 10, 0), { start: 1, end: 11, size: 10, cursor: 10 });
  assert.deepEqual(select.scrollWindow(100, 99, 10, 0), { start: 90, end: 100, size: 10, cursor: 99 });
  assert.deepEqual(select.scrollWindow(4, 3, 10, 0), { start: 0, end: 4, size: 4, cursor: 3 });
  assert.deepEqual(select.scrollWindow(0, 0, 10, 0), { start: 0, end: 0, size: 0, cursor: 0 });

  // Digit shortcuts address the 1st..9th row of the list
  // 数字快捷键对应列表第 1-9 行
  assert.equal(select.quickIndex('1'), 0);
  assert.equal(select.quickIndex('9'), 8);
  assert.equal(select.quickIndex('0'), null);
  assert.equal(select.quickIndex('12'), null);
  assert.equal(select.quickIndex('a'), null);

  // Range selection toggles a contiguous block without touching the input set
  // 区间选择只改一段连续行，且不修改入参
  const items = [1, 2, 3, 4].map((id) => ({ modelId: id, name: `m${id}` }));
  const before = new Set(['1']);
  const after = select.rangeSelection(before, items, 1, 3);
  assert.deepEqual([...before], ['1']);
  assert.deepEqual([...after].sort(), ['1', '2', '3', '4']);
  assert.deepEqual([...select.rangeSelection(after, items, 3, 1, false)].sort(), ['1']);

  // Custom rows (no modelId) still get a stable identity and label
  // 没有 modelId 的自定义行同样有稳定标识与名称
  const rows = [{ id: 'v10', title: '版本 A', totalBytes: 10 }];
  assert.equal(
    select.buildRowText(rows[0], { columns: 60, number: 1, nameWidth: 20, detailWidth: 0, sizeWidth: 5 }),
    `  ${view.checkbox(false)}  1 版本 A 10 B`
  );
  assert.equal(select.filterItems(rows, { keyword: 'v10' }).length, 1);
});

test('i18n-tui: 主菜单 / 固定页眉文案逐字一致且 app.js 已接线', () => {
  assert.equal(tr('tui.app.bannerTitle'), 'civitai-downloader');
  assert.equal(tr('tui.hint.main'), '↑↓ 选择 | Enter 进入 | ? 帮助');
  assert.equal(tr('tui.app.menuTitle'), '主菜单');
  const menu = [
    ['tui.app.menuDownload', '下载'],
    ['tui.app.menuModels', '本地模型管理'],
    ['tui.app.menuCollections', '本地收藏集管理'],
    ['tui.app.menuSettings', '设置'],
    ['tui.app.menuExit', '退出'],
  ];
  for (const [key, value] of menu) assert.equal(tr(key), value, key);
  assert.equal(tr('tui.app.contextLine', { site: 's', outDir: 'd', jobs: 4, logged: 'l' }), '站点 s | 输出目录 d | 并发 4 | 登录态 l');
  assert.equal(tr('tui.app.factSite'), '站点');
  assert.equal(tr('tui.app.factOutDir'), '下载目录');
  assert.equal(tr('tui.app.factJobs'), '并发');
  assert.equal(tr('tui.app.factSession'), '登录态');
  assert.equal(tr('tui.app.interruptNotice'), '已取消当前操作（在主菜单再按一次 Ctrl+C 退出程序）');
  assert.equal(tr('tui.app.loggedIn'), '已导出（如提示过期请重新登录）');
  assert.equal(tr('tui.app.notLoggedIn'), '未登录');
  assert.equal(tr('tui.app.operationFailed', { error: 'boom' }), '操作失败: boom');
  assert.equal(tr('tui.app.opened', { dir: 'D:\\out' }), '已打开: D:\\out');
  assert.equal(tr('tui.app.openFailed'), '打开目录失败');

  // Source wiring: menu entries really go through t() instead of keeping hard-coded text
  // 源码接线：菜单项确实通过 t() 取词，而不是残留硬编码
  const source = readTui('app.js');
  for (const key of [
    'tui.app.menuTitle',
    'tui.app.menuDownload',
    'tui.app.menuModels',
    'tui.app.menuCollections',
    'tui.app.menuSettings',
    'tui.app.menuExit',
    'tui.app.contextLine',
    'tui.app.goodbye',
  ]) {
    assert.ok(source.includes(`'${key}'`), `app.js 应引用 ${key}`);
  }
  // The five entries are the whole top level: the old single-purpose entries are gone.
  // 顶层就是这五项：旧的一堆单项入口已移除。
  assert.equal(app.MAIN_MENU.length, 5);
  assert.deepEqual(
    app.MAIN_MENU.map((item) => item.key),
    ['download', 'models', 'collections', 'settings', 'exit']
  );
});

test('i18n-tui: 仪表盘 / 任务视图 / 页脚文案逐字一致', () => {
  assert.equal(tr('tui.screen.infoTitle'), '仪表盘');
  assert.equal(tr('tui.screen.infoSettings'), '当前配置');
  assert.equal(tr('tui.screen.infoTasks'), '任务总览');
  assert.equal(tr('tui.screen.infoIdle'), '空闲 | 没有进行中的任务');
  // One line per page, listing only that page's keys.
  // 每页一行，且只列这一页能用的键。
  assert.equal(tr('tui.hint.main'), '↑↓ 选择 | Enter 进入 | ? 帮助');
  assert.equal(tr('tui.hint.menu'), '↑↓ 选择 | Enter 确认 | Esc 返回 | ? 帮助');
  assert.equal(tr('tui.hint.settings'), '↑↓ 选择 | Enter 修改 / 执行 | Esc 返回 | ? 帮助');
  assert.equal(tr('tui.hint.message'), 'Esc 返回 | ? 帮助');
  assert.equal(tr('tui.hint.taskView'), '↑↓ 选择 | Esc 返回 | ? 帮助');
  assert.equal(tr('tui.screen.taskTitle'), '任务视图');
  assert.equal(tr('tui.screen.taskCounts', { done: 2, skipped: 1, failed: 0, total: 9 }), '完成 2 | 跳过 1 | 失败 0 / 共 9 项');
  assert.equal(tr('tui.screen.taskElapsed', { elapsed: '00:03' }), '已用 00:03');
  assert.equal(tr('tui.screen.statusRunning'), '进行中');
  assert.equal(tr('tui.screen.statusDone'), '已完成');
  assert.equal(tr('tui.screen.statusCancelled'), '已取消');
  assert.equal(tr('tui.screen.statusFailed'), '失败');
  assert.equal(tr('tui.screen.logTitle'), '日志');
  assert.equal(tr('tui.screen.promptFailed', { error: 'boom' }), '界面渲染失败: boom');
  assert.equal(tr('tui.screen.taskCancelRequested', { name: 'Model A' }), '已请求取消：Model A');

  // The shell is wired to the catalog like every other TUI file
  // 外壳与其它 TUI 文件一样接入了文案表
  const source = readTui('screen.js');
  for (const key of [
    'tui.hint.taskView',
    'tui.hint.compact',
    'tui.screen.infoTitle',
    'tui.screen.infoSettings',
    'tui.screen.infoTasks',
    'tui.screen.taskTitle',
    'tui.screen.logTitle',
  ]) {
    assert.ok(source.includes(`'${key}'`), `screen.js 应引用 ${key}`);
  }
});

test('i18n-tui: 下载完成摘要与数量占位符逐字一致', () => {
  assert.equal(tr('tui.download.summaryDone', { done: 3, skipped: 1, failed: 2 }), '本次完成：完成 3，跳过 1，失败 2');
  assert.equal(
    tr('tui.download.summaryDoneMeta', { done: 3, skipped: 1, failed: 2, metaFailed: 4 }),
    '本次完成：完成 3，跳过 1，失败 2，元数据失败 4'
  );
  assert.equal(
    tr('tui.download.summaryCancelled', { done: 0, skipped: 0, failed: 1 }),
    '本次已取消：完成 0，跳过 0，失败 1（已下载文件保留，可续传）'
  );
  assert.equal(tr('tui.download.selectTitle', { count: 12, size: '3.00 MiB' }), '选择要下载的条目（共 12 项，合计 3.00 MiB）');
  assert.equal(tr('tui.download.elapsed', { elapsed: '1 分 2 秒', file: 'logs/a.log' }), '用时 1 分 2 秒；日志文件: logs/a.log');
  assert.equal(tr('tui.download.fileCount', { count: 2 }), '2 个文件');
  assert.equal(tr('tui.download.planTitle', { count: 2, size: '1.00 MiB' }), '本次计划：2 项，共 1.00 MiB');
  assert.equal(tr('tui.download.doneCount', { count: 5 }), '其中 5 项已完成（默认不勾选；如需重下可在后面选择强制重下）');
  assert.equal(tr('tui.download.currentMark'), '（当前）');
  assert.equal(tr('tui.download.unknownDate'), '未知日期');
});

test('i18n-tui: check 报告标题与更新摘要逐字一致', () => {
  assert.equal(tr('tui.check.collectionHeader', { id: 12345 }), '— 收藏集 12345 —');
  assert.equal(
    tr('tui.check.startUpdate', { collectionId: 12345, count: 5, size: '1.00 MiB' }),
    '开始更新收藏集 12345 的 5 项，共 1.00 MiB'
  );
  assert.equal(tr('tui.check.stateReset', { count: 4 }), '已重置 4 项状态，将重新校验/下载');
  assert.equal(tr('tui.check.summaryDone', { done: 5, skipped: 0, failed: 1 }), '更新完成：完成 5，跳过 0，失败 1');
  assert.equal(tr('tui.check.modeDeep'), '深度检查（校验本地 SHA256 + 线上文件哈希）');
  assert.equal(tr('tui.check.modeQuickDesc'), '秒级完成，发现不了「同版本被作者重传」');
  assert.equal(tr('tui.check.collectionLabel', { id: 7 }), '收藏集 7');
  assert.equal(tr('tui.check.completionRecords', { count: 3 }), '成员 3 项');
});

test('i18n-tui: 下载进度面板文案逐字一致', () => {
  assert.equal(tr('tui.run.downloading'), '下载中');
  assert.equal(tr('tui.run.counts', { ok: 2, skipped: 1, failed: 0, total: 9 }), '完成 2 | 跳过 1 | 失败 0 / 共 9 项');
  assert.equal(tr('tui.run.remaining', { eta: '00:12' }), '剩余 00:12');
  assert.equal(tr('tui.run.elapsed', { elapsed: '00:03' }), '已用 00:03');
  assert.equal(` ${tr('tui.run.retry', { attempt: 2, max: 3, code: 429 })}`, ' [第 2/3 次尝试 HTTP 429]');
  assert.equal(tr('tui.run.waiting'), '当前 | 等待下一项…（按 s 跳过当前模型，Esc 取消）');
  assert.equal(tr('tui.run.fileLabel'), '当前文件');
  assert.equal(tr('tui.run.cancelNotice'), '已请求取消，正在停止下载（已下载部分保留，可续传）…');
  assert.equal(tr('tui.run.cancelPending'), '正在取消，请稍候…（已下载部分保留，可续传）');
  assert.equal(tr('tui.run.skipNotice'), '收到跳过请求，将跳过当前模型（已下载部分保留）…');
});

test('i18n-tui: 公共交互基元（按键提示 / 信息块 / 状态栏 / 帮助页）', () => {
  // The plain (non-shell) path appends the menu hint to every prompt
  // 简易（无外壳）路径给每个提问追加菜单那一行按键提示
  const hints = pages.hintLines();
  assert.equal(hints.length, 1);
  assert.equal(hints[0], '↑↓ 选择 | Enter 确认 | Esc 返回 | ? 帮助');
  assert.ok(pages.hint().includes('Esc'));

  // Inside the frame each page owns its single line: the keys it lists are the keys that work there.
  // 框架里每一页都拥有自己那一行：列出来的键就是这一页能用的键。
  assert.equal(tr('tui.hint.confirm'), '←→ 选择 | y/n 快捷 | Enter 确认 | Esc 返回 | ? 帮助');
  assert.equal(tr('tui.hint.text'), 'Enter 提交 | Esc 放弃 | ? 帮助');
  assert.equal(tr('tui.hint.textPick'), 'Enter 提交 | Esc 放弃 | Ctrl+O 选择目录 | ? 帮助');
  assert.equal(tr('tui.pages.pickUnavailable'), '当前环境无法打开目录选择框，请直接输入路径');
  assert.equal(tr('tui.pages.listPosition', { index: 3, total: 12 }), '第 3 / 12 项');
  // Saving has no shortcut any more: it is a row of the page.
  // 保存不再有快捷键：它就是页面里的一行。
  assert.ok(!tr('tui.hint.settings').includes('s 保存'), tr('tui.hint.settings'));
  // The main menu owns a line too, and it does not advertise Esc (which does nothing there).
  // 主菜单也有自己那一行，且不再宣传 Esc（它在那里无效）。
  assert.ok(!tr('tui.hint.main').includes('Esc'), tr('tui.hint.main'));
  assert.equal(tr('tui.app.menuHint'), 'tui.app.menuHint');

  // Fact blocks align their label column and skip empty values
  // 信息块的标签列对齐，空值不输出
  const facts = pages.describeFacts([
    { label: '站点', value: 'https://civitai.com' },
    { label: '下载目录', value: 'D:\\out' },
    { label: '代理', value: '' },
    { label: '空值', value: null },
  ]);
  assert.equal(facts.length, 2);
  assert.ok(facts[0].includes('站点') && facts[0].includes('https://civitai.com'));
  // The value column starts at the same display column on every row (code-unit offsets differ,
  // CJK labels are two columns wide each)
  //
  // 值列在每一行的「显示列」位置相同（码元下标会不同：中文标签每个字占 2 列）
  const valueColumn = (line, value) => view.displayWidth(line.slice(0, line.indexOf(value)));
  assert.equal(valueColumn(facts[0], 'https://civitai.com'), valueColumn(facts[1], 'D:\\out'));

  // The status block of the main menu is built from the live config
  // 主菜单的状态块由当前配置生成
  const config = { cookiesFile: 'no-such-file-here', site: 'https://civitai.com', outDir: 'D:\\out', jobs: 2 };
  withLanguage('zh-CN', () => {
    const status = app.statusFacts(config);
    assert.ok(status.compact.includes('https://civitai.com'));
    assert.equal(status.facts.length, 4);
    // The panel order is fixed: site, session, directory, concurrency.
    // 面板顺序固定：站点、登录态、本地目录、并发。
    assert.equal(status.facts[1].value, '未登录');
    assert.equal(status.facts[2].value, 'D:\\out');
    assert.equal(status.facts[3].value, '2');
  });

  // Help page: a boxed key reference with the version line, in both languages
  // 帮助页：带边框的按键速查与版本行，中英双语都可用
  const lines = pages.helpLines({ version: '1.2.3', columns: 80 });
  const text = lines.join('\n');
  assert.ok(text.includes('帮助 / 快捷键'), text);
  assert.ok(text.includes('1.2.3'));
  assert.ok(text.includes('Ctrl+C'));
  withLanguage('en', () => {
    const englishText = pages.helpLines({ version: '1.2.3', columns: 80 }).join('\n');
    assert.ok(englishText.includes('Help / shortcuts'));
    assert.ok(!CJK.test(englishText), `en: 帮助页不应含中文：${englishText}`);
  });
});

test('i18n-tui: manage / login / settings 文案逐字一致', () => {
  assert.equal(tr('tui.manage.memberCount', { count: 9 }), '成员 9 项');
  assert.equal(tr('tui.manage.memberVersions', { versions: 2, pinned: '未固定' }), '2 个版本 | 未固定');
  assert.equal(
    tr('tui.manage.snapshotLine', { count: 3, fetchedAt: '2024-01-02T03:04:05.000Z' }),
    '成员快照：3 项（枚举于 2024-01-02T03:04:05.000Z）'
  );
  assert.equal(
    tr('tui.manage.changesLine', { added: 1, removed: 2, versionChanged: 3, previousFetchedAt: 'T0' }),
    '与上次枚举相比：新增 1，移除 2，版本变化 3（上次枚举于 T0）'
  );
  assert.equal(tr('tui.manage.changeAdded', { name: 'A' }), '  + 新增 A');
  assert.equal(tr('tui.manage.changeVersion', { name: 'A', from: 1, to: 2 }), '  ~ 版本变化 A: 1 → 2');
  assert.equal(tr('tui.manage.resetDone', { count: 2, names: 'a、b' }), '已重置 2 个模型的记录：a、b');
  assert.equal(tr('tui.manage.verifySummary', { label: '模型库', total: 3, size: '1.00 MiB' }), '模型库：共 3 个模型，合计 1.00 MiB');
  assert.equal(tr('tui.manage.verifyCounts', { ok: 3, broken: 1 }), '正常 3 项，异常 1 项');
  assert.equal(tr('tui.manage.dirLine', { dir: 'D:\\out' }), '目录: D:\\out');
  assert.equal(tr('tui.manage.brokenLine', { name: 'a.safetensors', reasons: `大小不符${tr('tui.manage.reasonSeparator')}缺少文件` }),
    'a.safetensors: 大小不符；缺少文件');
  assert.equal(tr('tui.manage.back'), '返回');
  assert.equal(tr('tui.manage.cancelled'), '已取消');

  assert.equal(tr('tui.login.title', { site: 'https://civitai.com' }), '登录 / 校验登录态（https://civitai.com）');
  assert.equal(tr('tui.login.startConfirm', { site: 's' }), '将打开浏览器登录 s，现在开始？');
  assert.equal(tr('tui.login.modeCheckDesc'), '不打开登录页，验证保存的会话是否仍有效');
  assert.equal(tr('tui.login.done'), '登录流程结束，可返回主菜单继续使用');

  assert.equal(tr('tui.settings.outDir', { root: 'C:\\repo' }), '下载目录（相对路径相对项目根：C:\\repo）');
  assert.equal(tr('tui.settings.chromePath'), 'Chrome/Edge 路径（留空自动检测）');
  assert.equal(tr('tui.settings.dedupHardlink'), '硬链接（同盘零占用，注意：删一处不影响另一处，但改内容会同步）');
  // Every field is written the moment it is confirmed: the feedback names the field and its new value.
  // 每个字段确认即写盘：反馈里带上字段名与新值。
  assert.equal(
    tr('tui.settings.savedItem', { label: '界面语言', value: 'English' }),
    '已保存：界面语言 = English'
  );
  assert.equal(tr('tui.settings.unchanged', { label: '并发' }), '并发 未修改');
  assert.equal(
    tr('tui.settings.siteChanged'),
    '站点已变更：Chrome profile 会切换到新站点的独立目录，请重新登录（主菜单 → 登录 / 更新登录）'
  );
});

// ---------------------------------------------------------------------------
// en translations
// en 翻译
// ---------------------------------------------------------------------------

test('i18n-tui: 切到 en 后 TUI 文案为英文、非空且与 zh 不同', () => {
  assert.ok(TUI_KEYS.length >= 200, `TUI 键数量偏少：${TUI_KEYS.length}`);
  withLanguage('en', () => {
    for (const key of TUI_KEYS) {
      const value = i18n.t(key);
      assert.equal(typeof value, 'string', `${key} 必须是字符串`);
      assert.ok(value.length > 0, `${key} 不能为空`);
      assert.notEqual(value, key, `${key} 不能返回裸键名（漏翻）`);
      if (SAME_IN_BOTH.has(key)) continue;
      assert.notEqual(value, zh[key], `${key} 必须有英文翻译`);
      assert.ok(!CJK.test(value), `${key} 的英文不应含中文：${value}`);
    }
    // Technical terms stay as is
    // 技术名词保留原样
    assert.ok(i18n.t('tui.manage.hashConfirm').includes('SHA256'));
    assert.ok(i18n.t('tui.check.modeDeep').includes('SHA256'));
    assert.ok(i18n.t('tui.settings.engine').includes('aria2c'));
    assert.ok(i18n.t('tui.settings.engineCurl').includes('curl'));
    assert.ok(i18n.t('tui.settings.notifyWebhook').includes('Webhook'));
    assert.ok(i18n.t('tui.settings.languageAuto').includes('CIVITAI_LANG'));
    // Cancelling is Esc's job in the redesigned TUI, and the header says so.
    // 新版 TUI 里取消由 Esc 负责，页眉也是这么写的。
    assert.ok(i18n.t('tui.hint.menu').includes('Esc'));
    assert.ok(i18n.t('tui.run.cancelNotice').length > 0);
    // The program name is a brand: it stays the same in both languages.
    // 程序名是品牌名：中英文都保持同一写法。
    assert.equal(i18n.t('tui.app.bannerTitle'), 'civitai-downloader');
    assert.ok(i18n.t('tui.download.collectionIdPrompt').includes('URL'));
    // Key names inside the key hints must stay readable in English
    // 键位提示里的按键名在英文下要能看懂
    assert.ok(i18n.t('tui.hint.picker').includes('Space'));
    assert.ok(i18n.t('tui.hint.picker').includes('Enter'));
  });
  // Still Chinese after the language is restored
  // 恢复后仍是中文
  assert.equal(i18n.t('tui.app.menuTitle'), '主菜单');
});

test('i18n-tui: TUI 文案在 en 下确实变化（抽样对照）', () => {
  const pairs = [
    ['tui.app.menuTitle', 'Main menu'],
    ['tui.select.statusDownloaded', 'Downloaded'],
    ['tui.select.sortSizeDesc', 'By size ↓'],
    ['tui.run.downloading', 'Downloading'],
    ['tui.manage.verifyAllOk', 'All files verified'],
    ['tui.login.modeCheck', 'Only check the current session'],
    ['tui.settings.language', 'Interface language'],
  ];
  withLanguage('en', () => {
    for (const [key, expected] of pairs) {
      assert.equal(i18n.t(key), expected, key);
      assert.notEqual(i18n.t(key), zh[key], key);
    }
  });
  for (const [key] of pairs) assert.equal(i18n.t(key), zh[key], `${key} 恢复 zh-CN 后应逐字一致`);
});

// ---------------------------------------------------------------------------
// Placeholders / key set / exported constants
// 占位符 / 键集合 / 导出常量
// ---------------------------------------------------------------------------

test('i18n-tui: 占位符在两种语言下都被替换（数量/名称/路径/大小）', () => {
  const cases = [
    ['tui.select.footer', { page: 2, pageCount: 4, count: 15, selected: 3, total: 40 }, ['2/4', '15', '3/40']],
    ['tui.run.counts', { ok: 2, skipped: 1, failed: 0, total: 9 }, ['2', '1', '0', '9']],
    ['tui.download.keywordPrompt', { count: 42 }, ['42']],
    ['tui.download.lowSpace', { planned: '1.00 MiB', dir: 'D:\\out', free: '2.00 MiB' }, ['1.00 MiB', 'D:\\out', '2.00 MiB']],
    ['tui.manage.resetDone', { count: 3, names: 'a、b' }, ['3', 'a、b']],
    ['tui.check.startUpdate', { collectionId: 777, count: 5, size: '1.00 MiB' }, ['777', '5', '1.00 MiB']],
    ['tui.app.contextLine', { site: 's', outDir: 'd', jobs: 4, logged: 'l' }, ['s', 'd', '4', 'l']],
    ['tui.select.summary', { selected: 1, total: 2, visible: 3, selectedSize: '4B', visibleSize: '5B' }, ['1', '2', '3', '4B', '5B']],
  ];
  for (const lang of ['zh-CN', 'en']) {
    withLanguage(lang, () => {
      for (const [key, params, expects] of cases) {
        const out = i18n.t(key, params);
        assertNoPlaceholder(lang, key, out);
        for (const expected of expects) {
          assert.ok(out.includes(expected), `${lang}: ${key} 缺少 ${expected}：${out}`);
        }
      }
    });
  }
});

test('i18n-tui: tui.* 键集合一致、命名规范、无缺翻', () => {
  assert.deepEqual(i18n.missingKeys('en'), []);
  assert.deepEqual(i18n.missingKeys('zh-CN'), []);
  assert.ok(TUI_KEYS.length >= 200);
  for (const key of TUI_KEYS) {
    assert.ok(Object.prototype.hasOwnProperty.call(en, key), `en 缺少 ${key}`);
    assert.match(key, /^[a-zA-Z][a-zA-Z0-9]*(\.[a-zA-Z][a-zA-Z0-9]*)+$/, `键名不规范: ${key}`);
    assert.ok(TUI_MODULES.has(key.split('.')[1]), `键名模块不合法: ${key}`);
  }
  // Every TUI file is wired to the message catalog
  // 每个 TUI 文件都接入了文案表
  for (const file of TUI_FILES) {
    const source = readTui(file);
    assert.ok(
      source.includes("require('../i18n')") || source.includes("require('../../i18n')"),
      `${file} 应 require('../i18n') 或 require('../../i18n')`
    );
  }

  // Keys referenced in the source map one-to-one to the catalog (catches typos and missing registrations)
  // 源码里引用的键与文案表一一对应（防止键名写错/漏登记）
  const referenced = new Set();
  for (const file of TUI_FILES) {
    for (const match of readTui(file).matchAll(/'tui\.[a-zA-Z0-9.]+'/g)) {
      referenced.add(match[0].slice(1, -1));
    }
  }
  assert.deepEqual([...referenced].filter((key) => zh[key] === undefined), [], '源码引用了未登记的键');
  assert.deepEqual(TUI_KEYS.filter((key) => !referenced.has(key)), [], '文案表中有未被任何 TUI 文件引用的键');
});

test('i18n-tui: select.js 导出常量/纯函数在两种语言下都可用且随语言切换', () => {
  const items = [
    { modelId: 1, name: 'Alpha', type: 'Checkpoint', baseModel: 'SD 1.5', totalBytes: 1024 },
    { modelId: 2, name: 'Beta', type: 'LORA', baseModel: 'SDXL 1.0', totalBytes: 2048 },
  ];
  const zhLabels = Object.fromEntries(select.SORT_MODES.map((mode) => [mode, select.SORT_LABELS[mode]]));
  const zhHints = Array.from(select.KEY_HINTS);

  for (const lang of ['zh-CN', 'en']) {
    withLanguage(lang, () => {
      for (const mode of select.SORT_MODES) {
        const label = select.SORT_LABELS[mode];
        assert.ok(label && label.trim().length > 0, `${lang}: ${mode} 标签不能为空`);
        assert.notEqual(label, `tui.select.sort${mode}`, `${lang}: ${mode} 标签不能是裸键名`);
        if (lang === 'en') assert.ok(!CJK.test(label), `en: ${mode} 标签不应含中文：${label}`);
      }
      for (const hint of select.KEY_HINTS) {
        assert.ok(hint.trim().length > 0);
        assertNoPlaceholder(lang, 'tui.hint.picker', hint);
      }
      assert.equal(select.KEY_HINTS.length, 1);
      assert.notEqual(select.describeStatus(items[0], { 1: { versionId: 1 } }), '');
      const lines = select.buildHeaderLines({
        search: 'x',
        sort: 'size',
        selectedCount: 1,
        itemCount: 2,
        visibleCount: 2,
        selectedBytes: 1,
        visibleBytes: 2,
        page: 0,
        pageCount: 1,
        sizeFormatter: (n) => `${n}B`,
      });
      assert.equal(lines.length, 3);
      if (lang === 'en') {
        assert.ok(!CJK.test(lines.join('\n')), `en: 表头不应含中文：${lines.join(' | ')}`);
        assert.ok(lines[1].includes('Search: "x"'));
      }
      // Rendering still respects the column width
      // 渲染仍然受列宽约束
      const rendered = select.renderListLines(items, {
        columns: 60,
        indexWidth: 2,
        nameWidth: 20,
        detailWidth: 10,
        sizeWidth: 7,
        cursor: 0,
        minRows: 3,
        colorize: false,
        sizeFormatter: (n) => `${n}B`,
      });
      assert.equal(rendered.length, 3);
      for (const line of rendered) assert.ok(select.displayWidth(line) <= 60, `行宽超限：${line}`);
    });
    // Lazy lookup: leaving withLanguage must restore the previous language
    // 惰性取词：退出 withLanguage 后必须回到原语言
    assert.deepEqual(Object.fromEntries(select.SORT_MODES.map((mode) => [mode, select.SORT_LABELS[mode]])), zhLabels);
    assert.deepEqual(Array.from(select.KEY_HINTS), zhHints);
  }

  // Language switching is live (module-level constants must not freeze the text at load time)
  // 语言切换是实时的（模块级常量不能在加载时把文案定死）
  withLanguage('en', () => {
    assert.notEqual(select.SORT_LABELS.size, zhLabels.size);
    assert.notEqual(select.KEY_HINTS[0], zhHints[0]);
  });
  assert.equal(select.SORT_LABELS.size, zhLabels.size);
  assert.equal(select.KEY_HINTS[0], zhHints[0]);
});

// ---------------------------------------------------------------------------
// Language state / leftover source text
// 语言状态 / 源码残留
// ---------------------------------------------------------------------------

test('i18n-tui: 语言状态不泄漏（try/finally 恢复）', (t) => {
  t.after(() => i18n.setLanguage(LANGUAGE_AT_LOAD));

  withLanguage('en', () => {
    assert.equal(i18n.getLanguage(), 'en');
    assert.equal(i18n.t('tui.app.menuExit'), 'Exit');
  });
  assert.equal(i18n.getLanguage(), LANGUAGE_AT_LOAD);
  assert.equal(i18n.t('tui.app.menuExit'), '退出');

  // Must restore even when an exception is thrown
  // 抛异常时也必须恢复
  assert.throws(
    () =>
      withLanguage('en', () => {
        throw new Error('boom');
      }),
    /boom/
  );
  assert.equal(i18n.getLanguage(), LANGUAGE_AT_LOAD);
  assert.equal(i18n.t('tui.select.statusDownloaded'), '已下载');
});

test('i18n-tui: TUI 源码不残留中文硬编码（注释除外）', () => {
  for (const file of TUI_FILES) {
    const lines = readTui(file).split('\n');
    const offenders = [];
    lines.forEach((line, index) => {
      if (CJK.test(stripLineComment(line))) offenders.push(`${index + 1}: ${line.trim()}`);
    });
    assert.deepEqual(offenders, [], `${file} 仍有硬编码中文：\n${offenders.join('\n')}`);
  }
});
