const express = require('express');
const fs = require('fs');
const agentRegistry = require('../services/agentRegistry');
const localRouter = require('./docker-local');

const router = express.Router();
const TRANSPORT = process.env.RUNLABQA_DOCKER_TRANSPORT === 'local' ? 'local' : 'agent';
const ACTIONS = new Set(['up-selenium', 'up-build', 'rebuild', 'down', 'down-all']);

function readConfig(req) {
  try {
    return JSON.parse(fs.readFileSync(req.profile.config, 'utf-8')) || {};
  } catch {
    return {};
  }
}

// En modo agente la API solo enruta; en modo `local` todas las rutas caen al
// router legado, que ejecuta docker en el host de la API (desarrollo).
function viaAgent(handler) {
  return async (req, res, next) => {
    if (TRANSPORT === 'local') return next();

    const config = readConfig(req);
    const agentId = config.workstationId || '';
    if (!agentId) {
      return res.status(400).json({
        error: 'El perfil no tiene workstationId. Configúralo en Ajustes > Proyecto.',
        transport: TRANSPORT,
      });
    }
    if (!agentRegistry.isOnline(agentId)) {
      return res.status(503).json({
        error: `Agente ${agentId} no conectado. Verifica RUNLABQA_AGENT_ID y el token en la workstation.`,
        transport: TRANSPORT,
        workstationId: agentId,
      });
    }

    const profile = {
      id: req.profile.id,
      projectPath: config.projectPath || '',
      workstationId: agentId,
    };
    try {
      await handler(req, res, { agentId, profile });
    } catch (e) {
      if (!res.headersSent) {
        res.status(502).json({ error: e.message, transport: TRANSPORT, workstationId: agentId });
      }
    }
  };
}

router.get('/agents', (req, res) => {
  res.json({ agents: TRANSPORT === 'local' ? [] : agentRegistry.list(), transport: TRANSPORT });
});

router.get('/check', viaAgent(async (req, res, { agentId, profile }) => {
  const data = await agentRegistry.request(agentId, 'check', profile);
  res.json({ ...data, workstationId: agentId, transport: TRANSPORT });
}));

router.post('/start-desktop', viaAgent(async (req, res, { agentId, profile }) => {
  const data = await agentRegistry.request(agentId, 'start', profile);
  res.json({ ...data, workstationId: agentId, transport: TRANSPORT });
}));

router.get('/status', viaAgent(async (req, res, { agentId, profile }) => {
  const data = await agentRegistry.request(agentId, 'status', profile);
  res.json({ ...data, workstationId: agentId, transport: TRANSPORT });
}));

router.get('/containers', viaAgent(async (req, res, { agentId, profile }) => {
  const data = await agentRegistry.request(agentId, 'containers', profile);
  res.json({ ...data, workstationId: agentId, transport: TRANSPORT });
}));

router.post('/run', viaAgent(async (req, res, { agentId, profile }) => {
  const action = String((req.body && req.body.action) || '');
  if (!ACTIONS.has(action)) {
    return res.status(400).json({ error: `Acción Docker inválida: ${action}` });
  }
  // El progreso llega por Socket.io; la respuesta HTTP es inmediata.
  void agentRegistry.request(agentId, 'run', profile, { wait: false, args: { action } })
    .catch((e) => console.error('[docker] fallo al despachar run:', e.message));
  res.json({ started: true, workstationId: agentId, transport: TRANSPORT });
}));

router.post('/stop', viaAgent(async (req, res, { agentId, profile }) => {
  const data = await agentRegistry.request(agentId, 'stop', profile);
  res.json({ ...data, workstationId: agentId, transport: TRANSPORT });
}));

router.get('/report', viaAgent(async (req, res, { agentId, profile }) => {
  const data = await agentRegistry.request(agentId, 'report', profile);
  if (!data || !data.exists) {
    return res.status(404).send('Aún no hay reporte. Ejecuta los tests primero.');
  }
  res.type('html').send(Buffer.from(data.html, 'base64'));
}));

// Modo legado: mismo contrato, pero ejecutando docker en el host de la API.
router.use(localRouter);

module.exports = router;
module.exports.TRANSPORT = TRANSPORT;
