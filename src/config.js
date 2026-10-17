'use strict';

const fs = require('fs');
const path = require('path');

const ROOT = path.resolve(__dirname, '..');

const DEFAULTS = {
  site: 'https://civitai.red',
  outDir: 'downloads',
  profileDir: '.data/chrome-profile',
  chromePath: '',
  debugPort: 9222,
  userAgent:
    'Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/155.0.0.0 Safari/537.36',
};

function loadConfig() {
  const file = path.join(ROOT, 'config.json');
  let cfg = { ...DEFAULTS };
  if (fs.existsSync(file)) {
    let user;
    try {
      user = JSON.parse(fs.readFileSync(file, 'utf8'));
    } catch (e) {
      throw new Error(`config.json 解析失败: ${e.message}`);
    }
    cfg = { ...cfg, ...user };
  }
  cfg.site = String(cfg.site || DEFAULTS.site).replace(/\/+$/, '');
  if (!/^https?:\/\//i.test(cfg.site)) {
    throw new Error('config.json 中 site 必须是 http(s) 开头的完整地址');
  }
  cfg.outDir = path.resolve(ROOT, String(cfg.outDir || DEFAULTS.outDir));
  cfg.profileDir = path.resolve(ROOT, String(cfg.profileDir || DEFAULTS.profileDir));
  cfg.dataDir = path.join(ROOT, '.data');
  cfg.cookiesFile = path.join(cfg.dataDir, 'cookies.txt');
  cfg.debugPort = Number(cfg.debugPort) || DEFAULTS.debugPort;
  return cfg;
}

module.exports = { ROOT, DEFAULTS, loadConfig };
