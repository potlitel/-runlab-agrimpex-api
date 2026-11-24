#!/usr/bin/env node
// Agente de workstation para el módulo Docker de RunLab Agrimpex.
//
// Se conecta SALIENTE a la API central por Socket.io, se autentica con token y
// ejecuta las operaciones Docker en el host donde corre. El socket del daemon
// nunca se expone: quien habla con él es este proceso local.

// Node 22 con NODE_USE_ENV_PROXY=1 mete también el cliente Socket.io en el
// proxy corporativo, incluso hacia una API interna. El flag se lee al arrancar
// el proceso, así que hay que relanzarse sin él; HTTP_PROXY/HTTPS_PROXY se
// conservan para Docker.
if (process.env.NODE_USE_ENV_PROXY) {
  const { spawnSync } = require('child_process');
  const env = { ...process.env };
  delete env.NODE_USE_ENV_PROXY;
  const child = spawnSync(process.execPath, [__filename, ...process.argv.slice(2)], {
    env,
    stdio: 'inherit',
  });
  process.exit(child.status === null ? 1 : child.status);
}

const fs = require('fs');
const os = require('os');
const path = require('path');
const { io: connect } = require('socket.io-client');
const runner = require('../services/dockerRunner');

const URL = process.env.RUNLABQA_AGENT_URL || 'http://localhost:3001';
const AGENT_ID = process.env.RUNLABQA_AGENT_ID || '';
const TOKEN = process.env.RUNLABQA_AGENT_TOKEN || '';
const LABEL = process.env.RUNLABQA_AGENT_LABEL || os.hostname();
const REPORT_MAX_BYTES = 10 * 1024 * 1024;

if (!AGENT_ID || !TOKEN) {
  console.error('[agent] RUNLABQA_AGENT_ID y RUNLABQA_AGENT_TOKEN son obligatorios');
  process.exit(1);
}

// Adaptador de `io` para reutilizar dockerRunner sin cambios: sus eventos
// (`docker:log`, `docker:started`, `docker:exit`, `profiles:status`) viajan
// dentro de `agent:event` con el requestId de la petición.
function ioFor(socket, requestId) {
  const send = (event, payload) =>
    socket.emit('agent:event', { requestId, event, payload });
  return {
    to: () => ({ emit: send }),
    emit: (event, payload) =>
      socket.emit('agent:event', { requestId, event, payload, broadcast: true }),
  };
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

    default:
      throw new Error(`Operación de agente desconocida: ${op}`);
  }
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

socket.on('agent:command', async (message) => {
  const { requestId, op, profile, args } = message || {};
  if (!requestId || !op) return;
  console.log(`[agent] ${requestId} → ${op}`);
  try {
    const data = await execute(op, profile || {}, args || {}, socket, requestId);
    socket.emit('agent:result', { requestId, ok: true, data });
  } catch (e) {
    console.error(`[agent] ${requestId} falló: ${e.message}`);
    socket.emit('agent:result', { requestId, ok: false, error: e.message });
  }
});

for (const signal of ['SIGINT', 'SIGTERM']) {
  process.on(signal, () => {
    socket.disconnect();
    process.exit(0);
  });
}
