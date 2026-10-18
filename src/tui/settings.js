'use strict';

/**
 * TUI flow for editing config.json.
 *
 * The settings used to be one long chain of questions, so changing the proxy meant walking through
 * sixteen prompts. Now a summary shows the current values, and only the fields of the section the
 * user opens are asked; every section can be left with Esc, the draft can be reviewed before it is
 * written, and nothing is saved until "Save to config.json" is chosen.
 *
 *
 * 编辑 config.json 的 TUI 流程。
 *
 * 此前设置是一条十七问的长链，只想改代理也得一路回车走完。现在先看一眼当前值摘要，
 * 只询问用户打开的那一组字段；每一组都能用 Esc 退出，写盘前可以先看变更清单，
 * 并且只有选择「保存到 config.json」才会真正落盘。
 */

const { saveConfig } = require('../config');
const { t } = require('../i18n');
const view = require('./view');
const pages = require('./pages');

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
  if (value === undefined || value === null || value === '') return '-';
  return String(value);
}

/**
 * Ask for one field and patch the draft. Returns false when the user cancelled the field.
 * 询问一个字段并写入草稿。用户取消该字段时返回 false。
 */
async function askField(config, draft, field) {
  const current = config[field.key];
  if (field.type === 'confirm') {
    const answer = await pages.promptConfirm(
      t('tui.settings.confirmCurrent', {
        label: t(field.label),
        value: current ? t('common.yes') : t('common.no'),
      }),
      { initial: !!current }
    );
    if (answer === null) return false;
    draft[field.key] = answer;
    return true;
  }

  if (field.type === 'select') {
    const values = field.options.map(([value]) => value);
    const picked = await pages.promptMenu(t(field.label), field.options.map(([value, labelKey]) => ({
      title: t(labelKey),
      value,
    })), { initial: Math.max(0, values.indexOf(String(current === undefined ? '' : current))) });
    if (picked === null) return false;
    draft[field.key] = picked;
    return true;
  }

  const initial = displayValue(config, field);
  const text = await pages.promptText(
    `${t(field.label)}${field.optional ? t('tui.settings.optional') : ''}`,
    {
      initial,
      validate: field.validate ? VALIDATORS[field.validate] : undefined,
    }
  );
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
 * Ask every field of one section. Returns false when the user cancelled the section.
 * 逐项询问某一组的全部字段。用户取消该组时返回 false。
 */
async function askSection(config, draft, section) {
  console.log('');
  console.log(view.colors.bold(`  ${t(section.titleKey)}`));
  console.log(view.colors.dim(`  ${t(section.descKey)}`));
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
 * Print the current values of every section once, as a compact summary.
 * 一次性打印每组设置的当前值，作为紧凑摘要。
 */
function printSummary(config) {
  console.log('');
  console.log(view.colors.bold(`  ${t('tui.settings.summaryTitle')}`));
  for (const section of SECTIONS) {
    const preview = section.fields
      .slice(0, 3)
      .map((f) => displayValue(config, f))
      .join(view.separator());
    console.log(
      `  ${view.colors.dim(view.padTo(t(section.titleKey), 14))}  ${view.colors.dim(view.truncateTo(preview, 60))}`
    );
  }
}

async function settingsFlow(config) {
  const draft = {};
  let saved = false;

  // Print the current values once: the summary stays at the top of the page instead of being
  // re-appended after every section (which pushed the whole page up on each visit).
  //
  // 当前值只打印一次：摘要固定留在页面顶部，不再每改一组就重印一遍（那会把整页往上顶）。
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
    // One line of feedback per section, with how many changes are waiting to be saved.
    // 每组只留一行反馈，并说明还有多少改动等待保存。
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
      (item) =>
        `${item.label}: ${view.colors.dim(String(item.before))} → ${view.colors.cyan(String(item.after))}`
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
  view.log(t('tui.settings.saved'));
  if (patch.site !== undefined && patch.site !== config.site) {
    view.log(t('tui.settings.siteChanged'));
  }
  return true;
}

module.exports = { settingsFlow, SECTIONS, changedPatch, settingsPatch: changedPatch };
