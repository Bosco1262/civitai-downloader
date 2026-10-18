'use strict';

/**
 * Shared interaction primitives of the TUI: menus, confirmations, the help page, the pager and the
 * list pickers.
 *
 * Why a module: every flow used to hand-build its own `prompts` calls, so key hints, cancel
 * semantics and pickers drifted apart (some flows answered Esc with the initial value, some
 * pickers were plain two-line prompts). All flows now go through here:
 *
 *  - `promptMenu` / `promptConfirm` / `promptText` add a consistent key hint and one cancel rule:
 *    Esc always returns null, so a caller can tell "cancelled" from a real answer;
 *  - `pickOne` / `pickMany` use the full-screen picker under a TTY and fall back to the plain
 *    prompts list without one (CI, redirection, dumb terminals);
 *  - `showHelp` renders the key reference, which is reachable from the main menu and from inside
 *    the picker;
 *  - `describeFacts` renders the "field: value" block used by the detail pages.
 *
 *
 * TUI 的公共交互基元：菜单、确认框、帮助页、分页器与列表选择器。
 *
 * 独立成模块的原因：此前每个流程各自拼 `prompts` 调用，按键提示、取消语义与选择器风格
 * 逐渐分裂（有的流程里 Esc 会返回初始值，有的选择器只是两行提示）。现在统一走这里：
 *
 *  - `promptMenu` / `promptConfirm` / `promptText` 统一补上按键提示，并统一取消规则：
 *    Esc 一定返回 null，调用方据此区分「取消」与「真实答案」；
 *  - `pickOne` / `pickMany` 在 TTY 下用全屏选择器，非 TTY 回退到 prompts 列表
 *    （CI、重定向、哑终端）；
 *  - `showHelp` 渲染按键速查，主菜单与选择器内部都能打开；
 *  - `describeFacts` 渲染详情页的「字段: 值」区块。
 */

const fs = require('fs');
const { t } = require('../i18n');
const view = require('./view');
const { displayWidth } = view;
const { selectItems, isInteractive } = require('./select');
const { installRawKeys } = require('./keys');

/**
 * Resolve the prompts module on first use instead of at load time.
 *
 * The flows of this module are the only place where the TUI asks questions, so keeping the lookup
 * late means a test (or an embedder) can replace `prompts` with a scripted stub without caring about
 * module load order.
 *
 *
 * 第一次使用时才解析 prompts 模块，而不是在加载时解析。
 *
 * 本模块的流程是 TUI 里唯一提问的地方，延迟解析意味着测试（或嵌入方）可以
 * 用脚本化替身替换 `prompts`，而不必关心模块加载顺序。
 */
function promptLib() {
  return require('prompts');
}

/**
 * Lazily resolved key-hint lines (the language may change after this module is loaded).
 * 惰性取词的按键提示行（语言可能在本模块加载之后切换）。
 */
const HINT_KEYS = ['tui.pages.hintMove', 'tui.pages.hintCancel'];

function hintLines() {
  return HINT_KEYS.map((key) => t(key));
}

/**
 * One-line key hint appended to every prompt message: how to move/confirm and how to cancel.
 * 追加在每个提示语后面的一行按键说明：如何移动/确认、如何取消。
 */
function hint() {
  return view.colors.dim(`\n${hintLines().join(view.separator())}`);
}

/**
 * Version of the package, read once (shown on the help page).
 * 包版本，只读一次（帮助页显示用）。
 */
let cachedVersion = null;
function packageVersion() {
  if (cachedVersion !== null) return cachedVersion;
  try {
    const pkg = JSON.parse(fs.readFileSync(require('path').join(__dirname, '..', '..', 'package.json'), 'utf8'));
    cachedVersion = String(pkg.version || '');
  } catch (e) {
    cachedVersion = '';
  }
  return cachedVersion;
}

// ---------------------------------------------------------------------------
// Prompts wrappers
// 提示封装
// ---------------------------------------------------------------------------

/**
 * Read the answer of a prompt.
 *
 * Normally the answer object only carries the requested field (`value` for a menu, `ok` for a
 * confirmation). The extra field names keep scripted/legacy answers working, where the caller
 * supplied a flow-specific key such as `action` or `modelId`.
 *
 *
 * 读取一次提问的答案。
 *
 * 正常情况下答案对象只有一个字段（菜单是 `value`，确认是 `ok`）。
 * 额外接受若干个旧字段名，便于脚本化/历史答案继续可用（例如 `action`、`modelId`）。
 *
 * @returns {{found:boolean, value:any}}
 */
function answerValue(ans, names) {
  if (!ans || typeof ans !== 'object') return { found: false, value: undefined };
  for (const name of names) {
    if (Object.prototype.hasOwnProperty.call(ans, name)) return { found: true, value: ans[name] };
  }
  return { found: false, value: undefined };
}

/**
 * Normalize the answer of a list prompt into a plain id.
 *
 * A real prompt answers with the short id; scripted or legacy answers sometimes hand back the whole
 * row (`{modelId: …}`), which callers should not have to unwrap themselves.
 *
 *
 * 把列表提问的答案归一化成裸 ID。
 *
 * 真实提问返回的是短 ID；脚本化或历史答案有时会直接给出整行（`{modelId: …}`），
 * 调用方不应该自己拆包。
 */
function answerId(value) {
  if (value && typeof value === 'object') {
    for (const key of ['modelId', 'id', 'versionId', 'value', 'key']) {
      if (value[key] !== undefined && value[key] !== null) return String(value[key]);
    }
    return '';
  }
  return value === undefined || value === null ? '' : String(value);
}

/**
 * Single-choice menu.
 *
 * Returns the chosen value, or null when the user cancelled (Esc / Ctrl+C) — never the initial
 * value, so an accidental Esc can no longer be mistaken for a choice.
 *
 *
 * 单选菜单。
 *
 * 返回选中的值；用户取消（Esc / Ctrl+C）时返回 null，绝不会返回初始值，
 * 因此误按 Esc 不会再被当成一次选择。
 *
 * @param {string} message
 * @param {Array<{title:string, value:any, description?:string}>} choices
 * @param {{initial?:number, hint?:boolean, name?:string}} [options]
 * @returns {Promise<any|null>}
 */
async function promptMenu(message, choices, options = {}) {
  const name = options.name || 'value';
  const ans = await promptLib()({
    type: 'select',
    name,
    message: options.hint === false ? message : `${message}${hint()}`,
    choices,
    initial: Number.isFinite(options.initial) ? options.initial : 0,
  });
  const answer = answerValue(
    ans,
    [name].concat(['value', 'action', 'id', 'mode', 'scope', 'modelId', 'versionId', 'deep', 'type', 'base'])
  );
  return answer.found ? answer.value : null;
}

/**
 * Yes/no confirmation. Returns true / false, or null when the user cancelled.
 *
 * `danger` marks a destructive default: the highlighted answer becomes "no" so that a bare Enter
 * cannot delete files.
 *
 *
 * 是/否确认。返回 true / false；用户取消时返回 null。
 *
 * `danger` 用于有破坏性的默认值：高亮项变成「否」，避免直接回车就删文件。
 *
 * @param {string} message
 * @param {{initial?:boolean, danger?:boolean}} [options]
 * @returns {Promise<boolean|null>}
 */
async function promptConfirm(message, options = {}) {
  const initial = options.initial === undefined ? !options.danger : !!options.initial;
  const ans = await promptLib()({
    type: 'confirm',
    name: 'ok',
    message: `${options.danger ? view.colors.yellow(message) : message}${hint()}`,
    initial,
  });
  const answer = answerValue(ans, ['ok', 'value', 'confirm', 'go', 'force', 'deep', 'files', 'open', 'pin']);
  return answer.found ? !!answer.value : null;
}

/**
 * Text input with a validator. Returns the trimmed string, or null when cancelled.
 * 文本输入（带校验）。返回去掉首尾空白后的字符串；取消时返回 null。
 */
async function promptText(message, options = {}) {
  const ans = await promptLib()({
    type: 'text',
    name: 'text',
    message: options.hint === false ? message : `${message}${hint()}`,
    initial: options.initial,
    validate: options.validate,
  });
  const answer = answerValue(ans, ['text', 'value', 'kw', 'dir', 'id', 'refs', 'ids']);
  if (!answer.found) return null;
  const value = String(answer.value);
  return options.trim === false ? value : value.trim();
}

/**
 * Output directory prompt, shared by every download flow.
 * 输出目录提示，各下载流程共用。
 *
 * @returns {Promise<string|null>} raw text (the caller resolves it against config.root)
 */
async function promptOutDir(config, current) {
  return promptText(t('tui.download.outDirPrompt', { root: config.root }), {
    initial: current || config.outDir,
    validate: (v) => (String(v).trim() ? true : t('tui.download.notEmpty')),
  });
}

// ---------------------------------------------------------------------------
// List pickers
// 列表选择器
// ---------------------------------------------------------------------------

/**
 * Whether the interactive picker can be used (TTY + an explicit opt-out via CIVITAI_PLAIN=1).
 * 是否可以使用交互式选择器（需要 TTY；可用 CIVITAI_PLAIN=1 显式关闭）。
 */
function canPick() {
  return !process.env.CIVITAI_PLAIN && isInteractive();
}

/**
 * Run a slow task while telling the user it is still running.
 *
 * Launcher or network phases can take tens of seconds with nothing to print, which looks exactly
 * like a frozen TUI. This prints the phase once, then a "still waiting (Ns)" line every interval so
 * the screen keeps moving and the user knows Ctrl+C is the way out.
 *
 *
 * 执行耗时任务时告诉用户「还在动」。
 *
 * 启动浏览器、等网络这类阶段可能几十秒没有任何输出，看起来就像界面卡死。
 * 这里先打印一次阶段说明，之后每隔一段时间补一行「仍在等待（Ns）」，
 * 让屏幕保持有变化，也提示用户按 Ctrl+C 可以退出。
 *
 * @param {string} message already translated phase description
 * @param {() => Promise<any>} fn
 * @param {{intervalMs?:number, onTick?:(seconds:number)=>void}} [opts]
 */
async function withSpinner(message, fn, opts = {}) {
  const started = Date.now();
  const intervalMs = Math.max(1000, Number(opts.intervalMs) || 15000);
  const tick =
    typeof opts.onTick === 'function'
      ? opts.onTick
      : () => console.log(view.colors.dim(`  ${t('tui.pages.stillWorking', { seconds: elapsedSeconds(started) })}`));

  console.log(view.colors.dim(`  ${message}`));
  const timer = setInterval(() => {
    try {
      tick();
    } catch (e) {
      // A broken progress hint must never break the task itself.
      // 进度提示出错不能影响任务本身。
    }
  }, intervalMs);
  if (typeof timer.unref === 'function') timer.unref();
  try {
    return await fn();
  } finally {
    clearInterval(timer);
  }
}

/**
 * Whole seconds elapsed since `startedAt`.
 * 自 `startedAt` 起经过的整秒数。
 */
function elapsedSeconds(startedAt) {
  return Math.max(0, Math.round((Date.now() - Number(startedAt || 0)) / 1000));
}

/**
 * Identifier of one picker row: `modelId` when present, otherwise the row index as a string.
 * Custom rows (they carry `idOf`) win over both.
 *
 * 选择器某一行的标识：优先 `modelId`，没有就用行下标（字符串）。
 * 自带 `idOf` 的自定义行优先。
 */
function rowId(item, index, opts = {}) {
  if (typeof opts.idOf === 'function') return String(opts.idOf(item, index));
  if (item && item.modelId !== undefined && item.modelId !== null) return String(item.modelId);
  return String(index);
}

/**
 * Pick exactly one item from a list. The full-screen picker is used under a TTY; otherwise the plain
 * prompts list keeps CI and redirected runs working. Both paths answer with the item itself, so
 * callers never see a half-answered state.
 *
 * 从列表中单选一项。TTY 下使用全屏选择器；否则用 prompts 列表，保证 CI 与重定向场景仍可用。
 * 两条路径都返回条目本身，调用方不会拿到半成品答案。
 *
 * @param {Array<object>} items
 * @param {{
 *   message:string, title?:string, describe?:(item:object, state:any)=>string, state?:any,
 *   label?:(item:object)=>string, idOf?:(item:object, index:number)=>string,
 *   initialCursor?:number, onLog?:(msg:string)=>void, onEnter?:() => void,
 *   decidedMessage?:string, decidedParams?:(item:object)=>Record<string, any>
 * }} opts
 * @returns {Promise<object|null>} the chosen item, or null when cancelled
 */
async function pickOne(items, opts = {}) {
  const list = Array.isArray(items) ? items.filter(Boolean) : [];
  if (!list.length) return null;
  const onLog = typeof opts.onLog === 'function' ? opts.onLog : view.log;
  const label = typeof opts.label === 'function' ? opts.label : (item) => String(item.name || '');
  const ids = list.map((item, index) => rowId(item, index, opts));

  if (canPick()) {
    const answer = await selectItems(list, {
      mode: 'single',
      title: opts.title || opts.message,
      describe: opts.describe,
      state: opts.state,
      label,
      initialCursor: Number.isFinite(opts.initialCursor) ? opts.initialCursor : 0,
      onLog,
      onEnter: opts.onEnter,
      minHeight: 6,
    });
    if (!answer || !answer.selected.size) {
      view.decision('tui.view.decisionCancelled');
      return null;
    }
    const wanted = String([...answer.selected][0]);
    const chosen = list[ids.indexOf(wanted)] || null;
    const decidedParams = typeof opts.decidedParams === 'function' ? opts.decidedParams(chosen) : null;
    view.decision(opts.decidedMessage || 'tui.view.decisionSelected', {
      name: chosen ? label(chosen) : wanted,
      ...(decidedParams || {}),
    });
    return chosen;
  }

  const ans = await promptLib()({
    type: 'select',
    name: 'value',
    message: `${opts.message}${hint()}`,
    choices: list.map((item, index) => ({
      title: label(item),
      value: ids[index],
      description: typeof opts.describe === 'function' ? opts.describe(item, opts.state) : undefined,
    })),
    initial: Number.isFinite(opts.initialCursor) ? opts.initialCursor : 0,
  });
  const answer = answerValue(ans, ['value', 'modelId', 'id', 'versionId', 'action', 'mode']);
  if (!answer.found) return null;
  return list[ids.indexOf(answerId(answer.value))] || null;
}

/**
 * Pick any number of items from a list (an empty selection is allowed).
 * 从列表中多选若干项（允许一个都不选）。
 *
 * @param {Array<object>} items
 * @param {{
 *   message:string, title?:string, describe?:(item:object, state:any)=>string, state?:any,
 *   label?:(item:object)=>string, initialSelected?:Iterable<string|number>,
 *   onLog?:(msg:string)=>void, onEnter?:() => void
 * }} opts
 * @returns {Promise<Array<object>|null>} the chosen items (possibly empty), or null when cancelled
 */
async function pickMany(items, opts = {}) {
  const list = Array.isArray(items) ? items.filter(Boolean) : [];
  if (!list.length) return [];
  const onLog = typeof opts.onLog === 'function' ? opts.onLog : view.log;
  const label = typeof opts.label === 'function' ? opts.label : (item) => String(item.name || '');
  const ids = list.map((item, index) => rowId(item, index, opts));
  const initial = new Set(Array.from(opts.initialSelected || [], (v) => String(v)));

  if (canPick()) {
    const answer = await selectItems(list, {
      mode: 'multi',
      title: opts.title || opts.message,
      describe: opts.describe,
      state: opts.state,
      label,
      initialSelected: initial,
      onLog,
      onEnter: opts.onEnter,
      minHeight: 6,
    });
    if (!answer) {
      view.decision('tui.view.decisionCancelled');
      return null;
    }
    const chosen = new Set([...answer.selected].map(String));
    const picked = list.filter((item, index) => chosen.has(ids[index]));
    view.decision('tui.view.decisionPicked', { count: picked.length });
    return picked;
  }

  const ans = await promptLib()({
    type: 'multiselect',
    name: 'ids',
    message: `${opts.message}${hint()}`,
    instructions: t('tui.pages.multiselectInstructions'),
    choices: list.map((item, index) => ({
      title: label(item),
      value: ids[index],
      selected: initial.has(ids[index]),
      description: typeof opts.describe === 'function' ? opts.describe(item, opts.state) : undefined,
    })),
  });
  const answer = answerValue(ans, ['ids', 'value', 'selected']);
  if (!answer.found) return null;
  const chosen = new Set((Array.isArray(answer.value) ? answer.value : []).map((v) => answerId(v)));
  return list.filter((item, index) => chosen.has(ids[index]));
}

// ---------------------------------------------------------------------------
// Fact blocks (detail pages)
// 信息区块（详情页）
// ---------------------------------------------------------------------------

/**
 * Render "field: value" lines with a common label column.
 * 渲染「字段: 值」行，标签列对齐。
 *
 * @param {Array<{label:string, value:string, color?:(s:string)=>string}>} facts
 * @returns {string[]}
 */
function describeFacts(facts) {
  const rows = (Array.isArray(facts) ? facts : []).filter(
    (f) => f && f.value !== undefined && f.value !== null && String(f.value).trim() !== ''
  );
  if (!rows.length) return [];
  const width = rows.reduce((max, f) => Math.max(max, displayWidth(String(f.label))), 0);
  return rows.map((f) => {
    const label = view.padTo(String(f.label), width);
    const value = String(f.value);
    const paint = typeof f.color === 'function' ? f.color : (s) => s;
    return `  ${view.colors.dim(label)}  ${paint(value)}`;
  });
}

/**
 * Print a titled block: a heading line followed by indented body lines.
 * 打印带标题的信息块：标题行 + 缩进正文。
 */
function printBlock(title, lines) {
  console.log('');
  console.log(view.colors.bold(`  ${title}`));
  for (const line of lines) console.log(`  ${line}`);
}

// ---------------------------------------------------------------------------
// Help page
// 帮助页
// ---------------------------------------------------------------------------

/**
 * Shortcut sections shown on the help page.
 * 帮助页展示的快捷键分组。
 */
const HELP_SECTIONS = [
  {
    titleKey: 'tui.help.sectionGeneral',
    items: [
      ['↑/↓ · k/j', 'tui.help.generalMove'],
      ['Home/End', 'tui.help.generalFirstLast'],
      ['PgUp/PgDn · [ ]', 'tui.help.generalPage'],
      ['/', 'tui.help.generalSearch'],
      ['t / b', 'tui.help.generalFilter'],
      ['s', 'tui.help.generalSort'],
      ['Space', 'tui.help.generalToggle'],
      ['a / i', 'tui.help.generalAllInvert'],
      ['1-9', 'tui.help.generalQuickSelect'],
      ['Enter', 'tui.help.generalConfirm'],
      ['Esc / q', 'tui.help.generalBack'],
      ['Ctrl+C', 'tui.help.generalQuit'],
      ['?', 'tui.help.generalHelp'],
    ],
  },
  {
    titleKey: 'tui.help.sectionDownload',
    items: [
      ['s', 'tui.help.runSkip'],
      ['Ctrl+C', 'tui.help.runCancel'],
    ],
  },
];

/**
 * Help page lines (pure, unit-testable): a boxed key reference.
 * 帮助页内容行（纯函数，可单测）：带边框的按键速查。
 *
 * @param {{columns?:number, version?:string}} [opts]
 * @returns {string[]}
 */
function helpLines(opts = {}) {
  const columns = view.screenColumns();
  const width = Math.max(48, Math.min(Number(opts.columns) || columns, columns) - 2);
  const g = view.glyphs();
  const keyWidth = HELP_SECTIONS.reduce(
    (max, section) => Math.max(max, ...section.items.map(([keys]) => displayWidth(keys))),
    0
  );
  const inner = width - 2;
  const lines = [];
  const top = `${g.boxH.repeat(2)} ${t('tui.help.title')} `;
  lines.push(`  ${view.truncateTo(top + g.boxH.repeat(Math.max(0, width - displayWidth(top))), width)}`);

  const version = opts.version === undefined ? packageVersion() : opts.version;
  const subtitle = version ? t('tui.help.version', { version }) : '';
  if (subtitle) lines.push(`  ${view.colors.dim(view.truncateTo(`  ${subtitle}`, width))}`);

  for (const section of HELP_SECTIONS) {
    lines.push(`  ${view.colors.bold(view.truncateTo(`  ${t(section.titleKey)}`, width))}`);
    for (const [keys, descKey] of section.items) {
      const key = view.padTo(keys, keyWidth);
      lines.push(`  ${view.truncateTo(`    ${view.colors.cyan(key)}  ${t(descKey)}`, width)}`);
    }
  }

  const footer = `  ${t('tui.help.footer')}`;
  lines.push(`  ${view.colors.dim(view.truncateTo(footer, width))}`);
  // Keep the visual frame balanced: one blank line above and below the body.
  // 让视觉边框上下对称：正文前后各留一个空行。
  return ['', ...lines, ''];
}

/**
 * Show the help page and wait for a key when possible.
 *
 * Under a TTY it takes over the screen (alternate buffer), so closing it brings the menu back
 * untouched instead of leaving twenty lines of key reference in the scrollback. Any key closes it
 * (Ctrl+C still exits the app); without a TTY it is printed and returned immediately, which keeps
 * logs and CI output readable.
 *
 *
 * 显示帮助页，并在可用时等待一次按键。
 *
 * TTY 下它会接管屏幕（备用缓冲区），因此关闭后菜单原样回来，而不会在回滚缓冲里留下二十行按键说明。
 * 任意键关闭（Ctrl+C 仍会退出程序）；非 TTY 下直接打印返回，保证日志与 CI 输出可读。
 *
 * @param {{onQuit?:() => void, stream?:NodeJS.ReadStream, out?:NodeJS.WriteStream}} [opts]
 */
async function showHelp(opts = {}) {
  const out = opts.out || process.stdout;
  const stdin = opts.stream || process.stdin;
  const interactive = !!(stdin && stdin.isTTY) && !process.env.CIVITAI_PLAIN;

  if (interactive) view.beginFullScreen();
  try {
    out.write(`${helpLines({ columns: out.columns }).join('\n')}\n`);
    if (!interactive) return;

    await new Promise((resolve) => {
      let release = () => {};
      const restore = installRawKeys({
        stream: stdin,
        onSignal: (intent) => {
          release();
          if (intent === 'cancel') {
            if (typeof opts.onQuit === 'function') opts.onQuit();
            else view.triggerCancel();
          }
          resolve();
        },
        onKey: () => {
          release();
          resolve();
          return false;
        },
      });
      // No raw keys on this terminal: do not wait for a key that can never arrive, just say so.
      // 这个终端拿不到原始按键：不要等一个永远不会到来的按键，直接说明。
      if (!restore) {
        out.write(`${t('tui.view.helpNoWait')}\n`);
        resolve();
        return;
      }
      release = restore;
    });
  } finally {
    // Leaving the alternate buffer restores the screen exactly as it was before the help page.
    // 退出备用缓冲区后，屏幕恢复到打开帮助页之前的样子。
    if (interactive) view.endFullScreen();
  }
}

// ---------------------------------------------------------------------------
// Small confirm helpers used by several flows
// 多个流程共用的确认辅助
// ---------------------------------------------------------------------------

/**
 * Ask before re-downloading already completed items; returns 'force' | 'skip' | null (cancelled).
 * 询问如何处理已完成项；返回 'force' | 'skip' | null（取消）。
 */
async function askRedownload(count) {
  const choice = await promptMenu(t('tui.pages.redownloadTitle', { count }), [
    { title: t('tui.pages.redownloadSkip'), value: 'skip', description: t('tui.pages.redownloadSkipDesc') },
    { title: t('tui.pages.redownloadForce'), value: 'force', description: t('tui.pages.redownloadForceDesc') },
  ]);
  return choice;
}

module.exports = {
  hint,
  hintLines,
  packageVersion,
  promptMenu,
  promptConfirm,
  promptText,
  promptOutDir,
  pickOne,
  pickMany,
  canPick,
  withSpinner,
  elapsedSeconds,
  describeFacts,
  printBlock,
  HELP_SECTIONS,
  helpLines,
  showHelp,
  askRedownload,
};
