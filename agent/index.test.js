const { test, after } = require('node:test');
const assert = require('node:assert');
const fs = require('fs');
const os = require('os');
const path = require('path');
const agent = require('./index');
const collector = require('../services/playwrightCollector');
const pwRunner = require('../services/playwrightRunner');

const originalCollect = collector.collectTests;
const originalRunTests = pwRunner.runTests;
const originalAbort = pwRunner.abortExecution;

function fakeSocket() {
  const emitted = [];
  return {
    id: 'socket-test',
    emitted,
    emit(event, payload) { emitted.push({ event, payload }); },
  };
}

function resultOf(socket, requestId) {
  return new Promise((resolve) => {
    const check = () => {
      const found = socket.emitted.find((e) => e.event === 'agent:result' && e.payload.requestId === requestId);
      if (found) return resolve(found.payload);
      setImmediate(check);
    };
    check();
  });
}

after(() => {
  collector.collectTests = originalCollect;
  pwRunner.runTests = originalRunTests;
  pwRunner.abortExecution = originalAbort;
  agent.activeRuns.clear();
});

test('2.1 collect reutiliza el collector con projectPath y comando recibidos', async () => {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'agent-collect-'));
  const kit = path.join(dir, 'fake-playwright');
  const report = {
    config: { projects: [{ name: 'chromium' }], rootDir: dir },
    suites: [{ title: 'a.spec.ts', file: 'a.spec.ts', specs: [{ title: 'works', file: 'a.spec.ts' }] }],
  };
  fs.writeFileSync(kit, `#!/bin/sh\ncat <<'EOF'\n${JSON.stringify(report)}\nEOF\n`, { mode: 0o755 });
  fs.mkdirSync(path.join(dir, 'kit'), { recursive: true });

  const seen = [];
  collector.collectTests = async (projectPath, cmd) => {
    seen.push({ projectPath, cmd });
    return { files: { 'a.spec.ts': ['a.spec.ts::works'] }, total: 1, projects: ['chromium'] };
  };
  const data = await agent.execute('collect', { id: 'p1' }, {
    projectPath: path.join(dir, 'kit'),
    runnerCmd: kit,
  }, fakeSocket(), 'req-collect');

  assert.deepEqual(seen[0], { projectPath: path.join(dir, 'kit'), cmd: kit });
  assert.deepEqual(data.files, { 'a.spec.ts': ['a.spec.ts::works'] });
  assert.equal(data.total, 1);
  assert.deepEqual(data.projects, ['chromium']);
});

test('2.1 falta de Playwright produce error explícito', async () => {
  collector.collectTests = originalCollect;
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'agent-no-pw-'));
  await assert.rejects(
    agent.execute('collect', { id: 'p1' }, {
      projectPath: dir,
      runnerCmd: '/no/existe/playwright-bin',
    }, fakeSocket(), 'req-missing'),
    /No se pudo ejecutar Playwright|No se encontraron tests/
  );
});

test('2.2 runTests despacha al instante y emite eventos con requestId', async () => {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'agent-run-'));
  const summary = { total: 1, passed: 1, failed: 0 };
  pwRunner.runTests = async (io, profileId, testIds, projectPath, cmd, envVars, paramsByTest, reportsDir, options) => {
    io.to(`profile:${profileId}`).emit('execution:started', { total: testIds.length });
    io.to(`profile:${profileId}`).emit('progress', { current: 1, total: 1 });
    io.to(`profile:${profileId}`).emit('execution:completed', { reportId: options.reportId, summary });
    fs.writeFileSync(path.join(reportsDir, `${options.reportId}.json`), JSON.stringify({ id: options.reportId, summary }));
    return { reportId: options.reportId, summary };
  };

  const socket = fakeSocket();
  const dispatched = await agent.execute('runTests', { id: 'p1' }, {
    profileId: 'p1',
    projectPath: '/kit',
    runId: 'agent_runX',
    testIds: ['a.spec.ts::works'],
    reportsDir: dir,
    envVars: {},
  }, socket, 'req-run');

  assert.deepEqual(dispatched, { dispatched: true });
  const result = await resultOf(socket, 'req-run');
  assert.equal(result.ok, true);
  assert.equal(result.data.reportId, 'agent_runX');
  assert.equal(result.data.manifest.files.length, 1);
  assert.equal(result.data.manifest.files[0].path, 'agent_runX.json');

  const events = socket.emitted.filter((e) => e.event === 'agent:event').map((e) => e.payload);
  assert.deepEqual(events.map((e) => e.event), ['execution:started', 'progress', 'execution:completed']);
  assert.ok(events.every((e) => e.requestId === 'req-run'));
  assert.deepEqual(events[2].payload.summary, summary);
});

test('2.3 abort cancela la corrida del requestId indicado', async () => {
  let pendingResolve;
  pwRunner.runTests = () => new Promise((resolve) => { pendingResolve = resolve; });
  const aborted = [];
  pwRunner.abortExecution = (profileId) => aborted.push(profileId);

  const socket = fakeSocket();
  await agent.execute('runTests', { id: 'p1' }, {
    profileId: 'p9',
    projectPath: '/kit',
    runId: 'agent_abort',
    testIds: ['a.spec.ts::works'],
    reportsDir: fs.mkdtempSync(path.join(os.tmpdir(), 'agent-abort-')),
  }, socket, 'req-abortable');

  const result = await agent.execute('abort', { id: 'p1' }, { requestId: 'req-abortable' }, socket, 'req-abort');
  assert.deepEqual(result, { aborted: true, requestId: 'req-abortable' });
  assert.deepEqual(aborted, ['p9']);
  const final = resultOf(socket, 'req-abortable');
  pendingResolve({ reportId: 'agent_abort', summary: {} });
  assert.equal((await final).ok, true);
  assert.equal(agent.activeRuns.has('req-abortable'), false);
});

test('2.3 ioFor redacta secretos en test:output', () => {
  const socket = fakeSocket();
  const io = agent.ioFor(socket, 'req-redact', ['super-secreto-123']);
  io.to('profile:p1').emit('test:output', { id: 't1', line: 'TOKEN=super-secreto-123 ok' });
  io.emit('test:output', { id: 't1', line: 'otra línea super-secreto-123' });

  const outputs = socket.emitted
    .filter((e) => e.event === 'agent:event' && e.payload.event === 'test:output')
    .map((e) => e.payload.payload.line);
  assert.deepEqual(outputs, ['TOKEN=*** ok', 'otra línea ***']);
  assert.equal(agent.redactSecrets('x=super-secreto-123', ['super-secreto-123']), 'x=***');
});

test('2.3 handleCommand no emite resultado duplicado para runTests', async () => {
  pwRunner.runTests = async (io, profileId, ids, projectPath, cmd, env, params, reportsDir, options) => {
    return { reportId: options.reportId, summary: {} };
  };
  const socket = fakeSocket();
  await agent.handleCommand(socket, {
    requestId: 'req-handler',
    op: 'runTests',
    profile: { id: 'p1' },
    args: {
      profileId: 'p1',
      projectPath: '/kit',
      runId: 'agent_handler',
      testIds: ['t1'],
      reportsDir: fs.mkdtempSync(path.join(os.tmpdir(), 'agent-handler-')),
    },
  });
  const results = socket.emitted.filter((e) => e.event === 'agent:result');
  assert.equal(results.length, 0); // el resultado final lo emite la corrida en segundo plano
  const final = await resultOf(socket, 'req-handler');
  assert.equal(final.ok, true);
});
