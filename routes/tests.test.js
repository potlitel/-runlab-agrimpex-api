const { test, after } = require('node:test');
const assert = require('node:assert');
const fs = require('fs');
const os = require('os');
const path = require('path');
const http = require('http');
const express = require('express');

process.env.RUNLABQA_DOCKER_TRANSPORT = 'agent';
const testControl = require('../services/testControl');
const router = require('./tests');

const original = {
  collect: testControl.collect,
  run: testControl.run,
  abort: testControl.abort,
  isRemoteRunning: testControl.isRemoteRunning,
  clearRemoteRuns: testControl.clearRemoteRuns,
};

after(() => {
  testControl.collect = original.collect;
  testControl.run = original.run;
  testControl.abort = original.abort;
  testControl.isRemoteRunning = original.isRemoteRunning;
  testControl.clearRemoteRuns = original.clearRemoteRuns;
  delete process.env.RUNLABQA_DOCKER_TRANSPORT;
});

function server(config) {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'tests-route-'));
  const configPath = path.join(dir, 'config.json');
  fs.writeFileSync(configPath, JSON.stringify(config));
  const app = express();
  app.use(express.json());
  app.set('io', { to: () => ({ emit: () => {} }) });
  app.use((req, res, next) => {
    req.profile = {
      id: 'p1',
      config: configPath,
      reportsDir: path.join(dir, 'reports'),
      dataDir: path.join(dir, 'data'),
      collection: path.join(dir, 'data', 'last-collection.json'),
      entornos: [],
    };
    next();
  });
  app.use('/api/tests', router);
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

test('1.2 /tests/status refleja la corrida remota', async () => {
  testControl.clearRemoteRuns();
  testControl.isRemoteRunning = () => false;
  const srv = server({ projectPath: '/kit', workstationId: 'ws-a' });
  await new Promise((r) => srv.listen(0, '127.0.0.1', r));
  assert.deepEqual((await req(srv, 'GET', '/api/tests/status')).body, { running: false });

  testControl.isRemoteRunning = () => true;
  assert.deepEqual((await req(srv, 'GET', '/api/tests/status')).body, { running: true });
  srv.close();
});

test('1.2 /tests/run responde 409 cuando hay corrida remota en curso', async () => {
  testControl.isRemoteRunning = () => true;
  testControl.run = async () => { throw new Error('no debería despacharse'); };
  const srv = server({ projectPath: '/kit', workstationId: 'ws-a' });
  await new Promise((r) => srv.listen(0, '127.0.0.1', r));
  const res = await req(srv, 'POST', '/api/tests/run', { testIds: ['a.spec.ts::test'] });
  assert.equal(res.status, 409);
  assert.match(res.body.error, /in progress/);
  srv.close();
});

test('3.1 /tests/run despacha al agente del workstationId', async () => {
  testControl.isRemoteRunning = () => false;
  const dispatched = [];
  testControl.run = async (io, profile, context) => {
    dispatched.push({ profile, context });
    return { mode: 'agent', started: true, requestId: 'req-9', runId: 'agent_run9', agentId: 'ws-a' };
  };
  const srv = server({ projectPath: '/kit', workstationId: 'ws-a' });
  await new Promise((r) => srv.listen(0, '127.0.0.1', r));
  const res = await req(srv, 'POST', '/api/tests/run', {
    testIds: ['a.spec.ts::test'],
    params: { ENV: 'QA' },
    project: 'chromium',
  });
  assert.equal(res.status, 200);
  assert.equal(res.body.transport, 'agent');
  assert.equal(res.body.workstationId, 'ws-a');
  assert.equal(dispatched[0].context.projectPath, '/kit');
  assert.equal(dispatched[0].context.envVars.ENV, 'QA');
  assert.equal(dispatched[0].context.options.project, 'chromium');
  srv.close();
});

test('3.1 perfil sin workstationId sigue usando la ruta local', async () => {
  testControl.isRemoteRunning = () => false;
  const dispatched = [];
  testControl.run = async (io, profile, context) => {
    dispatched.push(context);
    return { mode: 'local', started: true };
  };
  const srv = server({ projectPath: '/kit' });
  await new Promise((r) => srv.listen(0, '127.0.0.1', r));
  const res = await req(srv, 'POST', '/api/tests/run', { testIds: ['a.spec.ts::test'] });
  assert.equal(res.status, 200);
  assert.equal(res.body.transport, 'local');
  assert.equal(dispatched.length, 1);
  srv.close();
});

test('3.1 agente no registrado rechaza collect y run con 503', async () => {
  const offline = Object.assign(new Error('Agente ws-x no conectado'), { code: 'AGENT_OFFLINE', workstationId: 'ws-x' });
  testControl.isRemoteRunning = () => false;
  testControl.collect = async () => { throw offline; };
  testControl.run = async () => { throw offline; };
  const srv = server({ projectPath: '/kit', workstationId: 'ws-x' });
  await new Promise((r) => srv.listen(0, '127.0.0.1', r));
  const c = await req(srv, 'GET', '/api/tests/collect');
  assert.equal(c.status, 503);
  assert.equal(c.body.workstationId, 'ws-x');
  const r = await req(srv, 'POST', '/api/tests/run', { testIds: ['a.spec.ts::test'] });
  assert.equal(r.status, 503);
  srv.close();
});

test('3.1 /tests/abort enruta la corrida remota a testControl', async () => {
  const calls = [];
  testControl.abort = async (profile, context) => {
    calls.push({ profile, context });
    return { remote: true, requestId: 'req-9', agentId: 'ws-a' };
  };
  const srv = server({ projectPath: '/kit', workstationId: 'ws-a' });
  await new Promise((r) => srv.listen(0, '127.0.0.1', r));
  const res = await req(srv, 'POST', '/api/tests/abort');
  assert.equal(res.status, 200);
  assert.equal(res.body.remote, true);
  assert.equal(calls[0].context.profileId, 'p1');
  srv.close();
});
