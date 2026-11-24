const { test } = require('node:test');
const assert = require('node:assert');
const fs = require('fs');
const os = require('os');
const path = require('path');
const configRouter = require('./config');

function routeHandler(method, routePath = '/') {
  const layer = configRouter.stack.find(
    (l) => l.route && l.route.path === routePath && l.route.methods[method],
  );
  assert.ok(layer, `falta ruta ${method.toUpperCase()} ${routePath}`);
  return layer.route.stack[0].handle;
}

function call(handler, req) {
  return new Promise((resolve, reject) => {
    const res = {
      json(payload) { resolve(payload); },
      status(code) {
        this.statusCode = code;
        return this;
      },
    };
    try {
      const result = handler(req, res);
      if (result && typeof result.then === 'function') result.then(resolve, reject);
    } catch (e) {
      reject(e);
    }
  });
}

test('POST /config normaliza y persiste formato, calidad y escala de evidencia', async () => {
  const root = fs.mkdtempSync(path.join(os.tmpdir(), 'runlab-config-'));
  const configPath = path.join(root, 'config.json');
  fs.writeFileSync(configPath, JSON.stringify({
    projectPath: '/proyecto',
    evidence: { screenshot: 'always', imageFormat: 'png', imageQuality: 90, scale: 'css' },
  }));
  const req = {
    body: {
      projectPath: '/proyecto',
      evidence: {
        screenshot: 'always',
        imageFormat: 'JPG',
        imageQuality: '72',
        scale: 'DEVICE',
      },
    },
    profile: { config: configPath, reportsDir: path.join(root, 'reports'), collection: path.join(root, 'collection') },
  };

  const saved = await call(routeHandler('post'), req);
  assert.deepStrictEqual(saved.config.evidence, {
    screenshot: 'always',
    imageFormat: 'jpg',
    imageQuality: 72,
    scale: 'device',
  });
  assert.deepStrictEqual(JSON.parse(fs.readFileSync(configPath, 'utf-8')).evidence, saved.config.evidence);

  // Simula la recarga del perfil: GET /config devuelve lo persistido.
  const reloaded = await call(routeHandler('get'), { profile: req.profile });
  assert.strictEqual(reloaded.evidence.imageFormat, 'jpg');
  assert.strictEqual(reloaded.evidence.imageQuality, 72);
  assert.strictEqual(reloaded.evidence.scale, 'device');
});

test('POST /config conserva valores previos cuando llegan opciones inválidas', async () => {
  const root = fs.mkdtempSync(path.join(os.tmpdir(), 'runlab-config-invalid-'));
  const configPath = path.join(root, 'config.json');
  fs.writeFileSync(configPath, JSON.stringify({
    projectPath: '/proyecto',
    evidence: { imageFormat: 'jpeg', imageQuality: 80, scale: 'css' },
  }));
  const req = {
    body: {
      projectPath: '/proyecto',
      evidence: { imageFormat: 'webp', imageQuality: 900, scale: ' retina ' },
    },
    profile: { config: configPath, reportsDir: path.join(root, 'reports'), collection: path.join(root, 'collection') },
  };

  const saved = await call(routeHandler('post'), req);
  assert.deepStrictEqual(saved.config.evidence, {
    imageFormat: 'jpeg',
    imageQuality: 80,
    scale: 'css',
  });
});
