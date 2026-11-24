const { test, after } = require('node:test');
const assert = require('node:assert');
const fs = require('fs');
const os = require('os');
const path = require('path');
const registry = require('./agentRegistry');
const control = require('./testControl');

const ORIGINAL_ENV = process.env.RUNLABQA_DOCKER_TRANSPORT;
const originalIsOnline = registry.isOnline;

function profileIn(config) {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'test-control-'));
  const configPath = path.join(dir, 'config.json');
  fs.writeFileSync(configPath, JSON.stringify(config));
  return { id: 'p1', config: configPath, reportsDir: path.join(dir, 'reports') };
}

after(() => {
  if (ORIGINAL_ENV === undefined) delete process.env.RUNLABQA_DOCKER_TRANSPORT;
  else process.env.RUNLABQA_DOCKER_TRANSPORT = ORIGINAL_ENV;
  registry.isOnline = originalIsOnline;
  control.clearRemoteRuns();
});

test('1.1 perfil con workstationId y agente conectado usa el agente', () => {
  delete process.env.RUNLABQA_DOCKER_TRANSPORT;
  registry.isOnline = () => true;
  const t = control.selectTransport(profileIn({ workstationId: 'ws-a', projectPath: '/kit' }));
  assert.equal(t.mode, 'agent');
  assert.equal(t.agentId, 'ws-a');
  assert.equal(t.config.projectPath, '/kit');
});

test('1.1 perfil sin workstationId usa ejecución local', () => {
  delete process.env.RUNLABQA_DOCKER_TRANSPORT;
  registry.isOnline = () => true;
  const t = control.selectTransport(profileIn({ projectPath: '/kit' }));
  assert.equal(t.mode, 'local');
  assert.equal(t.agentId, '');
});

test('1.1 RUNLABQA_DOCKER_TRANSPORT=local fuerza local aunque haya workstationId', () => {
  process.env.RUNLABQA_DOCKER_TRANSPORT = 'local';
  registry.isOnline = () => true;
  const t = control.selectTransport(profileIn({ workstationId: 'ws-a' }));
  assert.equal(t.mode, 'local');
  assert.equal(control.isLegacyLocal(), true);
  delete process.env.RUNLABQA_DOCKER_TRANSPORT;
});

test('1.1 agente desconectado falla explícitamente, sin fallback local', () => {
  delete process.env.RUNLABQA_DOCKER_TRANSPORT;
  registry.isOnline = () => false;
  assert.throws(
    () => control.selectTransport(profileIn({ workstationId: 'ws-perdido' })),
    (err) => {
      assert.equal(err.code, 'AGENT_OFFLINE');
      assert.match(err.message, /ws-perdido/);
      assert.match(err.message, /no se ejecutará localmente/);
      return true;
    }
  );
});

test('1.2 registro de corrida remota: estado, corrida en curso y cierre', () => {
  control.clearRemoteRuns();
  assert.equal(control.isRemoteRunning('p1'), false);

  const run = control.startRemoteRun('p1', { requestId: 'req-1', agentId: 'ws-a', runId: 'agent_run1' });
  assert.equal(run.status, 'running');
  assert.equal(control.isRemoteRunning('p1'), true);
  assert.deepEqual(control.getRemoteRun('p1'), run);

  // Un requestId distinto no debe cerrar la corrida activa.
  control.finishRemoteRun('p1', 'otro', 'completed');
  assert.equal(control.isRemoteRunning('p1'), true);

  control.finishRemoteRun('p1', 'req-1', 'aborted');
  assert.equal(control.isRemoteRunning('p1'), false);
  assert.equal(control.getRemoteRun('p1').status, 'aborted');
});

test('1.2 abort enruta al agente dueño de la corrida', async () => {
  control.clearRemoteRuns();
  control.startRemoteRun('p1', { requestId: 'req-2', agentId: 'ws-b', runId: 'agent_run2' });

  const original = registry.request;
  const calls = [];
  registry.request = async (agentId, op, profile, options) => {
    calls.push({ agentId, op, args: options.args, timeout: options.timeout });
    return { aborted: true };
  };
  try {
    const profile = profileIn({ workstationId: 'ws-b' });
    const res = await control.abort(profile, { profileId: 'p1' });
    assert.equal(res.remote, true);
    assert.equal(calls[0].agentId, 'ws-b');
    assert.equal(calls[0].op, 'abort');
    assert.equal(calls[0].args.requestId, 'req-2');
    assert.equal(control.getRemoteRun('p1').status, 'aborted');
  } finally {
    registry.request = original;
  }
});

test('2.4 desconexión del agente cierra la corrida y emite execution:failed', async () => {
  const originalRequest = registry.request;
  registry._reset();
  const socket = {
    id: 'ws-live',
    handshake: { auth: { agentId: 'ws-live' } },
    join() {},
    emit(event, payload) { this.lastCommand = payload; },
    disconnect() {},
  };
  registry.register(socket, { agentId: 'ws-live' });
  registry.isOnline = () => true;

  const emitted = [];
  const io = { to: () => ({ emit: (event, payload) => emitted.push({ event, payload }) }) };
  const profile = profileIn({ workstationId: 'ws-live', projectPath: '/kit' });

  try {
    const dispatch = await control.run(io, profile, {
      profileId: 'p1',
      testIds: ['t1'],
      projectPath: '/kit',
      reportsDir: profile.reportsDir,
    });
    assert.equal(dispatch.mode, 'agent');
    assert.equal(control.isRemoteRunning('p1'), true);
    assert.equal(socket.lastCommand.requestId, dispatch.requestId);

    registry.unregister(socket);
    assert.equal(control.isRemoteRunning('p1'), false);
    assert.equal(control.getRemoteRun('p1').status, 'failed');
    assert.equal(emitted.length, 1);
    assert.equal(emitted[0].event, 'execution:failed');
    assert.match(emitted[0].payload.error, /desconectado/);
  } finally {
    registry.request = originalRequest;
    registry._reset();
    control.clearRemoteRuns();
  }
});

test('3.2 artefactos válidos se escriben bajo agent/<runId>', () => {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'agent-artifacts-'));
  const manifest = {
    files: [
      { path: 'report_1.json', data: Buffer.from('{"ok":true}').toString('base64') },
      { path: 'report_1/assets/capture.png', data: Buffer.from([0x89, 0x50, 0x4e, 0x47]).toString('base64') },
    ],
  };
  const res = control.persistArtifacts(dir, 'agent_ok', manifest);
  assert.equal(res.saved.length, 2);
  assert.equal(res.rejected.length, 0);
  assert.ok(fs.existsSync(path.join(dir, 'agent', 'agent_ok', 'report_1.json')));
  assert.ok(fs.existsSync(path.join(dir, 'agent', 'agent_ok', 'report_1', 'assets', 'capture.png')));
});

test('3.2 rechaza traversal, extensión no permitida y límites de tamaño', () => {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'agent-artifacts-'));
  const big = Buffer.alloc(10 * 1024 * 1024 + 1, 1).toString('base64');
  const manifest = {
    files: [
      { path: '../escape.json', data: Buffer.from('x').toString('base64') },
      { path: 'malware.exe', data: Buffer.from('x').toString('base64') },
      { path: 'big.png', data: big },
      { path: '/abs.json', data: Buffer.from('x').toString('base64') },
    ],
  };
  const res = control.persistArtifacts(dir, 'agent_bad', manifest);
  assert.equal(res.saved.length, 0);
  assert.equal(res.rejected.length, 4);
  assert.match(res.rejected[0].reason, /\.\./);
  assert.match(res.rejected[1].reason, /extensión/);
  assert.match(res.rejected[2].reason, /10 MB/);
  assert.match(res.rejected[3].reason, /absoluta/);
});

test('3.2 aplica el tope de 50 MB por corrida', () => {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'agent-artifacts-'));
  const chunk = Buffer.alloc(9 * 1024 * 1024, 7).toString('base64');
  const files = Array.from({ length: 6 }, (_, i) => ({ path: `big-${i}.png`, data: chunk }));
  const res = control.persistArtifacts(dir, 'agent_total', { files });
  assert.equal(res.saved.length, 5);
  assert.equal(res.rejected.length, 1);
  assert.match(res.rejected[0].reason, /50 MB/);
  assert.ok(res.total <= 50 * 1024 * 1024);
});
