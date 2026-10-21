'use strict';

/**
 * TUI contract checks for the phased refactor.
 *
 * Rules that must become zero later are reported as TODO and listed in ALLOWLIST, while rules that
 * are already true fail the script immediately. This keeps CI useful today without blocking the
 * migration on a big-bang cleanup.
 *
 *
 * 分阶段重构期间的 TUI 契约检查。
 *
 * 目标为零的规则以 TODO 报告并列入 ALLOWLIST，已经成立的规则则直接让脚本失败。
 * 这样 CI 今天就有用，又不会要求一次性大清理。
 */

const fs = require('fs');
const path = require('path');

const ROOT = path.resolve(__dirname, '..');
const TUI_ROOT = path.join(ROOT, 'src', 'tui');

/**
 * Known violations that a later phase removes. Keys are rule ids; values are repo-relative paths.
 * 后续阶段要清除的已知违规。键是规则 id，值是仓库相对路径。
 */
const ALLOWLIST = {};

const RULES = [
  {
    id: 'terminal-write',
    title: 'flows must not own the terminal',
    titleZh: '流程不得直接接管终端',
    files: 'flows',
    pattern: /process\.stdout\.write|process\.stdin\.setRawMode|\.setRawMode\s*\(|require\(\s*['"]readline['"]\s*\)|console\.(?:log|error|warn)/,
  },
  {
    id: 'shell-internals',
    title: 'flows must not call shell lifecycle or private geometry',
    titleZh: '流程不得调用外壳生命周期或私有几何',
    files: 'flows',
    pattern: /screen\.(?:start|stop|bodyGeometry|resetState|render)\s*\(|layout\.(?:chromeRows|listRows)\s*\(/,
  },
  {
    id: 'date-slice',
    title: 'dates must go through the shared formatter',
    titleZh: '日期必须经过共享格式化器',
    files: 'flows',
    pattern: /\.slice\(\s*0\s*,\s*(?:10|16|19)\s*\)/,
  },
  {
    id: 'literal-glyph',
    title: 'display glyphs must come from layout.glyphs',
    titleZh: '展示字符必须来自 layout.glyphs',
    files: 'flows',
    pattern: /'·'|'!'|'--'/,
  },
  {
    id: 'direct-color',
    title: 'flows must use semantic color tokens',
    titleZh: '流程必须使用语义颜色令牌',
    files: 'flows',
    pattern: /\bcolors\.(?:bold|dim|red|green|yellow|blue|magenta|cyan|reverse)\b/,
  },
  {
    id: 'dead-palette',
    title: 'unused palette entries must stay removed',
    titleZh: '未使用的调色板项必须保持移除',
    files: 'tui',
    pattern: /\bcolors\.(?:blue|magenta)\b/,
  },
  {
    id: 'task-schema',
    title: 'the shell must not know download task fields',
    titleZh: '外壳不得了解下载任务字段',
    files: 'screen',
    pattern: /\b(?:metaFailed|logFile|attempts|failures)\b/,
  },
];

/**
 * Collect every JavaScript file under a directory.
 * 收集某个目录下的所有 JavaScript 文件。
 *
 * @param {string} dir
 * @returns {string[]}
 */
function walk(dir) {
  const out = [];
  let entries;
  try {
    entries = fs.readdirSync(dir, { withFileTypes: true });
  } catch (e) {
    return out;
  }
  for (const entry of entries) {
    const full = path.join(dir, entry.name);
    if (entry.isDirectory()) out.push(...walk(full));
    else if (entry.isFile() && entry.name.endsWith('.js')) out.push(full);
  }
  return out;
}

/**
 * Resolve the files a rule applies to.
 * 解析一条规则适用的文件。
 *
 * @param {'flows'|'tui'|'screen'} scope
 * @returns {string[]}
 */
function filesFor(scope) {
  if (scope === 'screen') return [path.join(TUI_ROOT, 'shell', 'screen.js')];
  if (scope === 'tui') return walk(TUI_ROOT);
  const flowsDir = path.join(TUI_ROOT, 'flows');
  // app.js owns the plain-mode entry and prints there; the remaining flows are shell-only.
  // app.js 负责简易模式入口并直接打印；其余流程只服务外壳。
  return walk(flowsDir).filter((file) => path.basename(file) !== 'app.js');
}

/**
 * Repo-relative path with forward slashes.
 * 仓库相对路径，使用正斜杠。
 *
 * @param {string} file
 * @returns {string}
 */
function relative(file) {
  return path.relative(ROOT, file).replace(/\\/g, '/');
}

/**
 * Whether a source line is a comment and should not be treated as code.
 * 判断源码行是否为注释，注释不应被当成代码。
 *
 * @param {string} line
 * @returns {boolean}
 */
function isCommentLine(line) {
  const trimmed = line.trim();
  return trimmed.startsWith('//') || trimmed.startsWith('/*') || trimmed.startsWith('*');
}

/**
 * Find every match of one rule.
 * 找出某条规则的全部匹配。
 *
 * @param {string[]} files
 * @param {RegExp} pattern
 * @returns {Array<{file:string, line:number, text:string}>}
 */
function scan(files, pattern) {
  const matches = [];
  for (const file of files) {
    const source = fs.readFileSync(file, 'utf8');
    source.split(/\r?\n/).forEach((line, index) => {
      if (isCommentLine(line)) return;
      if (pattern.test(line)) {
        matches.push({ file: relative(file), line: index + 1, text: line.trim() });
      }
      pattern.lastIndex = 0;
    });
  }
  return matches;
}

/**
 * Check that every `tui.hint.*` value is one non-empty line in both languages.
 * 检查两种语言里的每个 `tui.hint.*` 都是非空单行。
 *
 * @returns {Array<{key:string, problem:string}>}
 */
function checkHints() {
  const zh = require(path.join(ROOT, 'src', 'i18n', 'zh-CN'));
  const en = require(path.join(ROOT, 'src', 'i18n', 'en'));
  const problems = [];
  const zhKeys = Object.keys(zh).filter((key) => key.startsWith('tui.hint.')).sort();
  const enKeys = Object.keys(en).filter((key) => key.startsWith('tui.hint.')).sort();

  for (const key of new Set([...zhKeys, ...enKeys])) {
    if (!zhKeys.includes(key)) problems.push({ key, problem: 'missing in zh-CN' });
    if (!enKeys.includes(key)) problems.push({ key, problem: 'missing in en' });
    for (const [language, catalog] of [
      ['zh-CN', zh],
      ['en', en],
    ]) {
      if (!Object.prototype.hasOwnProperty.call(catalog, key)) continue;
      const value = catalog[key];
      if (typeof value !== 'string' || !value.trim()) {
        problems.push({ key, problem: `empty or non-string in ${language}` });
        continue;
      }
      if (value.includes('\n')) problems.push({ key, problem: `multi-line in ${language}` });
    }
  }
  return problems;
}

function main() {
  const verbose = process.argv.includes('--verbose');
  let failures = 0;
  let todos = 0;
  const usedAllowlist = new Set();
  const flowFiles = filesFor('flows');

  console.log('TUI contract check / TUI 契约检查');
  console.log(`Flow files: ${flowFiles.length} / 流程文件：${flowFiles.length}`);
  console.log('');

  for (const rule of RULES) {
    const matches = scan(filesFor(rule.files), rule.pattern);
    const allowedFiles = new Set(ALLOWLIST[rule.id] || []);
    const allowed = matches.filter((match) => allowedFiles.has(match.file));
    const unexpected = matches.filter((match) => !allowedFiles.has(match.file));

    for (const match of allowed) usedAllowlist.add(`${rule.id}|${match.file}`);

    if (unexpected.length) {
      failures += unexpected.length;
      console.log(`[FAIL] ${rule.id}: ${rule.title} / ${rule.titleZh}`);
      for (const match of unexpected) {
        console.log(`  ${match.file}:${match.line}  ${match.text.slice(0, 120)}`);
      }
    } else if (allowed.length) {
      todos += allowed.length;
      const files = [...new Set(allowed.map((match) => match.file))].join(', ');
      console.log(`[TODO] ${rule.id}: ${allowed.length} allowlisted violation(s) / 已列入白名单：${files}`);
      if (verbose) {
        for (const match of allowed) console.log(`  ${match.file}:${match.line}  ${match.text.slice(0, 120)}`);
      }
    } else {
      console.log(`[ OK ] ${rule.id}`);
    }
  }

  const hintProblems = checkHints();
  if (hintProblems.length) {
    failures += hintProblems.length;
    console.log('[FAIL] hint-shape: every tui.hint.* must be one non-empty line / 每个 tui.hint.* 必须是非空单行');
    for (const problem of hintProblems) console.log(`  ${problem.key}: ${problem.problem}`);
  } else {
    console.log('[ OK ] hint-shape');
  }

  for (const [rule, files] of Object.entries(ALLOWLIST)) {
    for (const file of files) {
      if (!usedAllowlist.has(`${rule}|${file}`)) {
        console.log(`[NOTE] allowlist entry no longer needed: ${rule} -> ${file} / 白名单项已不再需要`);
      }
    }
  }

  console.log('');
  console.log(`Summary: ${failures} failure(s), ${todos} allowlisted violation(s) / 汇总：${failures} 处失败，${todos} 处白名单违规`);
  if (failures) process.exitCode = 1;
}

main();

module.exports = {
  ALLOWLIST,
  RULES,
  scan,
  checkHints,
  filesFor,
};
