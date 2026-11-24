// Registro de agentes de workstation y enrutado de comandos Docker.
// La API central no ejecuta `docker`: solo conoce agentes conectados por
// Socket.io y reenvía sus eventos a la sala del perfil que los solicitó.

const DEFAULT_TIMEOUT = 15000;

let io = null;
const agents = new Map(); // agentId -> { socketId, socket, label, connectedAt }
const pending = new Map(); // requestId -> { resolve, reject, profileId, agentId, wait }
let seq = 0;

function attach(ioRef) {
  io = ioRef;
}

function nextRequestId() {
  seq += 1;
  return `docker-${Date.now().toString(36)}-${seq}`;
}

function register(socket, info) {
  const agentId = String(info.agentId || '');
  if (!agentId) throw new Error('agentId requerido');

  const previous = agents.get(agentId);
  agents.set(agentId, {
    agentId,
    socketId: socket.id,
    socket,
    label: String(info.label || agentId),
    connectedAt: new Date().toISOString(),
  });
  if (previous && previous.socketId !== socket.id) {
    // El agente más reciente gana; el viejo se desconecta y no debe borrar
    // la entrada nueva cuando dispare su evento `disconnect`.
    try { previous.socket.disconnect(true); } catch {}
  }
  socket.join(`agent:${agentId}`);
  socket.emit('agent:ready', { agentId });
}

function failPendingFor(agentId, error) {
  for (const [requestId, entry] of pending.entries()) {
    if (entry.agentId !== agentId) continue;
    pending.delete(requestId);
    if (entry.timer) clearTimeout(entry.timer);
    if (entry.reject) entry.reject(new Error(error));
  }
}

function unregister(socket) {
  const agentId = String((socket.handshake && socket.handshake.auth && socket.handshake.auth.agentId) || '');
  const current = agentId && agents.get(agentId);
  if (current && current.socketId === socket.id) {
    agents.delete(agentId);
    failPendingFor(agentId, `Agente ${agentId} desconectado`);
  }
}

function isOnline(agentId) {
  return !!agentId && agents.has(String(agentId));
}

function list() {
  return [...agents.values()].map((a) => ({
    agentId: a.agentId,
    label: a.label,
    connectedAt: a.connectedAt,
  }));
}

// Evento de progreso del agente: se reemite tal cual a la sala del perfil
// (`docker:started`, `docker:log`, `docker:exit`) o en broadcast
// (`profiles:status`) para que la UI siga consumiendo los eventos de siempre.
function forwardEvent(message) {
  const entry = message && pending.get(message.requestId);
  if (!entry || !io) return;
  const payload = message.payload === undefined ? {} : message.payload;
  if (message.broadcast) io.emit(message.event, payload);
  else io.to(`profile:${entry.profileId}`).emit(message.event, payload);
}

function resolveResult(message) {
  const entry = message && pending.get(message.requestId);
  if (!entry) return;
  pending.delete(message.requestId);
  if (entry.timer) clearTimeout(entry.timer);
  if (!entry.resolve) return; // operación fire-and-forget (run)
  if (message.ok) entry.resolve(message.data);
  else entry.reject(new Error(message.error || 'La operación falló en el agente'));
}

/**
 * Envía una operación al agente de la workstation.
 * @param {string} agentId
 * @param {string} op check|status|containers|run|stop|start|report
 * @param {object} profile { id, projectPath }
 * @param {{ timeout?: number, wait?: boolean, args?: object }} options
 *   args: parámetros de la operación (p. ej. `{ action: 'up-build' }`).
 *   wait:false para `run`, que responde al instante y progresa por eventos.
 */
function request(agentId, op, profile, options = {}) {
  if (!isOnline(agentId)) {
    return Promise.reject(new Error(`Agente ${agentId || '(sin workstationId)'} no conectado`));
  }
  const agent = agents.get(String(agentId));
  const requestId = nextRequestId();
  const wait = options.wait !== false;

  return new Promise((resolve, reject) => {
    const entry = { resolve: wait ? resolve : null, reject: wait ? reject : null, profileId: profile.id, agentId: String(agentId), timer: null };
    if (wait) {
      entry.timer = setTimeout(() => {
        pending.delete(requestId);
        reject(new Error(`Timeout esperando al agente ${agentId} (${op})`));
      }, options.timeout || DEFAULT_TIMEOUT);
    }
    pending.set(requestId, entry);
    agent.socket.emit('agent:command', { requestId, op, profile, args: options.args || {} });
    // Las operaciones fire-and-forget (run) se consideran despachadas al
    // instante; su progreso y cierre llegan por `agent:event`/`agent:result`.
    if (!wait) resolve({ dispatched: true });
  });
}

module.exports = {
  attach,
  register,
  unregister,
  isOnline,
  list,
  request,
  forwardEvent,
  resolveResult,
  _reset: () => { agents.clear(); pending.clear(); seq = 0; io = null; },
};
