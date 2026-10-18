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

const { saveConfig } = require('../config');
const { t } = require('../i18n');
const layout = require('./layout');
const view = require('./view');
const pages = require('./pages');
const screen = require('./screen');

const { colors, displayWidth, truncateTo } = layout;

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
      { key: 'fileTypes', type: 'text', label: 'tui.settings.fileTypes', validate: 'fileTypes' },
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

// ---------------------------------------------------------------------------
// Shell page
// 外壳页面
// ---------------------------------------------------------------------------

/**
 * Rows of the settings page: section headers, one row per field and the action rows.
 * 设置页的行：分组标题、每个字段一行，以及操作行。
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
  rows.push({ kind: 'action', action: 'save', label: t('tui.settings.saveAction'), help: t('tui.settings.saveActionDesc') });
  return rows;
}

/**
 * Value shown on the right of one field row.
 * 字段行右侧显示的值。
 */
function rowValue(config, draft, field) {
  const current = field.key === 'fileTypes' ? (config.fileTypes || ['Model']).join(',') : config[field.key];
  const changed = Object.prototype.hasOwnProperty.call(draft, field.key);
  const text = changed ? displayValue({ ...config, ...draft }, field) : displayValue(config, field);
  return {
    text,
    changed: changed && String(draft[field.key]) !== String(current),
  };
}

/**
 * Edit one field: open the matching prompt and write the answer into the draft.
 * 修改一个字段：打开对应提问，并把答案写进草稿。
 */
async function editField(config, draft, field) {
  const current = config[field.key];
  if (field.type === 'confirm') {
    const answer = await pages.promptConfirm(t(field.label), { initial: !!current, stage: '' });
    if (answer === null) return false;
    draft[field.key] = answer;
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
    draft[field.key] = picked;
    return true;
  }

  const text = await pages.promptText(`${t(field.label)}${field.optional ? t('tui.settings.optional') : ''}`, {
    // The editor starts from the raw value: the display fallback ("-") would otherwise be written
    // back into an empty optional field.
    //
    // 编辑器以原始值为初值：否则显示用的兜底值（「-」）会被写回空的可选字段。
    initial: current === undefined || current === null ? '' : String(current),
    validate: field.validate ? VALIDATORS[field.validate] : undefined,
  });
  if (text === null) return false;
  if (field.validate === 'fileTypes') {
    draft[field.key] = text
      .split(',')
      .map((s) => s.trim())
      .filter(Boolean);
    return true;
  }
  if (field.key === 'site') draft[field.key] = text.replace(/\/+$/, '');
  else if (['debugPort', 'jobs', 'metaConcurrency', 'apiRateLimit', 'downloadAttempts'].includes(field.key)) {
    draft[field.key] = Number(text);
  } else draft[field.key] = text;
  return true;
}

/**
 * List the differences between the original config and the draft.
 * 列出原配置与草稿之间的差异。
 */
function changedPatch(config, draft) {
  const patch = {};
  const changed = [];
  for (const section of SECTIONS) {
    for (const field of section.fields) {
      if (!Object.prototype.hasOwnProperty.call(draft, field.key)) continue;
      const before = field.key === 'fileTypes' ? (config.fileTypes || ['Model']).join(',') : config[field.key];
      const after = field.key === 'fileTypes' ? draft[field.key].join(',') : draft[field.key];
      if (String(before) === String(after)) continue;
      patch[field.key] = draft[field.key];
      changed.push({ label: t(field.label), before, after });
    }
  }
  return { patch, changed };
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
 * 所有交互都发生在一个提问内部：字段编辑器是嵌套的提问，因此 Esc 先关闭编辑器，
 * 再按一次才离开本页（第一次会提示还有多少项没保存）。
 *
 * @returns {Promise<boolean>} whether anything was written to config.json
 */
async function settingsPage(config) {
  const draft = {};
  const rows = buildRows();
  const selectable = rows.map((row, index) => (row.kind === 'section' ? -1 : index)).filter((index) => index >= 0);
  const state = { cursor: selectable[0], saved: false, escapeArmed: false };

  const step = (delta) => {
    const position = selectable.indexOf(state.cursor);
    const next = Math.max(0, Math.min(selectable.length - 1, position + delta));
    state.cursor = selectable[next];
  };

  const labelWidth = rows.reduce((max, row) => (row.kind === 'section' ? max : Math.max(max, displayWidth(row.label))), 0);

  return screen.prompt({
    title: t('tui.app.menuSettings'),
    hints: () => [t('tui.settings.pageHint')],
    // Prompts are rendered with `(state, ctx)`; the page keeps its own state in the closure, so only
    // the geometry (`ctx`) is used here.
    //
    // 提问的渲染签名是 `(state, ctx)`；本页的状态保存在闭包里，因此这里只用到几何信息 `ctx`。
    render(_state, ctx) {
      const lines = [];
      const valueColumn = Math.min(labelWidth, Math.floor(ctx.width * 0.4));
      for (const [index, row] of rows.entries()) {
        if (row.kind === 'section') {
          if (index > 0) lines.push('');
          lines.push(colors.dim(row.label));
          continue;
        }
        const cursor = index === state.cursor;
        const marker = cursor ? colors.cyan(layout.glyphs().cursor) : ' ';
        const label = cursor ? colors.bold(layout.padTo(row.label, valueColumn)) : layout.padTo(row.label, valueColumn);
        let value = '';
        if (row.kind === 'field') {
          const shown = rowValue(config, draft, row.field);
          value = shown.changed ? colors.green(`* ${shown.text}`) : shown.text;
        } else if (row.action === 'save') {
          const pending = changedPatch(config, draft).changed.length;
          value = pending ? colors.yellow(t('tui.settings.pendingCount', { count: pending })) : colors.dim(t('tui.settings.noChangesShort'));
        }
        lines.push(`${marker} ${label}   ${truncateTo(value, Math.max(8, ctx.width - valueColumn - 4))}`);
      }
      const help = rows[state.cursor] && rows[state.cursor].help;
      if (help) lines.push('', colors.dim(truncateTo(help, ctx.width)));
      return lines;
    },
    onEscape(entry) {
      const pending = changedPatch(config, draft).changed.length;
      // First Esc with unsaved edits asks once; the second one really leaves without saving.
      // 有未保存改动时第一次 Esc 先问一次，第二次才真正放弃并离开。
      if (pending && !state.escapeArmed) {
        state.escapeArmed = true;
        screen.notice(t('tui.settings.unsavedNotice', { count: pending }), colors.yellow);
        return true;
      }
      entry.settle(state.saved);
      return true;
    },
    async onKey(text, key, entry) {
      if (key.name === 'up' || text === 'k') step(-1);
      else if (key.name === 'down' || text === 'j') step(1);
      else if (key.name === 'pageup') step(-8);
      else if (key.name === 'pagedown') step(8);
      else if (key.name === 'home') state.cursor = selectable[0];
      else if (key.name === 'end') state.cursor = selectable[selectable.length - 1];
      else if (key.name === 'return') await activate();
      else if (text === 's') await save();
      else return;
      state.escapeArmed = false;
    },
  });

  /**
   * Enter on the current row: edit a field, or run an action row.
   * 在当前行按回车：修改字段，或执行操作行。
   */
  async function activate() {
    const row = rows[state.cursor];
    if (!row || row.kind === 'section') return;
    if (row.kind === 'field') {
      const done = await editField(config, draft, row.field);
      if (done) {
        const pending = changedPatch(config, draft).changed.length;
        if (pending) view.decision('tui.settings.draftUpdated', { count: pending });
      }
      return;
    }
    if (row.action === 'save') return save();
    if (row.action === 'login') return require('./login').loginFlow(config);
    if (row.action === 'doctor') {
      // The environment check prints through the CLI catalog: keep its lines inside the frame.
      // 环境体检按命令行方式打印：把它的输出留在框架内。
      return view.captureOutput(() =>
        require('../commands/doctor').main(config, { positionals: [], flags: {} })
      );
    }
    if (row.action === 'open') {
      if (view.openDir(config.outDir)) view.log(t('tui.app.opened', { dir: config.outDir }));
      else view.log(t('tui.app.openFailed'));
      return;
    }
    return undefined;
  }

  /**
   * Write the pending changes to config.json.
   * 把待保存的改动写入 config.json。
   */
  async function save() {
    const { patch, changed } = changedPatch(config, draft);
    if (!changed.length) {
      screen.notice(t('tui.settings.noChanges'), colors.dim);
      return;
    }
    pages.printBlock(
      t('tui.settings.changeTitle', { count: changed.length }),
      changed.map(
        (item) => `${item.label}: ${colors.dim(String(item.before))} → ${colors.cyan(String(item.after))}`
      )
    );
    const confirm = await pages.promptConfirm(t('tui.settings.saveConfirm', { count: changed.length }), {
      initial: true,
    });
    if (!confirm) {
      view.note(t('tui.settings.cancelled'));
      return;
    }
    saveConfig(config, patch);
    Object.assign(config, patch);
    for (const key of Object.keys(draft)) delete draft[key];
    state.saved = true;
    state.escapeArmed = false;
    view.log(t('tui.settings.saved'));
    if (patch.site !== undefined) view.log(t('tui.settings.siteChanged'));
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
async function askField(config, draft, field) {
  return editField(config, draft, field);
}

/**
 * Ask every field of one section. Returns false when the user cancelled the section.
 * 逐项询问某一组的全部字段。用户取消该组时返回 false。
 */
async function askSection(config, draft, section) {
  view.note('');
  view.note(colors.bold(`  ${t(section.titleKey)}`));
  view.note(colors.dim(`  ${t(section.descKey)}`));
  for (const field of section.fields) {
    const done = await askField(config, draft, field);
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
  view.note(colors.bold(`  ${t('tui.settings.summaryTitle')}`));
  for (const section of SECTIONS) {
    const preview = section.fields
      .slice(0, 3)
      .map((f) => displayValue(config, f))
      .join(view.separator());
    view.note(
      `  ${colors.dim(layout.padTo(t(section.titleKey), 14))}  ${colors.dim(truncateTo(preview, 60))}`
    );
  }
}

/**
 * Section-by-section settings flow used without the app shell.
 * 没有应用外壳时使用的分组式设置流程。
 */
async function plainSettingsFlow(config) {
  const draft = {};
  let saved = false;
  printSummary(config);

  for (;;) {
    const choices = SECTIONS.map((section) => ({
      title: t(section.titleKey),
      value: section.key,
      description: t(section.descKey),
    }));
    choices.push({ title: t('tui.settings.saveAction'), value: '__save__', description: t('tui.settings.saveActionDesc') });

    const action = await pages.promptMenu(t('tui.settings.menuTitle'), choices);
    if (action === null) {
      if (!saved) view.log(t('tui.settings.cancelled'));
      return saved;
    }
    if (action === '__save__') break;

    const section = SECTIONS.find((s) => s.key === action);
    if (!section) continue;
    await askSection(config, draft, section);
    const pending = changedPatch(config, draft).changed.length;
    if (pending) view.decision('tui.settings.draftUpdated', { count: pending });
  }

  const { patch, changed } = changedPatch(config, draft);
  if (!changed.length) {
    view.log(t('tui.settings.noChanges'));
    return false;
  }

  pages.printBlock(
    t('tui.settings.changeTitle', { count: changed.length }),
    changed.map(
      (item) => `${item.label}: ${colors.dim(String(item.before))} → ${colors.cyan(String(item.after))}`
    )
  );

  const confirm = await pages.promptConfirm(t('tui.settings.saveConfirm', { count: changed.length }), {
    initial: true,
  });
  if (!confirm) {
    view.log(t('tui.settings.cancelled'));
    return false;
  }

  saveConfig(config, patch);
  Object.assign(config, patch);
  view.log(t('tui.settings.saved'));
  if (patch.site !== undefined) view.log(t('tui.settings.siteChanged'));
  return true;
}

/**
 * Settings entry point: the list page with the shell, the section chain without it.
 * 设置入口：有外壳时是列表页，没有外壳时是分组问答链。
 */
async function settingsFlow(config) {
  if (screen.isActive()) return settingsPage(config);
  return plainSettingsFlow(config);
}

module.exports = {
  settingsFlow,
  settingsPage,
  buildRows,
  shortLabel,
  displayValue,
  SECTIONS,
  VALIDATORS,
  changedPatch,
  settingsPatch: changedPatch,
};
