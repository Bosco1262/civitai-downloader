'use strict';

const { log, formatBytes, sleep } = require('./util');

async function fetchVersionMeta(site, versionId, userAgent) {
  const res = await fetch(`${site}/api/v1/model-versions/${versionId}`, {
    headers: { 'User-Agent': userAgent, Accept: 'application/json' },
    signal: AbortSignal.timeout(60000),
  });
  if (!res.ok) throw new Error(`HTTP ${res.status}`);
  return res.json();
}

function extractFiles(meta) {
  const modelFiles = (meta.files || []).filter((f) => f.type === 'Model');
  const primary = modelFiles.filter((f) => f.primary);
  const picked = primary.length ? primary : modelFiles;
  return picked.map((f) => ({
    fileId: f.id,
    name: f.name,
    sizeKB: f.sizeKB,
    bytes: Math.round(f.sizeKB * 1024),
    sha256: f.hashes && f.hashes.SHA256 ? String(f.hashes.SHA256).toUpperCase() : null,
    downloadUrl: f.downloadUrl,
  }));
}

async function buildPlan(site, items, userAgent) {
  const plan = [];
  let totalBytes = 0;
  for (let i = 0; i < items.length; i++) {
    const item = items[i];
    if (!item.versionId) {
      plan.push({ ...item, error: '没有最新版本' });
      continue;
    }
    try {
      const meta = await fetchVersionMeta(site, item.versionId, userAgent);
      const files = extractFiles(meta);
      if (!files.length) throw new Error('没有可下载的 Model 文件');
      const bytes = files.reduce((sum, f) => sum + f.bytes, 0);
      totalBytes += bytes;
      plan.push({ ...item, files, totalBytes: bytes });
      log(`[${i + 1}/${items.length}] ${item.name} | ${files.length} 个文件 | ${formatBytes(bytes)}`);
    } catch (e) {
      plan.push({ ...item, error: String(e.message || e) });
      log(`[${i + 1}/${items.length}] 元数据获取失败: ${item.name} -> ${e.message}`);
    }
    await sleep(300);
  }
  return { plan, totalBytes };
}

module.exports = { fetchVersionMeta, extractFiles, buildPlan };
