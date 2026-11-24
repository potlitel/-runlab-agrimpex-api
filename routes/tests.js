const express = require('express');
const router = express.Router();
const fs = require('fs');
const path = require('path');
const { collectTests, getCached, setCached } = require('../services/playwrightCollector');
const { runTests, abortExecution, isRunning } = require('../services/playwrightRunner');
const { readEnv } = require('../services/envManager');
const { getEntorno } = require('../services/profileManager');
const { ensureGrid } = require('../services/dockerControl');

function getConfig(req) {
  return JSON.parse(fs.readFileSync(req.profile.config, 'utf-8'));
}

function getRunnerCmd(cfg) {
  // playwrightCmd preferido; pytestCmd deprecado (lectura tolerante)
  if (cfg && cfg.playwrightCmd) return cfg.playwrightCmd;
  if (cfg && cfg.pytestCmd) {
    console.warn('[config] `pytestCmd` está deprecado; migra a `playwrightCmd`.');
    return cfg.pytestCmd;
  }
  return 'npx playwright';
}

function resolveEnvVars(req, entornoName, envFile, projectPath) {
  if (entornoName) {
    const vars = getEntorno(req.profile.entornos, entornoName);
    if (vars) return Object.fromEntries(vars.filter(v => !v.isComment && v.key).map(v => [v.key, v.value]));
  }
  if (envFile && projectPath) {
    const fullPath = path.join(projectPath, path.basename(envFile));
    if (fs.existsSync(fullPath)) {
      return Object.fromEntries(
        readEnv(fullPath).filter(v => !v.isComment && v.key).map(v => [v.key, v.value])
      );
    }
  }
  return {};
}

// Returns last collection from memory or disk (fast — no CLI re-run)
router.get('/cached', (req, res) => {
  const mem = getCached(req.profile.id);
  if (mem) return res.json(mem);

  const cachePath = req.profile.collection;
  if (!fs.existsSync(cachePath)) return res.json({ files: {}, total: 0, timestamp: null, projects: [] });
  try {
    const data = JSON.parse(fs.readFileSync(cachePath, 'utf-8'));
    if (!data.projects) data.projects = [];
    setCached(req.profile.id, data);
    res.json(data);
  } catch {
    res.json({ files: {}, total: 0, timestamp: null, projects: [] });
  }
});

router.get('/collect', async (req, res) => {
  try {
    const cfg = getConfig(req);
    const { projectPath } = cfg;
    const runnerCmd = getRunnerCmd(cfg);
    if (!projectPath) return res.status(400).json({ error: 'Project path not configured' });
    const result = await collectTests(projectPath, runnerCmd);

    const payload = {
      timestamp: new Date().toISOString(),
      files: result.files,
      total: result.total || 0,
      projects: result.projects || [],
      ...(result.errorFiles ? { errorFiles: result.errorFiles } : {})
    };

    // Caché en memoria y en disco
    setCached(req.profile.id, payload);
    try {
      const dataDir = req.profile.dataDir;
      if (!fs.existsSync(dataDir)) fs.mkdirSync(dataDir, { recursive: true });
      fs.writeFileSync(req.profile.collection, JSON.stringify(payload, null, 2), 'utf-8');
    } catch {}

    res.json(payload);
  } catch (e) {
    res.status(500).json({ error: e.message, raw: e.raw || '' });
  }
});

router.post('/run', async (req, res) => {
  try {
    if (isRunning(req.profile.id)) return res.status(409).json({ error: 'Execution already in progress' });
    const { testIds, profileName, envFile, useDocker, params, paramsByTest, project, grep, workers } = req.body;
    if (!testIds || !testIds.length) return res.status(400).json({ error: 'No tests selected' });
    const cfg = getConfig(req);
    const { projectPath, seleniumRemoteUrl, envPath } = cfg;
    const runnerCmd = getRunnerCmd(cfg);
    if (!projectPath) return res.status(400).json({ error: 'Project path not configured' });

    let envVars = resolveEnvVars(req, profileName, envFile, projectPath);
    if (Object.keys(envVars).length === 0 && envPath && fs.existsSync(envPath)) {
      envVars = Object.fromEntries(
        readEnv(envPath).filter(v => !v.isComment && v.key).map(v => [v.key, v.value])
      );
    }
    if (params && typeof params === 'object') {
      for (const [k, v] of Object.entries(params)) {
        if (k && v !== undefined && v !== null && String(v).trim() !== '') {
          envVars[String(k).trim()] = String(v);
        }
      }
    }
    if (seleniumRemoteUrl) envVars.SELENIUM_REMOTE_URL = seleniumRemoteUrl;
    const io = req.app.get('io');

    if (useDocker && seleniumRemoteUrl) {
      io.to(`profile:${req.profile.id}`).emit('execution:preparing', { message: 'Iniciando Selenium en Docker (esperando healthcheck)...' });
      try {
        await ensureGrid(io, req.profile);
      } catch (e) {
        io.to(`profile:${req.profile.id}`).emit('execution:prepare-failed', { error: e.message });
        return res.status(500).json({ error: e.message });
      }
    }

    const cleanPerTest = {};
    if (paramsByTest && typeof paramsByTest === 'object') {
      for (const [id, kv] of Object.entries(paramsByTest)) {
        if (!kv || typeof kv !== 'object') continue;
        const o = {};
        for (const [k, v] of Object.entries(kv)) {
          if (k && v !== undefined && v !== null && String(v).trim() !== '') o[String(k).trim()] = String(v);
        }
        if (Object.keys(o).length) cleanPerTest[id] = o;
      }
    }

    const options = {};
    if (project) options.project = project;
    if (grep) options.grep = grep;
    if (workers) options.workers = workers;
    if (cfg && cfg.evidence) options.evidence = cfg.evidence;
    options.errorImagesPath = cfg && cfg.errorImagesPath ? cfg.errorImagesPath : '';

    runTests(io, req.profile.id, testIds, projectPath, runnerCmd, envVars, cleanPerTest, req.profile.reportsDir, options);
    res.json({ success: true, message: `Starting ${testIds.length} tests` });
  } catch (e) {
    res.status(500).json({ error: e.message });
  }
});

router.post('/abort', (req, res) => {
  abortExecution(req.profile.id);
  res.json({ success: true });
});

router.get('/status', (req, res) => {
  res.json({ running: isRunning(req.profile.id) });
});

router.get('/file', (req, res) => {
  try {
    const { name } = req.query;
    if (!name) return res.status(400).json({ error: 'name requerido' });
    const { projectPath } = getConfig(req);
    if (!projectPath) return res.status(400).json({ error: 'Proyecto no configurado' });

    const filePath = path.resolve(projectPath, name);
    if (!filePath.startsWith(path.resolve(projectPath))) {
      return res.status(403).json({ error: 'Acceso denegado' });
    }
    if (!fs.existsSync(filePath)) return res.status(404).json({ error: 'Archivo no encontrado' });

    const content = fs.readFileSync(filePath, 'utf-8');
    const stats = fs.statSync(filePath);
    res.json({ content, path: filePath, size: stats.size, mtime: stats.mtime });
  } catch (e) {
    res.status(500).json({ error: e.message });
  }
});

router.post('/file', (req, res) => {
  try {
    const { name, content } = req.body;
    if (!name) return res.status(400).json({ error: 'name requerido' });
    if (content === undefined || content === null) return res.status(400).json({ error: 'content requerido' });

    const { projectPath } = getConfig(req);
    if (!projectPath) return res.status(400).json({ error: 'Proyecto no configurado' });

    const filePath = path.resolve(projectPath, name);
    if (!filePath.startsWith(path.resolve(projectPath))) {
      return res.status(403).json({ error: 'Acceso denegado' });
    }
    if (!fs.existsSync(filePath)) return res.status(404).json({ error: 'Archivo no encontrado' });

    fs.writeFileSync(filePath, content, 'utf-8');
    res.json({ success: true });
  } catch (e) {
    res.status(500).json({ error: e.message });
  }
});

module.exports = router;
