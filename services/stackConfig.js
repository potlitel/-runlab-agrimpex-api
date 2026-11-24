// Configuración central del stack (el .env que acompaña a docker-compose.yml).
//
// Este módulo es el único que puede tocar ese archivo: solo conoce una
// allowlist de claves, conserva comentarios y variables no administrables,
// escribe con archivo temporal + rename y guarda copias en /data. Nunca lee
// ni escribe los .env del proyecto de pruebas ni los de los perfiles.

const fs = require('fs');
const path = require('path');
const crypto = require('crypto');

const API_DIR = path.resolve(__dirname, '..');
const DEFAULT_STACK_DIR = process.env.RUNLABQA_STACK_ENV_DIR
  || path.resolve(API_DIR, '..', 'runlab-agrimpex-ui');
const DEFAULT_DATA_DIR = process.env.RUNLABQA_DATA_DIR
  || path.join(API_DIR, 'data');
const DEFAULT_PUBLIC_CONFIG_PATH = process.env.RUNLABQA_PUBLIC_CONFIG_PATH
  || path.join(DEFAULT_STACK_DIR, 'public', 'public-config.json');

const BACKUP_LIMIT = 10;
const MAX_VALUE_LENGTH = 512;

// `recreate` indica qué servicio hay que recrear cuando la clave cambia.
// Las URLs públicas no aparecen: se resuelven en runtime y no necesitan recreate.
const KEY_SPECS = [
  { key: 'VITE_API_URL', type: 'url', public: 'apiBaseUrl' },
  { key: 'VITE_SOCKET_URL', type: 'url', public: 'socketUrl' },
  { key: 'UI_PORT', type: 'port', recreate: 'runlabqa-ui' },
  { key: 'API_PORT', type: 'port', recreate: 'runlabqa-api' },
  { key: 'RUNLABQA_DOCKER_TRANSPORT', type: 'transport', recreate: 'runlabqa-api' },
  { key: 'RUNLABQA_DATA_DIR', type: 'path', recreate: 'runlabqa-api' },
  { key: 'RUNLABQA_PROFILES_DIR', type: 'path', recreate: 'runlabqa-api' },
  { key: 'PLAYWRIGHT_KIT_DIR', type: 'path', recreate: 'runlabqa-api' },
  { key: 'RUNLABQA_NOVNC_HOST', type: 'host', recreate: 'runlabqa-api' },
  { key: 'RUNLABQA_NOVNC_PORT', type: 'port', recreate: 'runlabqa-api' },
  { key: 'TZ', type: 'text', recreate: 'runlabqa-api' },
  { key: 'RUNLABQA_AGENT_TOKEN', type: 'secret', secret: true, recreate: 'runlabqa-api' },
  { key: 'UPDATE_TOKEN', type: 'secret', secret: true, recreate: 'runlabqa-api' },
];

const ALLOWED_KEYS = KEY_SPECS.map((spec) => spec.key);
const SECRET_KEYS = KEY_SPECS.filter((spec) => spec.secret).map((spec) => spec.key);

class ValidationError extends Error {
  constructor(message) {
    super(message);
    this.name = 'ValidationError';
  }
}

class NoBackupError extends Error {
  constructor() {
    super('No hay copia de seguridad disponible para restaurar.');
    this.name = 'NoBackupError';
  }
}

function readText(file) {
  try {
    return fs.readFileSync(file, 'utf8');
  } catch (e) {
    if (e.code === 'ENOENT') return '';
    throw e;
  }
}

// Parser línea a línea: cada línea se conserva tal cual salvo el valor de las
// claves administradas. Así sobreviven comentarios, líneas en blanco y variables
// añadidas a mano que la UI no conoce.
function parseEnv(content) {
  return content.split('\n').map((line) => {
    const match = /^(\s*)([A-Z][A-Z0-9_]*)\s*=\s*(.*)$/.exec(line);
    if (!match) return { kind: 'other', line };
    const raw = match[3];
    const quote = raw.startsWith('"') ? '"' : raw.startsWith("'") ? "'" : '';
    return { kind: 'var', line, key: match[2], indent: match[1], quote };
  });
}

function formatValue(value, quote) {
  if (value === '') return '';
  if (quote) return `${quote}${value.split(quote).join(`\\${quote}`)}${quote}`;
  return value;
}

function renderEnv(lines, updates) {
  const seen = new Set();
  const rendered = lines.map((entry) => {
    if (entry.kind !== 'var' || !Object.hasOwn(updates, entry.key)) return entry.line;
    seen.add(entry.key);
    const value = updates[entry.key];
    const start = entry.indent + entry.key + '=';
    return `${start}${formatValue(value, entry.quote)}`;
  });

  const missing = Object.entries(updates)
    .filter(([key]) => !seen.has(key))
    .map(([key, value]) => `${key}=${formatValue(value, '')}`);
  if (missing.length === 0) return rendered.join('\n');

  const needsNewline = rendered.length > 0 && rendered[rendered.length - 1] !== '';
  return [...rendered, ...(needsNewline ? [''] : []), ...missing, ''].join('\n');
}

function envValues(lines) {
  const values = {};
  for (const entry of lines) {
    if (entry.kind === 'var' && Object.hasOwn(values, entry.key) === false) {
      values[entry.key] = rawValue(entry.line);
    }
  }
  return values;
}

function rawValue(line) {
  const index = line.indexOf('=');
  if (index === -1) return '';
  return line.slice(index + 1).trim().replace(/^["']|["']$/g, '');
}

function validateValue(spec, key, value) {
  if (typeof value !== 'string') {
    throw new ValidationError(`El valor de ${key} debe ser texto.`);
  }
  if (value.length > MAX_VALUE_LENGTH) {
    throw new ValidationError(`El valor de ${key} supera los ${MAX_VALUE_LENGTH} caracteres.`);
  }
  if (/[\r\n]/.test(value)) {
    throw new ValidationError(`El valor de ${key} no puede contener saltos de línea.`);
  }
  if (value === '') return '';

  switch (spec.type) {
    case 'url': {
      let parsed;
      try { parsed = new URL(value); } catch { throw new ValidationError(`${key} debe ser una URL http(s) válida.`); }
      if (!['http:', 'https:'].includes(parsed.protocol)) {
        throw new ValidationError(`${key} debe usar http o https.`);
      }
      return value;
    }
    case 'port':
      if (!/^\d{1,5}$/.test(value) || Number(value) < 1 || Number(value) > 65535) {
        throw new ValidationError(`${key} debe ser un puerto entre 1 y 65535.`);
      }
      return value;
    case 'transport':
      if (!['agent', 'local'].includes(value)) {
        throw new ValidationError(`${key} debe ser "agent" o "local".`);
      }
      return value;
    case 'path':
      if (!/^(\/|[A-Za-z]:[\\/]|\.\.?\/)/.test(value)) {
        throw new ValidationError(`${key} debe ser una ruta absoluta (o relativa a Compose).`);
      }
      return value;
    case 'host':
      if (!/^[A-Za-z0-9._-]{1,253}$/.test(value)) {
        throw new ValidationError(`${key} no es un hostname válido.`);
      }
      return value;
    default:
      return value;
  }
}

function atomicWrite(file, content) {
  fs.mkdirSync(path.dirname(file), { recursive: true });
  const tmp = path.join(
    path.dirname(file),
    `.${path.basename(file)}.tmp-${process.pid}-${crypto.randomBytes(4).toString('hex')}`,
  );
  try {
    fs.writeFileSync(tmp, content, { encoding: 'utf8', mode: 0o600 });
    fs.renameSync(tmp, file);
  } finally {
    try { fs.unlinkSync(tmp); } catch (e) { if (e.code !== 'ENOENT') throw e; }
  }
}

function createStackConfig(options = {}) {
  const envPath = options.envPath || path.join(DEFAULT_STACK_DIR, '.env');
  const backupDir = options.backupDir || path.join(DEFAULT_DATA_DIR, 'config-backups');
  const metaPath = options.metaPath || path.join(backupDir, 'meta.json');
  const publicConfigPath = options.publicConfigPath || DEFAULT_PUBLIC_CONFIG_PATH;

  const specByKey = new Map(KEY_SPECS.map((spec) => [spec.key, spec]));

  function readMeta() {
    try {
      const meta = JSON.parse(readText(metaPath));
      return { version: Number(meta.version) || 0, pendingApply: Array.isArray(meta.pendingApply) ? meta.pendingApply : [] };
    } catch {
      return { version: 0, pendingApply: [] };
    }
  }

  function writeMeta(meta) {
    atomicWrite(metaPath, `${JSON.stringify(meta, null, 2)}\n`);
  }

  function currentState() {
    const lines = parseEnv(readText(envPath));
    return { lines, values: envValues(lines) };
  }

  function pendingFor(keys) {
    return KEY_SPECS
      .filter((spec) => spec.recreate && keys.includes(spec.key))
      .map((spec) => ({
        key: spec.key,
        service: spec.recreate,
        command: `docker compose up -d --force-recreate ${spec.recreate}`,
      }));
  }

  function publicFrom(values, version) {
    const apiBaseUrl = values.VITE_API_URL || '/api';
    const socketUrl = values.VITE_SOCKET_URL
      || (apiBaseUrl.startsWith('http') ? new URL(apiBaseUrl).origin : undefined);
    return { apiBaseUrl, socketUrl, configVersion: version };
  }

  function publishPublicConfig() {
    const { values } = currentState();
    const config = publicFrom(values, readMeta().version);
    // Escritura en el mismo archivo (sin rename): el mount de la UI apunta a
    // este inode y un rename dejaría a la UI sirviendo la versión antigua.
    fs.mkdirSync(path.dirname(publicConfigPath), { recursive: true });
    fs.writeFileSync(publicConfigPath, `${JSON.stringify(config, null, 2)}\n`, 'utf8');
    return config;
  }

  function snapshot() {
    const { values: raw } = currentState();
    const meta = readMeta();
    const values = {};
    const secrets = {};
    for (const spec of KEY_SPECS) {
      const value = raw[spec.key] || '';
      values[spec.key] = spec.secret ? null : value;
      if (spec.secret) secrets[spec.key] = { configured: Boolean(value) };
    }
    return {
      values,
      secrets,
      pendingApply: meta.pendingApply,
      configVersion: meta.version,
    };
  }

  function listBackups() {
    if (!fs.existsSync(backupDir)) return [];
    return fs.readdirSync(backupDir)
      .filter((name) => /^stack-.*\.env$/.test(name))
      .sort()
      .reverse();
  }

  function makeBackup() {
    fs.mkdirSync(backupDir, { recursive: true });
    const stamp = new Date().toISOString().replace(/[:.]/g, '-');
    const target = path.join(backupDir, `stack-${stamp}.env`);
    fs.copyFileSync(envPath, target);
    for (const old of listBackups().slice(BACKUP_LIMIT)) {
      fs.unlinkSync(path.join(backupDir, old));
    }
    return target;
  }

  function commit(updates, changedKeys) {
    makeBackup();
    const meta = readMeta();
    const next = { version: meta.version + 1, pendingApply: pendingFor(changedKeys) };
    const lines = parseEnv(readText(envPath));
    atomicWrite(envPath, renderEnv(lines, updates));
    writeMeta(next);
    publishPublicConfig();
    return snapshot();
  }

  function save(payload = {}) {
    const incomingValues = payload.values ?? {};
    const incomingSecrets = payload.secrets ?? {};
    if (typeof incomingValues !== 'object' || Array.isArray(incomingValues)
      || typeof incomingSecrets !== 'object' || Array.isArray(incomingSecrets)) {
      throw new ValidationError('El cuerpo debe contener los objetos values y secrets.');
    }

    for (const key of Object.keys(incomingValues)) {
      if (!specByKey.has(key)) throw new ValidationError(`Clave no permitida: ${key}`);
      if (specByKey.get(key).secret) {
        throw new ValidationError(`La clave secreta ${key} debe enviarse en secrets.`);
      }
    }
    for (const key of Object.keys(incomingSecrets)) {
      if (!specByKey.has(key) || !specByKey.get(key).secret) {
        throw new ValidationError(`Clave secreta no permitida: ${key}`);
      }
    }

    const { values: before } = currentState();
    const updates = {};
    for (const [key, value] of Object.entries(incomingValues)) {
      updates[key] = validateValue(specByKey.get(key), key, value);
    }
    for (const [key, input] of Object.entries(incomingSecrets)) {
      if (input === null || typeof input !== 'object') {
        throw new ValidationError(`La operación de ${key} debe ser un objeto.`);
      }
      const operation = input.operation || 'keep';
      if (!['keep', 'set', 'clear'].includes(operation)) {
        throw new ValidationError(`Operación no válida para ${key}: ${operation}`);
      }
      if (operation === 'keep') continue;
      if (operation === 'clear') {
        updates[key] = '';
        continue;
      }
      updates[key] = validateValue(specByKey.get(key), key, input.value);
      if (updates[key] === '') {
        throw new ValidationError(`Para reemplazar ${key} hay que aportar un valor no vacío.`);
      }
    }

    const changed = Object.keys(updates).filter(
      (key) => (before[key] || '') !== updates[key],
    );
    return commit(updates, changed);
  }

  function restore() {
    const backups = listBackups();
    if (backups.length === 0) throw new NoBackupError();
    const target = path.join(backupDir, backups[0]);
    const restored = parseEnv(readText(target));
    const restoredValues = envValues(restored);
    const { values: before } = currentState();
    const changed = ALLOWED_KEYS.filter(
      (key) => (before[key] || '') !== (restoredValues[key] || ''),
    );
    const updates = Object.fromEntries(
      changed.map((key) => [key, restoredValues[key] || '']),
    );
    return commit(updates, changed);
  }

  return {
    snapshot,
    save,
    restore,
    publishPublicConfig,
    listBackups,
    getPublicConfig() {
      const { values } = currentState();
      return publicFrom(values, readMeta().version);
    },
    paths: { envPath, backupDir, metaPath, publicConfigPath },
  };
}

const stackConfig = createStackConfig();

module.exports = {
  ...stackConfig,
  createStackConfig,
  ALLOWED_KEYS,
  SECRET_KEYS,
  KEY_SPECS,
  ValidationError,
  NoBackupError,
};
