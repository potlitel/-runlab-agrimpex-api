const express = require('express');
const router = express.Router();
const fs = require('fs');
const path = require('path');
const { EVIDENCE_MANIFEST } = require('../services/playwrightRunner');

const IMG_EXT = new Set(['.png', '.jpg', '.jpeg', '.gif', '.webp', '.bmp']);
const VIDEO_EXT = new Set(['.webm', '.mp4']);
const TRACE_EXT = new Set(['.zip']);
const CONTEXT_EXT = new Set(['.md', '.txt']);
const EVIDENCE_EXT = new Set([...IMG_EXT, ...VIDEO_EXT, ...TRACE_EXT, ...CONTEXT_EXT]);

function getConfig(req) {
  try { return JSON.parse(fs.readFileSync(req.profile.config, 'utf-8')); }
  catch { return {}; }
}

// Carpeta de evidencias: override en config o <projectPath>/reports/errors.
function resolveFolder(req) {
  const cfg = getConfig(req);
  if (cfg.errorImagesPath) return cfg.errorImagesPath;
  if (cfg.projectPath) return path.join(cfg.projectPath, 'reports', 'errors');
  return '';
}

function evidenceKind(name = '', contentType = '') {
  const ext = path.extname(String(name)).toLowerCase();
  const ct = String(contentType).toLowerCase();
  if (IMG_EXT.has(ext) || ct.startsWith('image/')) return 'image';
  if (VIDEO_EXT.has(ext) || ct.startsWith('video/')) return 'video';
  if (TRACE_EXT.has(ext) || ct === 'application/zip' || String(name).toLowerCase().includes('trace')) return 'trace';
  if (CONTEXT_EXT.has(ext) || ct === 'text/markdown' || String(name).toLowerCase().includes('error-context')) return 'context';
  return 'other';
}

function isEvidenceFile(name = '', contentType = '') {
  const ext = path.extname(String(name)).toLowerCase();
  if (EVIDENCE_EXT.has(ext)) return true;
  const ct = String(contentType).toLowerCase();
  return ct.startsWith('image/') || ct.startsWith('video/') || ct === 'application/zip' || ct === 'text/markdown';
}

function safeStat(filePath) {
  try { return fs.statSync(filePath); } catch { return null; }
}

function readReportFiles(reportsDir) {
  try {
    if (!fs.existsSync(reportsDir)) return [];
    return fs.readdirSync(reportsDir)
      .filter(f => f.endsWith('.json'))
      .map(f => {
        const full = path.join(reportsDir, f);
        const st = safeStat(full);
        return { file: f, full, mtime: st ? st.mtimeMs : 0 };
      })
      .sort((a, b) => b.mtime - a.mtime);
  } catch {
    return [];
  }
}

function collectFolderItems(req, folder) {
  if (!folder || !fs.existsSync(folder)) return [];
  let entries = [];
  try { entries = fs.readdirSync(folder, { withFileTypes: true }); } catch { return []; }
  let manifestItems = {};
  try {
    const manifest = JSON.parse(fs.readFileSync(path.join(folder, EVIDENCE_MANIFEST), 'utf-8'));
    manifestItems = (manifest && manifest.items) || {};
  } catch { /* reportes antiguos no tienen manifiesto */ }
  const items = [];
  for (const ent of entries) {
    if (!ent.isFile()) continue;
    const name = ent.name;
    if (!isEvidenceFile(name)) continue;
    const meta = manifestItems[name] || {};
    const st = safeStat(path.join(folder, name));
    const kind = evidenceKind(name);
    items.push({
      id: `folder:${name}`,
      name,
      displayName: meta.displayName || name,
      kind,
      source: 'folder',
      mtime: st ? st.mtimeMs : 0,
      timestamp: st ? new Date(st.mtimeMs).toISOString() : null,
      size: st ? st.size : 0,
      reportId: meta.reportId || null,
      reportTimestamp: meta.reportTimestamp || null,
      testId: meta.testId || null,
      status: meta.status || null,
      evidenceSource: meta.evidenceSource || null,
      captureName: meta.name || null,
      contentType: meta.contentType || null,
      assetPath: meta.assetPath || null,
      width: meta.width ?? null,
      height: meta.height ?? null,
      url: `/api/errors/file?name=${encodeURIComponent(name)}`,
      downloadUrl: `/api/errors/file?name=${encodeURIComponent(name)}`,
    });
  }
  return items;
}

function collectReportItems(req) {
  const reportsDir = req.profile.reportsDir;
  const files = readReportFiles(reportsDir);
  const items = [];
  const seen = new Set();

  for (const rf of files) {
    let report;
    try { report = JSON.parse(fs.readFileSync(rf.full, 'utf-8')); } catch { continue; }
    const reportId = report.id || rf.file.replace(/\.json$/, '');
    const reportTimestamp = report.timestamp || null;
    const reportTsMs = reportTimestamp ? new Date(reportTimestamp).getTime() : rf.mtime;

    // 1) Capturas de tests passed/failed/error con assetPath
    for (const test of (report.tests || [])) {
      if (!['passed', 'failed', 'error'].includes(test.status)) continue;
      const atts = Array.isArray(test.attachments) ? test.attachments : [];
      for (let i = 0; i < atts.length; i++) {
        const att = atts[i] || {};
        const assetPath = att.assetPath;
        if (!assetPath || typeof assetPath !== 'string') continue;
        if (!isEvidenceFile(assetPath, att.contentType || att.name || '')) continue;
        const key = `${reportId}:${assetPath}`;
        if (seen.has(key)) continue;
        seen.add(key);
        const abs = path.join(reportsDir, reportId, 'assets', assetPath);
        const st = safeStat(abs);
        const base = path.basename(assetPath);
        const kind = evidenceKind(assetPath, att.contentType || att.name || '');
        const assetUrl = `/api/reports/${encodeURIComponent(reportId)}/assets/${assetPath.split('/').map(encodeURIComponent).join('/')}`;
        items.push({
          id: `report:${reportId}:${i}:${assetPath}`,
          name: att.name || base,
          displayName: att.name || base,
          kind,
          source: 'report',
          mtime: st ? st.mtimeMs : reportTsMs,
          timestamp: reportTimestamp,
          size: st ? st.size : null,
          reportId,
          reportTimestamp,
          testId: test.id || null,
          status: test.status,
          evidenceSource: att.evidenceSource || (kind === 'image' ? 'capture' : 'failure-artifact'),
          captureName: att.name || null,
          assetPath,
          contentType: att.contentType || null,
          width: att.width ?? null,
          height: att.height ?? null,
          url: assetUrl,
          downloadUrl: assetUrl,
        });
      }
    }

    // 2) error-context.md en assets/test-results (aunque no esté en adjuntos)
    const testResultsDir = path.join(reportsDir, reportId, 'assets', 'test-results');
    const stack = [testResultsDir];
    while (stack.length) {
      const dir = stack.pop();
      let ents = [];
      try { ents = fs.readdirSync(dir, { withFileTypes: true }); } catch { continue; }
      for (const ent of ents) {
        const full = path.join(dir, ent.name);
        if (ent.isDirectory()) { stack.push(full); continue; }
        if (!ent.isFile()) continue;
        if (ent.name.toLowerCase() !== 'error-context.md') continue;
        const rel = path.relative(path.join(reportsDir, reportId, 'assets'), full).replace(/\\/g, '/');
        const key = `${reportId}:${rel}`;
        if (seen.has(key)) continue;
        seen.add(key);
        const st = safeStat(full);
        const assetUrl = `/api/reports/${encodeURIComponent(reportId)}/assets/${rel.split('/').map(encodeURIComponent).join('/')}`;
        items.push({
          id: `report:${reportId}:ctx:${rel}`,
          name: ent.name,
          displayName: ent.name,
          kind: 'context',
          source: 'report',
          mtime: st ? st.mtimeMs : reportTsMs,
          timestamp: reportTimestamp,
          size: st ? st.size : null,
          reportId,
          reportTimestamp,
          testId: null,
          status: 'failed',
          assetPath: rel,
          contentType: 'text/markdown',
          url: assetUrl,
          downloadUrl: assetUrl,
        });
      }
    }
  }

  return items;
}

// GET /api/errors/images → evidencia unificada (carpeta + reportes)
router.get('/images', (req, res) => {
  try {
    const folder = resolveFolder(req);
    const configured = !!folder;
    const folderExists = configured && fs.existsSync(folder);
    const folderMissing = configured && !folderExists;

    const folderItems = folderExists ? collectFolderItems(req, folder) : [];
    const reportItems = collectReportItems(req);

    // Merge: report items first? or by mtime desc overall
    const items = [...reportItems, ...folderItems].sort((a, b) => (b.mtime || 0) - (a.mtime || 0));

    res.json({
      configured,
      folder,
      folderMissing,
      // Compatibilidad: imágenes de carpeta (vista legacy)
      images: folderExists ? folderItems.filter(i => i.kind === 'image').map(i => ({ name: i.name, mtime: i.mtime, size: i.size })) : [],
      items,
      counts: {
        total: items.length,
        folder: folderItems.length,
        reports: reportItems.length,
      },
    });
  } catch (e) {
    res.status(500).json({ error: e.message, images: [], items: [] });
  }
});

function serveFolderFile(req, res, allowedExts) {
  try {
    const folder = resolveFolder(req);
    if (!folder) return res.status(400).send('Carpeta no configurada');
    const name = String(req.query.name || '');
    const filePath = path.resolve(folder, name);
    const root = path.resolve(folder);
    if (!filePath.startsWith(root + path.sep) && filePath !== root) return res.status(403).send('Acceso denegado');
    if (!fs.existsSync(filePath) || !fs.statSync(filePath).isFile()) return res.status(404).send('Archivo no encontrado');
    const ext = path.extname(filePath).toLowerCase();
    if (allowedExts && !allowedExts.has(ext)) return res.status(400).send('Tipo de archivo no permitido');
    res.sendFile(filePath);
  } catch (e) {
    res.status(500).send(e.message);
  }
}

// GET /api/errors/image?name=... → imagen de carpeta (compat)
router.get('/image', (req, res) => serveFolderFile(req, res, IMG_EXT));

// GET /api/errors/file?name=... → archivo de evidencia de carpeta (imagen/video/trace/context)
router.get('/file', (req, res) => serveFolderFile(req, res, EVIDENCE_EXT));

module.exports = router;
// Helpers expuestos para pruebas del contrato de evidencia.
module.exports.collectFolderItems = collectFolderItems;
module.exports.collectReportItems = collectReportItems;
module.exports.evidenceKind = evidenceKind;
