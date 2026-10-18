'use strict';

const prompts = require('prompts');
const { saveConfig } = require('../config');
const { t } = require('../i18n');
const view = require('./view');

async function settingsFlow(config) {
  const ans = await prompts([
    {
      type: 'text',
      name: 'site',
      message: t('tui.settings.site'),
      initial: config.site,
      validate: (v) => /^https?:\/\/\S+$/i.test(String(v).trim()) || t('tui.settings.invalidSite'),
    },
    {
      type: 'text',
      name: 'outDir',
      message: t('tui.settings.outDir', { root: config.root }),
      initial: config.outDir,
      validate: (v) => (String(v).trim() ? true : t('tui.settings.notEmpty')),
    },
    {
      type: 'text',
      name: 'chromePath',
      message: t('tui.settings.chromePath'),
      initial: config.chromePath || '',
    },
    {
      type: 'text',
      name: 'debugPort',
      message: t('tui.settings.debugPort'),
      initial: String(config.debugPort),
      validate: (v) => /^\d{2,5}$/.test(String(v).trim()) || t('tui.settings.invalidPort'),
    },
    {
      type: 'text',
      name: 'userAgent',
      message: t('tui.settings.userAgent'),
      initial: String(config.userAgent),
      validate: (v) => (String(v).trim() ? true : t('tui.settings.notEmpty')),
    },
    {
      type: 'text',
      name: 'jobs',
      message: t('tui.settings.jobs'),
      initial: String(config.jobs),
      validate: (v) => (/^[1-8]$/.test(String(v).trim()) ? true : t('tui.settings.invalidJobs')),
    },
    {
      type: 'text',
      name: 'metaConcurrency',
      message: t('tui.settings.metaConcurrency'),
      initial: String(config.metaConcurrency),
      validate: (v) => (/^[1-8]$/.test(String(v).trim()) ? true : t('tui.settings.invalidJobs')),
    },
    {
      type: 'text',
      name: 'apiRateLimit',
      message: t('tui.settings.apiRateLimit'),
      initial: String(config.apiRateLimit),
      validate: (v) => (/^\d+$/.test(String(v).trim()) ? true : t('tui.settings.invalidInteger')),
    },
    {
      type: 'text',
      name: 'proxy',
      message: t('tui.settings.proxy'),
      initial: config.proxy || '',
      validate: (v) =>
        !String(v).trim() ||
        /^(https?|socks[45]?):\/\/\S+$/i.test(String(v).trim()) ||
        t('tui.settings.invalidProxy'),
    },
    {
      type: 'text',
      name: 'fileTypes',
      message: t('tui.settings.fileTypes'),
      initial: (config.fileTypes || ['Model']).join(','),
      validate: (v) => (String(v).trim() ? true : t('tui.settings.invalidFileTypes')),
    },
    {
      type: 'text',
      name: 'downloadAttempts',
      message: t('tui.settings.downloadAttempts'),
      initial: String(config.downloadAttempts),
      validate: (v) => (/^\d+$/.test(String(v).trim()) ? true : t('tui.settings.invalidInteger')),
    },
    {
      type: 'select',
      name: 'engine',
      message: t('tui.settings.engine'),
      choices: [
        { title: t('tui.settings.engineCurl'), value: 'curl' },
        { title: t('tui.settings.engineAuto'), value: 'auto' },
        { title: t('tui.settings.engineAria2'), value: 'aria2' },
      ],
      initial: ['curl', 'auto', 'aria2'].indexOf(String(config.engine)),
    },
    {
      type: 'select',
      name: 'dedup',
      message: t('tui.settings.dedup'),
      choices: [
        { title: t('tui.settings.dedupOff'), value: 'off' },
        { title: t('tui.settings.dedupHardlink'), value: 'hardlink' },
        { title: t('tui.settings.dedupCopy'), value: 'copy' },
      ],
      initial: ['off', 'hardlink', 'copy'].indexOf(String(config.dedup)),
    },
    {
      type: 'text',
      name: 'notifyWebhook',
      message: t('tui.settings.notifyWebhook'),
      initial: config.notifyWebhook || '',
      validate: (v) =>
        !String(v).trim() || /^https?:\/\/\S+$/i.test(String(v).trim()) || t('tui.settings.invalidSite'),
    },
    {
      type: 'confirm',
      name: 'notifyToast',
      message: t('tui.settings.notifyToast'),
      initial: !!config.notifyToast,
    },
    {
      type: 'select',
      name: 'language',
      message: t('tui.settings.language'),
      choices: [
        { title: t('tui.settings.languageAuto'), value: '' },
        { title: t('tui.settings.languageZh'), value: 'zh-CN' },
        { title: t('tui.settings.languageEn'), value: 'en' },
      ],
      initial: ['', 'zh-CN', 'en'].indexOf(String(config.language || '')),
    },
    {
      type: 'select',
      name: 'headless',
      message: t('tui.settings.headless'),
      choices: [
        { title: t('tui.settings.headlessAuto'), value: 'auto' },
        { title: t('tui.settings.headlessAlways'), value: 'always' },
        { title: t('tui.settings.headlessNever'), value: 'never' },
      ],
      initial: ['auto', 'always', 'never'].indexOf(String(config.headless || 'auto')),
    },
  ]);

  if (!ans || ans.site === undefined) {
    view.log(t('tui.settings.cancelled'));
    return false;
  }

  const patch = {
    site: String(ans.site).trim().replace(/\/+$/, ''),
    outDir: String(ans.outDir).trim(),
    chromePath: String(ans.chromePath).trim(),
    debugPort: Number(ans.debugPort),
    userAgent: String(ans.userAgent).trim(),
    jobs: Number(ans.jobs),
    metaConcurrency: Number(ans.metaConcurrency),
    apiRateLimit: Number(ans.apiRateLimit),
    proxy: String(ans.proxy).trim(),
    fileTypes: String(ans.fileTypes)
      .split(',')
      .map((s) => s.trim())
      .filter(Boolean),
    downloadAttempts: Number(ans.downloadAttempts),
    engine: String(ans.engine),
    dedup: String(ans.dedup),
    notifyWebhook: String(ans.notifyWebhook || '').trim(),
    notifyToast: !!ans.notifyToast,
    language: String(ans.language || ''),
    headless: String(ans.headless || 'auto'),
  };

  saveConfig(config, patch);
  view.log(t('tui.settings.saved'));
  if (patch.site !== config.site) {
    view.log(t('tui.settings.siteChanged'));
  }
  return true;
}

module.exports = { settingsFlow };
