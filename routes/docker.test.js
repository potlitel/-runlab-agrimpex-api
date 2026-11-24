const { test, after } = require('node:test');
const assert = require('node:assert');
const fs = require('fs');
const os = require('os');
const path = require('path');
const http = require('http');
const express = require('express');

// Estas rutas se prueban en modo agente con el registry simulado.
process.env.RUNLABQA_DOCKER_TRANSPORT = 'agent';
const registry = require('../services/agentRegistry');
const router = require('./docker');

const original = {
  isOnline: registry.isOnline,
  list: registry.list,
  request: registry.request,
};

after(() => {
  registry.isOnline = original.isOnline;
  registry.list = original.list;
  registry.request = original.request;
});

function server(config) {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'docker-route-'));
  const configPath = path.join(dir, 'config.json');
  fs.writeFileSync(configPath, JSON.stringify(config));
  const app = express();
  app.use(express.json());
  app.use((req, res, next) => {
    req.profile = { id: 'p1', config: configPath };
    next();
  });
  app.use('/api/docker', router);
  return http.createServer(app);
}

function req(srv, method, urlPath, body) {
  return new Promise((resolve, reject) => {
    const payload = body === undefined ? undefined : JSON.stringify(body);
    const r = http.request({
      ...srv.address(),
      method,
      path: urlPath,
      headers: payload ? { 'content-type': 'application/json', 'content-length': Buffer.byteLength(payload) } : {},
    }, (res) => {
      let b = '';
      res.on('data', (d) => { b += d; });
      res.on('end', () => resolve({ status: res.statusCode, body: b ? JSON.parse(b) : null }));
    });
    r.on('error', reject);
    if (payload) r.write(payload);
    r.end();
  });
}

function stubOnline() {
  registry.isOnline = () => true;
  registry.list = () => [{ agentId: 'ws-a', label: 'Estación A' }];
  registry.request = async (agentId, op) => ({ ok: true, op, agentId });
}

test('GET /check enruta al agente del workstationId del perfil', async () => {
  stubOnline();
  const srv = server({ projectPath: '/proyecto', workstationId: 'ws-a' });
  await new Promise((r) => srv.listen(0, '127.0.0.1', r));
  const res = await req(srv, 'GET', '/api/docker/check');
  assert.equal(res.status, 200);
  assert.equal(res.body.agentId, 'ws-a');
  assert.equal(res.body.op, 'check');
  assert.equal(res.body.transport, 'agent');
  srv.close();
});

test('GET /agents lista los agentes conectados', async () => {
  stubOnline();
  const srv = server({ workstationId: 'ws-a' });
  await new Promise((r) => srv.listen(0, '127.0.0.1', r));
  const res = await req(srv, 'GET', '/api/docker/agents');
  assert.equal(res.status, 200);
  assert.equal(res.body.agents[0].agentId, 'ws-a');
  srv.close();
});

test('POST /run valida la acción y despacha sin esperar al agente', async () => {
  stubOnline();
  const dispatched = [];
  registry.request = async (agentId, op, profile, options) => {
    dispatched.push({ op, args: options && options.args, wait: options && options.wait });
    return {};
  };
  const srv = server({ workstationId: 'ws-a' });
  await new Promise((r) => srv.listen(0, '127.0.0.1', r));
  const bad = await req(srv, 'POST', '/api/docker/run', { action: 'rm -rf /' });
  assert.equal(bad.status, 400);
  const ok = await req(srv, 'POST', '/api/docker/run', { action: 'up-build' });
  assert.equal(ok.status, 200);
  assert.equal(ok.body.started, true);
  assert.deepEqual(dispatched[0], { op: 'run', args: { action: 'up-build' }, wait: false });
  srv.close();
});

test('sin workstationId o con agente caído responde 400 / 503', async () => {
  stubOnline();
  const sinId = server({ projectPath: '/proyecto' });
  await new Promise((r) => sinId.listen(0, '127.0.0.1', r));
  const a = await req(sinId, 'GET', '/api/docker/check');
  assert.equal(a.status, 400);
  assert.match(a.body.error, /workstationId/);
  sinId.close();

  registry.isOnline = () => false;
  const caido = server({ workstationId: 'ws-a' });
  await new Promise((r) => caido.listen(0, '127.0.0.1', r));
  const b = await req(caido, 'GET', '/api/docker/check');
  assert.equal(b.status, 503);
  assert.match(b.body.error, /no conectado/);
  caido.close();
});
