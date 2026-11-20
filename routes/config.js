const express = require('express');
const router = express.Router();
const fs = require('fs');
const path = require('path');
const { spawn } = require('child_process');
const { resetProjectData, samePath } = require('../services/projectData');

function openNativeDialog(type, startPath) {
  return new Promise((resolve) => {
    const safe = (startPath || '').replace(/'/g, "''").replace(/`/g, '').replace(/\$/g, '');

    if (process.platform === 'win32') {
      let script;
      if (type === 'folder') {
        script = [
          'Add-Type -AssemblyName System.Windows.Forms;',
          '$d = New-Object System.Windows.Forms.FolderBrowserDialog;',
          "$d.Description = 'Seleccionar carpeta';",
          '$d.ShowNewFolderButton = $true;',
          safe ? `$d.SelectedPath = '${safe}';` : '',
          "if ($d.ShowDialog() -eq 'OK') { Write-Output $d.SelectedPath }"
        ].join(' ');
      } else {
        script = [
          'Add-Type -AssemblyName System.Windows.Forms;',
          '$d = New-Object System.Windows.Forms.OpenFileDialog;',
          "$d.Filter = 'Env files (*.env)|*.env|All files (*.*)|*.*';",
          safe ? `$d.InitialDirectory = '${path.dirname(safe) || safe}';` : '',
          "if ($d.ShowDialog() -eq 'OK') { Write-Output $d.FileName }"
        ].join(' ');
      }

      const proc = spawn('powershell', ['-NoProfile', '-Command', script]);
      let out = '';
      proc.stdout.on('data', d => { out += d.toString(); });
      proc.on('close', () => resolve(out.trim() || null));
      proc.on('error', () => resolve(null));

    } else if (process.platform === 'darwin') {
      const applescript = type === 'folder'
        ? `POSIX path of (choose folder with prompt "Seleccionar carpeta")`
        : `POSIX path of (choose file with prompt "Seleccionar archivo .env")`;
      const proc = spawn('osascript', ['-e', applescript]);
      let out = '';
      proc.stdout.on('data', d => { out += d.toString(); });
      proc.on('close', () => resolve(out.trim().replace(/\n$/, '') || null));
      proc.on('error', () => resolve(null));

    } else {
      const args = type === 'folder'
        ? ['--file-selection', '--directory', '--title=Seleccionar carpeta']
        : ['--file-selection', '--title=Seleccionar archivo .env'];
      const proc = spawn('zenity', args);
      let out = '';
      proc.stdout.on('data', d => { out += d.toString(); });
      proc.on('close', () => resolve(out.trim() || null));
      proc.on('error', () => resolve(null));
    }
  });
}

router.get('/browse', async (req, res) => {
  const type = req.query.type === 'file' ? 'file' : 'folder';
  const startPath = req.query.startPath || '';
  try {
    const selected = await openNativeDialog(type, startPath);
    res.json(selected ? { path: selected } : { path: null, cancelled: true });
  } catch (e) {
    res.status(500).json({ error: e.message });
  }
});

function findEnvFile(projectPath, depth = 2) {
  if (!projectPath || !fs.existsSync(projectPath)) return null;
  try {
    if (!fs.statSync(projectPath).isDirectory()) return null;
  } catch { return null; }

  const root = path.join(projectPath, '.env');
  if (fs.existsSync(root) && fs.statSync(root).isFile()) return root;

  if (depth <= 0) return null;
  let entries;
  try { entries = fs.readdirSync(projectPath, { withFileTypes: true }); }
  catch { return null; }

  const SKIP = new Set(['node_modules', 'venv', '.git', '__pycache__', '.idea', '.vscode', 'dist', 'build']);
  for (const e of entries) {
    if (!e.isDirectory() || SKIP.has(e.name) || e.name.startsWith('.')) continue;
    const found = findEnvFile(path.join(projectPath, e.name), depth - 1);
    if (found) return found;
  }
  return null;
}

function detectProjectMcp(projectPath) {
  if (!projectPath || !fs.existsSync(projectPath)) return { detected: false, signals: [] };
  try {
    if (!fs.statSync(projectPath).isDirectory()) return { detected: false, signals: [] };
  } catch { return { detected: false, signals: [] }; }

  const signals = [];

  // package.json: dependencias y scripts relacionados con MCP (p.ej. @playwright/mcp)
  const pkgPath = path.join(projectPath, 'package.json');
  if (fs.existsSync(pkgPath)) {
    try {
      const pkg = JSON.parse(fs.readFileSync(pkgPath, 'utf-8'));
      const sections = ['dependencies', 'devDependencies', 'optionalDependencies', 'peerDependencies'];
      for (const section of sections) {
        const deps = pkg && pkg[section] && typeof pkg[section] === 'object' ? pkg[section] : {};
        for (const name of Object.keys(deps)) {
          if (/(@playwright\/mcp|\bplaywright-mcp\b|(^|[\/\-_])mcp([\/\-_]|$))/i.test(name) || /^@.*\/.*mcp/i.test(name)) {
            signals.push(`dependency:${name}`);
          }
        }
      }
      const scripts = pkg && pkg.scripts && typeof pkg.scripts === 'object' ? pkg.scripts : {};
      for (const [key, value] of Object.entries(scripts)) {
        const text = `${key} ${String(value ?? '')}`;
        if (/@playwright\/mcp|\bplaywright-mcp\b|\bmcp-server\b/i.test(text)) {
          signals.push(`script:${key}`);
        }
      }
    } catch {}
  }

  // Archivos de configuración MCP comunes en la raíz del proyecto
  const mcpFiles = ['mcp.json', '.mcp.json', 'mcp.config.json', 'mcp-config.json', '.cursor/mcp.json', '.vscode/mcp.json', 'claude_desktop_config.json'];
  for (const rel of mcpFiles) {
    try {
      if (fs.existsSync(path.join(projectPath, rel))) signals.push(`file:${rel}`);
    } catch {}
  }

  // Configuraciones de clientes/agentes con sección MCP (p. ej. opencode.json)
  const mcpConfigFiles = ['opencode.json', 'opencode.jsonc', '.opencode/opencode.json', '.opencode/opencode.jsonc'];
  for (const rel of mcpConfigFiles) {
    const full = path.join(projectPath, rel);
    try {
      if (!fs.existsSync(full)) continue;
      const raw = fs.readFileSync(full, 'utf-8');
      let parsed = null;
      try {
        parsed = JSON.parse(raw);
      } catch {
        // JSONC/simple comments fallback
        const stripped = raw.replace(/\/\*[\s\S]*?\*\//g, '').replace(/(^|\s+)\/\/.*$/gm, '');
        try { parsed = JSON.parse(stripped); } catch {}
      }
      if (!parsed || typeof parsed !== 'object') continue;
      const mcp = parsed.mcp || parsed.mcpServers;
      if (mcp && typeof mcp === 'object' && !Array.isArray(mcp) && Object.keys(mcp).length > 0) {
        signals.push(`config:${rel}`);
        for (const [name, cfg] of Object.entries(mcp)) {
          if (cfg && typeof cfg === 'object' && cfg.enabled === false) continue;
          signals.push(`server:${name}`);
        }
      }
    } catch {}
  }

  // Documentación del proyecto que declara integración Playwright MCP
  try {
    const readmePath = path.join(projectPath, 'README.md');
    if (fs.existsSync(readmePath)) {
      const readme = fs.readFileSync(readmePath, 'utf-8');
      if (/@playwright\/mcp/i.test(readme) || /Playwright MCP/i.test(readme)) {
        signals.push('docs:README.md');
      }
    }
  } catch {}

  // Referencias en playwright.config.*
  try {
    const entries = fs.readdirSync(projectPath);
    for (const entry of entries) {
      if (!/^playwright\.config\.(t|j)sx?$|^playwright\.config\.mjs$|^playwright\.config\.cjs$/i.test(entry)) continue;
      try {
        const content = fs.readFileSync(path.join(projectPath, entry), 'utf-8');
        if (/@playwright\/mcp|\bplaywright-mcp\b/i.test(content)) signals.push(`config:${entry}`);
      } catch {}
    }
  } catch {}

  const unique = [...new Set(signals)];
  return { detected: unique.length > 0, signals: unique };
}

router.get('/detect-env', (req, res) => {
  try {
    const projectPath = req.query.projectPath || '';
    res.json({ path: findEnvFile(projectPath) });
  } catch (e) {
    res.status(500).json({ error: e.message, path: null });
  }
});

function readConfig(p) {
  return JSON.parse(fs.readFileSync(p, 'utf-8'));
}

function writeConfig(p, data) {
  fs.writeFileSync(p, JSON.stringify(data, null, 2));
}

router.get('/', (req, res) => {
  try {
    const config = readConfig(req.profile.config);
    res.json({
      ...config,
      projectFeatures: {
        mcp: detectProjectMcp(config.projectPath || '')
      }
    });
  } catch (e) {
    res.status(500).json({ error: e.message });
  }
});

router.post('/', (req, res) => {
  try {
    const {
      projectPath, envPath, playwrightCmd, pytestCmd,
      txtFolderPath, seleniumRemoteUrl, errorImagesPath, jsonDataPath,
      evidence
    } = req.body;

    let prevProjectPath = '';
    let prevTxtFolderPath = '';
    let prevSeleniumRemoteUrl = '';
    let prevErrorImagesPath = '';
    let prevJsonDataPath = '';
    let prevPlaywrightCmd = '';
    let prevPytestCmd = '';
    let prevEvidence = undefined;
    let prevConfig = {};
    try {
      prevConfig = readConfig(req.profile.config) || {};
      prevProjectPath = prevConfig.projectPath || '';
      prevTxtFolderPath = prevConfig.txtFolderPath || '';
      prevSeleniumRemoteUrl = prevConfig.seleniumRemoteUrl || '';
      prevErrorImagesPath = prevConfig.errorImagesPath || '';
      prevJsonDataPath = prevConfig.jsonDataPath || '';
      prevPlaywrightCmd = prevConfig.playwrightCmd || '';
      prevPytestCmd = prevConfig.pytestCmd || 'pytest';
      prevEvidence = prevConfig.evidence;
    } catch {}

    if (pytestCmd && !playwrightCmd) {
      console.warn('[config] `pytestCmd` está deprecado; usa `playwrightCmd` para proyectos Playwright.');
    }

    const projectChanged = !samePath(prevProjectPath, projectPath);

    const normalizedEvidence = evidence && typeof evidence === 'object' ? {
      screenshot: ['always', 'only-on-failure', 'off'].includes(evidence.screenshot) ? evidence.screenshot : (prevEvidence && prevEvidence.screenshot),
      video: ['on', 'off', 'retain-on-failure', 'on-first-retry'].includes(evidence.video) ? evidence.video : (prevEvidence && prevEvidence.video),
      trace: ['on', 'off', 'retain-on-failure', 'on-first-retry'].includes(evidence.trace) ? evidence.trace : (prevEvidence && prevEvidence.trace),
      fullPage: typeof evidence.fullPage === 'boolean' ? evidence.fullPage : (prevEvidence && typeof prevEvidence.fullPage === 'boolean' ? prevEvidence.fullPage : undefined),
    } : (evidence === null ? undefined : prevEvidence);

    // Remove undefined keys from evidence
    let finalEvidence = normalizedEvidence;
    if (finalEvidence && typeof finalEvidence === 'object') {
      finalEvidence = Object.fromEntries(Object.entries(finalEvidence).filter(([, v]) => v !== undefined));
      if (Object.keys(finalEvidence).length === 0) finalEvidence = undefined;
    }

    const updated = {
      projectPath,
      envPath,
      playwrightCmd: playwrightCmd !== undefined ? playwrightCmd : (prevPlaywrightCmd || ''),
      pytestCmd: pytestCmd !== undefined ? pytestCmd : prevPytestCmd,
      txtFolderPath: txtFolderPath !== undefined ? txtFolderPath : prevTxtFolderPath,
      seleniumRemoteUrl: seleniumRemoteUrl !== undefined ? seleniumRemoteUrl : prevSeleniumRemoteUrl,
      errorImagesPath: errorImagesPath !== undefined ? errorImagesPath : prevErrorImagesPath,
      jsonDataPath: jsonDataPath !== undefined ? jsonDataPath : prevJsonDataPath,
      ...(finalEvidence ? { evidence: finalEvidence } : {})
    };

    // Compatibilidad: si no hay playwrightCmd definido, mantener comportamiento previo con pytestCmd
    if (!updated.playwrightCmd && updated.pytestCmd) {
      // se permite; rutas resolverán el comando con tolerancia
    }

    writeConfig(req.profile.config, updated);

    let reset = null;
    if (projectChanged && prevProjectPath) {
      reset = resetProjectData(req.profile.reportsDir, req.profile.collection);
    }

    res.json({ success: true, config: updated, projectChanged, reset });
  } catch (e) {
    res.status(500).json({ error: e.message });
  }
});

router.post('/validate', (req, res) => {
  try {
    const { projectPath, playwrightCmd, pytestCmd } = req.body;
    if (pytestCmd && !playwrightCmd) {
      console.warn('[config] `pytestCmd` está deprecado; migra a `playwrightCmd`.');
    }
    if (!projectPath) return res.json({ valid: false, reason: 'No path provided' });
    if (!fs.existsSync(projectPath)) return res.json({ valid: false, reason: 'Path does not exist' });

    const stat = fs.statSync(projectPath);
    if (!stat.isDirectory()) return res.json({ valid: false, reason: 'Path is not a directory' });

    const contents = fs.readdirSync(projectPath);
    const hasPlaywright = contents.some(f => /^playwright\.config\.(t|j)sx?$|^playwright\.config\.mjs$|^playwright\.config\.cjs$/i.test(f));
    const hasPytest = contents.some(f =>
      f === 'pytest.ini' || f === 'conftest.py' || f === 'setup.cfg' ||
      f === 'pyproject.toml' || f.startsWith('test_') || f.endsWith('_test.py')
    );

    if (!hasPlaywright && !hasPytest) {
      return res.json({ valid: false, reason: 'No se encontraron marcadores de proyecto (playwright.config.* o pytest.ini/conftest.py/test_*.py)' });
    }
    res.json({ valid: true });
  } catch (e) {
    res.status(500).json({ error: e.message });
  }
});

module.exports = router;
