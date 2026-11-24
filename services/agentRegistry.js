// Registro de agentes de workstation y enrutado de comandos Docker.
// La API central no ejecuta `docker`: solo conoce agentes conectados por
// Socket.io y reenvía sus eventos a la sala del perfil que los solicitó.

const DEFAULT_TIMEOUT = 15000;
const OP_TIMEOUTS = { collect: 60000, abort: 10000 };

let io = null;
const agents = new Map(); // agentId -> { socketId, socket, label, connectedAt }
const pending = new Map(); // requestId -> { resolve, reject, profileId, agentId, wait, hooks }
let seq = 0;

// Redacción defensiva en la API: además de que el agente no reenvía valores de
// entorno, las claves sensibles nunca deben llegar a la sala del perfil.
const SECRET_KEY = /(?:token|password|secret|key|credential)/i;
function redactOutputLine(line) {
  return String(line == null ? '' : line).replace(
    /([A-Za-z0-9_.-]+)\s*[=:]\s*("[^"]*"|'[^']*'|[^\s,;]+)/g,
    (match, key, value) => (SECRET_KEY.test(key) ? `${key}=***` : match)
  );
}

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

// Cierre único de una petición fallida: limpia el timer, avisa al hook de
// fallo (operaciones `wait:false`) y rechaza la promesa cuando la hay.
function failRequest(requestId, entry, error) {
  if (!pending.has(requestId)) return;
  pending.delete(requestId);
  if (entry.timer) clearTimeout(entry.timer);
  if (entry.onFailure) {
    try { entry.onFailure(new Error(error)); } catch (e) { console.error('[registry] onFailure:', e.message); }
  }
  if (entry.reject) entry.reject(new Error(error));
}

function failPendingFor(agentId, error) {
  for (const [requestId, entry] of [...pending.entries()]) {
    if (entry.agentId !== agentId) continue;
    failRequest(requestId, entry, error);
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
  if (!entry) return;
  let payload = message.payload === undefined ? {} : message.payload;
  if (message.event === 'test:output' && payload && typeof payload === 'object' && typeof payload.line === 'string') {
    payload = { ...payload, line: redactOutputLine(payload.line) };
  }
  if (entry.onEvent) {
    try { entry.onEvent(message.event, payload, message); } catch (e) { console.error('[registry] onEvent:', e.message); }
  }
  if (!io) return;
  if (message.broadcast) io.emit(message.event, payload);
  else io.to(`profile:${entry.profileId}`).emit(message.event, payload);
}

function resolveResult(message) {
  const entry = message && pending.get(message.requestId);
  if (!entry) return;
  if (message.ok) {
    if (entry.onResult) {
      try { entry.onResult(message.data); } catch (e) { console.error('[registry] onResult:', e.message); }
    }
    pending.delete(message.requestId);
    if (entry.timer) clearTimeout(entry.timer);
    if (entry.resolve) entry.resolve(message.data);
    return;
  }
  failRequest(message.requestId, entry, message.error || 'La operación falló en el agente');
}

/**
 * Envía una operación al agente de la workstation.
 * @param {string} agentId
 * @param {string} op check|status|containers|run|stop|start|report|collect|runTests|abort
 * @param {object} profile { id, projectPath }
 * @param {{ timeout?: number, wait?: boolean, args?: object,
 *          onFailure?: Function, onResult?: Function, onEvent?: Function }} options
 *   args: parámetros de la operación (p. ej. `{ action: 'up-build' }`).
 *   wait:false para `run`/`runTests`, que responden al instante y progresan por eventos.
 *   onFailure/onResult/onEvent: hooks para corridas fire-and-forget.
 */
function request(agentId, op, profile, options = {}) {
  if (!isOnline(agentId)) {
    return Promise.reject(new Error(`Agente ${agentId || '(sin workstationId)'} no conectado`));
  }
  const agent = agents.get(String(agentId));
  const requestId = nextRequestId();
  const wait = options.wait !== false;

  return new Promise((resolve, reject) => {
    const entry = {
      resolve: wait ? resolve : null,
      reject: wait ? reject : null,
      profileId: profile.id,
      agentId: String(agentId),
      timer: null,
      onFailure: options.onFailure || null,
      onResult: options.onResult || null,
      onEvent: options.onEvent || null,
    };
    if (wait) {
      entry.timer = setTimeout(() => {
        failRequest(requestId, entry, `Timeout esperando al agente ${agentId} (${op})`);
      }, options.timeout || OP_TIMEOUTS[op] || DEFAULT_TIMEOUT);
    }
    pending.set(requestId, entry);
    agent.socket.emit('agent:command', { requestId, op, profile, args: options.args || {} });
    // Las operaciones fire-and-forget (run/runTests) se consideran despachadas
    // al instante; su progreso y cierre llegan por `agent:event`/`agent:result`.
    // Se devuelve el requestId para que la API pueda registrar la corrida.
    if (!wait) resolve({ dispatched: true, requestId });
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
