const { test } = require('node:test');
const assert = require('node:assert');
const fs = require('fs');
const os = require('os');
const path = require('path');
const http = require('http');
const express = require('express');

const ORIGINAL_DATA_DIR = process.env.RUNLABQA_DATA_DIR;
// Caché desactivada: cada petición debe reflejar el estado montado por el test.
process.env.RUNLABQA_HEALTH_CACHE_MS = '0';

function server(dataDir) {
  if (dataDir) process.env.RUNLABQA_DATA_DIR = dataDir;
  else delete process.env.RUNLABQA_DATA_DIR;
  ['../services/profileManager'].forEach(m => {
    try { delete require.cache[require.resolve(m)]; } catch { /* no cargado */ }
  });
  const app = express();
  app.use('/api', require('./health'));
  return http.createServer(app);
}

function req(srv, urlPath, headers = {}) {
  return new Promise((resolve) => {
    const r = http.request({ ...srv.address(), method: 'GET', path: urlPath, headers }, (res) => {
      let b = '';
      res.on('data', d => { b += d; });
      res.on('end', () => resolve({ status: res.statusCode, body: b ? JSON.parse(b) : null }));
    });
    r.end();
  });
}

async function withServer(dataDir, fn) {
  const srv = server(dataDir);
  await new Promise(r => srv.listen(0, r));
  try { await fn(srv); }
  finally {
    await new Promise(r => srv.close(r));
    if (ORIGINAL_DATA_DIR === undefined) delete process.env.RUNLABQA_DATA_DIR;
    else process.env.RUNLABQA_DATA_DIR = ORIGINAL_DATA_DIR;
  }
}

function setupDataDir({ withGallery = true, projectPath = '' } = {}) {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'health-'));
  // Fijar el data dir antes de cargar profileManager: este módulo cachea la
  // ruta en tiempo de require y sin esto los tests escribirían en profiles/.
  process.env.RUNLABQA_DATA_DIR = dir;
  fs.mkdirSync(path.join(dir, 'profiles'), { recursive: true });
  ['../services/profileManager'].forEach(m => {
    try { delete require.cache[require.resolve(m)]; } catch { /* no cargado */ }
  });
  const pm = require('../services/profileManager');
  const profile = pm.createProfile('Perfil health');
  const gallery = fs.mkdtempSync(path.join(os.tmpdir(), 'health-gallery-'));
  const paths = pm.profilePaths(profile.id);
  const cfg = JSON.parse(fs.readFileSync(paths.config, 'utf-8'));
  cfg.errorImagesPath = withGallery ? gallery : '';
  cfg.projectPath = projectPath;
  fs.writeFileSync(paths.config, JSON.stringify(cfg, null, 2));
  return { dir, gallery, paths };
}

test('GET /api/health responde sin perfil y sin exponer rutas', async () => {
  await withServer(null, async (srv) => {
    const res = await req(srv, '/api/health');
    assert.strictEqual(res.status, 200);
    assert.strictEqual(res.body.status, 'ok');
    assert.strictEqual(typeof res.body.uptimeSeconds, 'number');
    assert.ok(res.body.uptimeSeconds >= 0);
    assert.strictEqual(typeof res.body.version, 'string');

    const payload = JSON.stringify(res.body);
    assert.ok(!payload.includes('/'), 'el payload no debe contener rutas');
    assert.ok(!payload.includes(process.cwd()), 'el payload no debe contener la ruta de trabajo');

    // La cabecera de perfil se ignora: el healthcheck nunca depende de ella.
    const withProfile = await req(srv, '/api/health', { 'x-profile-id': 'perfil-inexistente' });
    assert.strictEqual(withProfile.status, 200);
    assert.strictEqual(withProfile.body.status, 'ok');
  });
});

test('GET /api/health/detail con directorios críticos escribibles', async () => {
  const { dir, gallery } = setupDataDir();
  try {
    await withServer(dir, async (srv) => {
      const res = await req(srv, '/api/health/detail');
      assert.strictEqual(res.status, 200);
      assert.strictEqual(res.body.status, 'ok');
      assert.deepStrictEqual(res.body.failedChecks, []);
      const ids = res.body.checks.critical.map(c => c.id);
      assert.deepStrictEqual(ids, ['profiles', 'reports', 'evidenceGallery']);
      assert.ok(res.body.checks.critical.every(c => c.status === 'ok'));
    });
    // Ninguna prueba de escritura deja archivos residuales.
    assert.deepStrictEqual(fs.readdirSync(dir).filter(n => n.startsWith('.healthcheck-')), []);
    assert.deepStrictEqual(fs.readdirSync(gallery).filter(n => n.startsWith('.healthcheck-')), []);
  } finally {
    fs.rmSync(dir, { recursive: true, force: true });
    fs.rmSync(gallery, { recursive: true, force: true });
  }
});

test('GET /api/health/detail con directorio crítico no escribible', async () => {
  const { dir, gallery } = setupDataDir();
  const profilesDir = path.join(dir, 'profiles');
  try {
    fs.chmodSync(profilesDir, 0o500);
    await withServer(dir, async (srv) => {
      const res = await req(srv, '/api/health/detail');
      assert.strictEqual(res.status, 503);
      assert.strictEqual(res.body.status, 'unhealthy');
      assert.ok(res.body.failedChecks.includes('profiles'));
      assert.strictEqual(
        res.body.checks.critical.find(c => c.id === 'profiles').status,
        'unhealthy'
      );
      const payload = JSON.stringify(res.body);
      assert.ok(!payload.includes(dir), 'la respuesta no debe filtrar la ruta temporal');
      assert.ok(!payload.includes(gallery), 'la respuesta no debe filtrar la galería');
    });
  } finally {
    fs.chmodSync(profilesDir, 0o700);
    fs.rmSync(dir, { recursive: true, force: true });
    fs.rmSync(gallery, { recursive: true, force: true });
  }
});

test('GET /api/health/detail con directorio crítico ausente', async () => {
  const { dir, gallery } = setupDataDir();
  try {
    fs.rmSync(path.join(dir, 'profiles'), { recursive: true, force: true });
    await withServer(dir, async (srv) => {
      const res = await req(srv, '/api/health/detail');
      assert.strictEqual(res.status, 503);
      assert.strictEqual(res.body.status, 'unhealthy');
      assert.ok(res.body.failedChecks.includes('profiles'));
      assert.strictEqual(
        res.body.checks.critical.find(c => c.id === 'profiles').message,
        'Directorio no disponible'
      );
    });
  } finally {
    fs.rmSync(dir, { recursive: true, force: true });
    fs.rmSync(gallery, { recursive: true, force: true });
  }
});

test('un check informativo degradado responde 200 sin afectar a los críticos', async () => {
  const project = fs.mkdtempSync(path.join(os.tmpdir(), 'health-project-'));
  const { dir, gallery } = setupDataDir({ projectPath: project });
  try {
    await withServer(dir, async (srv) => {
      const res = await req(srv, '/api/health/detail');
      assert.strictEqual(res.status, 200);
      assert.strictEqual(res.body.status, 'degraded');
      assert.deepStrictEqual(res.body.failedChecks, ['playwrightKit']);
      assert.ok(res.body.checks.critical.every(c => c.status === 'ok'));
      assert.deepStrictEqual(
        res.body.checks.informational.map(c => c.id),
        ['profile', 'projectPath', 'playwrightKit', 'scheduler', 'socket', 'dockerGrid']
      );
    });
  } finally {
    fs.rmSync(dir, { recursive: true, force: true });
    fs.rmSync(gallery, { recursive: true, force: true });
    fs.rmSync(project, { recursive: true, force: true });
  }
});

test('galería sin configurar no cuenta como fallo crítico', async () => {
  const { dir, gallery } = setupDataDir({ withGallery: false });
  try {
    await withServer(dir, async (srv) => {
      const res = await req(srv, '/api/health/detail');
      assert.strictEqual(res.status, 200);
      const galleryCheck = res.body.checks.critical.find(c => c.id === 'evidenceGallery');
      assert.strictEqual(galleryCheck.status, 'not_configured');
      assert.ok(!res.body.failedChecks.includes('evidenceGallery'));
    });
  } finally {
    fs.rmSync(dir, { recursive: true, force: true });
    fs.rmSync(gallery, { recursive: true, force: true });
  }
});

test('el contrato no filtra rutas, entorno ni mensajes de excepción', async () => {
  const sentinelName = 'RUNLABQA_HEALTH_SENTINEL';
  const sentinelValue = 'valor-sensible-9f3a-no-debe-aparecer';
  process.env[sentinelName] = sentinelValue;
  const { dir, gallery } = setupDataDir();
  const profilesDir = path.join(dir, 'profiles');
  try {
    fs.chmodSync(profilesDir, 0o500);
    await withServer(dir, async (srv) => {
      const live = await req(srv, '/api/health');
      const detail = await req(srv, '/api/health/detail');
      for (const payload of [JSON.stringify(live.body), JSON.stringify(detail.body)]) {
        assert.ok(!payload.includes(dir), 'no debe filtrar la ruta del data dir');
        assert.ok(!payload.includes(gallery), 'no debe filtrar la galería');
        assert.ok(!payload.includes(sentinelValue), 'no debe filtrar variables de entorno');
        assert.ok(!payload.includes('EACCES') && !payload.includes('ENOENT'), 'no debe filtrar excepciones');
      }

      assert.ok(['ok', 'degraded', 'unhealthy'].includes(detail.body.status));
      assert.strictEqual(typeof detail.body.uptimeSeconds, 'number');
      const knownIds = new Set([
        'profiles', 'reports', 'evidenceGallery',
        'profile', 'projectPath', 'playwrightKit', 'scheduler', 'socket', 'dockerGrid',
      ]);
      for (const id of detail.body.failedChecks) {
        assert.ok(knownIds.has(id), `id inesperado en failedChecks: ${id}`);
      }
      const allChecks = [...detail.body.checks.critical, ...detail.body.checks.informational];
      for (const item of allChecks) {
        assert.ok(knownIds.has(item.id), `id inesperado: ${item.id}`);
        assert.ok(['ok', 'degraded', 'unhealthy', 'not_configured'].includes(item.status));
        for (const key of Object.keys(item)) {
          assert.ok(['id', 'status', 'message'].includes(key), `campo inesperado: ${key}`);
        }
      }
    });
  } finally {
    delete process.env[sentinelName];
    fs.chmodSync(profilesDir, 0o700);
    fs.rmSync(dir, { recursive: true, force: true });
    fs.rmSync(gallery, { recursive: true, force: true });
  }
});
