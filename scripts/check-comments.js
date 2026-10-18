'use strict';

// Bilingual comment checker.
//
// Rules enforced (see README "Code Comments"):
//  1. every standalone comment block must contain both English and Chinese text;
//  2. English comes first, Chinese after;
//  3. blank comment lines between the two languages:
//       - single-line pair (1 line each)              → 0 blank lines
//       - single-block multi-line (a paragraph each)  → 1 blank line
//       - multi-section (either side has 2+ sections) → 2 blank lines
//  4. sections within the same language are separated by exactly 1 blank line;
//  5. trailing comments (`code; // ...`) must be bilingual on that single line.
//
// Usage: node scripts/check-comments.js [--json] [--only <path>]
//
//
// 双语注释规范检查器。
//
// 规则（见 README 的「Code Comments」）：
//  1. 每个独立注释块都必须同时包含英文与中文；
//  2. 英文在前、中文在后；
//  3. 两种语言之间的空注释行：
//       - 单行对照（各 1 行）      → 0 行空行
//       - 单段多行（各一段）        → 1 行空行
//       - 多段（任一侧 2 段以上）    → 2 行空行
//  4. 同一语言内的段落之间必须恰好 1 行空行；
//  5. 行尾注释（`code; // ...`）必须在该行内中英双语。
//
// 用法：node scripts/check-comments.js [--json] [--only <路径>]

const fs = require('fs');
const path = require('path');

const ROOT = path.resolve(__dirname, '..');
const SCAN_DIRS = ['src', 'tests', 'scripts'];
const SCAN_FILES = ['cli.js', 'ui.js', 'web.js'];

// Translation tables are data files whose banner comments are structural; skip them.
// 文案表是数据文件，里面的分节注释属于结构标记，跳过检查。
const EXEMPT = new Set(['src/i18n/zh-CN.js', 'src/i18n/en.js']);
const SKIP_DIRS = new Set(['node_modules', '.git', '.data', 'downloads']);

const CJK = /[\u3400-\u4dbf\u4e00-\u9fff\uf900-\ufaff]/;
const ASCII_WORD = /[A-Za-z]{2,}/;

/**
 * JSDoc tags whose body may span several lines (`@param {{` … `}} opts`). Everything after such a
 * line belongs to the tag until the next tag or a blank line, so the type body is not mistaken for
 * user-facing text that has to be bilingual.
 *
 * JSDoc 标签，其内容可能跨多行（`@param {{` … `}} opts`）。这类行之后的内容在遇到下一个标签或空行前
 * 都属于该标签，避免把类型体当成必须双语的正文。
 */
const TAG_START = /^@(param|returns?|see|example|throws|type|typedef|property|deprecated|template)\b/;
const TAG_LINE = /^@[A-Za-z]/;

// Collect every .js file under the scan roots, skipping heavy generated folders.
// 收集扫描根下的所有 .js 文件，跳过体积大的生成目录。
function walk(dir, out) {
  let entries;
  try {
    entries = fs.readdirSync(dir, { withFileTypes: true });
  } catch (e) {
    return;
  }
  for (const entry of entries) {
    if (SKIP_DIRS.has(entry.name)) continue;
    const full = path.join(dir, entry.name);
    if (entry.isDirectory()) walk(full, out);
    else if (entry.isFile() && entry.name.endsWith('.js')) out.push(full);
  }
}

// Build the file list (relative paths, exemption applied).
// 生成待检查文件清单（相对路径，已应用豁免）。
function collectFiles() {
  const files = [];
  const seen = new Set();
  const add = (abs) => {
    const rel = path.relative(ROOT, abs).replace(/\\/g, '/');
    if (seen.has(rel) || EXEMPT.has(rel)) return;
    seen.add(rel);
    files.push({ abs, rel });
  };
  for (const dir of SCAN_DIRS) {
    const found = [];
    walk(path.join(ROOT, dir), found);
    for (const abs of found) add(abs);
  }
  for (const name of SCAN_FILES) add(path.join(ROOT, name));
  return files.sort((a, b) => a.rel.localeCompare(b.rel));
}

// Classify a piece of text: containing CJK means Chinese.
// 判断一段文字的语言：含中日韩字符即视为中文。
function langOf(text) {
  return CJK.test(text) ? 'zh' : 'en';
}

// Line kind: blank / tag (`@param`, `@returns`) / symbol-only / text.
// 行类型：空行 / 标签行（`@param`、`@returns`）/ 纯符号 / 正文。
function lineKind(text) {
  const trimmed = text.trim();
  if (!trimmed) return 'blank';
  if (TAG_LINE.test(trimmed)) return 'tag';
  if (!ASCII_WORD.test(trimmed) && !CJK.test(trimmed)) return 'symbol';
  return 'text';
}

/**
 * Classify every line of a block, keeping multi-line tag bodies out of the text lines.
 * 判定注释块里每一行的类型，并把跨行标签的内容排除在正文之外。
 */
function classifyLines(lines) {
  const out = [];
  let inTag = false;
  for (const item of lines) {
    const kind = lineKind(item.text);
    if (kind === 'blank') inTag = false;
    else if (kind === 'tag') inTag = true;
    else if (inTag) {
      out.push({ ...item, kind: 'tag' });
      continue;
    }
    out.push({ ...item, kind });
  }
  return out;
}

// Strip the comment markers (`//`, `/*`, leading `*`) and trailing spaces.
// 去掉注释标记（`//`、`/*`、行首 `*`）与行尾空格。
function stripBlock(lines, style) {
  return lines.map((raw) => {
    let text = raw;
    if (style === 'line') {
      text = text.replace(/^\s*\/\/+/, '');
    } else {
      text = text
        .replace(/^\s*\/\*\*?/, '')
        .replace(/\*\/\s*$/, '')
        .replace(/^\s*\*\s?/, '');
    }
    return text.replace(/\s+$/, '');
  });
}

// Validate one comment block against the rules above.
// 按上面的规则校验一个注释块。
function checkBlock(block) {
  const problems = [];
  const kept = [];
  for (const item of classifyLines(block.lines)) {
    if (item.kind === 'tag' || item.kind === 'symbol') continue;
    kept.push(item);
  }
  const textLines = kept.filter((l) => l.kind === 'text');
  // Pure separator lines (`// ----`) are exempt.
  // 纯符号分隔线（`// ----`）不参与校验。
  if (!textLines.length) return problems;
  if (process.env.DEBUG_COMMENTS) {
    console.log(
      `  [block @${block.startLine}] ` +
        textLines.map((l) => `${l.line}:${langOf(l.text)}:${JSON.stringify(l.text.slice(0, 30))}`).join(' | ')
    );
  }

  // Group consecutive lines of the same language into runs.
  // 把同一语言且行号连续的行合并成 run。
  const runs = [];
  for (const line of textLines) {
    const lang = langOf(line.text);
    const prev = runs[runs.length - 1];
    if (prev && prev.lang === lang && line.line === prev.endLine + 1) {
      prev.endLine = line.line;
      prev.count++;
      prev.lines.push(line.text);
    } else {
      runs.push({ lang, startLine: line.line, endLine: line.line, count: 1, lines: [line.text] });
    }
  }

  const hasEn = runs.some((r) => r.lang === 'en');
  const hasZh = runs.some((r) => r.lang === 'zh');
  if (!hasEn || !hasZh) {
    return [
      {
        line: block.startLine,
        reason: hasEn ? 'missing-chinese' : 'missing-english',
        snippet: (runs[0] && runs[0].lines[0]) || '',
      },
    ];
  }

  const enRuns = runs.filter((r) => r.lang === 'en');
  const zhRuns = runs.filter((r) => r.lang === 'zh');
  const idxFirstZh = runs.indexOf(zhRuns[0]);
  const idxLastEn = runs.lastIndexOf(enRuns[enRuns.length - 1]);
  // English must come before Chinese.
  // 顺序：英文必须在中文之前。
  if (idxFirstZh < idxLastEn) {
    problems.push({ line: block.startLine, reason: 'order', snippet: runs[0].lines[0] });
    return problems;
  }

  // Blank lines between adjacent runs.
  // 相邻 run 之间的空行数。
  for (let i = 0; i < runs.length - 1; i++) {
    const a = runs[i];
    const b = runs[i + 1];
    const blanks = b.startLine - a.endLine - 1;
    if (a.lang === b.lang) {
      if (blanks !== 1) {
        problems.push({
          line: b.startLine,
          reason: `same-language-separator(${blanks}, expected 1)`,
          snippet: b.lines[0],
        });
      }
      continue;
    }
    const multiSection = enRuns.length > 1 || zhRuns.length > 1;
    const expected = multiSection ? 2 : a.count > 1 || b.count > 1 ? 1 : 0;
    if (blanks !== expected) {
      problems.push({
        line: b.startLine,
        reason: `cross-language-separator(${blanks}, expected ${expected})`,
        snippet: b.lines[0],
      });
    }
  }
  return problems;
}

// Match a trailing comment: `//` must be preceded by whitespace so that URLs (`https://`)
// and regex literals (`/\*\//`) are not mistaken for comments.
//
// 匹配行尾注释：`//` 前必须是空白，避免把 URL（`https://`）与正则字面量（`/\*\//`）误判成注释。
const TRAILING = /(^|\s)\/\/(.*)$/;

// Check one file and return its problems.
// 检查一个文件并返回问题列表。
function checkFile(file) {
  const source = fs.readFileSync(file.abs, 'utf8');
  const lines = source.split(/\r?\n/);
  const problems = [];
  let i = 0;
  while (i < lines.length) {
    const line = lines[i];
    const trimmed = line.trim();

    // Block comment /* ... */
    // 块注释 /* ... */
    if (trimmed.startsWith('/*')) {
      const start = i;
      // The opening line is taken without asking: a leading `* @param` line right above means the
      // block was already consumed as the `/**` block before it.
      //
      // 起始行无条件收下：上方若紧邻 `* @param`，说明那个块已经作为 `/**` 块处理过了。
      const raw = [lines[i]];
      let closed = /^\s*\/\*.*\*\/\s*$/.test(lines[i]);
      i++;
      while (!closed && i < lines.length) {
        const current = lines[i];
        // Only a line whose content is just the closer ends the block: JSDoc prose may contain `*/`
        // inside a line, and that must not be mistaken for the end of the block.
        //
        // 只有「整行就是结束符」才算块结束：JSDoc 正文里可能在一行中间出现 `*/`，不能据此提前收尾。
        if (/^\s*\*\/\s*$/.test(current)) {
          raw.push(current);
          closed = true;
          i++;
          break;
        }
        // A line that is neither `* …` nor the closer means the block is over: a bare `* @param`
        // belongs to the `/**` above, which was already consumed as its own block. Stopping here also
        // keeps the code below a JSDoc block from being read as comment content.
        //
        // 既不是 `* …` 也不是结束符的行说明本块到此为止：单独一行的 `* @param` 属于上方那个
        // 已被处理过的 `/**`；在此停下也能避免把 JSDoc 下面的代码当成注释内容。
        if (!/^\s*\*/.test(current)) break;
        raw.push(current);
        i++;
      }
      if (!closed) continue;
      const stripped = stripBlock(raw, 'block').map((text, k) => ({ text, line: start + 1 + k }));
      problems.push(...checkBlock({ startLine: start + 1, lines: stripped }));
      continue;
    }

    // Standalone // comment block
    // 独立行注释块 //
    if (trimmed.startsWith('//')) {
      const start = i;
      const raw = [];
      while (i < lines.length && lines[i].trim().startsWith('//')) {
        raw.push(lines[i]);
        i++;
      }
      const stripped = stripBlock(raw, 'line').map((text, k) => ({ text, line: start + 1 + k }));
      problems.push(...checkBlock({ startLine: start + 1, lines: stripped }));
      continue;
    }

    // Trailing comment on a code line: code; // ...
    // 代码行上的行尾注释：code; // ...
    const trailing = TRAILING.exec(line);
    if (trailing) {
      const text = trailing[2].trim();
      if (text) {
        const kind = lineKind(text);
        if (kind === 'text' && !(CJK.test(text) && ASCII_WORD.test(text))) {
          problems.push({ line: i + 1, reason: 'trailing-not-bilingual', snippet: text });
        }
      }
    }
    i++;
  }
  return problems;
}

// CLI entry: print a report and exit non-zero when violations exist.
// 命令行入口：输出报告，存在问题时以非零码退出。
function main() {
  const json = process.argv.includes('--json');
  const onlyIdx = process.argv.indexOf('--only');
  const only = onlyIdx !== -1 ? String(process.argv[onlyIdx + 1] || '').replace(/\\/g, '/') : null;
  let files = collectFiles();
  if (only) files = files.filter((f) => f.rel === only || f.rel.startsWith(`${only}/`));
  if (!files.length) {
    console.error(`没有匹配的文件：--only ${only} / no file matched`);
    process.exitCode = 1;
    return;
  }
  const report = [];
  let total = 0;
  for (const file of files) {
    const problems = checkFile(file);
    if (!problems.length) continue;
    total += problems.length;
    report.push({ file: file.rel, problems });
  }

  if (json) {
    console.log(JSON.stringify({ files: files.length, violations: total, report }, null, 2));
  } else {
    for (const entry of report) {
      console.log(`\n${entry.file}  (${entry.problems.length})`);
      for (const p of entry.problems.slice(0, 8)) {
        console.log(`  L${p.line}  ${p.reason}  | ${String(p.snippet).slice(0, 90)}`);
      }
      if (entry.problems.length > 8) console.log(`  … 还有 ${entry.problems.length - 8} 处`);
    }
    console.log(
      `\n${report.length} 个文件存在 ${total} 处注释规范问题（共检查 ${files.length} 个文件）/ ` +
        `${total} comment issues in ${report.length} of ${files.length} files`
    );
  }
  if (total) process.exitCode = 1;
}

module.exports = {
  collectFiles,
  checkFile,
  checkBlock,
  classifyLines,
  lineKind,
  langOf,
  stripBlock,
  ROOT,
};

if (require.main === module) main();
