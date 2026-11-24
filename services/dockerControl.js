// Punto único de entrada para operaciones Docker del backend.
// En modo agente, ni las rutas /api/docker ni el scheduler ejecutan `docker`
// en el servidor: todo se envía a la workstation asignada al perfil.

const fs = require('fs');
const runner = require('./dockerRunner');
const registry = require('./agentRegistry');

const LOCAL = process.env.RUNLABQA_DOCKER_TRANSPORT === 'local';

function readConfig(profile) {
  try {
    return JSON.parse(fs.readFileSync(profile.config, 'utf-8')) || {};
  } catch {
    return {};
  }
}

function ensureGrid(io, profile) {
  if (LOCAL) return runner.ensureGrid(io, profile);

  const cfg = readConfig(profile);
  const agentId = cfg.workstationId || '';
  if (!agentId) {
    return Promise.reject(new Error('El perfil no tiene workstationId; no se puede levantar el grid'));
  }
  return registry.request(agentId, 'ensureGrid', {
    id: profile.id || 'scheduler',
    projectPath: cfg.projectPath || '',
    workstationId: agentId,
  });
}

module.exports = { ensureGrid };
