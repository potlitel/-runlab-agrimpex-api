const { spawn } = require('child_process');
const path = require('path');
const fs = require('fs');

// Caché en memoria por perfil: { [profileId]: { data, timestamp } }
const memoryCache = new Map();

function getCached(profileId) {
  const entry = memoryCache.get(profileId);
  return entry ? entry.data : null;
}

function setCached(profileId, data) {
  memoryCache.set(profileId, { data, timestamp: Date.now() });
}

function clearCached(profileId) {
  memoryCache.delete(profileId);
}

function resolveCmd(playwrightCmd = 'npx playwright') {
  const parts = String(playwrightCmd || 'npx playwright').trim().split(/\s+/);
  return { cmd: parts[0], baseArgs: parts.slice(1) };
}

function collectTests(projectPath, playwrightCmd = 'npx playwright') {
  return new Promise((resolve, reject) => {
    const { cmd, baseArgs } = resolveCmd(playwrightCmd);
    const args = [...baseArgs, 'test', '--list', '--reporter=json'];

    const proc = spawn(cmd, args, {
      cwd: projectPath,
      shell: true,
      env: { ...process.env }
    });

    let stdout = '';
    let stderr = '';

    proc.stdout.on('data', d => { stdout += d.toString(); });
    proc.stderr.on('data', d => { stderr += d.toString(); });

    proc.on('close', (code) => {
      const rawAll = (stderr + '\n' + stdout).trim();
      let json = extractJson(stdout);

      if (!json) {
        const err = new Error(
          code === 127 || /ENOENT|not found|is not recognized|no se reconoce/i.test(rawAll)
            ? 'No se pudo ejecutar Playwright. Verifica que `playwrightCmd` sea correcto y que Playwright esté instalado (por ejemplo `npx playwright install`).'
            : `playwright test --list falló (exit code ${code})`
        );
        err.raw = rawAll;
        return reject(err);
      }

      const projects = extractProjects(json);
      const { files, total } = extractTests(json, projectPath);
      const errorFiles = extractErrorFiles(json);

      const hasErrors = Array.isArray(json.errors) && json.errors.length > 0;

      if (total === 0 && !hasErrors) {
        const err = new Error('No se encontraron tests en el proyecto configurado. Verifica la ruta del proyecto y la configuración de Playwright (testDir/testMatch/projects).');
        err.raw = (stderr || '').trim();
        return reject(err);
      }

      if (total === 0 && hasErrors) {
        const first = json.errors[0];
        const msg = first && first.message ? String(first.message) : 'Error al listar tests con Playwright.';
        const err = new Error(msg);
        err.raw = (stderr + '\n' + json.errors.map(e => e.message || '').join('\n')).trim();
        return reject(err);
      }

      const result = { files, total, projects };
      if (errorFiles.length) result.errorFiles = errorFiles;
      resolve(result);
    });

    proc.on('error', (err) => {
      err.raw = `Failed to start process: ${playwrightCmd}. Asegúrate de que el comando sea correcto y que Playwright/browsers estén instalados.`;
      reject(err);
    });
  });
}

function extractJson(stdout) {
  try { return JSON.parse(stdout); } catch {}

  const end = stdout.lastIndexOf('}');
  if (end === -1) return null;

  // Busca un inicio de objeto JSON plausible para el reporte de Playwright
  // (top-level suele incluir "config" o "suites").
  const candidates = [];
  const patterns = [/\n\{\s*\n\s*"config"/g, /\n\{\s*\n\s*"suites"/g, /\{\s*"config"/g, /\{\s*"suites"/g];
  for (const re of patterns) {
    let m;
    while ((m = re.exec(stdout)) !== null) {
      let idx = m.index;
      if (stdout[idx] === '\n') idx += 1;
      candidates.push(idx);
    }
  }
  // Fallback: cualquier '{' al inicio de línea
  if (!candidates.length) {
    const re = /(^|\n)\{/g;
    let m;
    while ((m = re.exec(stdout)) !== null) {
      candidates.push(m.index + (m[1] ? m[1].length : 0));
    }
  }

  const seen = new Set();
  // Probar candidatos desde el más tardío hacia atrás (más probable que sea el reporte principal)
  for (const start of [...new Set(candidates)].sort((a, b) => b - a)) {
    if (seen.has(start) || start > end) continue;
    seen.add(start);
    try { return JSON.parse(stdout.slice(start, end + 1)); } catch {}
  }

  // Último recurso: recortar entre primer '{' razonable y último '}'
  const start = stdout.indexOf('{');
  if (start !== -1 && end > start) {
    try { return JSON.parse(stdout.slice(start, end + 1)); } catch {}
  }
  return null;
}

function extractProjects(json) {
  const projects = (json && json.config && Array.isArray(json.config.projects))
    ? json.config.projects
    : [];
  const names = projects
    .map(p => (p && (p.name || p.id)) ? String(p.name || p.id) : '')
    .filter(Boolean);
  return [...new Set(names)];
}

function extractTests(json, projectPath) {
  const files = {};
  let total = 0;
  const seen = new Set();
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
      const rel = path.relative(base, abs).replace(/\\/g, '/');
      return rel || path.basename(abs);
    }
    return String(filePath).replace(/\\/g, '/');
  }

  function visitSuite(suite, ancestors, inheritedFile) {
    if (!suite) return;
    const rawFile = suite.file ? String(suite.file).replace(/\\/g, '/') : '';
    const suiteFile = suite.file ? relFile(suite.file) : inheritedFile;
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

    const specs = Array.isArray(suite.specs) ? suite.specs : [];
    for (const spec of specs) {
      const file = relFile(spec.file || (spec.location && spec.location.file) || suiteFile);
      const specTitle = String(spec.title || '').trim();
      if (!file || !specTitle) continue;
      const fullTitle = nextAncestors.concat([specTitle]).join(' › ');
      const id = `${file}::${fullTitle}`;
      if (seen.has(id)) continue;
      seen.add(id);
      if (!files[file]) files[file] = [];
      files[file].push(id);
      total++;
    }

    const children = Array.isArray(suite.suites) ? suite.suites : [];
    for (const child of children) visitSuite(child, nextAncestors, suiteFile);
  }

  const suites = (json && Array.isArray(json.suites)) ? json.suites : [];
  for (const s of suites) visitSuite(s, [], '');
  return { files, total };
}

function extractErrorFiles(json) {
  const errors = (json && Array.isArray(json.errors)) ? json.errors : [];
  const files = [];
  for (const e of errors) {
    const loc = e && e.location && e.location.file;
    if (loc) files.push(String(loc).replace(/\\/g, '/'));
  }
  return [...new Set(files)];
}

module.exports = { collectTests, getCached, setCached, clearCached };
