const { spawn } = require('child_process');
const fs = require('fs');
const os = require('os');
const path = require('path');
const runtime = require('./runtimeRegistry');

const DEFAULT_REPORTS_DIR = path.join(__dirname, '..', 'reports');

// Los bytes de un adjunto solo en memoria viajan fuera del JSON serializado:
// el símbolo evita que el reporte written a disco incluya bases64 gigantes.
const ATTACHMENT_BYTES = Symbol('attachmentBytes');

// Manifiesto que acompaña a las imágenes publicadas en la galería de evidencias.
const EVIDENCE_MANIFEST = '.runlab-evidence.json';

// Valores por defecto documentados, compartidos con el helper del kit.
const EVIDENCE_ENV_DEFAULTS = {
  RUNLAB_SCREENSHOT_FORMAT: 'png',
  RUNLAB_SCREENSHOT_QUALITY: '90',
  RUNLAB_SCREENSHOT_SCALE: 'css',
  RUNLAB_SCREENSHOT_TIMEOUT: '30000',
};

// Estado por perfil
const state = new Map(); // profileId -> { running, currentProc, aborted }

function _state(profileId) {
  if (!state.has(profileId)) state.set(profileId, { running: false, currentProc: null, aborted: false });
  return state.get(profileId);
}

function isRunning(profileId) {
  const s = state.get(profileId);
  return !!(s && s.running);
}

function abortExecution(profileId) {
  const s = state.get(profileId);
  if (!s) return;
  s.aborted = true;
  if (s.currentProc) {
    try {
      if (process.platform === 'win32') {
        spawn('taskkill', ['/pid', String(s.currentProc.pid), '/f', '/t'], { shell: true });
      } else {
        // El proceso se lanza en su propio grupo (detached); matar el grupo
        // asegura terminar también a los workers hijos de Playwright.
        try {
          process.kill(-s.currentProc.pid, 'SIGTERM');
        } catch {
          s.currentProc.kill('SIGTERM');
        }
      }
    } catch {
      // ya terminó
    }
  }
}

function emit(io, profileId, event, payload) {
  if (io) io.to(`profile:${profileId}`).emit(event, { ...payload, profileId });
}

function resolveCmd(playwrightCmd = 'npx playwright') {
  const parts = String(playwrightCmd || 'npx playwright').trim().split(/\s+/);
  return { cmd: parts[0], baseArgs: parts.slice(1) };
}

function safeMkdir(dir) {
  if (!fs.existsSync(dir)) fs.mkdirSync(dir, { recursive: true });
}

function copyDirSync(src, dst) {
  if (!fs.existsSync(src)) return false;
  const stat = fs.statSync(src);
  if (!stat.isDirectory()) return false;
  safeMkdir(dst);
  for (const entry of fs.readdirSync(src, { withFileTypes: true })) {
    const s = path.join(src, entry.name);
    const d = path.join(dst, entry.name);
    if (entry.isDirectory()) copyDirSync(s, d);
    else if (entry.isFile()) {
      try { fs.copyFileSync(s, d); } catch {}
    }
  }
  return true;
}

function normalizeStatus(pwStatus) {
  if (pwStatus === 'expected' || pwStatus === 'passed') return 'passed';
  if (pwStatus === 'skipped') return 'skipped';
  if (pwStatus === 'flaky') return 'failed';
  if (pwStatus === 'unexpected' || pwStatus === 'failed' || pwStatus === 'timedOut' || pwStatus === 'interrupted') return 'failed';
  return 'error';
}

function pickError(result) {
  const errs = [];
  if (result.error && result.error.message) errs.push(String(result.error.message));
  if (Array.isArray(result.errors)) {
    for (const e of result.errors) if (e && e.message) errs.push(String(e.message));
  }
  return errs.join('\n').trim();
}

function collectAttachments(result) {
  const out = [];
  const push = (a) => {
    if (!a) return;
    const normalized = {
      name: a.name || '',
      contentType: a.contentType || '',
      path: a.path || ''
    };
    // El reporter JSON expone `body` (base64 o array de bytes) cuando el
    // adjunto no tiene archivo. Lo conservamos en memoria para persistirlo.
    if (!normalized.path && a.body) normalized[ATTACHMENT_BYTES] = a.body;
    out.push(normalized);
  };
  if (Array.isArray(result.attachments)) result.attachments.forEach(push);
  // algunos reporters ponen screenshots/traces en otros campos; normalizamos paths conocidos
  return out.filter(a => a.path || a.name || a[ATTACHMENT_BYTES]);
}

function flattenJsonReport(json, projectPath) {
  const tests = [];
  const base = projectPath ? path.resolve(projectPath) : '';
  const rootDir = json && json.config && json.config.rootDir ? path.resolve(json.config.rootDir) : '';

  function relFile(filePath) {
    if (!filePath) return '';
    let abs;
    if (path.isAbsolute(filePath)) {
      abs = filePath;
    } else {
      const fromProject = base ? path.resolve(base, filePath) : path.resolve(filePath);
      const fromRoot = rootDir ? path.resolve(rootDir, filePath) : null;
      if (fromRoot && fs.existsSync(fromRoot)) abs = fromRoot;
      else if (fs.existsSync(fromProject)) abs = fromProject;
      else if (fromRoot && base && (fromRoot === base || fromRoot.startsWith(base + path.sep))) abs = fromRoot;
      else abs = fromProject;
    }
    if (base && (abs === base || abs.startsWith(base + path.sep))) {
      return path.relative(base, abs).replace(/\\/g, '/');
    }
    return String(filePath).replace(/\\/g, '/');
  }

  function visitSuite(suite, ancestors, inheritedFile) {
    if (!suite) return;
    const rawFile = suite.file ? String(suite.file).replace(/\\/g, '/') : '';
    const suiteFile = relFile(suite.file || inheritedFile);
    const title = suite.title ? String(suite.title).trim() : '';
    const fileBase = suiteFile ? path.posix.basename(suiteFile) : '';
    const rawBase = rawFile ? path.posix.basename(rawFile) : '';
    const normTitle = title.replace(/\\/g, '/');
    const isFileSuite = !!(title && suiteFile && (
      title === suiteFile ||
      normTitle === suiteFile ||
      title === rawFile ||
      normTitle === rawFile ||
      title === fileBase ||
      title === rawBase ||
      (rawFile && (rawFile.endsWith('/' + normTitle) || normTitle.endsWith('/' + rawFile))) ||
      (suiteFile && (suiteFile.endsWith('/' + normTitle) || normTitle.endsWith('/' + suiteFile)))
    ));
    const nextAncestors = (title && !isFileSuite) ? ancestors.concat([title]) : ancestors;
    for (const spec of (suite.specs || [])) {
      const file = relFile(spec.file || (spec.location && spec.location.file) || suiteFile);
      const specTitle = String(spec.title || '').trim();
      const fullTitle = nextAncestors.concat([specTitle]).join(' › ');
      const id = file && specTitle ? `${file}::${fullTitle}` : (specTitle || file);
      const pwTests = Array.isArray(spec.tests) ? spec.tests : [];
      if (!pwTests.length) {
        tests.push({ id, status: 'skipped', duration: 0, output: '', errorMsg: '', attachments: [] });
        continue;
      }
      for (const t of pwTests) {
        const results = Array.isArray(t.results) ? t.results : [];
        const last = results[results.length - 1] || {};
        const status = normalizeStatus(t.status || t.expectedStatus || last.status);
        const duration = (last.duration || 0) / 1000;
        const errorMsg = pickError(last) + (t.status === 'flaky' ? '\n[flaky]' : '');
        const attachments = collectAttachments(last);
        const expectedScreenshots = (Array.isArray(t.annotations) ? t.annotations : [])
          .filter(a => a && a.type === 'expected-screenshot' && a.description)
          .map(a => String(a.description).trim())
          .filter(Boolean);
        const projectName = t.projectName || t.projectId || '';
        const testId = projectName ? `${id} [${projectName}]` : id;
        let output = '';
        if (Array.isArray(last.stdout)) output += last.stdout.map(x => (typeof x === 'string' ? x : (x.text || ''))).join('');
        if (Array.isArray(last.stderr)) output += last.stderr.map(x => (typeof x === 'string' ? x : (x.text || ''))).join('');
        tests.push({ id: testId, status, duration, output, errorMsg: errorMsg.trim(), attachments, expectedScreenshots, project: projectName });
      }
    }
    for (const child of (suite.suites || [])) visitSuite(child, nextAncestors, suiteFile);
  }

  for (const s of ((json && json.suites) || [])) visitSuite(s, [], '');
  return tests;
}

const PLAYWRIGHT_CONFIG_FILES = [
  'playwright.config.ts',
  'playwright.config.mts',
  'playwright.config.cts',
  'playwright.config.js',
  'playwright.config.mjs',
  'playwright.config.cjs',
];

function findPlaywrightConfig(projectPath) {
  if (!projectPath) return null;
  for (const name of PLAYWRIGHT_CONFIG_FILES) {
    const full = path.join(projectPath, name);
    try {
      if (fs.existsSync(full) && fs.statSync(full).isFile()) return full;
    } catch {}
  }
  return null;
}

/** Traduce el perfil de evidencia a variables de entorno del kit de Playwright. */
function buildEvidenceEnv(evidence) {
  const env = {};
  if (!evidence || typeof evidence !== 'object') return env;

  const format = String(evidence.imageFormat || '').toLowerCase();
  if (['png', 'jpeg', 'jpg'].includes(format)) {
    env.RUNLAB_SCREENSHOT_FORMAT = format === 'jpg' ? 'jpeg' : format;
  }
  const quality = Number(evidence.imageQuality);
  if (Number.isInteger(quality) && quality >= 1 && quality <= 100) {
    env.RUNLAB_SCREENSHOT_QUALITY = String(quality);
  }
  const scale = String(evidence.scale || '').toLowerCase();
  if (['css', 'device'].includes(scale)) env.RUNLAB_SCREENSHOT_SCALE = scale;
  return env;
}

function mapScreenshotMode(mode) {
  if (mode === 'always') return 'on';
  if (mode === 'only-on-failure') return 'only-on-failure';
  if (mode === 'off') return 'off';
  return null;
}

function buildEvidenceUseOverride(evidence) {
  if (!evidence || typeof evidence !== 'object') return null;
  const use = {};
  const screenshotMode = mapScreenshotMode(evidence.screenshot);
  if (screenshotMode) {
    if (evidence.fullPage && screenshotMode !== 'off') {
      use.screenshot = { mode: screenshotMode, fullPage: true };
    } else {
      use.screenshot = screenshotMode;
    }
  }
  if (typeof evidence.video === 'string' && ['on', 'off', 'retain-on-failure', 'on-first-retry'].includes(evidence.video)) {
    use.video = evidence.video;
  }
  if (typeof evidence.trace === 'string' && ['on', 'off', 'retain-on-failure', 'on-first-retry'].includes(evidence.trace)) {
    use.trace = evidence.trace;
  }
  return Object.keys(use).length ? use : null;
}

function createEvidenceConfigOverride(projectPath, evidence) {
  const useOverride = buildEvidenceUseOverride(evidence);
  if (!useOverride) return null;
  const configPath = findPlaywrightConfig(projectPath);
  if (!configPath) return null;

  const ext = path.extname(configPath).toLowerCase();
  const configDir = path.dirname(path.resolve(configPath));
  // Usar nombre relativo desde el mismo directorio para preservar resolución de rutas relativas del config base.
  const baseName = path.basename(configPath);
  const jsonOverride = JSON.stringify(useOverride);
  let wrapperExt = '.cjs';
  let content = '';

  if (ext === '.mjs') {
    wrapperExt = '.mjs';
    content = `import baseConfig from ${JSON.stringify('./' + baseName)};\nconst base = baseConfig && baseConfig.default ? baseConfig.default : baseConfig;\nconst override = ${jsonOverride};\nexport default { ...base, use: { ...(base && base.use ? base.use : {}), ...override } };\n`;
  } else if (ext === '.ts' || ext === '.mts' || ext === '.cts') {
    wrapperExt = ext;
    content = `import baseConfig from ${JSON.stringify('./' + baseName)};\nconst base: any = (baseConfig as any)?.default ?? baseConfig;\nconst override = ${jsonOverride} as any;\nexport default { ...base, use: { ...(base?.use || {}), ...override } };\n`;
  } else {
    wrapperExt = '.cjs';
    content = `const baseConfig = require(${JSON.stringify('./' + baseName)});\nconst base = baseConfig && baseConfig.default ? baseConfig.default : baseConfig;\nconst override = ${jsonOverride};\nmodule.exports = { ...base, use: { ...(base && base.use ? base.use : {}), ...override } };\n`;
  }

  const wrapperPath = path.join(configDir, `.playwright.config.runlab-override.${Date.now()}${wrapperExt}`);
  fs.writeFileSync(wrapperPath, content, 'utf-8');
  return wrapperPath;
}

function toAssetPath(attachmentPath, projectPath, runAssetsDir) {
  if (!attachmentPath) return null;
  const abs = path.resolve(String(attachmentPath));
  const candidates = [
    { base: path.join(projectPath, 'test-results'), prefix: 'test-results' },
    { base: path.join(projectPath, 'playwright-report'), prefix: 'playwright-report' },
  ];
  for (const c of candidates) {
    const baseAbs = path.resolve(c.base);
    if (abs === baseAbs || abs.startsWith(baseAbs + path.sep)) {
      const rel = path.join(c.prefix, path.relative(baseAbs, abs)).replace(/\\/g, '/');
      const copied = path.join(runAssetsDir, rel);
      try {
        if (fs.existsSync(copied)) return rel;
      } catch {}
      return rel;
    }
  }
  // Fallback: if already inside runAssetsDir
  const assetsAbs = path.resolve(runAssetsDir);
  if (abs === assetsAbs || abs.startsWith(assetsAbs + path.sep)) {
    return path.relative(assetsAbs, abs).replace(/\\/g, '/');
  }
  return null;
}

function isImageAttachment(att) {
  if (!att) return false;
  const ct = String(att.contentType || '').toLowerCase();
  if (ct.startsWith('image/')) return true;
  const name = String(att.name || '').toLowerCase();
  return name.includes('screenshot') || /\.(png|jpe?g|gif|webp)$/i.test(String(att.path || ''));
}

/** Convierte las formas en que el reporter JSON entrega `body` a un Buffer. */
function attachmentBytes(value) {
  if (!value) return null;
  if (Buffer.isBuffer(value)) return value;
  if (Array.isArray(value)) {
    try { return Buffer.from(value); } catch { return null; }
  }
  if (typeof value === 'string') {
    try { return Buffer.from(value, 'base64'); } catch { return null; }
  }
  if (typeof value === 'object' && typeof value.base64 === 'string') {
    try { return Buffer.from(value.base64, 'base64'); } catch { return null; }
  }
  return null;
}

const IMAGE_SIGNATURES = [
  { ext: '.png', contentType: 'image/png', match: b => b.length >= 8 && b.subarray(0, 8).equals(Buffer.from([0x89, 0x50, 0x4e, 0x47, 0x0d, 0x0a, 0x1a, 0x0a])) },
  { ext: '.jpg', contentType: 'image/jpeg', match: b => b.length >= 3 && b[0] === 0xff && b[1] === 0xd8 && b[2] === 0xff },
  { ext: '.gif', contentType: 'image/gif', match: b => b.length >= 6 && b.subarray(0, 4).toString('ascii') === 'GIF8' },
  { ext: '.webp', contentType: 'image/webp', match: b => b.length >= 12 && b.subarray(0, 4).toString('ascii') === 'RIFF' && b.subarray(8, 12).toString('ascii') === 'WEBP' },
  { ext: '.bmp', contentType: 'image/bmp', match: b => b.length >= 2 && b[0] === 0x42 && b[1] === 0x4d },
];

/** Detecta el formato real por firma de bytes (no por el contentType declarado). */
function detectImageFormat(bytes) {
  if (!bytes || bytes.length < 8) return null;
  const found = IMAGE_SIGNATURES.find(s => s.match(bytes));
  return found ? { ext: found.ext, contentType: found.contentType } : null;
}

/** Registra incidencias de integridad sin interrumpir la corrida. */
function addIntegrityIssue(report, issue) {
  if (!report.integrity || typeof report.integrity !== 'object') {
    report.integrity = { issues: [], missingScreenshots: [], invalidImages: [] };
  }
  report.integrity.issues.push(issue);
  if (issue.type === 'missing-screenshot') {
    report.integrity.missingScreenshots.push({ testId: issue.testId, name: issue.name });
  }
  if (issue.type === 'invalid-image') {
    report.integrity.invalidImages.push({ testId: issue.testId, name: issue.name, message: issue.message });
  }
  if (report.summary) report.summary.integrityIssues = report.integrity.issues.length;
}

/** Normaliza nombres de captura igual que el helper del kit de Playwright. */
function normalizeCaptureName(value) {
  const cleaned = String(value || '')
    .trim()
    .replace(/^screenshot-+/i, '')
    .replace(/[^a-zA-Z0-9._-]+/g, '-')
    .replace(/-+/g, '-')
    .replace(/^[-.]+|[-.]+$/g, '');
  return `screenshot-${cleaned || 'capture'}`;
}

/** Compara las anotaciones `expected-screenshot` con los adjuntos reales. */
function checkScreenshotIntegrity(report) {
  for (const test of (report.tests || [])) {
    const expected = Array.isArray(test.expectedScreenshots) ? test.expectedScreenshots : [];
    if (!expected.length) continue;
    const actual = (test.attachments || []).map(a => String((a && a.name) || ''));
    const actualNormalized = new Set(actual.map(normalizeCaptureName));
    for (const name of expected) {
      if (actual.includes(name) || actualNormalized.has(normalizeCaptureName(name))) continue;
      addIntegrityIssue(report, {
        type: 'missing-screenshot',
        testId: test.id || null,
        name,
        message: `Captura declarada pero no generada: ${name}`,
      });
    }
  }
  return report.integrity || { issues: [], missingScreenshots: [], invalidImages: [] };
}

/**
 * Escribe un adjunto que solo traía bytes en memoria dentro de los assets de
 * la corrida. Devuelve true cuando se persistió; los inválidos se dejan para
 * que la comprobación de integridad los registre sin abortar la corrida.
 */
function persistBodyImageAttachment(att, runAssetsDir, report, testId) {
  const bytes = attachmentBytes(att[ATTACHMENT_BYTES]);
  if (!bytes) return false;
  const format = detectImageFormat(bytes);
  delete att[ATTACHMENT_BYTES];
  if (!format) {
    if (isImageAttachment(att)) {
      addIntegrityIssue(report, {
        type: 'invalid-image',
        testId: testId || null,
        name: att.name || '(sin nombre)',
        message: 'Adjunto declarado como imagen con bytes no válidos',
      });
    }
    return false;
  }

  const folder = path.join(runAssetsDir, 'attachments');
  safeMkdir(folder);
  const stem = sanitizeFilePart(String(att.name || 'screenshot').replace(/\.[a-z0-9]+$/i, ''));
  let fileName = `${stem}${format.ext}`;
  let counter = 2;
  while (fs.existsSync(path.join(folder, fileName))) {
    fileName = `${stem}-${counter++}${format.ext}`;
  }
  fs.writeFileSync(path.join(folder, fileName), bytes);

  att.path = path.join(folder, fileName);
  att.name = fileName.replace(/\.[^.]+$/, '');
  att.contentType = format.contentType;
  return true;
}

/** Lee las dimensiones reales de una imagen desde su cabecera (si están disponibles). */
function readImageDimensions(filePath) {
  try {
    const fd = fs.openSync(filePath, 'r');
    let head;
    try {
      head = Buffer.alloc(Math.min(fs.fstatSync(fd).size, 262144));
      fs.readSync(fd, head, 0, head.length, 0);
    } finally {
      fs.closeSync(fd);
    }
    const bytes = head;
    if (!detectImageFormat(bytes)) return null;
    const isPng = bytes.subarray(0, 8).equals(Buffer.from([0x89, 0x50, 0x4e, 0x47, 0x0d, 0x0a, 0x1a, 0x0a]));
    if (isPng && bytes.length >= 24) return { width: bytes.readUInt32BE(16), height: bytes.readUInt32BE(20) };
    if (bytes[0] === 0xff && bytes[1] === 0xd8 && bytes[2] === 0xff) {
      let offset = 2;
      const sof = [0xc0, 0xc1, 0xc2, 0xc3, 0xc5, 0xc6, 0xc7, 0xc9, 0xca, 0xcb, 0xcd, 0xce, 0xcf];
      while (offset + 9 < bytes.length) {
        if (bytes[offset] !== 0xff) { offset++; continue; }
        const marker = bytes[offset + 1];
        if (marker === 0xd8 || marker === 0xd9 || marker === 0x01 || (marker >= 0xd0 && marker <= 0xd7)) {
          offset += 2;
          continue;
        }
        const length = bytes.readUInt16BE(offset + 2);
        if (sof.includes(marker)) {
          return { width: bytes.readUInt16BE(offset + 7), height: bytes.readUInt16BE(offset + 5) };
        }
        if (length < 2) break;
        offset += 2 + length;
      }
      return null;
    }
    if (bytes.subarray(0, 4).toString('ascii') === 'GIF8' && bytes.length >= 10) {
      return { width: bytes.readUInt16LE(6), height: bytes.readUInt16LE(8) };
    }
    if (bytes.subarray(0, 4).toString('ascii') === 'RIFF' && bytes.subarray(8, 12).toString('ascii') === 'WEBP') {
      if (bytes.length >= 30 && bytes.subarray(12, 16).toString('ascii') === 'VP8X') {
        return { width: 1 + bytes.readUIntLE(24, 3), height: 1 + bytes.readUIntLE(27, 3) };
      }
    }
    if (bytes[0] === 0x42 && bytes[1] === 0x4d && bytes.length >= 26) {
      return { width: bytes.readUInt32LE(18), height: Math.abs(bytes.readInt32LE(22)) };
    }
  } catch {}
  return null;
}

/** Comprueba la firma de una imagen ya escrita en disco. */
function fileHasValidImageSignature(filePath) {
  try {
    const fd = fs.openSync(filePath, 'r');
    try {
      const head = Buffer.alloc(Math.min(fs.fstatSync(fd).size, 32));
      fs.readSync(fd, head, 0, head.length, 0);
      return !!detectImageFormat(head);
    } finally {
      fs.closeSync(fd);
    }
  } catch {
    return false;
  }
}

/** Distingue las capturas declaradas por el test de los artefactos automáticos de fallo. */
function evidenceSourceFor(att) {
  const name = String((att && att.name) || '').toLowerCase();
  const ct = String((att && att.contentType) || '').toLowerCase();
  if (name === 'screenshot' || name === 'trace' || name === 'video' ||
      ct.startsWith('video/') || ct === 'application/zip') {
    return 'failure-artifact';
  }
  return 'capture';
}

/** Añade estado, origen y dimensiones a cada adjunto ya persistido. */
function enrichEvidenceMetadata(report, runAssetsDir) {
  for (const test of (report.tests || [])) {
    for (const att of (test.attachments || [])) {
      if (!att || !att.assetPath) continue;
      att.status = test.status;
      att.source = 'report';
      att.evidenceSource = evidenceSourceFor(att);
      att.captureName = att.name || null;
      if (isImageAttachment(att) && (att.width == null || att.height == null)) {
        const dims = readImageDimensions(path.join(runAssetsDir, att.assetPath));
        if (dims) {
          att.width = dims.width;
          att.height = dims.height;
        }
      }
    }
  }
}

function normalizeReportAssets(report, projectPath, runAssetsDir) {
  let previewImage = null;
  for (const test of (report.tests || [])) {
    if (!Array.isArray(test.attachments)) continue;
    for (const att of test.attachments) {
      // Adjuntos `body`-only: se escriben en disco antes de calcular assetPath.
      if (!att.path && att[ATTACHMENT_BYTES] && isImageAttachment(att)) {
        persistBodyImageAttachment(att, runAssetsDir, report, test.id);
      } else if (att[ATTACHMENT_BYTES]) {
        delete att[ATTACHMENT_BYTES];
      }
      const assetPath = toAssetPath(att.path, projectPath, runAssetsDir);
      if (assetPath) att.assetPath = assetPath;
      if (!assetPath || !isImageAttachment(att)) continue;

      // Un adjunto declarado como imagen debe tener bytes de imagen válidos.
      // Se valida la copia en assets o, si aún no existe, el archivo original.
      const filePath = [path.join(runAssetsDir, assetPath), att.path].find(p => p && fs.existsSync(p));
      if (!filePath || !fileHasValidImageSignature(filePath)) {
        addIntegrityIssue(report, {
          type: 'invalid-image',
          testId: test.id || null,
          name: att.name || '(sin nombre)',
          message: 'Adjunto declarado como imagen con firma no válida',
        });
        delete att.assetPath;
        continue;
      }
      if (!previewImage) previewImage = assetPath;
    }
  }
  if (!report.summary || typeof report.summary !== 'object') report.summary = {};
  report.summary.previewImage = previewImage;
  enrichEvidenceMetadata(report, runAssetsDir);
}

function resolveFailureEvidenceFolder(projectPath, configuredPath) {
  if (configuredPath && String(configuredPath).trim()) return String(configuredPath).trim();
  if (projectPath) return path.join(projectPath, 'reports', 'errors');
  return '';
}

function sanitizeFilePart(value, max = 80) {
  const s = String(value || '')
    .replace(/[<>:"/\\|?*\x00-\x1F]/g, '_')
    .replace(/\s+/g, ' ')
    .trim();
  if (!s) return 'evidence';
  return s.length > max ? s.slice(0, max) : s;
}

function isPublishableEvidence(att) {
  if (!att) return false;
  const ct = String(att.contentType || '').toLowerCase();
  const name = String(att.name || '').toLowerCase();
  const p = String(att.path || att.assetPath || '').toLowerCase();
  if (ct.startsWith('image/') || ct.startsWith('video/')) return true;
  if (ct === 'application/zip' || ct === 'text/markdown' || ct === 'text/plain') return true;
  if (name.includes('screenshot') || name.includes('trace') || name.includes('video') || name.includes('error-context')) return true;
  return /\.(png|jpe?g|gif|webp|bmp|webm|mp4|zip|md|txt)$/i.test(p);
}

/**
 * Publica la evidencia de tests passed/failed/error en la carpeta global.
 * Las capturas declaradas conviven con los artefactos automáticos de fallo
 * (screenshot, trace, vídeo); un manifiesto guarda su metadato para que
 * `/api/errors/images` pueda mostrar estado, origen y dimensiones.
 */
function publishEvidence(report, runAssetsDir, projectPath, options = {}) {
  const folder = resolveFailureEvidenceFolder(projectPath, options.errorImagesPath);
  if (!folder) return;
  try { safeMkdir(folder); } catch { return; }

  const published = {};
  for (const test of (report.tests || [])) {
    if (!['passed', 'failed', 'error'].includes(test.status)) continue;
    if (!Array.isArray(test.attachments)) continue;
    let idx = 0;
    for (const att of test.attachments) {
      if (!att || !att.assetPath || !isPublishableEvidence(att)) continue;
      const src = path.join(runAssetsDir, att.assetPath);
      try {
        if (!fs.existsSync(src) || !fs.statSync(src).isFile()) continue;
      } catch { continue; }

      idx++;
      const ext = path.extname(att.assetPath) || path.extname(att.path || '') || '.bin';
      const base = sanitizeFilePart(report.id) + '__' + sanitizeFilePart(test.id, 120) + '__' + String(idx).padStart(2, '0') + ext;
      const dest = path.join(folder, base);
      try { fs.copyFileSync(src, dest); } catch { continue; }

      const displayName = att.name || path.basename(att.assetPath);
      published[base] = {
        name: displayName,
        displayName,
        status: test.status,
        evidenceSource: att.evidenceSource || evidenceSourceFor(att),
        testId: test.id || null,
        reportId: report.id || null,
        reportTimestamp: report.timestamp || null,
        contentType: att.contentType || null,
        assetPath: att.assetPath,
        width: att.width ?? null,
        height: att.height ?? null,
      };
    }
  }

  try {
    fs.writeFileSync(path.join(folder, EVIDENCE_MANIFEST), JSON.stringify({ version: 1, items: published }, null, 2), 'utf-8');
  } catch {}
}

function deriveSummary(tests, jsonStats, durationSec) {
  const passed = tests.filter(t => t.status === 'passed').length;
  const failed = tests.filter(t => t.status === 'failed').length;
  const errors = tests.filter(t => t.status === 'error').length;
  const skipped = tests.filter(t => t.status === 'skipped').length;
  const total = tests.length || (jsonStats ? (jsonStats.expected || 0) + (jsonStats.unexpected || 0) + (jsonStats.skipped || 0) + (jsonStats.flaky || 0) : 0);
  return { total, passed, failed, errors, skipped, duration: durationSec };
}

async function runTests(io, profileId, testIds, projectPath, playwrightCmd = 'npx playwright', envVars = {}, paramsByTest = {}, reportsDir = DEFAULT_REPORTS_DIR, options = {}) {
  const s = _state(profileId);
  s.running = true;
  s.aborted = false;
  s.currentProc = null;
  runtime.start(io, profileId, 'tests');

  const startTime = Date.now();
  const reportId = `report_${Date.now()}`;
  const runAssetsDir = path.join(reportsDir, reportId, 'assets');
  const jsonOutPath = path.join(reportsDir, `${reportId}.result.json`);
  safeMkdir(reportsDir);
  safeMkdir(runAssetsDir);

  const ids = Array.isArray(testIds) ? testIds : [];
  emit(io, profileId, 'execution:started', { total: ids.length });

  let overrideConfigPath = null;
  const evidence = options && options.evidence;
  if (evidence) {
    try {
      overrideConfigPath = createEvidenceConfigOverride(projectPath, evidence);
    } catch (e) {
      // No bloquear ejecución si falla el override; se usará config del proyecto.
      console.warn('[playwrightRunner] No se pudo aplicar override de evidencias:', e && e.message ? e.message : e);
      overrideConfigPath = null;
    }
  }

  // El perfil de evidencia gobierna la captura: se inyecta después de envVars
  // para que la configuración guardada gane sobre valores genéricos del entorno.
  const evidenceEnv = buildEvidenceEnv(evidence);
  const effectiveEvidenceEnv = { ...EVIDENCE_ENV_DEFAULTS, ...evidenceEnv };
  const evidenceLog = '[playwrightRunner] Evidencia efectiva: ' +
    Object.entries(effectiveEvidenceEnv).map(([k, v]) => `${k}=${v}`).join(' ');
  console.log(evidenceLog);
  emit(io, profileId, 'test:output', { id: ids[0] || '', line: evidenceLog + '\n' });

  const { cmd, baseArgs } = resolveCmd(playwrightCmd);
  const args = buildArgs(baseArgs, ids, paramsByTest, options, overrideConfigPath);

  let lineBuffer = '';
  let completedSeen = 0;
  const totalForProgress = ids.length || 0;

  const proc = spawn(cmd, args, {
    cwd: projectPath,
    shell: true,
    detached: process.platform !== 'win32',
    env: {
      ...process.env,
      ...(envVars || {}),
      ...evidenceEnv,
      // Intento de dirigir salida JSON a archivo cuando se usa reporter json
      PLAYWRIGHT_JSON_OUTPUT_NAME: jsonOutPath,
      PLAYWRIGHT_JSON_OUTPUT_FILE: jsonOutPath,
    }
  });
  s.currentProc = proc;

  proc.stdout.on('data', (data) => {
    const text = data.toString();
    lineBuffer += text;
    const lines = lineBuffer.split(/\r?\n/);
    lineBuffer = lines.pop() || '';
    for (const line of lines) handleLine(io, profileId, line, ids, () => {
      completedSeen++;
      if (totalForProgress > 0) {
        emit(io, profileId, 'progress', {
          current: Math.min(completedSeen, totalForProgress),
          total: totalForProgress,
          percentage: Math.round((Math.min(completedSeen, totalForProgress) / totalForProgress) * 100)
        });
      }
    });
  });

  proc.stderr.on('data', (data) => {
    const text = data.toString();
    emit(io, profileId, 'test:output', { id: ids[0] || '', line: text });
  });

  await new Promise((resolveClose) => {
    proc.on('close', () => resolveClose());
    proc.on('error', () => resolveClose());
  });

  const totalDuration = (Date.now() - startTime) / 1000;

  // Intentar cargar JSON de resultados (archivo o stdout embebido no disponible aquí;
  // si no existe, generamos un reporte mínimo a partir de lo conocido).
  let json = null;
  try {
    if (fs.existsSync(jsonOutPath)) {
      json = JSON.parse(fs.readFileSync(jsonOutPath, 'utf-8'));
    }
  } catch {
    json = null;
  }

  let tests = json ? flattenJsonReport(json, projectPath) : [];
  if (!tests.length && ids.length) {
    // Fallback: construir resultados mínimos si no pudimos parsear JSON estructurado.
    const status = s.aborted ? 'error' : 'error';
    tests = ids.map(id => ({ id, status, duration: 0, output: '', errorMsg: s.aborted ? 'Ejecución abortada' : 'No se pudo obtener el reporte JSON de Playwright.', attachments: [] }));
  }

  const summary = deriveSummary(tests, json && json.stats, totalDuration);

  const report = {
    id: reportId,
    timestamp: new Date().toISOString(),
    summary,
    tests,
    evidenceEnv: effectiveEvidenceEnv,
  };

  // Copiar assets de Playwright (HTML report y test-results) al workspace del run.
  try { copyDirSync(path.join(projectPath, 'playwright-report'), path.join(runAssetsDir, 'playwright-report')); } catch {}
  try { copyDirSync(path.join(projectPath, 'test-results'), path.join(runAssetsDir, 'test-results')); } catch {}

  // Normalizar adjuntos a rutas de assets servibles y calcular imagen de preview del reporte.
  try { normalizeReportAssets(report, projectPath, runAssetsDir); } catch {}

  // Verificar que todas las capturas declaradas por anotación se generaron.
  try { checkScreenshotIntegrity(report); } catch {}

  // Publicar capturas de tests passed/failed/error a la carpeta global (galería de evidencias).
  try { publishEvidence(report, runAssetsDir, projectPath, options); } catch {}

  safeMkdir(reportsDir);
  fs.writeFileSync(path.join(reportsDir, `${reportId}.json`), JSON.stringify(report, null, 2));

  // Limpieza de archivos temporales
  try { if (fs.existsSync(jsonOutPath)) fs.unlinkSync(jsonOutPath); } catch {}
  try { if (overrideConfigPath && fs.existsSync(overrideConfigPath)) fs.unlinkSync(overrideConfigPath); } catch {}

  if (s.aborted) {
    emit(io, profileId, 'execution:aborted', { reportId, completed: completedSeen, total: ids.length, summary });
  } else {
    emit(io, profileId, 'execution:completed', { reportId, summary });
  }

  s.running = false;
  s.currentProc = null;
  runtime.stop(io, profileId, 'tests');

  return { reportId, summary, tests };
}

function buildArgs(baseArgs, testIds, paramsByTest, options = {}, overrideConfigPath = null) {
  const args = [...baseArgs, 'test'];

  if (overrideConfigPath) {
    args.push('-c', overrideConfigPath);
  }

  // Selección: paths/ids. Si vienen como "file::title", pasamos el archivo como target.
  const targets = [];
  for (const id of (testIds || [])) {
    const s = String(id);
    const file = s.includes('::') ? s.split('::')[0] : s;
    if (file) targets.push(file);
  }
  const uniqTargets = [...new Set(targets)];
  args.push(...uniqTargets);

  const project = options.project || (paramsByTest && paramsByTest.__project) || null;
  const grep = options.grep || (paramsByTest && paramsByTest.__grep) || null;
  const workers = options.workers || (paramsByTest && paramsByTest.__workers) || null;

  if (project) args.push(`--project=${project}`);
  if (grep) args.push('-g', String(grep));
  if (workers) args.push(`--workers=${workers}`);

  // reporters: line para streaming + json (salida dirigida por env vars)
  args.push('--reporter=line,json');
  return args;
}

function handleLine(io, profileId, line, ids, onCompleted) {
  const text = String(line || '');
  if (!text.trim()) return;

  // Emitir salida cruda para visibilidad
  emit(io, profileId, 'test:output', { id: ids[0] || '', line: text });

  // Heurística: líneas de resultado del reporter line/list suelen contener ✓, ✘, x, ok, passed/failed/skipped
  // Ejemplos: "  ✓  1 [chromium] › file.spec.ts:3:5 › title (1s)" o con símbolos unicode.
  const completedMatch = /(\u2713|✓|✔|passed|\u2718|✘|×|failed|\u23ED|skipped|\u00B7)/i.test(text) && /(›|>|\]|::)/.test(text);
  if (completedMatch) {
    // Intentar extraer id/título aproximado
    const approxId = extractIdFromLine(text, ids);
    const status = /(\u2718|✘|×|failed)/i.test(text) ? 'failed' : (/skipped|\u23ED/i.test(text) ? 'skipped' : 'passed');
    // Emitir started+completed mínimos para alimentar UI en vivo (si no hay JSON streaming fino)
    emit(io, profileId, 'test:started', { id: approxId, index: 0, total: ids.length });
    emit(io, profileId, 'test:completed', { id: approxId, status, duration: 0, output: text, errorMsg: status === 'failed' ? text.trim() : '', attachments: [] });
    onCompleted();
  }
}

function extractIdFromLine(text, ids) {
  // Buscar coincidencia por archivo::título conocido en la línea
  for (const id of (ids || [])) {
    const parts = String(id).split('::');
    const title = parts[parts.length - 1];
    if (title && text.includes(title)) return id;
    const file = parts[0];
    if (file && text.includes(file)) return id;
  }
  return (ids && ids[0]) || '';
}

module.exports = {
  runTests,
  abortExecution,
  isRunning,
  buildEvidenceEnv,
  EVIDENCE_ENV_DEFAULTS,
  collectAttachments,
  flattenJsonReport,
  normalizeReportAssets,
  checkScreenshotIntegrity,
  addIntegrityIssue,
  normalizeCaptureName,
  detectImageFormat,
  readImageDimensions,
  enrichEvidenceMetadata,
  publishEvidence,
  attachmentBytes,
  ATTACHMENT_BYTES,
  EVIDENCE_MANIFEST,
};
