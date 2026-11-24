// Punto único de decisión de transporte para recolección y corridas de tests.
// Es el análogo de `dockerControl.js` para el módulo de pruebas: con
// `workstationId` y agente conectado todo se ejecuta en la workstation; sin ID
// se mantiene la ejecución local, y `RUNLABQA_DOCKER_TRANSPORT=local` fuerza el
// modo legado. Nunca hay fallback silencioso a local si el agente no responde.

const fs = require('fs');
const path = require('path');
const collector = require('./playwrightCollector');
const runner = require('./playwrightRunner');
const registry = require('./agentRegistry');

const FILE_SIZE_LIMIT = 10 * 1024 * 1024;
const RUN_SIZE_LIMIT = 50 * 1024 * 1024;
const ALLOWED_EXT = new Set([
  '.json', '.html', '.htm', '.txt', '.log', '.css', '.js',
  '.png', '.jpg', '.jpeg', '.gif', '.webp', '.bmp',
  '.zip', '.webm', '.trace',
]);

// profileId -> { requestId, agentId, runId, startedAt, status, artifacts }
const remoteRuns = new Map();

function isLegacyLocal() {
  return process.env.RUNLABQA_DOCKER_TRANSPORT === 'local';
}

function readConfig(profile) {
  try {
    return JSON.parse(fs.readFileSync(profile.config, 'utf-8')) || {};
  } catch {
    return {};
  }
}

/**
 * Selecciona el transporte para un perfil.
 * @returns {{ mode: 'local'|'agent', agentId: string, config: object }}
 * @throws Error explícita (AGENT_OFFLINE) si hay workstationId sin agente.
 */
function selectTransport(profile) {
  if (isLegacyLocal()) return { mode: 'local', agentId: '', config: readConfig(profile) };

  const config = readConfig(profile);
  const agentId = String(config.workstationId || '');
  if (!agentId) return { mode: 'local', agentId: '', config };

  if (!registry.isOnline(agentId)) {
    const err = new Error(`Agente ${agentId} no conectado; la corrida no se ejecutará localmente`);
    err.code = 'AGENT_OFFLINE';
    err.workstationId = agentId;
    throw err;
  }
  return { mode: 'agent', agentId, config };
}

function agentProfile(profile, agentId) {
  const config = readConfig(profile);
  return {
    id: profile.id,
    projectPath: config.projectPath || '',
    workstationId: agentId,
  };
}

// ── Registro de corridas remotas ────────────────────────────────────

function isRemoteRunning(profileId) {
  const run = remoteRuns.get(String(profileId));
  return !!(run && run.status === 'running');
}

function getRemoteRun(profileId) {
  const run = remoteRuns.get(String(profileId));
  return run ? { ...run } : null;
}

function startRemoteRun(profileId, info) {
  const run = {
    requestId: info.requestId,
    agentId: info.agentId,
    runId: info.runId,
    startedAt: new Date().toISOString(),
    status: 'running',
    artifacts: null,
  };
  remoteRuns.set(String(profileId), run);
  return { ...run };
}

function finishRemoteRun(profileId, requestId, status, extra = {}) {
  const run = remoteRuns.get(String(profileId));
  if (!run || (requestId && run.requestId !== requestId)) return;
  remoteRuns.set(String(profileId), { ...run, status, ...extra });
}

function clearRemoteRuns() {
  remoteRuns.clear();
}

// ── Artefactos ──────────────────────────────────────────────────────

/**
 * Escribe el manifiesto recibido del agente en `reportsDir/agent/<runId>`.
 * Valida rutas relativas, extensiones y límites por archivo y por corrida.
 */
function persistArtifacts(reportsDir, runId, manifest) {
  const target = path.resolve(reportsDir, 'agent', path.basename(String(runId)));
  const saved = [];
  const rejected = [];
  let total = 0;

  fs.mkdirSync(target, { recursive: true });

  const files = (manifest && Array.isArray(manifest.files)) ? manifest.files : [];
  for (const file of files) {
    const rel = String((file && file.path) || '');
    const reason = validateArtifactPath(rel);
    if (reason) {
      rejected.push({ path: rel, reason });
      continue;
    }

    let bytes;
    try {
      bytes = Buffer.from(String((file && file.data) || ''), 'base64');
    } catch {
      rejected.push({ path: rel, reason: 'base64 inválido' });
      continue;
    }
    if (bytes.length > FILE_SIZE_LIMIT) {
      rejected.push({ path: rel, reason: 'excede 10 MB por archivo' });
      continue;
    }
    if (total + bytes.length > RUN_SIZE_LIMIT) {
      rejected.push({ path: rel, reason: 'excede 50 MB por corrida' });
      continue;
    }

    const dest = path.resolve(target, rel);
    if (!dest.startsWith(target + path.sep)) {
      rejected.push({ path: rel, reason: 'ruta fuera del directorio de la corrida' });
      continue;
    }
    try {
      fs.mkdirSync(path.dirname(dest), { recursive: true });
      fs.writeFileSync(dest, bytes);
    } catch (e) {
      rejected.push({ path: rel, reason: e.message });
      continue;
    }
    total += bytes.length;
    saved.push({ path: rel, size: bytes.length });
  }

  return { saved, rejected, total, dir: target };
}

function validateArtifactPath(rel) {
  if (!rel) return 'ruta vacía';
  if (path.isAbsolute(rel)) return 'ruta absoluta';
  if (rel.split(/[\\/]/).includes('..')) return 'traversal (..)';
  const ext = path.extname(rel).toLowerCase();
  if (!ALLOWED_EXT.has(ext)) return `extensión no permitida (${ext || 'sin extensión'})`;
  return null;
}

// ── Operaciones ─────────────────────────────────────────────────────

async function collect(profile, runnerCmd = 'npx playwright') {
  const transport = selectTransport(profile);
  if (transport.mode === 'local') {
    return collector.collectTests(transport.config.projectPath || '', runnerCmd);
  }
  const data = await registry.request(transport.agentId, 'collect', agentProfile(profile, transport.agentId), {
    args: {
      projectPath: transport.config.projectPath || '',
      runnerCmd,
    },
  });
  return data || { files: {}, total: 0, projects: [] };
}

/**
 * Despacha una corrida. En local arranca el runner sin bloquear (la UI sigue
 * por eventos); en agente usa `wait:false` y devuelve en cuanto se despacha.
 */
async function run(io, profile, context) {
  const transport = selectTransport(profile);

  if (transport.mode === 'local') {
    Promise.resolve()
      .then(() => runner.runTests(
        io,
        context.profileId,
        context.testIds,
        context.projectPath || transport.config.projectPath || '',
        context.runnerCmd || 'npx playwright',
        context.envVars || {},
        context.paramsByTest || {},
        context.reportsDir,
        context.options || {}
      ))
      .catch((e) => console.error('[testControl] corrida local fallida:', e.message));
    return { mode: 'local', started: true };
  }

  const runId = `agent_${Date.now().toString(36)}_${Math.random().toString(36).slice(2, 7)}`;
  const profileId = String(context.profileId || profile.id);
  const reportsDir = context.reportsDir;

  const dispatched = await registry.request(transport.agentId, 'runTests', agentProfile(profile, transport.agentId), {
    wait: false,
    args: {
      runId,
      profileId,
      projectPath: context.projectPath || transport.config.projectPath || '',
      runnerCmd: context.runnerCmd || 'npx playwright',
      testIds: context.testIds || [],
      envVars: context.envVars || {},
      paramsByTest: context.paramsByTest || {},
      options: { ...(context.options || {}), reportId: runId },
      reportsDir: context.agentReportsDir || '',
    },
    onResult: (data) => {
      const manifest = data && data.manifest;
      const artifacts = manifest ? persistArtifacts(reportsDir, runId, manifest) : null;
      finishRemoteRun(profileId, dispatched.requestId, 'completed', { artifacts });
    },
    onFailure: (error) => {
      finishRemoteRun(profileId, dispatched.requestId, 'failed', { error: error.message });
      if (io) io.to(`profile:${profileId}`).emit('execution:failed', {
        error: error.message, runId, profileId,
      });
      console.error('[testControl] corrida remota fallida:', runId, error.message);
    },
  });

  startRemoteRun(profileId, {
    requestId: dispatched.requestId,
    agentId: transport.agentId,
    runId,
  });
  return { mode: 'agent', started: true, requestId: dispatched.requestId, runId, agentId: transport.agentId };
}

async function abort(profile, context = {}) {
  const run = getRemoteRun(context.profileId || profile.id);
  if (!run) return { remote: false };

  await registry.request(run.agentId, 'abort', agentProfile(profile, run.agentId), {
    args: { requestId: context.requestId || run.requestId, runId: run.runId },
    timeout: 10000,
  });
  finishRemoteRun(context.profileId || profile.id, run.requestId, 'aborted');
  return { remote: true, requestId: run.requestId, agentId: run.agentId };
}

module.exports = {
  isLegacyLocal,
  selectTransport,
  collect,
  run,
  abort,
  isRemoteRunning,
  getRemoteRun,
  startRemoteRun,
  finishRemoteRun,
  clearRemoteRuns,
  persistArtifacts,
  validateArtifactPath,
  FILE_SIZE_LIMIT,
  RUN_SIZE_LIMIT,
};
