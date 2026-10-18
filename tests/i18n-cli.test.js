'use strict';

/**
 * CLI-layer i18n regression tests.
 *
 * Three things matter here:
 *  1. usage() / error hints really come from the message catalog (no Chinese left after switching to en);
 *  2. the sample command `node cli.js <command>` survives in both languages (deliberately untranslated);
 *  3. the default language (zh-CN) keeps the exact wording from before the extraction.
 *
 * Note: cli.js does not export usage() (requiring it runs main), so this file asserts
 * the `cli.usage` message itself; each command module's usage() is really called and its output captured.
 *
 *
 * 命令行层 i18n 回归测试。
 *
 * 关注三件事：
 *  1. usage() / 错误提示确实走文案表（切到 en 后不再是中文）；
 *  2. 示例命令 `node cli.js <命令>` 在两种语言下都保留（刻意不翻译）；
 *  3. 默认语言（zh-CN）的文案与抽取前逐字一致。
 *
 * 注意：cli.js 没有导出 usage()（require 即执行 main），所以这里断言
 * `cli.usage` 这条文案本身；各命令模块的 usage() 则真实调用并捕获输出。
 */

const test = require('node:test');
const assert = require('node:assert/strict');

const i18n = require('../src/i18n');
const zh = require('../src/i18n/zh-CN');
const en = require('../src/i18n/en');
const errors = require('../src/errors');
const { describeError, printConfigWarnings, handleFatal } = require('../src/runtime');
const { commandNames, loadCommand } = require('../src/commandSpec');

const COMMANDS = commandNames();
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
 * Capture console output and restore process.exitCode (usage() sets it to 1).
 * 捕获 console 输出，并复原 process.exitCode（usage() 会把它设成 1）
 */
function captureOutput(fn) {
  const lines = [];
  const orig = { log: console.log, error: console.error };
  console.log = (...args) => lines.push(args.map(String).join(' '));
  console.error = (...args) => lines.push(args.map(String).join(' '));
  const prevCode = process.exitCode;
  process.exitCode = 0;
  try {
    fn();
  } finally {
    console.log = orig.log;
    console.error = orig.error;
    process.exitCode = prevCode;
  }
  return lines.join('\n');
}

/**
 * Switch language temporarily and restore it afterwards
 * (run-tests.js runs every test file in the same process).
 *
 * 临时切换语言，结束后恢复（run-tests.js 在同一进程里跑所有测试文件）
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
 * Really call the usage() of one command.
 * 真实调用某命令的 usage()
 */
function callUsage(name) {
  const mod = loadCommand(name);
  return captureOutput(() => mod.usage());
}

// ---------------------------------------------------------------------------
// Usage text
// usage 文案
// ---------------------------------------------------------------------------

test('i18n-cli: cli.usage 覆盖全部命令与 npm 用法示例', () => {
  // The npm section lists the command scripts plus the two UI entry points (pin has no npm script).
  // cli.usage 的 npm 段落列出各命令脚本，以及两个界面入口（pin 没有 npm script）。
  const npmScripts = ['login', 'list', 'download', 'check', 'verify', 'doctor', 'tui', 'webui'];
  for (const lang of ['zh-CN', 'en']) {
    const text = withLanguage(lang, () => i18n.t('cli.usage'));
    assert.ok(text.startsWith('civitai-downloader\n'), `${lang}: 首行应为程序名`);
    // The program name is a brand: identical in both languages.
    // 程序名是品牌名：中英文一致。
    assert.ok(!text.startsWith('civitai-collection-downloader'), `${lang}: 不应再出现旧包名`);
    for (const name of COMMANDS) {
      assert.ok(text.includes(`node cli.js ${name}`), `${lang}: 应包含 node cli.js ${name}`);
    }
    for (const name of npmScripts) {
      assert.ok(text.includes(`npm run ${name}`), `${lang}: 应包含 npm run ${name}`);
    }
    assert.ok(text.includes('--help'), `${lang}: 应提示 --help`);
    assert.ok(text.endsWith('\n'), `${lang}: 结尾保留换行`);
  }
});

test('i18n-cli: 各命令 usage() 在 zh-CN 下包含 node cli.js <命令>', () => {
  for (const name of COMMANDS) {
    const text = withLanguage('zh-CN', () => callUsage(name));
    assert.ok(text.length > 0, `${name}: usage 不应为空`);
    assert.ok(text.includes(`node cli.js ${name}`), `${name}: 应包含 node cli.js ${name}`);
    assert.ok(CJK.test(text), `${name}: zh-CN 下应为中文文案`);
  }
});

test('i18n-cli: 各命令 usage() 切到 en 后仍保留 node cli.js <命令> 示例', () => {
  for (const name of COMMANDS) {
    const text = withLanguage('en', () => callUsage(name));
    assert.ok(text.length > 0, `${name}: usage 不应为空`);
    assert.ok(text.includes(`node cli.js ${name}`), `${name}: en 下示例命令不翻译`);
    assert.ok(!CJK.test(text), `${name}: en 下不应残留中文`);
  }
});

test('i18n-cli: usage() 输出逐字取自语言包（未登记键会原样返回，故必须相等）', () => {
  for (const name of COMMANDS) {
    const key = `${name}.usage`;
    assert.ok(i18n.has(key, 'zh-CN'), `${key} 应登记在 zh-CN`);
    assert.ok(i18n.has(key, 'en'), `${key} 应登记在 en`);
    const toZh = i18n.createTranslator('zh-CN');
    const toEn = i18n.createTranslator('en');
    assert.equal(withLanguage('zh-CN', () => callUsage(name)), toZh(key), `${name}: 中文 usage 应等于文案表`);
    assert.equal(withLanguage('en', () => callUsage(name)), toEn(key), `${name}: 英文 usage 应等于文案表`);
  }
});

test('i18n-cli: usage() 多行文案保留原始缩进与换行', () => {
  const text = withLanguage('zh-CN', () => callUsage('download'));
  assert.ok(text.includes('\n选项:\n  --out <目录>        下载到指定目录（相对路径相对项目根）\n'), '缩进与换行应保留');
  assert.ok(text.includes('\n示例:\n  node cli.js download 161131\n'), '示例段落应保留');
  assert.ok(text.split('\n').length > 20, '应仍是整段多行文案');
});

// ---------------------------------------------------------------------------
// zh-CN verbatim regression
// zh-CN 逐字回归
// ---------------------------------------------------------------------------

test('i18n-cli: zh-CN 回归 —— cli.js 用法逐字一致', () => {
  const text = zh['cli.usage'];
  assert.ok(
    text.includes('  node cli.js login [--check]                     打开浏览器完成登录并保存会话（--check 只校验登录态）')
  );
  assert.ok(text.includes('用法:\n'));
  assert.ok(text.includes('download 常用选项:\n'));
  assert.ok(text.includes('  --jobs <n>  --refresh-meta  --resume  --file-types <t,t>  --no-primary  --ignore-space'));
  assert.ok(text.includes('npm 用法（传参需要 -- 分隔）:\n'));
  assert.ok(text.includes('提示: 也可以用 node cli.js <命令> --help 查看单个命令的说明。\n'));
});

test('i18n-cli: zh-CN 回归 —— download 用法中的参数说明逐字一致', () => {
  const text = zh['download.usage'];
  assert.ok(text.includes('  --version <m=v[,m=v]>  指定模型下载哪个版本'));
  assert.ok(text.includes('  --jobs <n>          同时下载的模型数（默认取 config.json 的 jobs）'));
  assert.ok(text.includes('  --engine <name>     下载引擎：curl（默认）/ aria2 / auto'));
  assert.ok(text.includes('  --dedup <mode>      跨收藏集去重：off（默认）/ hardlink / copy'));
  assert.ok(text.includes('  --force-lock        忽略「已有其它进程在处理该收藏集」的提示'));
  assert.ok(text.includes('  node cli.js download https://civitai.red/models/1191424?modelVersionId=1990837'));
});

test('i18n-cli: zh-CN 回归 —— check / verify 用法逐字一致', () => {
  assert.ok(
    zh['check.usage'].includes(
      '  --verify-files     深度校验：拉取线上文件哈希并校验本地 SHA256（能发现同版本重传/改名/增删）'
    )
  );
  assert.ok(zh['check.usage'].includes('  默认「快速」：只比对版本号与本地文件大小，跳过已完成项的元数据请求（秒级）'));
  assert.ok(zh['verify.usage'].includes('  --no-hash      只比对文件大小，不计算 SHA256（快很多）'));
  assert.ok(zh['verify.usage'].includes('  --repair       重新下载损坏/缺失的文件（需要记录里有下载直链）'));
});

test('i18n-cli: zh-CN 回归 —— login / list / doctor / pin 用法逐字一致', () => {
  assert.ok(zh['login.usage'].includes('  --check   只校验已保存的登录态是否有效，不打开登录页'));
  assert.ok(zh['list.usage'].includes('  --from-cache  不联网，直接使用上次枚举缓存（.data/items-<ID>.json）'));
  assert.ok(
    zh['doctor.usage'].includes('检查：Node 版本、配置、curl、浏览器、调试端口、Cookie、目录可写、磁盘空间、长路径支持。')
  );
  assert.ok(
    zh['pin.usage'].includes('  node cli.js pin <模型ID> [版本ID]        固定版本（省略版本ID = 固定当前已下载的最新版本）')
  );
});

test('i18n-cli: zh-CN 回归 —— models / check / pin 的模型库用法', () => {
  assert.ok(zh['models.usage'].includes('用法: node cli.js models [选项]'));
  assert.ok(zh['models.usage'].includes('--forget <id[,id]>'));
  assert.ok(zh['models.usage'].includes('--delete-files'));
  assert.ok(zh['models.usage'].includes('--relayout'));
  assert.ok(zh['models.usage'].includes('node cli.js models --pin 1191424=1990837'));
  assert.ok(zh['models.usage'].includes('modelId,name,type,versionId,versionName,files,bytes,outDir,dirName,pinned,verifiedAt'));
  assert.ok(zh['check.usage'].includes('--models           检查模型库里的全部模型'));
  assert.ok(zh['check.usage'].includes('model:<模型ID>'));
  assert.ok(zh['pin.usage'].includes('node cli.js pin model:<模型ID> [版本ID]'));
  assert.ok(zh['pin.usage'].includes('node cli.js pin --list'));
  assert.ok(zh['download.usage'].includes('--models <ref,ref>'));
  assert.ok(zh['download.usage'].includes('--from-file <文件>'));

  const enModels = i18n.createTranslator('en')('models.usage');
  assert.ok(enModels.includes('node cli.js models'));
  assert.ok(enModels.includes('--relayout'));
  assert.ok(!CJK.test(enModels), 'en 的 models.usage 不应含中文');
  const enPin = i18n.createTranslator('en')('pin.usage');
  assert.ok(enPin.includes('model:<modelId>'));
  assert.ok(!CJK.test(enPin));
});

test('i18n-cli: zh-CN 回归 —— 常用提示与逐字文案', () => {
  const t = i18n.createTranslator('zh-CN');
  assert.equal(t('cli.unknownCommand', { cmd: 'foo' }), '未知命令: foo\n');
  assert.equal(t('cli.unknownFlag', { flag: 'nope' }), '警告: 已忽略未知参数 --nope（用 --help 查看可用参数）');
  assert.equal(t('download.versionFormat', { pair: 'x' }), '--version 格式错误: x（应为 modelId=versionId）');
  assert.equal(t('list.usingCache', { file: 'F', time: 'T' }), '使用缓存 F（枚举于 T）');
  assert.equal(t('list.countHeader', { collectionId: '777', count: 3 }), '收藏集 777 共 3 项:');
  assert.equal(t('verify.counts', { ok: 1, broken: 2 }), '  正常 1 项，异常 2 项');
  assert.equal(t('verify.brokenDir', { dir: 'D:/x' }), '    目录: D:/x');
  assert.equal(t('doctor.summaryFails', { fails: 1, warns: 2 }), '发现 1 项问题、2 项警告');
  assert.equal(t('doctor.summaryOk'), '一切正常');
  assert.equal(t('pin.unpinned', { name: 'Model A' }), '已取消固定: Model A（下次下载会跟随线上版本）');
  assert.equal(t('runtime.configWarning', { message: 'x' }), '配置提示: x');
  assert.equal(
    t('check.quietSummary', {
      collectionId: '777',
      total: 4,
      updated: 1,
      fileChanged: 1,
      missing: 1,
      notDownloaded: 0,
      pinned: 1,
    }),
    '收藏集 777：共 4 项｜有更新 1｜文件变化 1｜缺失 1｜未下载 0｜固定版本 1'
  );
});

test('i18n-cli: en 文案确实换成英文，且技术名词保留原样', () => {
  const t = i18n.createTranslator('en');
  assert.equal(t('list.countHeader', { collectionId: '777', count: 3 }), 'Collection 777: 3 items:');
  assert.equal(t('doctor.summaryOk'), 'Everything looks fine');
  assert.equal(t('doctor.tagWarn'), '[WARN]');
  assert.equal(t('cli.unknownFlag', { flag: 'nope' }), 'Warning: ignoring unknown option --nope (use --help to see available options)');
  for (const key of ['cli.usage', 'download.usage', 'check.usage', 'verify.usage', 'doctor.usage', 'pin.usage', 'list.usage', 'login.usage']) {
    assert.ok(!CJK.test(t(key)), `${key}: en 文案不应含中文`);
  }
  assert.ok(t('download.usage').includes('Webhook'));
  assert.ok(t('download.usage').includes('curl'));
  assert.ok(t('download.usage').includes('aria2'));
  assert.ok(t('check.usage').includes('SHA256'));
  assert.ok(t('runtime.hintSiteInterface').includes('trpcPath'));
  assert.ok(t('doctor.hintChromePath').includes('chromePath'));
  assert.ok(t('doctor.hintConfigFileMissing').includes('config.json'));
});

// ---------------------------------------------------------------------------
// Error hints
// 错误提示
// ---------------------------------------------------------------------------

const ZH_HINTS = [
  ['AuthError', 'MSG\n提示：请运行登录流程刷新会话（npm run login 或 TUI「登录 / 更新登录」）'],
  ['ChallengeError', 'MSG\n提示：请在浏览器窗口中完成人机验证后重试'],
  ['RateLimitError', 'MSG\n提示：站点限流，可稍后重试或调低 config.json 的 apiRateLimit'],
  ['SiteInterfaceError', 'MSG\n提示：站点接口可能已调整，可在 config.json 中覆盖 trpcPath / trpcInput'],
  ['NetworkError', 'MSG\n提示：检查网络/代理设置（config.json 的 proxy）'],
];

test('i18n-cli: describeError（zh-CN）对常见错误给出逐字一致的提示', () => {
  assert.equal(describeError(null), '未知错误');
  assert.equal(describeError(new errors.CancelError('MSG')), '已取消');
  assert.equal(describeError(new errors.ConfigError('MSG')), 'MSG');
  assert.equal(describeError(new errors.NotFoundError('MSG')), 'MSG');
  assert.equal(describeError(new errors.DownloadError('MSG')), 'MSG');
  assert.equal(describeError(new errors.StateCorruptError('MSG')), 'MSG');
  assert.equal(describeError(new errors.AppError('MSG')), 'MSG');
  assert.equal(describeError(new Error('boom')), 'boom');
  for (const [name, expected] of ZH_HINTS) {
    assert.equal(describeError(new errors[name]('MSG')), expected, `${name} 的提示应与旧版逐字一致`);
  }
});

test('i18n-cli: describeError（en）提示为英文、内容非空且不丢原始错误', () => {
  const cases = ['AuthError', 'ChallengeError', 'RateLimitError', 'SiteInterfaceError', 'NetworkError'];
  for (const name of cases) {
    const text = withLanguage('en', () => describeError(new errors[name]('MSG')));
    assert.ok(text.length > 0, `${name}: en 下不应为空`);
    assert.ok(text.startsWith('MSG\n'), `${name}: 原始错误信息应保留在最前`);
    assert.ok(text.includes('Tip:'), `${name}: en 下应给出 Tip 提示`);
    assert.ok(!CJK.test(text), `${name}: en 下不应残留中文`);
  }
  assert.equal(withLanguage('en', () => describeError(null)), 'Unknown error');
  assert.equal(withLanguage('en', () => describeError(new errors.CancelError('MSG'))), 'Cancelled');
  assert.equal(withLanguage('en', () => describeError(new errors.ConfigError('MSG'))), 'MSG');
});

test('i18n-cli: printConfigWarnings / handleFatal 走文案表', () => {
  const zhLines = captureOutput(() => printConfigWarnings({ warnings: ['未知键 foo'] }));
  assert.equal(zhLines, '配置提示: 未知键 foo');

  const enLines = withLanguage('en', () => captureOutput(() => printConfigWarnings({ warnings: ['unknown key foo'] })));
  assert.equal(enLines, 'Config notice: unknown key foo');

  const fatalZh = captureOutput(() => handleFatal(new errors.ConfigError('boom')));
  assert.equal(fatalZh, '错误: boom');

  const fatalEn = withLanguage('en', () => captureOutput(() => handleFatal(new errors.ConfigError('boom'))));
  assert.equal(fatalEn, 'Error: boom');
});

test('i18n-cli: 语言包状态在测试结束后恢复为默认语言', () => {
  assert.equal(i18n.getLanguage(), LANGUAGE_AT_LOAD, '本文件不应把语言状态泄漏出去');
  assert.deepEqual(i18n.missingKeys('en'), [], 'en 不允许缺翻');
  const cliKeys = Object.keys(zh).filter((k) => /^(cli|login|list|download|check|verify|doctor|pin|runtime)\./.test(k));
  assert.ok(cliKeys.length >= 100, `命令行层文案键数量偏少：${cliKeys.length}`);
  for (const key of cliKeys) {
    assert.ok(en[key] !== undefined && en[key].length > 0, `${key} 在 en 中必须非空`);
  }
});
