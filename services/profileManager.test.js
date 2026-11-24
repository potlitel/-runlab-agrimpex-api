const { test } = require('node:test');
const assert = require('node:assert');
const fs = require('fs');
const path = require('path');
const os = require('os');

function load(indexObj) {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'pm-'));
  fs.mkdirSync(path.join(dir, 'profiles'), { recursive: true });
  if (indexObj !== undefined) {
    fs.writeFileSync(path.join(dir, 'profiles', 'index.json'), JSON.stringify(indexObj));
  }
  delete require.cache[require.resolve('./profileManager')];
  process.env.RUNLABQA_DATA_DIR = dir;
  return { pm: require('./profileManager'), dir };
}

test('slugify: normaliza a slug estable', () => {
  const { pm } = load();
  assert.strictEqual(pm.slugify('Perfil 1'), 'perfil-1');
  assert.strictEqual(pm.slugify('  Bde  Prod  '), 'bde-prod');
  assert.strictEqual(pm.slugify('Producción'), 'produccion');
});

test('profilePaths: rutas absolutas bajo profiles/<id>/', () => {
  const { pm, dir } = load();
  const p = pm.profilePaths('perfil-1');
  assert.strictEqual(p.config, path.join(dir, 'profiles', 'perfil-1', 'config.json'));
  assert.strictEqual(p.entornos, path.join(dir, 'profiles', 'perfil-1', 'entornos.json'));
  assert.strictEqual(p.reportsDir, path.join(dir, 'profiles', 'perfil-1', 'reports'));
  assert.strictEqual(p.collection, path.join(dir, 'profiles', 'perfil-1', 'data', 'last-collection.json'));
});

test('resolveProfile: perfil inexistente lanza', () => {
  const { pm } = load({ activeProfileId: 'perfil-1', profiles: [{ id: 'perfil-1', name: 'Perfil 1', createdAt: 'x' }] });
  assert.throws(() => pm.resolveProfile('no-existe'), /Perfil no encontrado/);
  assert.doesNotThrow(() => pm.resolveProfile('perfil-1'));
});

test('getActiveProfileId / setActiveProfileId', () => {
  const { pm } = load({ activeProfileId: 'perfil-1', profiles: [{ id: 'perfil-1', name: 'Perfil 1', createdAt: 'x' }] });
  assert.strictEqual(pm.getActiveProfileId(), 'perfil-1');
  pm.setActiveProfileId('perfil-1');
  assert.strictEqual(pm.getActiveProfileId(), 'perfil-1');
});

test('createProfile: crea dir + archivos + entrada de indice', () => {
  const { pm, dir } = load({ activeProfileId: null, profiles: [] });
  const p = pm.createProfile('Perfil 1');
  assert.strictEqual(p.id, 'perfil-1');
  assert.ok(fs.existsSync(path.join(dir, 'profiles', 'perfil-1', 'config.json')));
  assert.ok(fs.existsSync(path.join(dir, 'profiles', 'perfil-1', 'features.json')));
  assert.ok(pm.profileExists('perfil-1'));
});

test('createProfile: persiste el avatar enviado', () => {
  const { pm } = load({ activeProfileId: null, profiles: [] });
  const avatar = { style: 'bottts', seed: 'semilla-1' };
  const p = pm.createProfile('Perfil 1', { avatar });
  assert.deepStrictEqual(p.avatar, avatar);
  assert.deepStrictEqual(pm.listProfiles()[0].avatar, avatar);
});

test('updateProfile: actualiza nombre y avatar de forma atómica', () => {
  const { pm } = load({ activeProfileId: null, profiles: [] });
  const p = pm.createProfile('Perfil 1', { avatar: { style: 'notionists', seed: 'a' } });
  const avatar = { style: 'lorelei', seed: 'b' };
  const updated = pm.updateProfile(p.id, { name: 'Renombrado', avatar });
  assert.strictEqual(updated.name, 'Renombrado');
  assert.deepStrictEqual(updated.avatar, avatar);
  assert.deepStrictEqual(pm.listProfiles()[0], updated);
  assert.throws(() => pm.updateProfile(p.id, {}), /name o avatar requeridos/);
  assert.throws(() => pm.updateProfile(p.id, { avatar: { style: 'x', seed: 'a' } }), /avatar\.style inválido/);
});

test('renameProfile: conserva el avatar', () => {
  const { pm } = load({ activeProfileId: null, profiles: [] });
  const p = pm.createProfile('Perfil 1', { avatar: { style: 'micah', seed: 'm' } });
  pm.renameProfile(p.id, 'Nuevo nombre');
  const stored = pm.listProfiles()[0];
  assert.strictEqual(stored.name, 'Nuevo nombre');
  assert.deepStrictEqual(stored.avatar, { style: 'micah', seed: 'm' });
});

test('createProfile: id colisionado se sufija', () => {
  const { pm } = load({ activeProfileId: 'perfil-1', profiles: [{ id: 'perfil-1', name: 'Perfil 1', createdAt: 'x' }] });
  const p = pm.createProfile('Perfil 1');
  assert.strictEqual(p.id, 'perfil-1-2');
});

test('duplicateProfile: hereda el avatar o aplica un override válido', () => {
  const { pm } = load({ activeProfileId: null, profiles: [] });
  const origin = pm.createProfile('Origen', { avatar: { style: 'bottts', seed: 'origen' } });
  const copy = pm.duplicateProfile(origin.id, 'Copia');
  assert.deepStrictEqual(copy.avatar, { style: 'bottts', seed: 'origen' });
  assert.deepStrictEqual(pm.listProfiles().find(p => p.id === origin.id).avatar, copy.avatar);
  const override = pm.duplicateProfile(origin.id, 'Copia 2', {
    avatar: { style: 'lorelei', seed: 'otra' },
  });
  assert.deepStrictEqual(override.avatar, { style: 'lorelei', seed: 'otra' });
  assert.throws(
    () => pm.duplicateProfile(origin.id, 'Copia 3', { avatar: { style: 'x', seed: 'a' } }),
    /avatar\.style inválido/
  );
});

test('duplicateProfile: copia config pero no reports', () => {
  const { pm, dir } = load({ activeProfileId: null, profiles: [] });
  pm.createProfile('Origen');
  fs.writeFileSync(path.join(dir, 'profiles', 'origen', 'config.json'), JSON.stringify({ projectPath: 'C:/x' }));
  fs.mkdirSync(path.join(dir, 'profiles', 'origen', 'reports'), { recursive: true });
  fs.writeFileSync(path.join(dir, 'profiles', 'origen', 'reports', 'r.json'), '{}');
  const dup = pm.duplicateProfile('origen', 'Copia');
  const cfg = JSON.parse(fs.readFileSync(path.join(dir, 'profiles', dup.id, 'config.json'), 'utf-8'));
  assert.strictEqual(cfg.projectPath, 'C:/x');
  assert.ok(!fs.existsSync(path.join(dir, 'profiles', dup.id, 'reports', 'r.json')));
});

test('deleteProfile: reasigna activo', () => {
  const { pm } = load({ activeProfileId: null, profiles: [] });
  pm.createProfile('Uno');
  pm.createProfile('Dos');
  pm.setActiveProfileId('uno');
  pm.deleteProfile('uno');
  assert.ok(!pm.profileExists('uno'));
  assert.strictEqual(pm.getActiveProfileId(), 'dos');
});

test('normalizeIndex: fallback determinista se expone y se persiste al mutar', () => {
  const { pm } = load({ activeProfileId: 'perfil-1', profiles: [{ id: 'perfil-1', name: 'Perfil 1' }] });
  const first = pm.getProfileSettings().profiles[0].avatar;
  const second = pm.getProfileSettings().profiles[0].avatar;
  assert.deepStrictEqual(first, { style: 'notionists', seed: 'perfil-1' });
  assert.deepStrictEqual(second, first);
  pm.setActiveProfileId('perfil-1');
  const stored = JSON.parse(fs.readFileSync(pm.INDEX_PATH, 'utf-8'));
  assert.deepStrictEqual(stored.profiles[0].avatar, first);
});

test('validateAvatar: valida estilo y seed, normalizeAvatar usa fallback', () => {
  const { pm } = load();
  assert.deepStrictEqual(
    pm.validateAvatar({ style: 'notionists', seed: ' perfil-1 ' }),
    { style: 'notionists', seed: 'perfil-1' }
  );
  assert.throws(() => pm.validateAvatar(), /avatar requerido/);
  assert.throws(() => pm.validateAvatar({ style: 'otro', seed: 'x' }), /avatar\.style inválido/);
  assert.throws(() => pm.validateAvatar({ style: 'notionists', seed: '' }), /avatar\.seed inválido/);
  assert.throws(() => pm.validateAvatar({ style: 'notionists', seed: 123 }), /avatar\.seed inválido/);
  assert.throws(() => pm.validateAvatar({ style: 'notionists', seed: 'x'.repeat(65) }), /avatar\.seed inválido/);
  assert.deepStrictEqual(pm.normalizeAvatar(null, 'perfil-1'), { style: 'notionists', seed: 'perfil-1' });
  assert.deepStrictEqual(
    pm.normalizeAvatar({ style: 'bottts', seed: 'abc' }, 'perfil-1'),
    { style: 'bottts', seed: 'abc' }
  );
});

test('entornos: read/write/get por path', () => {
  const { pm, dir } = load({ activeProfileId: null, profiles: [] });
  const p = path.join(dir, 'entornos.json');
  pm.writeEntornos(p, { Prepo: [{ key: 'U', value: 'x', isComment: false }] });
  assert.ok(pm.readEntornos(p).Prepo);
  assert.strictEqual(pm.getEntorno(p, 'Prepo')[0].key, 'U');
  assert.strictEqual(pm.getEntorno(p, 'noexiste'), null);
});
