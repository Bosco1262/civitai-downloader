'use strict';

/**
 * TUI flow for editing config.json.
 *
 * The settings page is a list of everything that can be changed — site, directories, concurrency,
 * proxy, notifications — shown with the value each key currently has. Enter selects one row and opens
 * its editor (a text field, a choice list or a yes/no), Esc leaves the page, and nothing is written to
 * the config file until "save" is chosen. Login and the environment check live here too, because "how
 * the tool is set up" is exactly what this page is about.
 *
 * Without the app shell (no TTY, CI) the same sections are asked one after another through the plain
 * prompt library, which keeps scripted runs working.
 *
 *
 * 编辑 config.json 的 TUI 流程。
 *
 * 设置页是所有可修改项的一张列表——站点、目录、并发、代理、通知——每项后面跟着它当前的值。
 * 回车选中某一行会打开它的编辑器（文本框、选择列表或是否确认），Esc 离开本页，
 * 并且只有选择「保存到 config.json」才会真正落盘。登录与环境体检也在这里，
 * 因为「工具是怎么配置的」正是这一页的主题。
 *
 * 没有应用外壳时（非 TTY、CI），同样的分组改由简易提问库逐项询问，保证脚本化运行仍可用。
 */

const { saveConfig, DEFAULTS } = require('../config');
const { t } = require('../i18n');
const layout = require('./layout');
const view = require('./view');
const pages = require('./pages');
const screen = require('./screen');
const reportPage = require('./report');
const list = require('./ui/list');
const { present } = require('./present');
const { color } = require('./tokens');

const { displayWidth, truncateTo } = layout;

/**
 * Settings sections. `fields` names the config keys asked in that section; `type` picks the prompt.
 * `label` is the message key, `options` lists the allowed values of a select.
 *
 * 设置分组。`fields` 是该组要问的配置键；`type` 决定用哪种提问；
 * `label` 是提示文案键，`options` 是选择项的候选值。
 */
const SECTIONS = [
  {
    key: 'basic',
    titleKey: 'tui.settings.sectionBasic',
    descKey: 'tui.settings.sectionBasicDesc',
    fields: [
      { key: 'site', type: 'text', label: 'tui.settings.site', validate: 'site' },
      { key: 'outDir', type: 'text', label: 'tui.settings.outDir', validate: 'notEmpty' },
      { key: 'chromePath', type: 'text', label: 'tui.settings.chromePath', optional: true },
      { key: 'debugPort', type: 'text', label: 'tui.settings.debugPort', validate: 'port' },
      {
        key: 'headless',
        type: 'select',
        label: 'tui.settings.headless',
        options: [
          ['auto', 'tui.settings.headlessAuto'],
          ['always', 'tui.settings.headlessAlways'],
          ['never', 'tui.settings.headlessNever'],
        ],
      },
      {
        key: 'language',
        type: 'select',
        label: 'tui.settings.language',
        options: [
          ['', 'tui.settings.languageAuto'],
          ['zh-CN', 'tui.settings.languageZh'],
          ['en', 'tui.settings.languageEn'],
        ],
      },
    ],
  },
  {
    key: 'download',
    titleKey: 'tui.settings.sectionDownload',
    descKey: 'tui.settings.sectionDownloadDesc',
    fields: [
      { key: 'jobs', type: 'text', label: 'tui.settings.jobs', validate: 'jobs' },
      { key: 'metaConcurrency', type: 'text', label: 'tui.settings.metaConcurrency', validate: 'jobs' },
      { key: 'downloadAttempts', type: 'text', label: 'tui.settings.downloadAttempts', validate: 'integer' },
      { key: 'requestTimeoutMs', type: 'text', label: 'tui.settings.requestTimeoutMs', validate: 'timeout' },
      { key: 'retries', type: 'text', label: 'tui.settings.retries', validate: 'retries' },
      { key: 'fileTypes', type: 'text', label: 'tui.settings.fileTypes', validate: 'fileTypes' },
      {
        key: 'layout',
        type: 'select',
        label: 'tui.settings.layout',
        options: [
          ['a1111', 'tui.settings.layoutA1111'],
          ['comfy', 'tui.settings.layoutComfy'],
          ['custom', 'tui.settings.layoutCustom'],
        ],
      },
      { key: 'baseModelLayer', type: 'confirm', label: 'tui.settings.baseModelLayer' },
      { key: 'primaryOnly', type: 'confirm', label: 'tui.settings.primaryOnly' },
      {
        key: 'engine',
        type: 'select',
        label: 'tui.settings.engine',
        options: [
          ['curl', 'tui.settings.engineCurl'],
          ['auto', 'tui.settings.engineAuto'],
          ['aria2', 'tui.settings.engineAria2'],
        ],
      },
      {
        key: 'dedup',
        type: 'select',
        label: 'tui.settings.dedup',
        options: [
          ['off', 'tui.settings.dedupOff'],
          ['hardlink', 'tui.settings.dedupHardlink'],
          ['copy', 'tui.settings.dedupCopy'],
        ],
      },
    ],
  },
  {
    key: 'network',
    titleKey: 'tui.settings.sectionNetwork',
    descKey: 'tui.settings.sectionNetworkDesc',
    fields: [
      { key: 'apiRateLimit', type: 'text', label: 'tui.settings.apiRateLimit', validate: 'integer' },
      { key: 'proxy', type: 'text', label: 'tui.settings.proxy', validate: 'proxy', optional: true },
      { key: 'userAgent', type: 'text', label: 'tui.settings.userAgent', validate: 'notEmpty' },
    ],
  },
  {
    key: 'notify',
    titleKey: 'tui.settings.sectionNotify',
    descKey: 'tui.settings.sectionNotifyDesc',
    fields: [
      { key: 'notifyWebhook', type: 'text', label: 'tui.settings.notifyWebhook', validate: 'webhook', optional: true },
      { key: 'notifyToast', type: 'confirm', label: 'tui.settings.notifyToast' },
    ],
  },
];

/**
 * Validators and formatters per field kind.
 * 每种字段的校验与格式转换。
 */
const VALIDATORS = {
  site: (v) => /^https?:\/\/\S+$/i.test(String(v).trim()) || t('tui.settings.invalidSite'),
  notEmpty: (v) => (String(v).trim() ? true : t('tui.settings.notEmpty')),
  port: (v) => /^\d{2,5}$/.test(String(v).trim()) || t('tui.settings.invalidPort'),
  jobs: (v) => (/^[1-8]$/.test(String(v).trim()) ? true : t('tui.settings.invalidJobs')),
  integer: (v) => (/^\d+$/.test(String(v).trim()) ? true : t('tui.settings.invalidInteger')),
  timeout: (v) => {
    const n = Number(String(v).trim());
    return Number.isFinite(n) && n >= 1000 && n <= 600000 ? true : t('tui.settings.invalidTimeout');
  },
  retries: (v) => {
    const n = Number(String(v).trim());
    return Number.isFinite(n) && n >= 0 && n <= 10 ? true : t('tui.settings.invalidRetries');
  },
  proxy: (v) =>
    !String(v).trim() || /^(https?|socks[45]?):\/\/\S+$/i.test(String(v).trim()) || t('tui.settings.invalidProxy'),
  webhook: (v) => !String(v).trim() || /^https?:\/\/\S+$/i.test(String(v).trim()) || t('tui.settings.invalidSite'),
  fileTypes: (v) =>
    String(v)
      .split(',')
      .map((s) => s.trim())
      .filter(Boolean).length > 0 || t('tui.settings.invalidFileTypes'),
};

/**
 * Current value of one field, formatted for display.
 * 某个字段的当前值（展示用格式）。
 */
function displayValue(config, field) {
  if (field.key === 'fileTypes') return (config.fileTypes || ['Model']).join(',');
  if (field.key === 'outDir') return config.outDir;
  const value = config[field.key];
  if (field.type === 'confirm') return value ? t('common.yes') : t('common.no');
  if (field.type === 'select' && field.options) {
    const match = field.options.find(([option]) => String(option) === String(value === undefined ? '' : value));
    if (match) return t(match[1]);
  }
  if (value === undefined || value === null || value === '') return '-';
  return String(value);
}

/**
 * Short row label of a field: the text before the first bracket, so the long explanatory messages
 * stay available as the help line instead of eating the whole row.
 *
 * 字段的短行标签：取第一个括号之前的部分，长说明因此留在帮助行上，而不是吃掉整行。
 */
function shortLabel(text) {
  const value = String(text === undefined || text === null ? '' : text);
  // The full-width bracket is written as an escape: a literal one would look like hard-coded
  // Chinese to the source check.
  //
  // 全角括号写成转义：直接写出来会被源码检查当成硬编码中文。
  const cut = value.split(/[\uFF08(]/)[0].trim();
  return cut || value;
}

/**
 * Kept as a re-export: the report page and the settings page share the same window adjustment, and
 * existing callers (and tests) still look it up here.
 *
 * 保留为重新导出：报告页与设置页共用同一套视窗调整，既有调用方（与测试）仍从这里取用。
 */
const scrollToSection = pages.scrollToSection;

// ---------------------------------------------------------------------------
// Environment check page
// 环境体检页
// ---------------------------------------------------------------------------

/**
 * Status badge of one check item (the CLI catalog already owns the three tags).
 * 一项检查的状态标签（三个标签由命令行文案表提供）。
 */
function doctorTag(status) {
  if (status === 'ok') return t('doctor.tagOk');
  if (status === 'warn') return t('doctor.tagWarn');
  return t('doctor.tagFail');
}

/**
 * Color of one check status: green / yellow / red.
 * 检查状态的颜色：绿 / 黄 / 红。
 */
function doctorColor(status) {
  if (status === 'ok') return color.success;
  if (status === 'warn') return color.warning;
  return color.danger;
}

/**
 * Report model of the environment check: counts on top, one row per item with its hint.
 * 环境体检的报告模型：上面是计数，每个检查项一行并带上建议。
 */
function doctorReportModel(items, deep) {
  const count = (status) => items.filter((item) => item.status === status).length;
  const modes = deep ? t('tui.doctor.report.modeDeep') : t('tui.doctor.report.modeQuick');
  return {
    title: t('tui.doctor.report.title'),
    summary: [
      { label: t('tui.doctor.report.factTotal'), value: String(items.length) },
      { label: t('tui.doctor.report.factOk'), value: String(count('ok')), color: color.success },
      { label: t('tui.doctor.report.factWarn'), value: String(count('warn')), color: color.warning },
      { label: t('tui.doctor.report.factFail'), value: String(count('fail')), color: color.danger },
      { label: t('tui.doctor.report.factMode'), value: modes },
    ],
    sections: [
      {
        title: t('tui.doctor.report.sectionItems'),
        rows: items.map((item) => ({
          label: `${doctorTag(item.status)} ${item.name}`,
          detail: String(item.detail || ''),
          extra: item.hint ? String(item.hint) : '',
          color: doctorColor(item.status),
        })),
      },
    ],
    actions: [
      { label: t('tui.doctor.report.actionQuick'), run: () => 'quick' },
      {
        label: t('tui.doctor.report.actionDeep'),
        description: t('tui.doctor.report.actionDeepDesc'),
        run: () => 'deep',
      },
      { label: t('tui.manage.back'), run: () => reportPage.BACK },
    ],
  };
}

/**
 * Shell environment-check loop: collect → page → (quick / deep) until the user leaves.
 * 外壳环境体检循环：体检 → 页面 → （快速 / 深度）直到用户离开。
 */
async function doctorReportPage(config) {
  let deep = false;
  for (;;) {
    const items = await pages.withSpinner(t('tui.doctor.report.collecting'), () =>
      require('../commands/doctor').collect(config, { deep })
    );
    const outcome = await reportPage.showReportPage(config, doctorReportModel(items, deep));
    if (outcome === 'quick') {
      deep = false;
      continue;
    }
    if (outcome === 'deep') {
      deep = true;
      continue;
    }
    return undefined;
  }
}

// ---------------------------------------------------------------------------
// Shell page
// 外壳页面
// ---------------------------------------------------------------------------

/**
 * Rows of the settings page: section headers, one row per field and the action rows. There is no
 * "save" row: every field is written to config.json the moment it is confirmed.
 *
 * 设置页的行：分组标题、每个字段一行，以及操作行。没有「保存」行：每个字段确认后立刻写入 config.json。
 */
function buildRows() {
  const rows = [];
  for (const section of SECTIONS) {
    rows.push({ kind: 'section', label: t(section.titleKey), section });
    for (const field of section.fields) {
      rows.push({ kind: 'field', field, section, label: shortLabel(t(field.label)), help: t(field.label) });
    }
  }
  rows.push({ kind: 'section', label: t('tui.settings.actionSection') });
  rows.push({ kind: 'action', action: 'login', label: t('tui.settings.actionLogin'), help: t('tui.settings.actionLoginDesc') });
  rows.push({ kind: 'action', action: 'open', label: t('tui.settings.actionOpenDir'), help: t('tui.settings.actionOpenDirDesc') });
  rows.push({ kind: 'action', action: 'doctor', label: t('tui.settings.actionDoctor'), help: t('tui.settings.actionDoctorDesc') });
  rows.push({ kind: 'action', action: 'reset', label: t('tui.settings.actionReset'), help: t('tui.settings.actionResetDesc') });
  return rows;
}

/**
 * Value shown on the right of one field row.
 * 字段行右侧显示的值。
 */
function rowValue(config, field) {
  return displayValue(config, field);
}

/**
 * Write one field to config.json right away and report it.
 *
 * Nothing is staged any more: confirming a field is the save. Re-entering the same value writes
 * nothing and says so, and changing the site still reminds the user to log in again.
 *
 *
 * 立即把一个字段写进 config.json 并给出反馈。
 *
 * 不再有暂存：确认字段就是保存。重填同样的值不会写盘，只会说明「未修改」；
 * 改动站点时仍然提醒需要重新登录。
 *
 * @returns {boolean} whether anything was written
 */
function applyField(config, field, value) {
  const before = field.key === 'fileTypes' ? (config.fileTypes || []).join(',') : config[field.key];
  const after = field.key === 'fileTypes' ? value.join(',') : value;
  const label = shortLabel(t(field.label));
  if (String(before) === String(after)) {
    view.decision('tui.settings.unchanged', { label });
    return false;
  }
  saveConfig(config, { [field.key]: value });
  config[field.key] = value;
  if (field.key === 'site') {
    // Changing the site is the one edit with a follow-up (a new Chrome profile + a new login), so it
    // takes over the toast instead of the generic "saved" line.
    //
    // 改站点是唯一需要后续动作的修改（新的 Chrome profile + 重新登录），
    // 因此它顶替通用的「已保存」提示。
    view.notice(t('tui.settings.siteChanged'), color.warning);
    return true;
  }
  view.decision('tui.settings.savedItem', { label, value: displayValue(config, field) });
  return true;
}

/**
 * Default value of one field, formatted for its editor. Text editors work on strings (the file-type
 * list is joined again), so the same helper feeds both the Ctrl+R shortcut and "restore all".
 *
 * 某个字段的默认值，按编辑器需要的形态给出。文本编辑器用字符串（文件类型列表重新用逗号连接），
 * 因此 Ctrl+R 与「全部恢复默认」共用这个助手。
 *
 * @returns {any} undefined when the field has no default
 */
function defaultOf(field) {
  if (!Object.prototype.hasOwnProperty.call(DEFAULTS, field.key)) return undefined;
  const value = DEFAULTS[field.key];
  if (field.validate === 'fileTypes' && Array.isArray(value)) return value.join(',');
  return value;
}

/**
 * Edit one field: open the matching prompt and write the answer immediately.
 * 修改一个字段：打开对应提问，并立即写入答案。
 *
 * @returns {Promise<boolean>} false when the user cancelled the editor
 */
async function editField(config, field) {
  const current = config[field.key];
  const fallback = defaultOf(field);
  if (field.type === 'confirm') {
    const answer = await pages.promptConfirm(t(field.label), { initial: !!current, stage: '' });
    if (answer === null) return false;
    applyField(config, field, answer);
    return true;
  }
  if (field.type === 'select') {
    const values = field.options.map(([value]) => value);
    const initial = Math.max(0, values.indexOf(String(current === undefined ? '' : current)));
    const picked = await pages.promptMenu(
      t(field.label),
      field.options.map(([value, labelKey]) => ({ title: t(labelKey), value })),
      { initial }
    );
    if (picked === null) return false;
    applyField(config, field, picked);
    return true;
  }

  const text = await pages.promptText(`${t(field.label)}${field.optional ? t('tui.settings.optional') : ''}`, {
    // The editor starts from the raw value: the display fallback ("-") would otherwise be written
    // back into an empty optional field.
    //
    // 编辑器以原始值为初值：否则显示用的兜底值（「-」）会被写回空的可选字段。
    initial: current === undefined || current === null ? '' : String(current),
    validate: field.validate ? VALIDATORS[field.validate] : undefined,
    // Paths get the platform's folder dialog on top of typing (Ctrl+O fills the field, Enter still
    // saves it), so the same page works on devices where no dialog can open.
    //
    // 路径字段在输入之外还能用系统目录对话框（Ctrl+O 填入，Enter 仍然负责保存），
    // 因此弹不出对话框的设备也能用同一页。
    pick: field.key === 'outDir' ? 'directory' : undefined,
    // Ctrl+R puts the config default back into the field (editable, then Enter applies it).
    // Ctrl+R 把配置默认值填回输入框（仍可编辑，Enter 才生效）。
    resetValue: fallback === undefined ? undefined : String(fallback),
  });
  if (text === null) return false;
  if (field.validate === 'fileTypes') {
    applyField(
      config,
      field,
      text
        .split(',')
        .map((s) => s.trim())
        .filter(Boolean)
    );
    return true;
  }
  if (field.key === 'site') applyField(config, field, text.replace(/\/+$/, ''));
  else if (
    ['debugPort', 'jobs', 'metaConcurrency', 'apiRateLimit', 'downloadAttempts', 'requestTimeoutMs', 'retries'].includes(
      field.key
    )
  ) {
    applyField(config, field, Number(text));
  } else applyField(config, field, text);
  return true;
}

/**
 * Settings page rendered inside the app shell.
 *
 * Everything happens inside one prompt: the field editor is a nested prompt, so Esc closes the editor
 * first and only leaves the page on the second press (the first one still shows what is pending).
 *
 *
 * 渲染在应用外壳里的设置页。
 *
 * 每个字段确认后立刻写盘，因此离开本页时没有「未保存」可言：Esc 就是返回上一级。
 *
 * @returns {Promise<boolean>} whether anything was written to config.json
 */
async function settingsPage(config) {
  const rows = buildRows();
  const selectable = rows.map((row, index) => (row.kind === 'section' ? -1 : index)).filter((index) => index >= 0);
  const state = { cursor: selectable[0], written: false, windowStart: 0 };

  // The cursor follows the shared form policy: wrap at both ends, page by ten rows.
  // 光标遵循共享表单策略：两端循环，每页十行。
  const step = (delta) => {
    const position = selectable.indexOf(state.cursor);
    state.cursor = selectable[list.moveCursor(position, delta, selectable.length, 'form')];
  };
  const page = (direction) => {
    const position = selectable.indexOf(state.cursor);
    state.cursor = selectable[list.pageCursor(position, direction, selectable.length, 10, 'form')];
  };

  const labelWidth = rows.reduce((max, row) => (row.kind === 'section' ? max : Math.max(max, displayWidth(row.label))), 0);

  return screen.prompt({
    title: t('tui.app.menuSettings'),
    // Saving has no shortcut of its own, so the line does not mention one either.
    // 保存没有单独的快捷键，因此这一行也不提它。
    hints: () => [t('tui.hint.settings')],
    // Prompts are rendered with `(state, ctx)`; the page keeps its own state in the closure, so only
    // the geometry (`ctx`) is used here.
    //
    // 提问的渲染签名是 `(state, ctx)`；本页的状态保存在闭包里，因此这里只用到几何信息 `ctx`。
    render(_state, ctx) {
      const width = Math.max(20, Math.floor(ctx.width) || 80);
      const room = Math.max(3, Math.floor(ctx.rows) || 3);
      const valueColumn = Math.min(labelWidth, Math.floor(width * 0.4));

      // Every row becomes one line first, so the scroll window can be computed over lines (section
      // headings and blank separators included) and the cursor can never leave the screen.
      //
      // 先把每一行都变成一行文本，再按「行」计算滚动视窗（包含分组标题与分隔空行），
      // 这样光标永远不会跑到屏幕外。
      const items = rows.map((row, index) => {
        if (row.kind === 'section') return { section: row.label };
        const cursor = index === state.cursor;
        const marker = cursor ? color.cursor(layout.glyphs().cursor) : ' ';
        const label = layout.padTo(row.label, valueColumn);
        // The row always shows what is in config.json right now: every edit was written already.
        // 这一行显示的就是 config.json 里的当前值：每次修改都已经写盘了。
        const value = row.kind === 'field' ? rowValue(config, row.field) : '';
        return {
          row: index,
          text: `${marker} ${cursor ? color.emphasis(label) : label}   ${truncateTo(value, Math.max(8, width - valueColumn - 4))}`,
        };
      });

      // Expand the section entries into "blank line + heading", remember which line each row is on and
      // which heading each line belongs to.
      //
      // 把分组项展开成「空行 + 标题」，记下每一行对应的文本行号，以及每一行属于哪个标题。
      const lines = [];
      const lineOfRow = new Map();
      const headingOfLine = new Map();
      const headingLines = new Set();
      let currentHeading = -1;
      for (const item of items) {
        if (item.section !== undefined) {
          if (lines.length) lines.push('');
          currentHeading = lines.length;
          headingLines.add(currentHeading);
          headingOfLine.set(currentHeading, currentHeading);
          lines.push(color.muted(item.section));
          continue;
        }
        lineOfRow.set(item.row, lines.length);
        headingOfLine.set(lines.length, currentHeading < 0 ? lines.length : currentHeading);
        lines.push(item.text);
      }

      const help = rows[state.cursor] && rows[state.cursor].help;
      const position = selectable.length > 1 ? t('tui.pages.listPosition', {
        index: selectable.indexOf(state.cursor) + 1,
        total: selectable.length,
      }) : '';
      // Keep one blank line plus the help line under the list; they never scroll away.
      // 列表下方固定留一行空行与一行说明，它们不参与滚动。
      const body = Math.max(1, room - 2);
      const cursorLine = lineOfRow.get(state.cursor) === undefined ? 0 : lineOfRow.get(state.cursor);
      const win = scrollToSection(
        list.windowOf(lines.length, cursorLine, body, state.windowStart),
        lines,
        body,
        cursorLine,
        headingOfLine,
        headingLines
      );
      state.windowStart = win.start;
      const shown = lines.slice(win.start, win.end);
      // The status line (position + explanation of the selected row) is pinned to the last body row:
      // spare rows go between the list and the status line, never between it and the footer, so the
      // gap the user sees is always above the status line, not below it.
      //
      // 状态行（序号 + 当前项说明）固定在主体最后一行：多余的空行留在列表与状态行之间，
      // 而不是状态行与页脚之间——用户看到的空行始终在状态行上方。
      while (shown.length + 2 < room) shown.push('');
      shown.push('', color.muted(truncateTo([position, help].filter(Boolean).join(view.separator()), width)));
      return shown;
    },
    onEscape(entry) {
      // Nothing is pending: every field was written when it was confirmed, so Esc is just "go back".
      // 没有待保存的东西：每个字段确认时就写盘了，因此 Esc 就是返回。
      entry.settle(state.written);
      return true;
    },
    async onKey(text, key, entry) {
      if (key.name === 'up') step(-1);
      else if (key.name === 'down') step(1);
      else if (key.name === 'pageup') page(-1);
      else if (key.name === 'pagedown') page(1);
      else if (key.name === 'home') state.cursor = selectable[list.homeCursor()];
      else if (key.name === 'end') state.cursor = selectable[list.endCursor(selectable.length)];
      else if (key.name === 'return') await activate();
      else return;
    },
  });

  /**
   * Enter on the current row: edit a field, or run an action row.
   * Enter 在当前行：修改字段，或执行操作行。
   */
  async function activate() {
    const row = rows[state.cursor];
    if (!row || row.kind === 'section') return;
    if (row.kind === 'field') {
      const done = await editField(config, row.field);
      if (done) state.written = true;
      return;
    }
    if (row.action === 'login') return require('./login').loginFlow(config);
    if (row.action === 'doctor') {
      // The checks are structured items, so the page renders OK/WARN/FAIL (and each hint) directly
      // instead of printing the CLI report into the log.
      //
      // 检查结果是结构化条目，因此页面直接渲染 OK/WARN/FAIL（以及每项的建议），
      // 而不是把命令行报告打印进日志。
      return doctorReportPage(config);
    }
    if (row.action === 'open') {
      if (view.openDir(config.outDir)) view.log(t('tui.app.opened', { dir: config.outDir }));
      else view.log(t('tui.app.openFailed'));
      return;
    }
    if (row.action === 'reset') {
      if (await resetEverything(config)) state.written = true;
      return;
    }
    return undefined;
  }
}

// ---------------------------------------------------------------------------
// Plain (non-shell) flow
// 简易（无外壳）流程
// ---------------------------------------------------------------------------

/**
 * Ask for one field and patch the draft. Returns false when the user cancelled the field.
 * 询问一个字段并写入草稿。用户取消该字段时返回 false。
 */
async function askField(config, field) {
  return editField(config, field);
}

/**
 * Ask every field of one section, writing each answer as soon as it is confirmed.
 * Returns false when the user cancelled the section.
 *
 * 逐项询问某一组的全部字段，每个答案确认后立即写盘。用户取消该组时返回 false。
 */
async function askSection(config, section) {
  view.note('');
  view.note(color.emphasis(`  ${t(section.titleKey)}`));
  view.note(color.muted(`  ${t(section.descKey)}`));
  for (const field of section.fields) {
    const done = await askField(config, field);
    if (!done) {
      view.log(t('tui.settings.sectionCancelled', { section: t(section.titleKey) }));
      return false;
    }
  }
  return true;
}

/**
 * Print the current values of every section once, as a compact summary.
 * 一次性打印每组设置的当前值，作为紧凑摘要。
 */
function printSummary(config) {
  view.note('');
  view.note(color.emphasis(`  ${t('tui.settings.summaryTitle')}`));
  for (const section of SECTIONS) {
    const preview = section.fields
      .slice(0, 3)
      .map((f) => displayValue(config, f))
      .join(view.separator());
    view.note(
      `  ${color.muted(layout.padTo(t(section.titleKey), 14))}  ${color.muted(truncateTo(preview, 60))}`
    );
  }
}

/**
 * Section-by-section settings flow used without the app shell. Same rule as the page: a confirmed
 * field is written immediately, so there is no save step here either.
 *
 * 没有应用外壳时使用的分组式设置流程。与页面一致：确认的字段立即写盘，因此这里也没有「保存」这一步。
 */
async function plainSettingsFlow(config) {
  let written = false;
  printSummary(config);

  for (;;) {
    const choices = SECTIONS.map((section) => ({
      title: t(section.titleKey),
      value: section.key,
      description: t(section.descKey),
    }));
    choices.push({
      title: t('tui.settings.actionReset'),
      value: '__reset__',
      description: t('tui.settings.actionResetDesc'),
    });

    const action = await pages.promptMenu(t('tui.settings.menuTitle'), choices);
    if (action === null) return written;

    if (action === '__reset__') {
      if (await resetEverything(config)) written = true;
      continue;
    }
    const section = SECTIONS.find((s) => s.key === action);
    if (!section) continue;
    await askSection(config, section);
  }
}

/**
 * Put every setting back to its built-in default, after one confirmation. Only the keys this page
 * owns are reset; anything else the user keeps in config.json is left untouched, and values that
 * already match the default are neither counted nor written.
 *
 * 一次性把这一页拥有的所有设置恢复成内置默认值（先确认一次）。只重置本页负责的键，
 * config.json 里的其它自定义内容保持原样；已经等于默认值的项不计数、也不写入。
 *
 * @returns {Promise<boolean>} whether anything was written
 */
async function resetEverything(config) {
  const patch = {};
  for (const section of SECTIONS) {
    for (const field of section.fields) {
      if (Object.prototype.hasOwnProperty.call(DEFAULTS, field.key)) patch[field.key] = DEFAULTS[field.key];
    }
  }
  const changed = Object.keys(patch).filter((key) => String(config[key]) !== String(patch[key]));
  if (!changed.length) {
    view.decision('tui.settings.resetNothing');
    return false;
  }
  const confirm = await pages.promptConfirm(t('tui.settings.resetConfirm', { count: changed.length }), {
    danger: true,
  });
  if (!confirm) return false;
  saveConfig(config, patch);
  Object.assign(config, patch);
  view.decision('tui.settings.resetDone', { count: changed.length });
  return true;
}

/**
 * Settings entry point: the list page with the shell, the section chain without it.
 * 设置入口：有外壳时是列表页，没有外壳时是分组问答链。
 */
async function settingsFlow(config) {
  return present({
    shell: () => settingsPage(config),
    plain: () => plainSettingsFlow(config),
  });
}

module.exports = {
  settingsFlow,
  settingsPage,
  buildRows,
  shortLabel,
  displayValue,
  applyField,
  scrollToSection,
  doctorReportModel,
  doctorReportPage,
  SECTIONS,
  VALIDATORS,
};
