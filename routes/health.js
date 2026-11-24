const fs = require('fs');
const path = require('path');
const crypto = require('crypto');
const express = require('express');

const router = express.Router();

// Versión estática, alineada con swagger.js. Se evita leer package.json en la
// ruta de liveness: este endpoint solo confirma que el proceso atiende HTTP.
const VERSION = '1.0.0';

const MESSAGES = {
  missing: 'Directorio no disponible',
  notDirectory: 'La ruta no es un directorio',
  notWritable: 'Directorio no escribible',
  noProfile: 'Sin perfil activo',
  notConfigured: 'No configurado',
  profileMissing: 'El perfil activo no existe',
  projectMissing: 'Proyecto no disponible',
  kitMissing: 'Kit Playwright no detectado',
  schedulerOff: 'Scheduler no iniciado',
  socketOff: 'Socket.io no disponible',
  gridDisabled: 'Feature Docker deshabilitada',
  gridMissing: 'Grid no configurado',
  composeMissing: 'Docker Compose no detectado',
};

// Espejo de PLAYWRIGHT_CONFIG_FILES en playwrightRunner.js; solo lectura.
const PLAYWRIGHT_CONFIG_FILES = [
  'playwright.config.ts', 'playwright.config.mts', 'playwright.config.cts',
  'playwright.config.js', 'playwright.config.mjs', 'playwright.config.cjs',
];
const COMPOSE_FILES = [
  'docker-compose.yml', 'docker-compose.yaml', 'compose.yml', 'compose.yaml',
];

let informationalCache = { at: 0, value: null };

function check(id, status, message) {
  return message ? { id, status, message } : { id, status };
}

function liveness(_req, res) {
  res.json({
    status: 'ok',
    uptimeSeconds: Math.floor(process.uptime()),
    version: VERSION,
  });
}

// Prueba de escritura real: `access(W_OK)` da falsos positivos con bind mounts
// y con el UID del contenedor. El archivo temporal se limpia siempre.
function writableDirectory(id, dir) {
  let probe = null;
  try {
    if (!dir) return check(id, 'not_configured', MESSAGES.notConfigured);
    if (!fs.existsSync(dir)) return check(id, 'unhealthy', MESSAGES.missing);
    if (!fs.statSync(dir).isDirectory()) return check(id, 'unhealthy', MESSAGES.notDirectory);
    probe = path.join(dir, `.healthcheck-${process.pid}-${crypto.randomBytes(4).toString('hex')}`);
    fs.writeFileSync(probe, '');
    return check(id, 'ok');
  } catch {
    return check(id, 'unhealthy', MESSAGES.notWritable);
  } finally {
    if (probe) {
      try { fs.unlinkSync(probe); } catch { /* la respuesta no depende de la limpieza */ }
    }
  }
}

function readConfig(paths) {
  try { return JSON.parse(fs.readFileSync(paths.config, 'utf-8')) || {}; }
  catch { return {}; }
}

function selectedProfile(req) {
  const pm = require('../services/profileManager');
  const requested = req && req.get ? String(req.get('x-profile-id') || '').trim() : '';
  const id = requested && pm.profileExists(requested) ? requested : pm.getActiveProfileId();
  return { id, paths: id && pm.profileExists(id) ? pm.profilePaths(id) : null };
}

function criticalChecks(req) {
  const baseDir = process.env.RUNLABQA_DATA_DIR || path.join(__dirname, '..');
  const profilesDir = path.join(baseDir, 'profiles');
  const checks = [writableDirectory('profiles', profilesDir)];

  const { id: activeId, paths } = selectedProfile(req);
  if (!paths) {
    checks.push(check('reports', 'not_configured', MESSAGES.noProfile));
    checks.push(check('evidenceGallery', 'not_configured', MESSAGES.notConfigured));
    return checks;
  }

  checks.push(writableDirectory('reports', paths.reportsDir));
  const configuredGallery = readConfig(paths).errorImagesPath;
  const gallery = typeof configuredGallery === 'string' ? configuredGallery.trim() : '';
  checks.push(gallery
    ? writableDirectory('evidenceGallery', gallery)
    : check('evidenceGallery', 'not_configured', MESSAGES.notConfigured));
  return checks;
}

function isDirectory(dir) {
  try { return !!dir && fs.statSync(dir).isDirectory(); }
  catch { return false; }
}

function hasAnyFile(dir, names) {
  if (!dir) return false;
  return names.some(name => {
    try { return fs.statSync(path.join(dir, name)).isFile(); }
    catch { return false; }
  });
}

function computeInformationalChecks(req) {
  const pm = require('../services/profileManager');
  const { getFlags } = require('../services/featureFlags');
  const { isStarted: schedulerStarted } = require('../services/scheduler');

  const { id: activeId, paths } = selectedProfile(req);
  const profileCheck = !activeId
    ? check('profile', 'not_configured', MESSAGES.noProfile)
    : pm.profileExists(activeId)
      ? check('profile', 'ok')
      : check('profile', 'degraded', MESSAGES.profileMissing);
  const cfg = paths ? readConfig(paths) : {};
  const projectPath = typeof cfg.projectPath === 'string' ? cfg.projectPath.trim() : '';

  const projectCheck = !projectPath
    ? check('projectPath', 'not_configured', MESSAGES.notConfigured)
    : isDirectory(projectPath)
      ? check('projectPath', 'ok')
      : check('projectPath', 'degraded', MESSAGES.projectMissing);
  const kitCheck = !projectPath
    ? check('playwrightKit', 'not_configured', MESSAGES.notConfigured)
    : hasAnyFile(projectPath, PLAYWRIGHT_CONFIG_FILES)
      ? check('playwrightKit', 'ok')
      : check('playwrightKit', 'degraded', MESSAGES.kitMissing);
  const schedulerCheck = schedulerStarted()
    ? check('scheduler', 'ok')
    : check('scheduler', 'not_configured', MESSAGES.schedulerOff);
  const socketCheck = req.app && req.app.get('io')
    ? check('socket', 'ok')
    : check('socket', 'not_configured', MESSAGES.socketOff);

  const flags = paths ? getFlags(paths.features) : {};
  const remoteUrl = typeof cfg.seleniumRemoteUrl === 'string' ? cfg.seleniumRemoteUrl.trim() : '';
  let dockerCheck;
  if (!paths || flags.docker === false) {
    dockerCheck = check('dockerGrid', 'not_configured', MESSAGES.gridDisabled);
  } else if (!remoteUrl) {
    dockerCheck = check('dockerGrid', 'not_configured', MESSAGES.gridMissing);
  } else {
    dockerCheck = hasAnyFile(projectPath, COMPOSE_FILES)
      ? check('dockerGrid', 'ok')
      : check('dockerGrid', 'degraded', MESSAGES.composeMissing);
  }

  return [profileCheck, projectCheck, kitCheck, schedulerCheck, socketCheck, dockerCheck];
}

function informationalChecks(req) {
  // Caché corta: la UI sondea cada ~30 s y estos checks no deben repetir E/S.
  const configured = Number(process.env.RUNLABQA_HEALTH_CACHE_MS);
  const ttl = Number.isFinite(configured) && configured >= 0 ? configured : 5000;
  const now = Date.now();
  if (ttl > 0 && informationalCache.value && now - informationalCache.at < ttl) {
    return informationalCache.value;
  }
  const value = computeInformationalChecks(req);
  informationalCache = { at: now, value };
  return value;
}

function detail(req, res) {
  const critical = criticalChecks(req);
  const informational = informationalChecks(req);
  const failedChecks = [...critical, ...informational]
    .filter(c => c.status === 'unhealthy' || c.status === 'degraded')
    .map(c => c.id);
  const status = critical.some(c => c.status === 'unhealthy')
    ? 'unhealthy'
    : informational.some(c => c.status === 'degraded')
      ? 'degraded'
      : 'ok';

  res.status(status === 'unhealthy' ? 503 : 200).json({
    status,
    uptimeSeconds: Math.floor(process.uptime()),
    checks: { critical, informational },
    failedChecks,
  });
}

router.get('/health', liveness);
router.get('/health/detail', detail);

module.exports = router;
