const { test } = require('node:test');
const assert = require('node:assert');
const fs = require('fs');
const path = require('path');
const os = require('os');
const {
  runTests,
  buildEvidenceEnv,
  EVIDENCE_ENV_DEFAULTS,
  collectAttachments,
  flattenJsonReport,
  normalizeReportAssets,
  detectImageFormat,
  publishEvidence,
  attachmentBytes,
  ATTACHMENT_BYTES,
} = require('./playwrightRunner');

function tempDir(prefix) {
  return fs.mkdtempSync(path.join(os.tmpdir(), prefix));
}

function pngBuffer(width = 180, height = 60) {
  const png = Buffer.alloc(24);
  Buffer.from([0x89, 0x50, 0x4e, 0x47, 0x0d, 0x0a, 0x1a, 0x0a]).copy(png, 0);
  png.writeUInt32BE(width, 16);
  png.writeUInt32BE(height, 20);
  return png;
}

test('detectImageFormat reconoce la firma real del archivo', () => {
  assert.deepStrictEqual(detectImageFormat(pngBuffer()), { ext: '.png', contentType: 'image/png' });
  assert.deepStrictEqual(detectImageFormat(Buffer.from([0xff, 0xd8, 0xff, 0xe0, 0, 16, 0x4a, 0x46, 0x49, 0x46])), {
    ext: '.jpg',
    contentType: 'image/jpeg',
  });
  assert.strictEqual(detectImageFormat(Buffer.from('esto no es una imagen')), null);
  assert.ok(attachmentBytes(pngBuffer().toString('base64')).equals(pngBuffer()));
});

test('un adjunto body-only se escribe en assets y obtiene assetPath y contentType', () => {
  const root = tempDir('runlab-body-');
  const runAssetsDir = path.join(root, 'assets');
  const body = pngBuffer();
  const collected = collectAttachments({
    attachments: [{ name: 'screenshot-pf1-success', contentType: 'image/png', body }],
  });
  assert.strictEqual(collected[0].path, '');
  assert.ok(collected[0][ATTACHMENT_BYTES]);

  const report = { id: 'report_body', summary: {}, tests: [{ id: 'spec::T1', status: 'passed', attachments: collected }] };
  normalizeReportAssets(report, path.join(root, 'project'), runAssetsDir);

  const att = report.tests[0].attachments[0];
  assert.strictEqual(att.assetPath, 'attachments/screenshot-pf1-success.png');
  assert.strictEqual(att.contentType, 'image/png');
  assert.strictEqual(att.name, 'screenshot-pf1-success');
  assert.ok(fs.existsSync(path.join(runAssetsDir, att.assetPath)));
  assert.strictEqual(report.summary.previewImage, att.assetPath);
  // Los bytes no deben acabar serializados en el reporte.
  assert.ok(!JSON.stringify(report).includes('base64'));
});

test('la publicación incluye capturas de tests que pasan y artefactos de fallo', () => {
  const errors = require('../routes/errors');
  const root = tempDir('runlab-publish-');
  const runAssetsDir = path.join(root, 'assets');
  const reportsDir = path.join(root, 'reports');
  const folder = path.join(root, 'gallery');
  const reportId = 'report_publish';
  fs.mkdirSync(runAssetsDir, { recursive: true });
  fs.mkdirSync(reportsDir, { recursive: true });

  const report = {
    id: reportId,
    timestamp: '2026-11-23T12:00:00.000Z',
    summary: {},
    tests: [
      {
        id: 'spec::T-pass',
        status: 'passed',
        attachments: [{
          name: 'screenshot-pf1-success', contentType: 'image/png', path: '',
          [ATTACHMENT_BYTES]: pngBuffer(320, 180),
        }],
      },
      {
        id: 'spec::T-fail',
        status: 'failed',
        attachments: [{
          name: 'screenshot', contentType: 'image/png', path: '',
          [ATTACHMENT_BYTES]: pngBuffer(640, 360),
        }],
      },
    ],
  };
  normalizeReportAssets(report, path.join(root, 'project'), runAssetsDir);
  publishEvidence(report, runAssetsDir, root, { errorImagesPath: folder });
  fs.writeFileSync(path.join(reportsDir, `${reportId}.json`), JSON.stringify(report, null, 2));

  const reportItems = errors.collectReportItems({ profile: { reportsDir } });
  const passingFromReport = reportItems.find(i => i.testId === 'spec::T-pass');
  assert.ok(passingFromReport, '/errors/images debe incluir capturas de tests que pasan');
  assert.strictEqual(passingFromReport.status, 'passed');
  assert.strictEqual(passingFromReport.source, 'report');
  assert.strictEqual(passingFromReport.evidenceSource, 'capture');
  assert.strictEqual(passingFromReport.width, 320);
  assert.strictEqual(passingFromReport.height, 180);

  const folderItems = errors.collectFolderItems(null, folder);
  assert.ok(!folderItems.some(i => i.name.startsWith('.runlab')), 'el manifiesto no es evidencia');
  const passingFromFolder = folderItems.find(i => i.status === 'passed');
  const failingFromFolder = folderItems.find(i => i.status === 'failed');
  assert.ok(passingFromFolder, 'la galería debe tener la captura del test exitoso');
  assert.ok(failingFromFolder, 'la galería debe conservar el screenshot de fallo');
  assert.strictEqual(passingFromFolder.evidenceSource, 'capture');
  assert.strictEqual(failingFromFolder.evidenceSource, 'failure-artifact');
  assert.strictEqual(passingFromFolder.width, 320);

  const stored = JSON.parse(fs.readFileSync(path.join(reportsDir, `${reportId}.json`), 'utf-8'));
  assert.strictEqual(stored.tests[0].attachments[0].status, 'passed');
  assert.strictEqual(stored.tests[0].attachments[0].evidenceSource, 'capture');
  assert.strictEqual(stored.tests[0].attachments[0].width, 320);
});

test('flattenJsonReport extrae las capturas declaradas por anotación', () => {
  const report = {
    suites: [{
      title: 'spec.spec.ts',
      file: 'spec.spec.ts',
      specs: [{
        title: 'captura declarada',
        file: 'spec.spec.ts',
        tests: [{
          status: 'passed',
          annotations: [
            { type: 'expected-screenshot', description: 'screenshot-estado' },
            { type: 'slow' },
          ],
          results: [{ status: 'passed', attachments: [] }],
        }],
      }],
    }],
  };
  const tests = flattenJsonReport(report, '/tmp/proyecto');
  assert.deepStrictEqual(tests[0].expectedScreenshots, ['screenshot-estado']);
});

test('una corrida señala la captura declarada que no se adjuntó', async () => {
  function fakeIo() {
    return { to: () => ({ emit() {} }), emit() {} };
  }
  const root = tempDir('runlab-integrity-');
  const reportsDir = path.join(root, 'reports');
  const fakeReport = {
    config: { rootDir: root },
    suites: [{
      title: 'spec.spec.ts',
      file: 'spec.spec.ts',
      specs: [
        {
          title: 'no adjunta',
          file: 'spec.spec.ts',
          tests: [{
            status: 'passed',
            annotations: [{ type: 'expected-screenshot', description: 'screenshot-faltante' }],
            results: [{ status: 'passed', duration: 10, attachments: [] }],
          }],
        },
        {
          title: 'sí adjunta',
          file: 'spec.spec.ts',
          tests: [{
            status: 'passed',
            annotations: [{ type: 'expected-screenshot', description: 'screenshot-presente' }],
            results: [{
              status: 'passed',
              duration: 10,
              attachments: [{
                name: 'screenshot-presente',
                contentType: 'image/png',
                body: pngBuffer().toString('base64'),
              }],
            }],
          }],
        },
      ],
    }],
    stats: { expected: 2 },
  };
  const fakeScript = path.join(root, 'fake-playwright.js');
  fs.writeFileSync(fakeScript, `
const fs = require('fs');
const report = ${JSON.stringify(fakeReport)};
fs.writeFileSync(process.env.PLAYWRIGHT_JSON_OUTPUT_FILE, JSON.stringify(report));
`);

  const result = await runTests(
    fakeIo(), 'perfil-integridad', ['spec.spec.ts'], root,
    `node ${fakeScript}`, {}, {}, reportsDir,
  );
  const stored = JSON.parse(fs.readFileSync(path.join(reportsDir, `${result.reportId}.json`), 'utf-8'));

  assert.strictEqual(stored.integrity.issues.length, 1);
  assert.strictEqual(stored.integrity.missingScreenshots.length, 1);
  assert.strictEqual(stored.integrity.missingScreenshots[0].name, 'screenshot-faltante');
  assert.strictEqual(stored.summary.integrityIssues, 1);
  assert.ok(stored.tests.some(t => t.expectedScreenshots.includes('screenshot-presente')));
  assert.ok(!JSON.stringify(stored).includes('"base64"'), 'los bytes del adjunto no se serializan en el reporte');
});

test('un adjunto corrupto se registra como incidencia sin abortar la normalización', () => {
  const root = tempDir('runlab-corrupto-');
  const runAssetsDir = path.join(root, 'assets');
  const projectPath = path.join(root, 'project');
  const corruptFile = path.join(projectPath, 'test-results', 'screenshot-path-corrupto.png');
  fs.mkdirSync(path.dirname(corruptFile), { recursive: true });
  fs.writeFileSync(corruptFile, Buffer.from('esto no es un png'));

  const report = {
    id: 'report_corrupto',
    summary: {},
    tests: [{
      id: 'spec::T-mixto',
      status: 'passed',
      attachments: [
        { name: 'screenshot-valida', contentType: 'image/png', path: '', [ATTACHMENT_BYTES]: pngBuffer(100, 50) },
        { name: 'screenshot-corrupta', contentType: 'image/png', path: '', [ATTACHMENT_BYTES]: Buffer.from('bytes corruptos') },
        { name: 'screenshot-path-corrupto', contentType: 'image/png', path: corruptFile },
      ],
    }],
  };

  assert.doesNotThrow(() => normalizeReportAssets(report, projectPath, runAssetsDir));
  const [valid, corruptBody, corruptPath] = report.tests[0].attachments;
  assert.strictEqual(valid.assetPath, 'attachments/screenshot-valida.png');
  assert.strictEqual(corruptBody.assetPath, undefined);
  assert.strictEqual(corruptPath.assetPath, undefined);
  assert.strictEqual(report.integrity.invalidImages.length, 2);
  assert.strictEqual(report.summary.integrityIssues, 2);
  assert.ok(fs.existsSync(path.join(runAssetsDir, valid.assetPath)), 'la imagen válida se persiste igualmente');
});

test('buildEvidenceEnv traduce el perfil y descarta valores inválidos', () => {
  assert.deepStrictEqual(buildEvidenceEnv({
    imageFormat: 'jpeg', imageQuality: 72, scale: 'device', screenshot: 'always',
  }), {
    RUNLAB_SCREENSHOT_FORMAT: 'jpeg',
    RUNLAB_SCREENSHOT_QUALITY: '72',
    RUNLAB_SCREENSHOT_SCALE: 'device',
  });
  assert.deepStrictEqual(buildEvidenceEnv({ imageQuality: 900, scale: 'rar', imageFormat: 'webp' }), {});
  assert.deepStrictEqual(buildEvidenceEnv(null), {});
  assert.strictEqual(EVIDENCE_ENV_DEFAULTS.RUNLAB_SCREENSHOT_FORMAT, 'png');
});

test('la corrida inyecta y registra la configuración de evidencia del perfil', async () => {
  const events = [];
  const fakeIo = { to: () => ({ emit() {} }), emit() {} };
  fakeIo.to = () => ({
    emit(ev, payload) { events.push({ ev, payload }); },
  });
  const root = tempDir('runlab-env-');
  const reportsDir = path.join(root, 'reports');
  const fakeReport = {
    config: { rootDir: root },
    suites: [{
      title: 'spec.spec.ts',
      file: 'spec.spec.ts',
      specs: [{
        title: 'sin capturas',
        file: 'spec.spec.ts',
        tests: [{ status: 'passed', annotations: [], results: [{ status: 'passed', attachments: [] }] }],
      }],
    }],
    stats: { expected: 1 },
  };
  const fakeScript = path.join(root, 'fake-playwright.js');
  fs.writeFileSync(fakeScript, `
const fs = require('fs');
process.stdout.write('fake playwright env ok\\n');
fs.writeFileSync(process.env.PLAYWRIGHT_JSON_OUTPUT_FILE, JSON.stringify(${JSON.stringify(fakeReport)}));
`);

  const evidence = { screenshot: 'always', fullPage: true, imageFormat: 'jpg', imageQuality: 64, scale: 'device' };
  const result = await runTests(
    fakeIo, 'perfil-evidencia', ['spec.spec.ts'], root,
    `node ${fakeScript}`, { RUNLAB_SCREENSHOT_QUALITY: '10' }, {}, reportsDir, { evidence },
  );
  const stored = JSON.parse(fs.readFileSync(path.join(reportsDir, `${result.reportId}.json`), 'utf-8'));

  assert.strictEqual(stored.evidenceEnv.RUNLAB_SCREENSHOT_FORMAT, 'jpeg');
  assert.strictEqual(stored.evidenceEnv.RUNLAB_SCREENSHOT_QUALITY, '64', 'el perfil gana sobre envVars genérico');
  assert.strictEqual(stored.evidenceEnv.RUNLAB_SCREENSHOT_SCALE, 'device');
  assert.strictEqual(stored.evidenceEnv.RUNLAB_SCREENSHOT_TIMEOUT, '30000', 'default documentado');
  const logLines = events.filter(e => e.ev === 'test:output').map(e => e.payload.line);
  assert.ok(logLines.some(l => l.includes('RUNLAB_SCREENSHOT_FORMAT=jpeg') && l.includes('RUNLAB_SCREENSHOT_QUALITY=64')));
});

test('la documentación de la API coincide con los campos reales de evidencia', () => {
  const swagger = require('../swagger');
  const errors = require('../routes/errors');
  const schemas = swagger.components.schemas;
  const itemSchema = schemas.EvidenceItem;
  const documented = new Set(Object.keys(itemSchema.properties));
  const configDocumented = new Set(Object.keys(schemas.EvidenceConfig.properties));
  const galleryDocumented = new Set(Object.keys(schemas.EvidenceGalleryResponse.properties));

  const root = tempDir('runlab-docs-');
  const reportsDir = path.join(root, 'reports');
  const reportId = 'report_docs';
  fs.mkdirSync(path.join(reportsDir, reportId, 'assets'), { recursive: true });
  const imageRel = 'attachments/screenshot-docs.png';
  fs.mkdirSync(path.join(reportsDir, reportId, 'assets', 'attachments'), { recursive: true });
  fs.writeFileSync(path.join(reportsDir, reportId, 'assets', imageRel), pngBuffer(240, 120));
  fs.writeFileSync(path.join(reportsDir, `${reportId}.json`), JSON.stringify({
    id: reportId,
    timestamp: '2026-11-23T12:00:00.000Z',
    summary: {},
    tests: [{
      id: 'spec::T-docs',
      status: 'passed',
      attachments: [{
        name: 'screenshot-docs', contentType: 'image/png', assetPath: imageRel,
        status: 'passed', source: 'report', evidenceSource: 'capture',
        captureName: 'screenshot-docs', width: 240, height: 120,
      }],
    }],
  }));

  const reportItem = errors.collectReportItems({ profile: { reportsDir } })[0];
  assert.ok(reportItem, 'el reporte debe generar un item de evidencia');
  for (const key of itemSchema.required) assert.ok(key in reportItem, `falta ${key} en /errors/images`);
  assert.deepStrictEqual(Object.keys(reportItem).filter(k => !documented.has(k)), []);
  for (const key of ['status', 'evidenceSource', 'captureName', 'width', 'height']) {
    assert.ok(documented.has(key), `Swagger no documenta ${key}`);
  }
  for (const key of ['imageFormat', 'imageQuality', 'scale']) {
    assert.ok(configDocumented.has(key), `Swagger no documenta config.evidence.${key}`);
  }
  for (const key of ['images', 'items', 'counts']) {
    assert.ok(galleryDocumented.has(key), `Swagger no documenta ${key}`);
  }
  assert.ok(swagger.paths['/api/errors/images'].get.responses['200'].content['application/json'].schema.$ref
    .endsWith('/EvidenceGalleryResponse'));

  const readme = fs.readFileSync(path.join(__dirname, '..', 'README.md'), 'utf8');
  for (const token of ['RUNLAB_SCREENSHOT_FORMAT', 'RUNLAB_SCREENSHOT_QUALITY', 'RUNLAB_SCREENSHOT_SCALE',
    'integrityIssues', '.runlab-evidence.json', 'captureName', 'evidenceSource']) {
    assert.ok(readme.includes(token), `README no documenta ${token}`);
  }
});

test('un adjunto con path existente conserva su nombre y ruta', () => {
  const root = tempDir('runlab-path-');
  const projectPath = path.join(root, 'project');
  const existing = path.join(projectPath, 'test-results', 'captura-original.png');
  fs.mkdirSync(path.dirname(existing), { recursive: true });
  fs.writeFileSync(existing, pngBuffer());
  const runAssetsDir = path.join(root, 'assets');

  const report = {
    id: 'report_path',
    summary: {},
    tests: [{
      id: 'spec::T2',
      status: 'passed',
      attachments: [{ name: 'captura-original', contentType: 'image/png', path: existing }],
    }],
  };
  normalizeReportAssets(report, projectPath, runAssetsDir);

  const att = report.tests[0].attachments[0];
  assert.strictEqual(att.name, 'captura-original');
  assert.strictEqual(att.assetPath, 'test-results/captura-original.png');
  assert.strictEqual(att.path, existing);
  assert.ok(!fs.existsSync(path.join(runAssetsDir, 'attachments', 'captura-original.png')));
});
