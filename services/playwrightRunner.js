const { spawn } = require('child_process');
const fs = require('fs');
const os = require('os');
const path = require('path');
const runtime = require('./runtimeRegistry');

const DEFAULT_REPORTS_DIR = path.join(__dirname, '..', 'reports');

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
    out.push({
      name: a.name || '',
      contentType: a.contentType || '',
      path: a.path || a.body ? (a.path || '') : ''
    });
  };
  if (Array.isArray(result.attachments)) result.attachments.forEach(push);
  // algunos reporters ponen screenshots/traces en otros campos; normalizamos paths conocidos
  return out.filter(a => a.path || a.name);
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
        const projectName = t.projectName || t.projectId || '';
        const testId = projectName ? `${id} [${projectName}]` : id;
        let output = '';
        if (Array.isArray(last.stdout)) output += last.stdout.map(x => (typeof x === 'string' ? x : (x.text || ''))).join('');
        if (Array.isArray(last.stderr)) output += last.stderr.map(x => (typeof x === 'string' ? x : (x.text || ''))).join('');
        tests.push({ id: testId, status, duration, output, errorMsg: errorMsg.trim(), attachments, project: projectName });
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

function normalizeReportAssets(report, projectPath, runAssetsDir) {
  let previewImage = null;
  for (const test of (report.tests || [])) {
    if (!Array.isArray(test.attachments)) continue;
    for (const att of test.attachments) {
      const assetPath = toAssetPath(att.path, projectPath, runAssetsDir);
      if (assetPath) att.assetPath = assetPath;
      if (!previewImage && assetPath && isImageAttachment(att)) {
        previewImage = assetPath;
      }
    }
  }
  if (!report.summary || typeof report.summary !== 'object') report.summary = {};
  report.summary.previewImage = previewImage;
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

function isFailureStatus(status) {
  return status === 'failed' || status === 'error';
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

function publishFailureEvidence(report, runAssetsDir, projectPath, options = {}) {
  const folder = resolveFailureEvidenceFolder(projectPath, options.errorImagesPath);
  if (!folder) return;
  try { safeMkdir(folder); } catch { return; }

  for (const test of (report.tests || [])) {
    if (!isFailureStatus(test.status)) continue;
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
      try { fs.copyFileSync(src, dest); } catch {}
    }
  }
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

  const report = { id: reportId, timestamp: new Date().toISOString(), summary, tests };

  // Copiar assets de Playwright (HTML report y test-results) al workspace del run.
  try { copyDirSync(path.join(projectPath, 'playwright-report'), path.join(runAssetsDir, 'playwright-report')); } catch {}
  try { copyDirSync(path.join(projectPath, 'test-results'), path.join(runAssetsDir, 'test-results')); } catch {}

  // Normalizar adjuntos a rutas de assets servibles y calcular imagen de preview del reporte.
  try { normalizeReportAssets(report, projectPath, runAssetsDir); } catch {}

  // Publicar evidencias de tests fallidos a la carpeta global (galería de Evidencia de fallos).
  try { publishFailureEvidence(report, runAssetsDir, projectPath, options); } catch {}

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

module.exports = { runTests, abortExecution, isRunning };
