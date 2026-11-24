const express = require('express');
const http = require('http');
const crypto = require('crypto');
const { Server } = require('socket.io');
const cors = require('cors');
const swaggerUi = require('swagger-ui-express');
const requireFeature = require('./middleware/requireFeature');
const resolveProfile = require('./middleware/resolveProfile');
const swaggerSpec = require('./swagger');
const agentRegistry = require('./services/agentRegistry');

const app = express();
const server = http.createServer(app);
const io = new Server(server, {
  cors: { origin: '*', methods: ['GET', 'POST'] }
});

app.use(cors());
app.use(express.json());

// ── Migración y bootstrap de perfiles ──────────────────────────────
const { migrateIfNeeded } = require('./services/profileMigration');
const pm = require('./services/profileManager');
const migRes = migrateIfNeeded();
if (migRes.migrated) console.log('[profiles] migrado config global ->', migRes.id);
if (pm.listProfiles().length === 0) {
  const p = pm.createProfile('Perfil 1');
  console.log('[profiles] creado perfil inicial', p.id);
}

app.set('io', io);
agentRegistry.attach(io);

// Gestión de perfiles: NO pasa por resolveProfile (opera sobre perfiles en sí).
app.use('/api/profile-admin', require('./routes/profileAdmin'));

// Actualización del propio dashboard: opera sobre los repos, no sobre un
// perfil, así que va antes de resolveProfile igual que profile-admin.
app.use('/api/system', require('./routes/system'));
app.use('/api/system', require('./routes/stackConfig'));

// Publicar el recurso de configuración en runtime también al arrancar, para
// que la UI pueda leerlo aunque todavía no se haya guardado nada.
try {
  require('./services/stackConfig').publishPublicConfig();
} catch (e) {
  console.warn('[stack-config] no se pudo publicar la configuración pública:', e.message);
}

// Salud del proceso: tampoco depende de perfil, para que el healthcheck de
// Docker funcione aunque no haya ninguno configurado.
app.use('/api', require('./routes/health'));

// Todas las demás rutas de /api resuelven el perfil del request.
app.use('/api', resolveProfile);

app.use('/api/config', require('./routes/config'));
app.use('/api/tests', require('./routes/tests'));
app.use('/api/features', require('./routes/features'));
app.use('/api/env', requireFeature('variables'), require('./routes/env'));
app.use('/api/profiles', requireFeature('variables'), require('./routes/profiles'));
app.use('/api/reports', requireFeature('reports'), require('./routes/reports'));
app.use('/api/automation', require('./routes/automation'));
app.use('/api/txtdata', requireFeature('txtData'), require('./routes/txtdata'));
app.use('/api/jsondata', requireFeature('jsonData'), require('./routes/jsondata'));
app.use('/api/docker', requireFeature('docker'), require('./routes/docker'));
app.use('/api/schedules', requireFeature('schedules'), require('./routes/schedules'));
app.use('/api/errors', requireFeature('errorImages'), require('./routes/errors'));

// Swagger/OpenAPI docs (spec inicial; ampliar según se documenten más rutas)
app.use('/api/docs', swaggerUi.serve, swaggerUi.setup(swaggerSpec, { explorer: true }));
app.get('/api/openapi.json', (req, res) => res.json(swaggerSpec));

// Proxy del noVNC: antes del fallback de SPA, que si no se lo tragaria.
require('./middleware/novncProxy')(app, server);

// Despues de todas las rutas /api: el fallback de SPA responde a cualquier GET
// que no sea /api ni /socket.io, asi que registrarlo antes se tragaria la API.
require('./middleware/serveFrontend')(app);

function tokenMatches(actual, expected) {
  if (!expected) return false;
  const a = Buffer.from(String(actual || ''));
  const b = Buffer.from(String(expected));
  return a.length === b.length && crypto.timingSafeEqual(a, b);
}

io.on('connection', (socket) => {
  const auth = socket.handshake.auth || {};

  // Agentes de workstation: conexión saliente, autenticada por token.
  // El daemon Docker permanece en la workstation; aquí solo se registran.
  if (auth.role === 'agent') {
    const agentId = String(auth.agentId || '');
    const validId = /^[A-Za-z0-9._-]{1,64}$/.test(agentId);
    if (!validId || !tokenMatches(auth.token, process.env.RUNLABQA_AGENT_TOKEN)) {
      socket.emit('agent:error', {
        error: process.env.RUNLABQA_AGENT_TOKEN
          ? 'Credenciales de agente inválidas'
          : 'RUNLABQA_AGENT_TOKEN no configurado en la API',
      });
      socket.disconnect(true);
      return;
    }
    try {
      agentRegistry.register(socket, auth);
      console.log('[agent] conectado', agentId);
    } catch (e) {
      socket.emit('agent:error', { error: e.message });
      socket.disconnect(true);
      return;
    }
    socket.on('agent:event', agentRegistry.forwardEvent);
    socket.on('agent:result', agentRegistry.resolveResult);
    socket.on('disconnect', () => {
      agentRegistry.unregister(socket);
      console.log('[agent] desconectado', agentId);
    });
    return;
  }

  console.log('Client connected:', socket.id);
  // El cliente se une a la sala del/los perfil(es) que quiere monitorear.
  socket.on('profile:join', (id) => { if (id) socket.join(`profile:${id}`); });
  socket.on('profile:leave', (id) => { if (id) socket.leave(`profile:${id}`); });
  socket.on('disconnect', () => console.log('Client disconnected:', socket.id));
});

// Programador de tests (calendarización): revisa cada minuto y dispara.
require('./services/scheduler').start(io);

const PORT = process.env.PORT || 3001;
server.listen(PORT, () => {
  console.log(`Backend running on http://localhost:${PORT}`);
});
