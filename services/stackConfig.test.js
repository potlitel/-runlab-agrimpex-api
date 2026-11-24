const { test } = require('node:test');
const assert = require('node:assert');
const fs = require('fs');
const os = require('os');
const path = require('path');
const {
  createStackConfig,
  ValidationError,
  NoBackupError,
} = require('./stackConfig');

const ORIGINAL = [
  '# .env del stack (comentario que debe sobrevivir)',
  'API_PORT=3001',
  'VITE_API_URL=http://localhost:3001/api',
  'OTRO_VALOR=a mano',
  '',
  '# token del agente',
  'RUNLABQA_AGENT_TOKEN=secreto-inicial',
  '',
].join('\n');

function setup(content = ORIGINAL) {
  const root = fs.mkdtempSync(path.join(os.tmpdir(), 'runlab-stack-'));
  const envPath = path.join(root, '.env');
  fs.writeFileSync(envPath, content);
  const config = createStackConfig({
    envPath,
    backupDir: path.join(root, 'backups'),
    metaPath: path.join(root, 'backups', 'meta.json'),
    publicConfigPath: path.join(root, 'public-config.json'),
  });
  return { root, envPath, config };
}

test('guarda una clave permitida conservando comentarios y claves no administrables', () => {
  const { envPath, config } = setup();

  const result = config.save({ values: { VITE_API_URL: 'https://dashboard.example.com/api' } });

  const content = fs.readFileSync(envPath, 'utf8');
  assert.match(content, /# \.env del stack \(comentario que debe sobrevivir\)/);
  assert.match(content, /OTRO_VALOR=a mano/);
  assert.match(content, /VITE_API_URL=https:\/\/dashboard\.example\.com\/api/);
  assert.match(content, /RUNLABQA_AGENT_TOKEN=secreto-inicial/);
  assert.equal(result.configVersion, 1);
  assert.equal(result.values.VITE_API_URL, 'https://dashboard.example.com/api');
  assert.equal(config.listBackups().length, 1);
});

test('publica la configuración pública sin secretos y la actualiza al guardar', () => {
  const { config } = setup();

  assert.deepStrictEqual(config.getPublicConfig(), {
    apiBaseUrl: 'http://localhost:3001/api',
    socketUrl: 'http://localhost:3001',
    configVersion: 0,
  });

  config.save({ values: { VITE_API_URL: 'https://dashboard.example.com/api' } });

  const published = JSON.parse(fs.readFileSync(config.paths.publicConfigPath, 'utf8'));
  assert.deepStrictEqual(published, {
    apiBaseUrl: 'https://dashboard.example.com/api',
    socketUrl: 'https://dashboard.example.com',
    configVersion: 1,
  });
  assert.equal(JSON.stringify(published).includes('secreto-inicial'), false);
});

test('rechaza claves no permitidas sin tocar el archivo', () => {
  const { envPath, config } = setup();
  const before = fs.readFileSync(envPath, 'utf8');

  assert.throws(() => config.save({ values: { OTRO_VALOR: 'cambio' } }), ValidationError);
  assert.throws(() => config.save({ secrets: { API_PORT: { operation: 'set', value: '1' } } }), ValidationError);
  assert.equal(fs.readFileSync(envPath, 'utf8'), before);
  assert.equal(config.listBackups().length, 0);
});

test('rechaza valores con saltos de línea y URLs inválidas', () => {
  const { envPath, config } = setup();
  const before = fs.readFileSync(envPath, 'utf8');

  assert.throws(() => config.save({ values: { TZ: 'UTC\nAPI_PORT=9999' } }), ValidationError);
  assert.throws(() => config.save({ values: { VITE_API_URL: 'ftp://ejemplo' } }), ValidationError);
  assert.throws(() => config.save({ values: { API_PORT: '3001\nX=1' } }), ValidationError);
  assert.equal(fs.readFileSync(envPath, 'utf8'), before);
  assert.equal(config.listBackups().length, 0);
});

test('los secretos se devuelven como null con estado configured y soportan keep/set/clear', () => {
  const { config } = setup();

  let snapshot = config.snapshot();
  assert.equal(snapshot.values.RUNLABQA_AGENT_TOKEN, null);
  assert.deepStrictEqual(snapshot.secrets.RUNLABQA_AGENT_TOKEN, { configured: true });

  snapshot = config.save({ secrets: { RUNLABQA_AGENT_TOKEN: { operation: 'keep' } } });
  assert.deepStrictEqual(snapshot.secrets.RUNLABQA_AGENT_TOKEN, { configured: true });
  assert.match(fs.readFileSync(config.paths.envPath, 'utf8'), /RUNLABQA_AGENT_TOKEN=secreto-inicial/);

  snapshot = config.save({ secrets: { RUNLABQA_AGENT_TOKEN: { operation: 'set', value: 'nuevo-secreto' } } });
  assert.equal(snapshot.values.RUNLABQA_AGENT_TOKEN, null);
  assert.equal(JSON.stringify(snapshot).includes('nuevo-secreto'), false);
  assert.match(fs.readFileSync(config.paths.envPath, 'utf8'), /RUNLABQA_AGENT_TOKEN=nuevo-secreto/);
  assert.deepStrictEqual(snapshot.pendingApply[0], {
    key: 'RUNLABQA_AGENT_TOKEN',
    service: 'runlabqa-api',
    command: 'docker compose up -d --force-recreate runlabqa-api',
  });

  snapshot = config.save({ secrets: { RUNLABQA_AGENT_TOKEN: { operation: 'clear' } } });
  assert.deepStrictEqual(snapshot.secrets.RUNLABQA_AGENT_TOKEN, { configured: false });
  assert.match(fs.readFileSync(config.paths.envPath, 'utf8'), /RUNLABQA_AGENT_TOKEN=$/m);
});

test('los cambios de URL pública no quedan pendientes de recreación', () => {
  const { config } = setup();
  const snapshot = config.save({ values: { VITE_API_URL: 'https://dashboard.example.com/api' } });
  assert.deepStrictEqual(snapshot.pendingApply, []);
});

test('restaura la copia anterior y avisa cuando no hay copia disponible', () => {
  const { envPath, config } = setup();

  assert.throws(() => config.restore(), NoBackupError);
  assert.equal(fs.readFileSync(envPath, 'utf8'), ORIGINAL);

  config.save({ values: { VITE_API_URL: 'https://dashboard.example.com/api' } });
  const restored = config.restore();

  assert.equal(restored.values.VITE_API_URL, 'http://localhost:3001/api');
  assert.equal(restored.configVersion, 2);
  assert.match(fs.readFileSync(envPath, 'utf8'), /VITE_API_URL=http:\/\/localhost:3001\/api/);
});

test('conserva como máximo diez copias de seguridad', () => {
  const { config } = setup();
  for (let i = 0; i < 12; i += 1) {
    config.save({ values: { API_PORT: String(3100 + i) } });
  }
  assert.equal(config.listBackups().length, 10);
});
