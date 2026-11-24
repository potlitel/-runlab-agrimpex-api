const { test } = require('node:test');
const assert = require('node:assert');
const fs = require('fs');
const path = require('path');
const os = require('os');
const http = require('http');
const express = require('express');

const AVATAR = { style: 'notionists', seed: 'semilla' };

function server() {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'pa-'));
  fs.mkdirSync(path.join(dir, 'profiles'), { recursive: true });
  process.env.RUNLABQA_DATA_DIR = dir;
  ['../services/profileManager', './profileAdmin'].forEach(m => { try { delete require.cache[require.resolve(m)]; } catch {} });
  const app = express();
  app.use(express.json());
  app.use('/api/profile-admin', require('./profileAdmin'));
  return http.createServer(app);
}

function req(srv, method, urlPath, body) {
  return new Promise((resolve) => {
    const data = body ? JSON.stringify(body) : null;
    const r = http.request({ ...srv.address(), method, path: urlPath, headers: { 'content-type': 'application/json' } }, (res) => {
      let b = ''; res.on('data', d => b += d); res.on('end', () => resolve({ status: res.statusCode, body: b ? JSON.parse(b) : null }));
    });
    if (data) r.write(data); r.end();
  });
}

test('alta: avatar obligatorio y válido', async () => {
  const app = server();
  await new Promise(r => app.listen(0, r));
  const missing = await req(app, 'POST', '/api/profile-admin', { name: 'Sin avatar' });
  assert.strictEqual(missing.status, 400);
  assert.match(missing.body.error, /avatar requerido/);
  const invalid = await req(app, 'POST', '/api/profile-admin', {
    name: 'Invalido', avatar: { style: 'x', seed: 'a' },
  });
  assert.strictEqual(invalid.status, 400);
  assert.match(invalid.body.error, /avatar\.style inválido/);
  const created = await req(app, 'POST', '/api/profile-admin', { name: 'Con avatar', avatar: AVATAR });
  assert.strictEqual(created.status, 200);
  assert.deepStrictEqual(created.body.avatar, AVATAR);
  const list = await req(app, 'GET', '/api/profile-admin');
  assert.deepStrictEqual(list.body.profiles[0].avatar, AVATAR);
  app.close();
});

test('actualización: avatar, nombre y renombrado compatible', async () => {
  const app = server();
  await new Promise(r => app.listen(0, r));
  const created = await req(app, 'POST', '/api/profile-admin', {
    name: 'Perfil', avatar: { style: 'notionists', seed: 'a' },
  });
  const id = created.body.id;
  const onlyAvatar = await req(app, 'PATCH', `/api/profile-admin/${id}`, {
    avatar: { style: 'lorelei', seed: 'b' },
  });
  assert.strictEqual(onlyAvatar.status, 200);
  assert.strictEqual(onlyAvatar.body.name, 'Perfil');
  assert.deepStrictEqual(onlyAvatar.body.avatar, { style: 'lorelei', seed: 'b' });

  const both = await req(app, 'PATCH', `/api/profile-admin/${id}`, {
    name: 'Renombrado', avatar: { style: 'bottts', seed: 'c' },
  });
  assert.strictEqual(both.status, 200);
  assert.strictEqual(both.body.name, 'Renombrado');
  assert.deepStrictEqual(both.body.avatar, { style: 'bottts', seed: 'c' });

  assert.strictEqual((await req(app, 'PATCH', `/api/profile-admin/${id}`, {})).status, 400);
  const invalid = await req(app, 'PATCH', `/api/profile-admin/${id}`, {
    avatar: { style: 'x', seed: 'a' },
  });
  assert.strictEqual(invalid.status, 400);
  assert.match(invalid.body.error, /avatar\.style inválido/);
  assert.strictEqual(
    (await req(app, 'PATCH', '/api/profile-admin/no-existe', { avatar: AVATAR })).status,
    404
  );

  const renamed = await req(app, 'PATCH', `/api/profile-admin/${id}/rename`, { name: 'Solo nombre' });
  assert.strictEqual(renamed.status, 200);
  const list = await req(app, 'GET', '/api/profile-admin');
  assert.strictEqual(list.body.profiles[0].name, 'Solo nombre');
  assert.deepStrictEqual(list.body.profiles[0].avatar, { style: 'bottts', seed: 'c' });
  app.close();
});

test('duplicado: herencia, override y override inválido', async () => {
  const app = server();
  await new Promise(r => app.listen(0, r));
  const origin = await req(app, 'POST', '/api/profile-admin', {
    name: 'Origen', avatar: { style: 'bottts', seed: 'origen' },
  });
  const id = origin.body.id;

  const inherited = await req(app, 'POST', `/api/profile-admin/${id}/duplicate`, { name: 'Copia' });
  assert.strictEqual(inherited.status, 200);
  assert.deepStrictEqual(inherited.body.avatar, { style: 'bottts', seed: 'origen' });

  const overridden = await req(app, 'POST', `/api/profile-admin/${id}/duplicate`, {
    name: 'Otra', avatar: { style: 'lorelei', seed: 'otra' },
  });
  assert.strictEqual(overridden.status, 200);
  assert.deepStrictEqual(overridden.body.avatar, { style: 'lorelei', seed: 'otra' });

  const invalid = await req(app, 'POST', `/api/profile-admin/${id}/duplicate`, {
    name: 'Invalida', avatar: { style: 'x', seed: 'a' },
  });
  assert.strictEqual(invalid.status, 400);
  assert.match(invalid.body.error, /avatar\.style inválido/);

  const list = await req(app, 'GET', '/api/profile-admin');
  assert.strictEqual(list.body.profiles.length, 3);
  assert.deepStrictEqual(list.body.profiles[0].avatar, { style: 'bottts', seed: 'origen' });
  app.close();
});

test('crear, listar, activar, borrar', async () => {
  const app = server();
  await new Promise(r => app.listen(0, r));
  const c = await req(app, 'POST', '/api/profile-admin', { name: 'Perfil 1', avatar: AVATAR });
  assert.strictEqual(c.status, 200);
  assert.strictEqual(c.body.id, 'perfil-1');
  const list = await req(app, 'GET', '/api/profile-admin');
  assert.strictEqual(list.body.profiles.length, 1);
  await req(app, 'POST', '/api/profile-admin', { name: 'Perfil 2', avatar: AVATAR });
  const act = await req(app, 'PATCH', '/api/profile-admin/perfil-2/activate');
  assert.strictEqual(act.status, 200);
  const del = await req(app, 'DELETE', '/api/profile-admin/perfil-1');
  assert.strictEqual(del.status, 200);
  app.close();
});

test('no permite borrar el ultimo perfil', async () => {
  const app = server();
  await new Promise(r => app.listen(0, r));
  await req(app, 'POST', '/api/profile-admin', { name: 'Solo', avatar: AVATAR });
  const del = await req(app, 'DELETE', '/api/profile-admin/solo');
  assert.strictEqual(del.status, 409);
  app.close();
});
