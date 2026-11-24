const express = require('express');
const router = express.Router();
const fs = require('fs');
const path = require('path');

// Las corridas del agente se guardan en `reportsDir/agent/<runId>` para no
// colisionar con las locales. Estos helper las hacen visibles por los mismos
// endpoints de siempre, resolviendo el id de la corrida a su reporte.
function findReportFile(reportsDir, id) {
  const direct = path.join(reportsDir, `${id}.json`);
  if (fs.existsSync(direct)) return direct;
  const agentDir = path.join(reportsDir, 'agent', path.basename(String(id)));
  if (fs.existsSync(agentDir)) {
    const json = fs.readdirSync(agentDir).find((f) => f.endsWith('.json'));
    if (json) return path.join(agentDir, json);
  }
  return null;
}

function findAssetsDir(reportsDir, id) {
  const direct = path.join(reportsDir, id, 'assets');
  if (fs.existsSync(direct)) return direct;
  const agentDir = path.join(reportsDir, 'agent', path.basename(String(id)));
  if (fs.existsSync(agentDir)) {
    for (const entry of fs.readdirSync(agentDir, { withFileTypes: true })) {
      if (!entry.isDirectory()) continue;
      const candidate = path.join(agentDir, entry.name, 'assets');
      if (fs.existsSync(candidate)) return candidate;
    }
  }
  return null;
}

function listReportFiles(reportsDir) {
  const files = fs.existsSync(reportsDir)
    ? fs.readdirSync(reportsDir)
      .filter((f) => f.endsWith('.json'))
      .map((f) => ({ id: f.replace(/\.json$/, ''), path: path.join(reportsDir, f) }))
    : [];
  const agentRoot = path.join(reportsDir, 'agent');
  if (fs.existsSync(agentRoot)) {
    for (const entry of fs.readdirSync(agentRoot, { withFileTypes: true })) {
      if (!entry.isDirectory()) continue;
      const reportPath = findReportFile(reportsDir, entry.name);
      if (reportPath) files.push({ id: entry.name, path: reportPath });
    }
  }
  return files;
}

router.get('/', (req, res) => {
  try {
    const REPORTS_DIR = req.profile.reportsDir;
    if (!fs.existsSync(REPORTS_DIR)) return res.json([]);
    const files = listReportFiles(REPORTS_DIR)
      .map(({ id, path: filePath }) => {
        try {
          const content = JSON.parse(fs.readFileSync(filePath, 'utf-8'));
          return { id, timestamp: content.timestamp, summary: content.summary };
        } catch {
          return null;
        }
      })
      .filter(Boolean)
      .sort((a, b) => new Date(b.timestamp) - new Date(a.timestamp));
    res.json(files);
  } catch (e) {
    res.status(500).json({ error: e.message });
  }
});

router.get('/analytics', (req, res) => {
  try {
    const REPORTS_DIR = req.profile.reportsDir;
    // ── Load last test collection (may not exist if user never clicked Actualizar Tests) ──
    const COLLECTION_PATH = req.profile.collection;
    let totalAvailable = null;
    const collectionByFile = {};  // fileName → available count

    if (fs.existsSync(COLLECTION_PATH)) {
      try {
        const col = JSON.parse(fs.readFileSync(COLLECTION_PATH, 'utf-8'));
        totalAvailable = col.total || 0;
        for (const [filePath, testIds] of Object.entries(col.files || {})) {
          const fileName = filePath.replace(/\\/g, '/').split('/').pop();
          collectionByFile[fileName] = (collectionByFile[fileName] || 0) + testIds.length;
        }
      } catch {}
    }

    const empty = {
      totalRuns: 0, totalExecutions: 0, totalPassed: 0, totalFailed: 0,
      passRate: 0, avgDuration: 0,
      totalAvailable, uniqueExecuted: 0, uniquePassed: 0, uniqueFailed: 0,
      neverExecuted: totalAvailable,
      byFile: [], timeline: []
    };

    if (!fs.existsSync(REPORTS_DIR)) return res.json(empty);

    const reportPaths = listReportFiles(REPORTS_DIR).map((f) => f.path);
    if (!reportPaths.length) return res.json(empty);

    // ── Load all reports chronologically (last status per test wins) ──
    const allReports = [];
    for (const filePath of reportPaths) {
      try { allReports.push(JSON.parse(fs.readFileSync(filePath, 'utf-8'))); } catch {}
    }
    allReports.sort((a, b) => new Date(a.timestamp) - new Date(b.timestamp));

    // ── Aggregate ──
    let totalRuns = 0, totalExecutions = 0, totalPassed = 0, totalFailed = 0, totalDuration = 0;
    const byFileAgg  = {};         // fileName → { passed, failed, total } (aggregate runs)
    const testLastStatus = {};     // testId   → last known status
    const timeline = [];

    for (const report of allReports) {
      totalRuns++;
      const p   = report.summary.passed || 0;
      const fa  = (report.summary.failed || 0) + (report.summary.errors || 0);
      const tot = report.summary.total || 0;
      totalPassed     += p;
      totalFailed     += fa;
      totalExecutions += tot;
      totalDuration   += report.summary.duration || 0;

      timeline.push({
        timestamp: report.timestamp,
        passed: p, failed: fa, total: tot,
        passRate: tot > 0 ? Math.round((p / tot) * 100) : 0
      });

      for (const test of (report.tests || [])) {
        const fileName = (test.id || '').split('::')[0].replace(/\\/g, '/').split('/').pop();
        if (!byFileAgg[fileName]) byFileAgg[fileName] = { file: fileName, passed: 0, failed: 0, total: 0 };
        byFileAgg[fileName].total++;
        if (test.status === 'passed') byFileAgg[fileName].passed++;
        else byFileAgg[fileName].failed++;
        testLastStatus[test.id] = test.status;   // overwrite → last status wins
      }
    }

    // ── Unique test counts ──
    const lastStatuses   = Object.values(testLastStatus);
    const uniqueExecuted = lastStatuses.length;
    const uniquePassed   = lastStatuses.filter(s => s === 'passed').length;
    const uniqueFailed   = uniqueExecuted - uniquePassed;
    const neverExecuted  = totalAvailable !== null ? Math.max(0, totalAvailable - uniqueExecuted) : null;

    // ── Per-file breakdown (merge aggregate + collection + unique) ──
    const byFileMap = { ...byFileAgg };

    // Add files in collection that have never been run
    for (const fileName of Object.keys(collectionByFile)) {
      if (!byFileMap[fileName]) byFileMap[fileName] = { file: fileName, passed: 0, failed: 0, total: 0 };
    }

    const byFileArr = Object.values(byFileMap).map(entry => {
      const avail = collectionByFile[entry.file] ?? null;

      // Per-file unique stats by scanning testLastStatus
      let fileUniquePassed = 0, fileUniqueExecuted = 0;
      for (const [id, status] of Object.entries(testLastStatus)) {
        const fn = id.split('::')[0].replace(/\\/g, '/').split('/').pop();
        if (fn === entry.file) {
          fileUniqueExecuted++;
          if (status === 'passed') fileUniquePassed++;
        }
      }
      const fileNeverExecuted = avail !== null ? Math.max(0, avail - fileUniqueExecuted) : null;

      return {
        file:             entry.file,
        totalAvailable:   avail,
        uniqueExecuted:   fileUniqueExecuted,
        uniquePassed:     fileUniquePassed,
        uniqueFailed:     fileUniqueExecuted - fileUniquePassed,
        neverExecuted:    fileNeverExecuted,
        aggregatePassed:  entry.passed,
        aggregateFailed:  entry.failed,
        aggregateTotal:   entry.total
      };
    }).sort((a, b) => (b.totalAvailable ?? b.uniqueExecuted) - (a.totalAvailable ?? a.uniqueExecuted));

    const passRate    = uniqueExecuted > 0 ? Math.round((uniquePassed / uniqueExecuted) * 100) : 0;
    const avgDuration = totalRuns > 0 ? totalDuration / totalRuns : 0;

    res.json({
      totalRuns, totalExecutions, totalPassed, totalFailed,
      passRate, avgDuration,
      totalAvailable, uniqueExecuted, uniquePassed, uniqueFailed, neverExecuted,
      byFile: byFileArr, timeline
    });
  } catch (e) {
    res.status(500).json({ error: e.message });
  }
});

router.get('/analytics/export', (req, res) => {
  try {
    const REPORTS_DIR = req.profile.reportsDir;
    const COLLECTION_PATH = req.profile.collection;
    let totalAvailable = null;
    const collectionByFile = {};

    if (fs.existsSync(COLLECTION_PATH)) {
      try {
        const col = JSON.parse(fs.readFileSync(COLLECTION_PATH, 'utf-8'));
        totalAvailable = col.total || 0;
        for (const [filePath, testIds] of Object.entries(col.files || {})) {
          const fileName = filePath.replace(/\\/g, '/').split('/').pop();
          collectionByFile[fileName] = (collectionByFile[fileName] || 0) + testIds.length;
        }
      } catch {}
    }

    const emptySummary = {
      totalRuns: 0, totalExecutions: 0, totalPassed: 0, totalFailed: 0,
      passRate: 0, avgDuration: 0,
      totalAvailable, uniqueExecuted: 0, uniquePassed: 0, uniqueFailed: 0,
      neverExecuted: totalAvailable,
      byFile: [], timeline: []
    };

    if (!fs.existsSync(REPORTS_DIR)) {
      return res.json({
        type: 'analytics',
        generatedAt: new Date().toISOString(),
        profile: { id: req.profile.id, name: req.profile.name },
        summary: emptySummary,
        timeline: [],
        byFile: [],
        recentRuns: [],
        sections: ['cover', 'kpis', 'trend', 'byFile', 'recentRuns', 'footer'],
        source: 'api-export',
      });
    }

    const reportFiles = listReportFiles(REPORTS_DIR);
    const allReports = [];
    for (const { id, path: filePath } of reportFiles) {
      try {
        const parsed = JSON.parse(fs.readFileSync(filePath, 'utf-8'));
        if (!parsed.id) parsed.id = id;
        allReports.push(parsed);
      } catch {}
    }
    allReports.sort((a, b) => new Date(a.timestamp) - new Date(b.timestamp));

    let totalRuns = 0, totalExecutions = 0, totalPassed = 0, totalFailed = 0, totalDuration = 0;
    const byFileAgg = {};
    const testLastStatus = {};
    const timeline = [];

    for (const report of allReports) {
      totalRuns++;
      const p = report.summary?.passed || 0;
      const fa = (report.summary?.failed || 0) + (report.summary?.errors || 0);
      const tot = report.summary?.total || 0;
      totalPassed += p;
      totalFailed += fa;
      totalExecutions += tot;
      totalDuration += report.summary?.duration || 0;

      timeline.push({
        timestamp: report.timestamp,
        passed: p, failed: fa, total: tot,
        passRate: tot > 0 ? Math.round((p / tot) * 100) : 0
      });

      for (const test of (report.tests || [])) {
        const fileName = (test.id || '').split('::')[0].replace(/\\/g, '/').split('/').pop();
        if (!byFileAgg[fileName]) byFileAgg[fileName] = { file: fileName, passed: 0, failed: 0, total: 0 };
        byFileAgg[fileName].total++;
        if (test.status === 'passed') byFileAgg[fileName].passed++;
        else byFileAgg[fileName].failed++;
        testLastStatus[test.id] = test.status;
      }
    }

    const lastStatuses = Object.values(testLastStatus);
    const uniqueExecuted = lastStatuses.length;
    const uniquePassed = lastStatuses.filter(s => s === 'passed').length;
    const uniqueFailed = uniqueExecuted - uniquePassed;
    const neverExecuted = totalAvailable !== null ? Math.max(0, totalAvailable - uniqueExecuted) : null;

    const byFileMap = { ...byFileAgg };
    for (const fileName of Object.keys(collectionByFile)) {
      if (!byFileMap[fileName]) byFileMap[fileName] = { file: fileName, passed: 0, failed: 0, total: 0 };
    }

    const byFileArr = Object.values(byFileMap).map(entry => {
      const avail = collectionByFile[entry.file] ?? null;
      let fileUniquePassed = 0, fileUniqueExecuted = 0;
      for (const [id, status] of Object.entries(testLastStatus)) {
        const fn = id.split('::')[0].replace(/\\/g, '/').split('/').pop();
        if (fn === entry.file) {
          fileUniqueExecuted++;
          if (status === 'passed') fileUniquePassed++;
        }
      }
      const fileNeverExecuted = avail !== null ? Math.max(0, avail - fileUniqueExecuted) : null;
      return {
        file: entry.file,
        totalAvailable: avail,
        uniqueExecuted: fileUniqueExecuted,
        uniquePassed: fileUniquePassed,
        uniqueFailed: fileUniqueExecuted - fileUniquePassed,
        neverExecuted: fileNeverExecuted,
        aggregatePassed: entry.passed,
        aggregateFailed: entry.failed,
        aggregateTotal: entry.total
      };
    }).sort((a, b) => (b.totalAvailable ?? b.uniqueExecuted) - (a.totalAvailable ?? a.uniqueExecuted));

    const passRate = uniqueExecuted > 0 ? Math.round((uniquePassed / uniqueExecuted) * 100) : 0;
    const avgDuration = totalRuns > 0 ? totalDuration / totalRuns : 0;

    const summary = {
      totalRuns, totalExecutions, totalPassed, totalFailed,
      passRate, avgDuration,
      totalAvailable, uniqueExecuted, uniquePassed, uniqueFailed, neverExecuted,
      byFile: byFileArr, timeline
    };

    const recentRuns = [...allReports]
      .sort((a, b) => new Date(b.timestamp) - new Date(a.timestamp))
      .slice(0, 10)
      .map(r => ({ id: r.id, timestamp: r.timestamp, summary: r.summary }));

    res.json({
      type: 'analytics',
      generatedAt: new Date().toISOString(),
      profile: { id: req.profile.id, name: req.profile.name },
      summary,
      timeline,
      byFile: byFileArr,
      recentRuns,
      sections: ['cover', 'kpis', 'trend', 'byFile', 'recentRuns', 'footer'],
      source: 'api-export',
    });
  } catch (e) {
    res.status(500).json({ error: e.message });
  }
});

router.get('/:id/assets/*', (req, res) => {
  try {
    const reportId = req.params.id;
    const relPath = req.params[0] || '';
    const found = findAssetsDir(req.profile.reportsDir, reportId);
    if (!found) return res.status(404).json({ error: 'Asset not found' });
    const assetsRoot = path.resolve(found);
    const fullPath = path.resolve(assetsRoot, relPath);
    if (!fullPath.startsWith(assetsRoot + path.sep) && fullPath !== assetsRoot) {
      return res.status(403).json({ error: 'Acceso denegado' });
    }
    if (!fs.existsSync(fullPath) || !fs.statSync(fullPath).isFile()) {
      return res.status(404).json({ error: 'Asset not found' });
    }
    res.sendFile(fullPath);
  } catch (e) {
    res.status(500).json({ error: e.message });
  }
});

router.get('/:id', (req, res) => {
  try {
    const filePath = findReportFile(req.profile.reportsDir, req.params.id);
    if (!filePath) return res.status(404).json({ error: 'Report not found' });
    res.json(JSON.parse(fs.readFileSync(filePath, 'utf-8')));
  } catch (e) {
    res.status(500).json({ error: e.message });
  }
});

router.get('/:id/export', (req, res) => {
  try {
    const filePath = findReportFile(req.profile.reportsDir, req.params.id);
    if (!filePath) return res.status(404).json({ error: 'Report not found' });
    const report = JSON.parse(fs.readFileSync(filePath, 'utf-8'));
    const tests = (report.tests || []).map(t => ({
      ...t,
      attachments: (t.attachments || []).map(a => ({
        ...a,
        kind: a.kind || (String(a.contentType || '').startsWith('image/') || /\.(png|jpe?g|gif|webp)$/i.test(String(a.path || a.assetPath || a.name || '')) ? 'image' : 'other'),
      })),
    }));

    res.json({
      type: 'run',
      generatedAt: new Date().toISOString(),
      profile: { id: req.profile.id, name: req.profile.name },
      report: { id: req.params.id, timestamp: report.timestamp },
      summary: report.summary,
      tests,
      sections: ['cover', 'summary', 'tests', 'evidence', 'footer'],
      source: 'api-export',
    });
  } catch (e) {
    res.status(500).json({ error: e.message });
  }
});

router.get('/:id/download/json', (req, res) => {
  const filePath = findReportFile(req.profile.reportsDir, req.params.id);
  if (!filePath) return res.status(404).json({ error: 'Report not found' });
  res.download(filePath);
});

router.get('/:id/download/html', (req, res) => {
  try {
    const filePath = findReportFile(req.profile.reportsDir, req.params.id);
    if (!filePath) return res.status(404).json({ error: 'Report not found' });
    const report = JSON.parse(fs.readFileSync(filePath, 'utf-8'));
    res.setHeader('Content-Type', 'text/html');
    res.send(generateHtmlReport(report));
  } catch (e) {
    res.status(500).json({ error: e.message });
  }
});

router.delete('/:id', (req, res) => {
  try {
    const filePath = findReportFile(req.profile.reportsDir, req.params.id);
    if (!filePath) return res.status(404).json({ error: 'Report not found' });
    fs.unlinkSync(filePath);
    res.json({ success: true });
  } catch (e) {
    res.status(500).json({ error: e.message });
  }
});

function generateHtmlReport(report) {
  const { timestamp, summary, tests } = report;
  const passRate = summary.total > 0 ? Math.round((summary.passed / summary.total) * 100) : 0;
  const testRows = tests.map(t => `
    <tr class="${t.status}">
      <td>${escapeHtml(t.id)}</td>
      <td class="status-cell">${t.status === 'passed' ? '✅' : t.status === 'failed' ? '❌' : '⚠️'} ${t.status}</td>
      <td>${t.duration ? t.duration.toFixed(2) + 's' : '-'}</td>
      <td><pre class="error-msg">${escapeHtml(t.errorMsg || '')}</pre></td>
    </tr>`).join('');

  return `<!DOCTYPE html>
<html lang="es">
<head>
<meta charset="UTF-8">
<meta name="viewport" content="width=device-width, initial-scale=1.0">
<title>Test Report - ${timestamp}</title>
<style>
  body{font-family:-apple-system,BlinkMacSystemFont,'Segoe UI',sans-serif;margin:0;padding:24px;background:#f5f5f5;color:#333}
  h1{color:#1e293b}
  .summary{display:grid;grid-template-columns:repeat(auto-fit,minmax(120px,1fr));gap:16px;margin:24px 0}
  .stat{background:white;border-radius:8px;padding:16px;text-align:center;box-shadow:0 1px 4px rgba(0,0,0,.1)}
  .stat .num{font-size:2em;font-weight:bold}
  .stat .label{color:#666;font-size:.85em}
  .passed .num{color:#22c55e}.failed .num{color:#ef4444}.total .num{color:#3b82f6}.rate .num{color:#f59e0b}
  table{width:100%;border-collapse:collapse;background:white;border-radius:8px;overflow:hidden;box-shadow:0 1px 4px rgba(0,0,0,.1)}
  th{background:#1e293b;color:white;padding:12px 16px;text-align:left}
  td{padding:10px 16px;border-bottom:1px solid #eee}
  tr.passed td:first-child{border-left:3px solid #22c55e}
  tr.failed td:first-child{border-left:3px solid #ef4444}
  tr.error td:first-child{border-left:3px solid #f59e0b}
  pre.error-msg{margin:0;font-size:.8em;color:#ef4444;white-space:pre-wrap;max-width:400px}
  .meta{color:#666;font-size:.9em;margin-bottom:8px}
</style>
</head>
<body>
<h1>Test Execution Report</h1>
<p class="meta">Executed: ${new Date(timestamp).toLocaleString()}</p>
<div class="summary">
  <div class="stat total"><div class="num">${summary.total}</div><div class="label">Total</div></div>
  <div class="stat passed"><div class="num">${summary.passed}</div><div class="label">Passed</div></div>
  <div class="stat failed"><div class="num">${(summary.failed || 0) + (summary.errors || 0)}</div><div class="label">Failed</div></div>
  <div class="stat rate"><div class="num">${passRate}%</div><div class="label">Pass Rate</div></div>
  <div class="stat"><div class="num">${summary.duration ? summary.duration.toFixed(1) + 's' : '-'}</div><div class="label">Duration</div></div>
</div>
<table>
  <thead><tr><th>Test</th><th>Status</th><th>Duration</th><th>Error</th></tr></thead>
  <tbody>${testRows}</tbody>
</table>
</body>
</html>`;
}

function escapeHtml(str) {
  return String(str).replace(/&/g,'&amp;').replace(/</g,'&lt;').replace(/>/g,'&gt;');
}

module.exports = router;
