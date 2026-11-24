const express = require('express');
const crypto = require('crypto');
const stackConfig = require('../services/stackConfig');
const { ValidationError, NoBackupError } = stackConfig;

// Mismo gate que /api/system/update: sin UPDATE_TOKEN la administración queda
// deshabilitada (fail closed) y no se revela ningún valor de configuración.
function requireUpdateToken(req, res, next) {
  const expected = process.env.UPDATE_TOKEN;
  if (!expected) {
    return res.status(503).json({
      error: 'La administración del stack está deshabilitada. Define UPDATE_TOKEN en el entorno del backend para activarla.',
      disabled: true,
    });
  }
  const given = req.get('x-update-token') || '';
  const a = Buffer.from(String(given));
  const b = Buffer.from(String(expected));
  const ok = a.length === b.length && crypto.timingSafeEqual(a, b);
  if (!ok) return res.status(401).json({ error: 'Token de administración inválido.' });
  next();
}

function createStackConfigRouter(config = stackConfig) {
  const router = express.Router();

  router.get('/stack-config', requireUpdateToken, (req, res) => {
    try {
      res.json(config.snapshot());
    } catch (e) {
      res.status(500).json({ error: e.message });
    }
  });

  router.put('/stack-config', requireUpdateToken, (req, res) => {
    try {
      res.json(config.save(req.body || {}));
    } catch (e) {
      if (e instanceof ValidationError) return res.status(400).json({ error: e.message });
      res.status(500).json({ error: e.message });
    }
  });

  router.post('/stack-config/restore', requireUpdateToken, (req, res) => {
    try {
      res.json(config.restore());
    } catch (e) {
      if (e instanceof NoBackupError) return res.status(404).json({ error: e.message });
      res.status(500).json({ error: e.message });
    }
  });

  // Sin token: la UI lo necesita antes de saber dónde está la API.
  router.get('/public-config', (req, res) => {
    try {
      res.set('Cache-Control', 'no-store');
      res.json(config.getPublicConfig());
    } catch (e) {
      res.status(500).json({ error: e.message });
    }
  });

  return router;
}

module.exports = createStackConfigRouter();
module.exports.createStackConfigRouter = createStackConfigRouter;
module.exports.requireUpdateToken = requireUpdateToken;
