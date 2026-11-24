const fs = require('fs');
const { readEnv } = require('./envManager');
const { runTests, isRunning } = require('./playwrightRunner');
const { ensureGrid } = require('./dockerControl');
const pm = require('./profileManager');

let io = null;
let lastTickMinute = null;

function loadFrom(schedPath) {
  try { return JSON.parse(fs.readFileSync(schedPath, 'utf-8')); }
  catch { return []; }
}

function saveTo(schedPath, list) {
  fs.writeFileSync(schedPath, JSON.stringify(list, null, 2));
}

function readConfigAt(configPath) {
  try { return JSON.parse(fs.readFileSync(configPath, 'utf-8')); }
  catch { return {}; }
}

function uid() {
  return 's_' + Date.now().toString(36) + Math.random().toString(36).slice(2, 7);
}

// Próxima ejecución (ISO) a partir de `from`. days: [] = todos los días.
function computeNextRun(s, from = new Date()) {
  if (!s.enabled || !s.time) return null;
  const [hh, mm] = s.time.split(':').map(Number);
  if (Number.isNaN(hh) || Number.isNaN(mm)) return null;
  for (let i = 0; i < 8; i++) {
    const d = new Date(from);
    d.setDate(from.getDate() + i);
    d.setHours(hh, mm, 0, 0);
    if (d <= from) continue;
    const dow = d.getDay();
    if (!s.days || s.days.length === 0 || s.days.includes(dow)) return d.toISOString();
  }
  return null;
}

function emitLog(activeIo, profileId, message, type = 'info') {
  if (activeIo) activeIo.to(`profile:${profileId}`).emit('schedule:log', { message, type, ts: Date.now(), profileId });
  console.log('[scheduler]', profileId, message);
}

function getRunnerCmd(cfg) {
  if (cfg && cfg.playwrightCmd) return cfg.playwrightCmd;
  if (cfg && cfg.pytestCmd) {
    console.warn('[scheduler] `pytestCmd` está deprecado; migra a `playwrightCmd`.');
    return cfg.pytestCmd;
  }
  return 'npx playwright';
}

// Entorno del subprocess: .env base + grid + params de la programación.
function buildEnv(cfg, schedule) {
  let env = {};
  if (cfg.envPath && fs.existsSync(cfg.envPath)) {
    env = Object.fromEntries(
      readEnv(cfg.envPath).filter(v => !v.isComment && v.key).map(v => [v.key, v.value])
    );
  }
  if (cfg.seleniumRemoteUrl) env.SELENIUM_REMOTE_URL = cfg.seleniumRemoteUrl;
  if (schedule.params && typeof schedule.params === 'object') {
    for (const [k, v] of Object.entries(schedule.params)) {
      if (k && v !== undefined && v !== null && String(v).trim() !== '') env[String(k).trim()] = String(v);
    }
  }
  return env;
}

async function trigger(schedule, paths, ioOverride) {
  const activeIo = ioOverride || io;
  const pid = paths.id;
  if (isRunning(pid)) {
    emitLog(activeIo, pid, `Programación "${schedule.name}" omitida: ya hay una ejecución en curso en este perfil`, 'error');
    return { ok: false, reason: 'busy' };
  }
  const cfg = readConfigAt(paths.config);
  if (!cfg.projectPath) {
    emitLog(activeIo, pid, `Programación "${schedule.name}" sin proyecto configurado`, 'error');
    return { ok: false, reason: 'no-project' };
  }
  const base = (schedule.testIds || []).filter(Boolean);
  if (!base.length) {
    emitLog(activeIo, pid, `Programación "${schedule.name}" sin tests`, 'error');
    return { ok: false, reason: 'no-tests' };
  }

  const repeat = Math.max(1, schedule.repeat || 1);
  const testIds = Array.from({ length: repeat }, () => base).flat();
  const env = buildEnv(cfg, schedule);
  const runnerCmd = getRunnerCmd(cfg);

  if (schedule.useDocker && cfg.seleniumRemoteUrl) {
    emitLog(activeIo, pid, `"${schedule.name}": levantando Selenium en Docker...`);
    try { await ensureGrid(activeIo, { ...paths, id: pid }); }
    catch (e) { emitLog(activeIo, pid, `"${schedule.name}": Docker falló — ${e.message}`, 'error'); }
  }

  const list = loadFrom(paths.schedules);
  const item = list.find(x => x.id === schedule.id);
  if (item) { item.lastRun = new Date().toISOString(); saveTo(paths.schedules, list); }

  emitLog(activeIo, pid, `▶ Ejecutando programación "${schedule.name}" (${testIds.length} test${testIds.length !== 1 ? 's' : ''})`, 'success');
  if (activeIo) activeIo.to(`profile:${pid}`).emit('schedule:run', { id: schedule.id, name: schedule.name, total: testIds.length, profileId: pid });

  runTests(activeIo, pid, testIds, cfg.projectPath, runnerCmd, env, schedule.paramsByTest || {}, paths.reportsDir);
  return { ok: true };
}

function tick() {
  const now = new Date();
  const minuteKey = `${now.getFullYear()}-${now.getMonth()}-${now.getDate()}-${now.getHours()}-${now.getMinutes()}`;
  if (minuteKey === lastTickMinute) return;
  lastTickMinute = minuteKey;

  const hhmm = now.toTimeString().slice(0, 5);
  const dow = now.getDay();
  for (const prof of pm.listProfiles()) {
    const paths = pm.profilePaths(prof.id);
    for (const s of loadFrom(paths.schedules)) {
      if (!s.enabled || s.time !== hhmm) continue;
      if (s.days && s.days.length && !s.days.includes(dow)) continue;
      trigger(s, paths);
    }
  }
}

function start(_io) {
  io = _io;
  setInterval(tick, 20000);
  tick();
  console.log('[scheduler] iniciado');
}

function isStarted() {
  return !!io;
}

module.exports = { loadFrom, saveTo, uid, computeNextRun, trigger, start, isStarted };
