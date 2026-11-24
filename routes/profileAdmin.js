const express = require('express');
const router = express.Router();
const pm = require('../services/profileManager');

// Servicios con estado runtime por perfil (para no borrar/renombrar en caliente).
let runtimeBusy = () => false;
try { runtimeBusy = require('../services/runtimeRegistry').isProfileBusy; } catch {}

router.get('/', (req, res) => {
  res.json(pm.getProfileSettings());
});

router.patch('/settings', (req, res) => {
  try {
    res.json(pm.updateProfileSettings(req.body || {}));
  } catch (e) { res.status(400).json({ error: e.message }); }
});

router.post('/', (req, res) => {
  try {
    const name = (req.body && req.body.name) || '';
    if (!name.trim()) return res.status(400).json({ error: 'name requerido' });
    let avatar;
    try { avatar = pm.validateAvatar(req.body && req.body.avatar); }
    catch (e) { return res.status(400).json({ error: e.message }); }
    const testDataSource = req.body && req.body.testDataSource;
    const options = { avatar };
    if (testDataSource) options.testDataSource = testDataSource;
    res.json(pm.createProfile(name, options));
  } catch (e) { res.status(500).json({ error: e.message }); }
});

router.patch('/:id/rename', (req, res) => {
  try {
    const name = (req.body && req.body.name) || '';
    if (!name.trim()) return res.status(400).json({ error: 'name requerido' });
    pm.renameProfile(req.params.id, name);
    res.json({ success: true });
  } catch (e) { res.status(400).json({ error: e.message }); }
});

router.post('/:id/duplicate', (req, res) => {
  try {
    const name = (req.body && req.body.name) || '';
    if (!name.trim()) return res.status(400).json({ error: 'name requerido' });
    const options = {};
    if (req.body && Object.prototype.hasOwnProperty.call(req.body, 'avatar')) {
      try { options.avatar = pm.validateAvatar(req.body.avatar); }
      catch (e) { return res.status(400).json({ error: e.message }); }
    }
    res.json(pm.duplicateProfile(req.params.id, name, options));
  } catch (e) { res.status(400).json({ error: e.message }); }
});

router.patch('/:id/activate', (req, res) => {
  try {
    if (!pm.profileExists(req.params.id)) return res.status(404).json({ error: 'Perfil no encontrado' });
    pm.setActiveProfileId(req.params.id);
    res.json({ success: true, activeProfileId: req.params.id });
  } catch (e) { res.status(500).json({ error: e.message }); }
});

router.patch('/:id', (req, res) => {
  try {
    if (!pm.profileExists(req.params.id)) return res.status(404).json({ error: 'Perfil no encontrado' });
    const body = req.body || {};
    const hasName = Object.prototype.hasOwnProperty.call(body, 'name');
    const hasAvatar = Object.prototype.hasOwnProperty.call(body, 'avatar');
    if (!hasName && !hasAvatar) return res.status(400).json({ error: 'name o avatar requeridos' });
    const patch = {};
    if (hasName) {
      if (typeof body.name !== 'string' || !body.name.trim()) {
        return res.status(400).json({ error: 'name requerido' });
      }
      patch.name = body.name;
    }
    if (hasAvatar) {
      try { patch.avatar = pm.validateAvatar(body.avatar); }
      catch (e) { return res.status(400).json({ error: e.message }); }
    }
    res.json(pm.updateProfile(req.params.id, patch));
  } catch (e) { res.status(500).json({ error: e.message }); }
});

router.delete('/:id', (req, res) => {
  try {
    if (pm.listProfiles().length <= 1) return res.status(409).json({ error: 'No se puede borrar el último perfil' });
    if (runtimeBusy(req.params.id)) return res.status(409).json({ error: 'Perfil en ejecución; deténlo antes de borrar' });
    pm.deleteProfile(req.params.id);
    res.json({ success: true, activeProfileId: pm.getActiveProfileId() });
  } catch (e) { res.status(500).json({ error: e.message }); }
});

module.exports = router;
