const { test } = require('node:test');
const assert = require('node:assert');
const registry = require('./agentRegistry');

function fakeSocket(id) {
  const emitted = [];
  return {
    id,
    handshake: { auth: { agentId: id } },
    emitted,
    joined: [],
    join(room) { this.joined.push(room); },
    emit(event, payload) { emitted.push({ event, payload }); },
    disconnect() {},
  };
}

test('registro por agentId y comando con args; resultado resuelve la petición', async () => {
  registry._reset();
  const socket = fakeSocket('ws-a');
  registry.register(socket, { agentId: 'ws-a', label: 'Estación A' });

  assert.equal(registry.isOnline('ws-a'), true);
  assert.deepEqual(registry.list()[0].label, 'Estación A');
  assert.deepEqual(socket.joined, ['agent:ws-a']);

  const promise = registry.request('ws-a', 'run', { id: 'p1', projectPath: '/proj' }, {
    wait: false,
    args: { action: 'up-selenium' },
  });
  const command = socket.emitted.find((e) => e.event === 'agent:command').payload;
  assert.equal(command.op, 'run');
  assert.equal(command.profile.projectPath, '/proj');
  assert.equal(command.args.action, 'up-selenium');
  assert.ok(command.requestId);

  registry.resolveResult({ requestId: command.requestId, ok: true, data: { started: true } });
  await promise; // fire-and-forget: no resuelve valor, pero no queda pendiente
});

test('eventos del agente se reemiten a la sala del perfil que los pidió', async () => {
  registry._reset();
  const events = [];
  const broadcasts = [];
  registry.attach({
    to: (room) => ({ emit: (event, payload) => events.push({ room, event, payload }) }),
    emit: (event, payload) => broadcasts.push({ event, payload }),
  });

  const socket = fakeSocket('ws-b');
  registry.register(socket, { agentId: 'ws-b' });
  const promise = registry.request('ws-b', 'status', { id: 'p9', projectPath: '' });
  const { requestId } = socket.emitted.find((e) => e.event === 'agent:command').payload;

  registry.forwardEvent({ requestId, event: 'docker:log', payload: { message: 'hola' } });
  registry.forwardEvent({ requestId, event: 'profiles:status', payload: [], broadcast: true });
  assert.deepEqual(events, [{ room: 'profile:p9', event: 'docker:log', payload: { message: 'hola' } }]);
  assert.equal(broadcasts[0].event, 'profiles:status');

  registry.resolveResult({ requestId, ok: true, data: { running: false } });
  assert.deepEqual(await promise, { running: false });
});

test('desconectar el agente falla las peticiones pendientes y lo marca offline', async () => {
  registry._reset();
  const socket = fakeSocket('ws-c');
  registry.register(socket, { agentId: 'ws-c' });
  const promise = registry.request('ws-c', 'check', { id: 'p1', projectPath: '' });
  registry.unregister(socket);

  assert.equal(registry.isOnline('ws-c'), false);
  await assert.rejects(promise, /Agente ws-c desconectado/);
});

test('sin agente conectado, request rechaza antes de emitir', async () => {
  registry._reset();
  await assert.rejects(
    registry.request('ws-inexistente', 'containers', { id: 'p1' }),
    /no conectado/
  );
});

test('2.4 wait:false devuelve requestId y el hook de fallo se llama al desconectar', async () => {
  registry._reset();
  const socket = fakeSocket('ws-run');
  registry.register(socket, { agentId: 'ws-run' });

  const failures = [];
  const dispatched = await registry.request('ws-run', 'runTests', { id: 'p1' }, {
    wait: false,
    onFailure: (err) => failures.push(err.message),
  });
  assert.equal(dispatched.dispatched, true);
  assert.ok(dispatched.requestId);

  registry.unregister(socket);
  assert.deepEqual(failures, ['Agente ws-run desconectado']);
});

test('2.4 timeout cierra la petición y dispara onFailure', async () => {
  registry._reset();
  const socket = fakeSocket('ws-timeout');
  registry.register(socket, { agentId: 'ws-timeout' });

  const failures = [];
  await assert.rejects(
    registry.request('ws-timeout', 'collect', { id: 'p1' }, {
      timeout: 10,
      onFailure: (err) => failures.push(err.message),
    }),
    /Timeout esperando al agente ws-timeout \(collect\)/
  );
  assert.equal(failures.length, 1);
  assert.match(failures[0], /Timeout/);
});

test('2.4 un agent:result fallido dispara onFailure en wait:false', async () => {
  registry._reset();
  const socket = fakeSocket('ws-error');
  registry.register(socket, { agentId: 'ws-error' });

  const failures = [];
  const { requestId } = await registry.request('ws-error', 'runTests', { id: 'p1' }, {
    wait: false,
    onFailure: (err) => failures.push(err.message),
  });
  registry.resolveResult({ requestId, ok: false, error: 'Playwright no instalado' });
  assert.deepEqual(failures, ['Playwright no instalado']);
});

test('2.3 la API redacta claves sensibles en test:output', async () => {
  registry._reset();
  const events = [];
  registry.attach({
    to: () => ({ emit: (event, payload) => events.push({ event, payload }) }),
    emit: () => {},
  });
  const socket = fakeSocket('ws-redact');
  registry.register(socket, { agentId: 'ws-redact' });
  const { requestId } = await registry.request('ws-redact', 'runTests', { id: 'p7' }, { wait: false });
  registry.forwardEvent({
    requestId,
    event: 'test:output',
    payload: { id: 't1', line: 'API_TOKEN=abc123 y PASSWORD: s3cret' },
  });
  assert.equal(events[0].payload.line, 'API_TOKEN=*** y PASSWORD=***');
});
