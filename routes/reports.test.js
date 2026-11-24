const { test } = require('node:test');
const assert = require('node:assert');
const fs = require('fs');
const os = require('os');
const path = require('path');
const http = require('http');
const express = require('express');
const testControl = require('../services/testControl');
const router = require('./reports');

function server(reportsDir) {
  const app = express();
  app.use((req, res, next) => { req.profile = { id: 'p1', reportsDir }; next(); });
  app.use('/api/reports', router);
  return http.createServer(app);
}

function req(srv, urlPath) {
  return new Promise((resolve, reject) => {
    const r = http.request({ ...srv.address(), method: 'GET', path: urlPath }, (res) => {
      let b = '';
      res.on('data', (d) => { b += d; });
      res.on('end', () => resolve({ status: res.statusCode, body: b }));
    });
    r.on('error', reject);
    r.end();
  });
}

test('3.2 /reports lista y sirve artefactos de una corrida remota', async () => {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'agent-reports-route-'));
  const report = {
    id: 'agent_run42',
    timestamp: new Date().toISOString(),
    summary: { total: 2, passed: 2 },
    tests: [],
  };
  const saved = testControl.persistArtifacts(dir, 'agent_run42', {
    files: [
      { path: 'agent_run42.json', data: Buffer.from(JSON.stringify(report)).toString('base64') },
      { path: 'agent_run42/assets/capture.png', data: Buffer.from([0x89, 0x50, 0x4e, 0x47]).toString('base64') },
    ],
  });
  assert.equal(saved.saved.length, 2);

  const srv = server(dir);
  await new Promise((r) => srv.listen(0, '127.0.0.1', r));
  try {
    const list = await req(srv, '/api/reports/');
    assert.equal(list.status, 200);
    const reports = JSON.parse(list.body);
    assert.equal(reports.length, 1);
    assert.equal(reports[0].id, 'agent_run42');

    const detail = await req(srv, '/api/reports/agent_run42');
    assert.equal(detail.status, 200);
    assert.equal(JSON.parse(detail.body).summary.passed, 2);

    const asset = await req(srv, '/api/reports/agent_run42/assets/capture.png');
    assert.equal(asset.status, 200);
  } finally {
    srv.close();
  }
});
