#!/usr/bin/env node
// Agente de workstation para RunLab Agrimpex.
//
// Se conecta SALIENTE a la API central por Socket.io, se autentica con token y
// ejecuta las operaciones Docker y de tests en el host donde corre. El socket
// del daemon nunca se expone: quien habla con él es este proceso local.

const fs = require('fs');
const os = require('os');
const path = require('path');
const { io: connect } = require('socket.io-client');
const runner = require('../services/dockerRunner');
const collector = require('../services/playwrightCollector');
const pwRunner = require('../services/playwrightRunner');

const URL = process.env.RUNLABQA_AGENT_URL || 'http://localhost:3001';
const AGENT_ID = process.env.RUNLABQA_AGENT_ID || '';
const TOKEN = process.env.RUNLABQA_AGENT_TOKEN || '';
const LABEL = process.env.RUNLABQA_AGENT_LABEL || os.hostname();
const REPORT_MAX_BYTES = 10 * 1024 * 1024;
const DEFAULT_AGENT_REPORTS_DIR = path.join(os.tmpdir(), 'runlab-agent-reports');

// requestId -> { profileId, runId } de las corridas en curso en este agente.
const activeRuns = new Map();

// Operaciones que notifican su propio `agent:result` al terminar en segundo
// plano; el handler no debe emitir un resultado adicional al despacharlas.
const BACKGROUND_OPS = new Set(['runTests']);

/** Sustituye cualquier valor de entorno que aparezca en la salida reenviada. */
function redactSecrets(text, secrets) {
  let out = String(text == null ? '' : text);
  for (const value of secrets || []) {
    const secret = String(value || '');
    if (secret.length < 3) continue; // evita reemplazos ruidosos de valores triviales
    out = out.split(secret).join('***');
  }
  return out;
}

// Adaptador de `io` para reutilizar los runners sin cambios: sus eventos
// (`docker:*`, `execution:*`, `test:*`, `progress`) viajan dentro de
// `agent:event` con el requestId de la petición.
function ioFor(socket, requestId, secrets = []) {
  const send = (event, payload) => {
    let safePayload = payload;
    if (event === 'test:output' && payload && typeof payload === 'object') {
      safePayload = { ...payload, line: redactSecrets(payload.line, secrets) };
    }
    socket.emit('agent:event', { requestId, event, payload: safePayload });
  };
  return {
    to: () => ({ emit: send }),
    emit: (event, payload) => {
      let safePayload = payload;
      if (event === 'test:output' && payload && typeof payload === 'object') {
        safePayload = { ...payload, line: redactSecrets(payload.line, secrets) };
      }
      socket.emit('agent:event', { requestId, event, payload: safePayload, broadcast: true });
    },
  };
}

function addFileToManifest(full, rel, out) {
  let size;
  try { size = fs.statSync(full).size; } catch { return; }
  if (!fs.statSync(full).isFile()) return;
  if (size > REPORT_MAX_BYTES) {
    out.skipped.push({ path: rel, reason: 'excede 10 MB' });
    return;
  }
  out.files.push({ path: rel, size, data: fs.readFileSync(full).toString('base64') });
}

function walkDir(dir, base, out) {
  if (!fs.existsSync(dir)) return;
  for (const entry of fs.readdirSync(dir, { withFileTypes: true })) {
    const full = path.join(dir, entry.name);
    const rel = path.relative(base, full).replace(/\\/g, '/');
    if (entry.isDirectory()) walkDir(full, base, out);
    else if (entry.isFile()) addFileToManifest(full, rel, out);
  }
}

/** Manifiesto de artefactos de una corrida, solo dentro del directorio dado. */
function buildManifest(reportsDir, reportId) {
  const base = path.resolve(reportsDir);
  const out = { reportId, files: [], skipped: [] };
  const reportJson = path.join(base, `${reportId}.json`);
  if (fs.existsSync(reportJson)) addFileToManifest(reportJson, `${reportId}.json`, out);
  walkDir(path.join(base, reportId), base, out);
  return out;
}

async function execute(op, profile, args, socket, requestId) {
  const io = ioFor(socket, requestId);

  switch (op) {
    case 'check':
      return runner.checkDocker();

    case 'containers':
      return runner.listContainers();

    case 'status': {
      const [grid, proj] = await Promise.all([
        runner.gridStatus(profile),
        runner.projectStatus(profile),
      ]);
      const state = runner.status(profile);
      const reportPath = profile.projectPath
        ? path.join(profile.projectPath, 'reports', 'report.html')
        : '';
      return {
        ...state,
        projectPath: profile.projectPath || '',
        gridUp: grid.up,
        projectUp: proj.count,
        hasReport: !!reportPath && fs.existsSync(reportPath),
      };
    }

    case 'run':
      return runner.run(io, profile, String(args.action || ''));

    case 'ensureGrid':
      return runner.ensureGrid(io, profile);

    case 'stop':
      return { stopped: runner.stop(io, profile) };

    case 'start':
      return runner.startDockerDesktop(io);

    case 'report': {
      const file = profile.projectPath
        ? path.join(profile.projectPath, 'reports', 'report.html')
        : '';
      if (!file || !fs.existsSync(file)) return { exists: false };
      if (fs.statSync(file).size > REPORT_MAX_BYTES) {
        throw new Error('El reporte supera el límite de 10 MB del agente');
      }
      return { exists: true, html: fs.readFileSync(file).toString('base64') };
    }

    case 'collect': {
      const projectPath = String(args.projectPath || profile.projectPath || '');
      if (!projectPath) throw new Error('projectPath requerido para collect');
      const result = await collector.collectTests(projectPath, String(args.runnerCmd || 'npx playwright'));
      return {
        files: result.files || {},
        total: result.total || 0,
        projects: result.projects || [],
        ...(result.errorFiles ? { errorFiles: result.errorFiles } : {}),
      };
    }

    case 'runTests': {
      const ctx = args || {};
      const projectPath = String(ctx.projectPath || profile.projectPath || '');
      if (!projectPath) throw new Error('projectPath requerido para runTests');
      const testIds = Array.isArray(ctx.testIds) ? ctx.testIds : [];
      if (!testIds.length) throw new Error('No se recibieron tests para runTests');

      const envVars = (ctx.envVars && typeof ctx.envVars === 'object') ? ctx.envVars : {};
      const secrets = Object.values(envVars)
        .filter((v) => v !== undefined && v !== null && String(v).length >= 3);
      const reportsDir = String(ctx.reportsDir || DEFAULT_AGENT_REPORTS_DIR);
      const runId = String(ctx.runId || requestId);
      const profileId = String(ctx.profileId || profile.id || 'agent');
      const options = (ctx.options && typeof ctx.options === 'object') ? { ...ctx.options } : {};
      if (!options.reportId) options.reportId = runId;

      fs.mkdirSync(reportsDir, { recursive: true });
      const runIo = ioFor(socket, requestId, secrets);
      activeRuns.set(requestId, { profileId, runId });

      // Despacho inmediato: la API ya recibió `{ dispatched: true }` y el
      // progreso/resultado final llegan por eventos con este requestId.
      Promise.resolve()
        .then(() => pwRunner.runTests(
          runIo,
          profileId,
          testIds,
          projectPath,
          String(ctx.runnerCmd || 'npx playwright'),
          envVars,
          ctx.paramsByTest || {},
          reportsDir,
          options
        ))
        .then((result) => {
          activeRuns.delete(requestId);
          socket.emit('agent:result', {
            requestId,
            ok: true,
            data: {
              reportId: result.reportId,
              summary: result.summary,
              manifest: buildManifest(reportsDir, result.reportId),
            },
          });
        })
        .catch((err) => {
          activeRuns.delete(requestId);
          socket.emit('agent:result', { requestId, ok: false, error: err.message });
        });

      return { dispatched: true };
    }

    case 'abort': {
      const target = String(args.requestId || '');
      const active = activeRuns.get(target);
      const profileId = String((active && active.profileId) || profile.id || 'agent');
      pwRunner.abortExecution(profileId);
      return { aborted: true, requestId: target || null };
    }

    default:
      throw new Error(`Operación de agente desconocida: ${op}`);
  }
}

async function handleCommand(socket, message) {
  const { requestId, op, profile, args } = message || {};
  if (!requestId || !op) return;
  console.log(`[agent] ${requestId} → ${op}`);
  try {
    const data = await execute(op, profile || {}, args || {}, socket, requestId);
    if (!BACKGROUND_OPS.has(op)) {
      socket.emit('agent:result', { requestId, ok: true, data });
    }
  } catch (e) {
    console.error(`[agent] ${requestId} falló: ${e.message}`);
    socket.emit('agent:result', { requestId, ok: false, error: e.message });
  }
}

function main() {
  if (!AGENT_ID || !TOKEN) {
    console.error('[agent] RUNLABQA_AGENT_ID y RUNLABQA_AGENT_TOKEN son obligatorios');
    process.exit(1);
  }

  const socket = connect(URL, {
    auth: { role: 'agent', agentId: AGENT_ID, token: TOKEN, label: LABEL },
    reconnection: true,
    reconnectionDelay: 2000,
  });

  socket.on('connect', () =>
    console.log(`[agent] ${AGENT_ID} conectado a ${URL}`));

  socket.on('agent:ready', ({ agentId }) =>
    console.log(`[agent] registrado como ${agentId}`));

  socket.on('agent:error', ({ error }) =>
    console.error(`[agent] rechazado: ${error}`));

  socket.on('connect_error', (err) =>
    console.error(`[agent] no pudo conectar: ${err.message}`));

  socket.on('disconnect', (reason) =>
    console.warn(`[agent] desconectado (${reason}); reintentando…`));

  socket.on('agent:command', (message) => { void handleCommand(socket, message); });

  for (const signal of ['SIGINT', 'SIGTERM']) {
    process.on(signal, () => {
      socket.disconnect();
      process.exit(0);
    });
  }
}

// Node 22 con NODE_USE_ENV_PROXY=1 mete también el cliente Socket.io en el
// proxy corporativo, incluso hacia una API interna. El flag se lee al arrancar
// el proceso, así que hay que relanzarse sin él; HTTP_PROXY/HTTPS_PROXY se
// conservan para Docker. Solo aplica al ejecutar el agente como script.
if (require.main === module && process.env.NODE_USE_ENV_PROXY) {
  const { spawnSync } = require('child_process');
  const env = { ...process.env };
  delete env.NODE_USE_ENV_PROXY;
  const child = spawnSync(process.execPath, [__filename, ...process.argv.slice(2)], {
    env,
    stdio: 'inherit',
  });
  process.exit(child.status === null ? 1 : child.status);
}

if (require.main === module) main();

module.exports = {
  execute,
  handleCommand,
  ioFor,
  redactSecrets,
  buildManifest,
  activeRuns,
  BACKGROUND_OPS,
  REPORT_MAX_BYTES,
};
