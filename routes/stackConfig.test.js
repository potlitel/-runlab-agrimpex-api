const { test } = require('node:test');
const assert = require('node:assert');
const fs = require('fs');
const os = require('os');
const path = require('path');
const { createStackConfigRouter } = require('./stackConfig');
const { createStackConfig } = require('../services/stackConfig');

const ENV = [
  'API_PORT=3001',
  'VITE_API_URL=http://localhost:3001/api',
  'RUNLABQA_AGENT_TOKEN=secreto-inicial',
  '',
].join('\n');

function setup() {
  const root = fs.mkdtempSync(path.join(os.tmpdir(), 'runlab-stack-route-'));
  const envPath = path.join(root, '.env');
  fs.writeFileSync(envPath, ENV);
  const config = createStackConfig({
    envPath,
    backupDir: path.join(root, 'backups'),
    metaPath: path.join(root, 'backups', 'meta.json'),
    publicConfigPath: path.join(root, 'public-config.json'),
  });
  return { config, router: createStackConfigRouter(config) };
}

function call(router, method, routePath, req = {}) {
  const layer = router.stack.find(
    (l) => l.route && l.route.path === routePath && l.route.methods[method],
  );
  assert.ok(layer, `falta ruta ${method.toUpperCase()} ${routePath}`);
  const handlers = layer.route.stack.map((l) => l.handle);

  return new Promise((resolve, reject) => {
    const res = {
      statusCode: 200,
      headers: {},
      json(payload) { resolve({ status: this.statusCode, body: payload }); },
      status(code) { this.statusCode = code; return this; },
      set(key, value) { this.headers[key] = value; return this; },
    };
    function next(err) {
      if (err) return reject(err);
      const handler = handlers.shift();
      if (!handler) return reject(new Error('la ruta no respondió'));
      try {
        const result = handler(req, res, next);
        if (result && typeof result.then === 'function') result.then(undefined, reject);
      } catch (e) {
        reject(e);
      }
    }
    req.get = (header) => (req.headers || {})[header] || '';
    next();
  });
}

function withToken(token = 'token-de-prueba') {
  const previous = process.env.UPDATE_TOKEN;
  process.env.UPDATE_TOKEN = token;
  return () => {
    if (previous === undefined) delete process.env.UPDATE_TOKEN;
    else process.env.UPDATE_TOKEN = previous;
  };
}

test('GET /stack-config responde 503 sin UPDATE_TOKEN y no revela valores', async () => {
  const previous = process.env.UPDATE_TOKEN;
  delete process.env.UPDATE_TOKEN;
  try {
    const { router } = setup();
    const response = await call(router, 'get', '/stack-config');
    assert.equal(response.status, 503);
    assert.equal(response.body.disabled, true);
    assert.equal(JSON.stringify(response.body).includes('secreto-inicial'), false);
  } finally {
    if (previous !== undefined) process.env.UPDATE_TOKEN = previous;
  }
});

test('GET /stack-config rechaza un token inválido con 401', async () => {
  const restore = withToken();
  try {
    const { router } = setup();
    const response = await call(router, 'get', '/stack-config', { headers: { 'x-update-token': 'malo' } });
    assert.equal(response.status, 401);
  } finally {
    restore();
  }
});

test('GET /stack-config devuelve secretos como null con su estado', async () => {
  const restore = withToken();
  try {
    const { router } = setup();
    const response = await call(router, 'get', '/stack-config', { headers: { 'x-update-token': 'token-de-prueba' } });
    assert.equal(response.status, 200);
    assert.equal(response.body.values.RUNLABQA_AGENT_TOKEN, null);
    assert.deepStrictEqual(response.body.secrets.RUNLABQA_AGENT_TOKEN, { configured: true });
    assert.equal(JSON.stringify(response.body).includes('secreto-inicial'), false);
    assert.equal(response.body.configVersion, 0);
  } finally {
    restore();
  }
});

test('PUT /stack-config aplica keep, set y clear con el token', async () => {
  const restore = withToken();
  try {
    const { router, config } = setup();
    const headers = { 'x-update-token': 'token-de-prueba' };

    let response = await call(router, 'put', '/stack-config', {
      headers,
      body: {
        values: { VITE_API_URL: 'https://dashboard.example.com/api' },
        secrets: { RUNLABQA_AGENT_TOKEN: { operation: 'set', value: 'nuevo-secreto' } },
      },
    });
    assert.equal(response.status, 200);
    assert.equal(response.body.values.VITE_API_URL, 'https://dashboard.example.com/api');
    assert.deepStrictEqual(response.body.secrets.RUNLABQA_AGENT_TOKEN, { configured: true });
    assert.equal(JSON.stringify(response.body).includes('nuevo-secreto'), false);
    assert.match(fs.readFileSync(config.paths.envPath, 'utf8'), /RUNLABQA_AGENT_TOKEN=nuevo-secreto/);

    response = await call(router, 'put', '/stack-config', {
      headers,
      body: { secrets: { RUNLABQA_AGENT_TOKEN: { operation: 'keep' } } },
    });
    assert.equal(response.status, 200);
    assert.match(fs.readFileSync(config.paths.envPath, 'utf8'), /RUNLABQA_AGENT_TOKEN=nuevo-secreto/);

    response = await call(router, 'put', '/stack-config', {
      headers,
      body: { secrets: { RUNLABQA_AGENT_TOKEN: { operation: 'clear' } } },
    });
    assert.equal(response.status, 200);
    assert.deepStrictEqual(response.body.secrets.RUNLABQA_AGENT_TOKEN, { configured: false });
  } finally {
    restore();
  }
});

test('PUT /stack-config rechaza claves no permitidas con 400 y no escribe', async () => {
  const restore = withToken();
  try {
    const { router, config } = setup();
    const before = fs.readFileSync(config.paths.envPath, 'utf8');
    const response = await call(router, 'put', '/stack-config', {
      headers: { 'x-update-token': 'token-de-prueba' },
      body: { values: { RUNLABQA_AGENT_TOKEN: 'no-deberia pasar' } },
    });
    assert.equal(response.status, 400);
    assert.equal(fs.readFileSync(config.paths.envPath, 'utf8'), before);
  } finally {
    restore();
  }
});

test('POST /restore avisa cuando no hay copia y restaura cuando existe', async () => {
  const restore = withToken();
  try {
    const { router } = setup();
    const headers = { 'x-update-token': 'token-de-prueba' };

    let response = await call(router, 'post', '/stack-config/restore', { headers });
    assert.equal(response.status, 404);
    assert.match(response.body.error, /No hay copia de seguridad/);

    await call(router, 'put', '/stack-config', {
      headers,
      body: { values: { VITE_API_URL: 'https://dashboard.example.com/api' } },
    });
    response = await call(router, 'post', '/stack-config/restore', { headers });
    assert.equal(response.status, 200);
    assert.equal(response.body.values.VITE_API_URL, 'http://localhost:3001/api');
  } finally {
    restore();
  }
});

test('GET /public-config no pide token y solo expone URLs y versión', async () => {
  const restore = withToken();
  try {
    const { router } = setup();
    const response = await call(router, 'get', '/public-config');
    assert.equal(response.status, 200);
    assert.deepStrictEqual(Object.keys(response.body).sort(), [
      'apiBaseUrl', 'configVersion', 'socketUrl',
    ]);
    assert.equal(response.body.apiBaseUrl, 'http://localhost:3001/api');
  } finally {
    restore();
  }
});
