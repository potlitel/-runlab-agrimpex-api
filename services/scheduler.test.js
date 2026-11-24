const { test, after } = require('node:test');
const assert = require('node:assert');
const fs = require('fs');
const os = require('os');
const path = require('path');
const scheduler = require('./scheduler');
const dockerControl = require('./dockerControl');
const testControl = require('./testControl');

const originalEnsureGrid = dockerControl.ensureGrid;
const originalRun = testControl.run;
const originalIsRemoteRunning = testControl.isRemoteRunning;

after(() => {
  dockerControl.ensureGrid = originalEnsureGrid;
  testControl.run = originalRun;
  testControl.isRemoteRunning = originalIsRemoteRunning;
});

function pathsFor(config) {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'scheduler-test-'));
  const configPath = path.join(dir, 'config.json');
  fs.writeFileSync(configPath, JSON.stringify(config));
  return {
    id: 'p1',
    config: configPath,
    schedules: path.join(dir, 'schedules.json'),
    reportsDir: path.join(dir, 'reports'),
  };
}

const io = { to: () => ({ emit: () => {} }) };

test('3.3 la corrida programada despacha al agente del workstationId', async () => {
  const grids = [];
  const dispatches = [];
  dockerControl.ensureGrid = async (activeIo, profile) => {
    const cfg = JSON.parse(fs.readFileSync(profile.config, 'utf-8'));
    grids.push({ ...profile, workstationId: cfg.workstationId });
    return { up: true };
  };
  testControl.isRemoteRunning = () => false;
  testControl.run = async (activeIo, profile, context) => {
    dispatches.push({ profile, context });
    return { mode: 'agent', started: true };
  };

  const paths = pathsFor({
    projectPath: '/kit',
    workstationId: 'ws-a',
    seleniumRemoteUrl: 'http://grid:4444',
  });
  const result = await scheduler.trigger({
    id: 's1',
    name: 'Nocturna',
    testIds: ['a.spec.ts::test'],
    useDocker: true,
    params: { ENV: 'QA' },
  }, paths, io);

  assert.equal(result.ok, true);
  assert.equal(grids.length, 1);
  assert.equal(grids[0].workstationId, 'ws-a');
  assert.equal(dispatches.length, 1);
  assert.equal(dispatches[0].profile.config, paths.config);
  assert.equal(dispatches[0].context.profileId, 'p1');
  assert.equal(dispatches[0].context.envVars.ENV, 'QA');
  assert.equal(dispatches[0].context.projectPath, '/kit');
});

test('3.3 un fallo del grid impide despachar la suite', async () => {
  dockerControl.ensureGrid = async () => { throw new Error('grid caído'); };
  testControl.run = async () => { throw new Error('no debería despacharse'); };

  const paths = pathsFor({
    projectPath: '/kit',
    workstationId: 'ws-a',
    seleniumRemoteUrl: 'http://grid:4444',
  });
  const result = await scheduler.trigger({
    id: 's2',
    name: 'Falla grid',
    testIds: ['a.spec.ts::test'],
    useDocker: true,
  }, paths, io);

  assert.equal(result.ok, false);
  assert.equal(result.reason, 'grid-failed');
});
