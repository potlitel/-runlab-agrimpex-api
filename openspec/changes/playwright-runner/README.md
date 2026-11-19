# Verificación — change `playwright-runner`

## Contexto
- **Kit objetivo:** `/home/potlitel/Trabajo/EICMA/Agrimpex/playwright-kit-profesional`
- **Backend:** `runlab-agrimpex-api` (Node 18+, CommonJS)
- **Contrato:** REST/Socket.io preservado (paridad QADash)

## Verificaciones realizadas en este entorno

### 1) Entorno Playwright (1.1)
```bash
node -e "const r=require('child_process').spawnSync('npx',['playwright','--version'],{encoding:'utf8'}); console.log(r.status, r.stdout)"
# => 0 / Version 1.65.1
```

### 2) Colección real contra el kit (2.1, 2.2, 2.3, 5.2)
```bash
cd runlab-agrimpex-api
node - <<'NODE'
const { collectTests, getCached, setCached } = require('./services/playwrightCollector');
(async () => {
  const kit = '/home/potlitel/Trabajo/EICMA/Agrimpex/playwright-kit-profesional';
  const r = await collectTests(kit, 'npx playwright');
  console.log({ total: r.total, projects: r.projects, files: Object.keys(r.files).length, sample: r.files[Object.keys(r.files)[0]].slice(0,2) });
  setCached('p1', r);
  console.log('cached', !!getCached('p1'));
})();
NODE
# Resultado observado: total=713, projects=[chromium,inbond,air-freight,logistic], files=93
```
- Soporta salida con prefijos no-JSON (p.ej. dotenv/dotenvx en stdout).
- IDs estables: `<archivo>::<título jerárquico>` (sin duplicar nombre de archivo como suite raíz).

### 3) Ejecución, reporte y assets (3.1-3.4, 4.1-4.3, 5.3)
```bash
cd runlab-agrimpex-api
node - <<'NODE'
const fs = require('fs'); const os = require('os'); const path = require('path');
const { runTests } = require('./services/playwrightRunner');
function fakeIo(){ return { to(){ return { emit(){} }; }, emit(){} }; }
(async () => {
  const kit = '/home/potlitel/Trabajo/EICMA/Agrimpex/playwright-kit-profesional';
  const reportsDir = fs.mkdtempSync(path.join(os.tmpdir(),'pw-run-'));
  const res = await runTests(fakeIo(), 'perfil-1', ['login.spec.ts::Login › inicia sesión con credenciales válidas'], kit, 'npx playwright', { PLAYWRIGHT_TEST_ENV: '1' }, {}, reportsDir, { project: 'chromium', grep: '__NO_MATCH__', workers: 1 });
  console.log({ reportId: res.reportId, summary: res.summary, report: fs.existsSync(path.join(reportsDir, res.reportId+'.json')), assets: fs.existsSync(path.join(reportsDir, res.reportId, 'assets')) });
})();
NODE
```
- Persiste `profiles/<id>/reports/<runId>.json` y crea `.../<runId>/assets/`.
- Copia `playwright-report/` y `test-results/` (si existen) al assets del run.
- Servicio de assets: `GET /api/reports/:id/assets/*` (incluye trace/screenshot).

### 4) Regresión backend (6.2)
```bash
cd runlab-agrimpex-api && npm test
# => 27/27 pass, 0 fail
```

### 5) Aislamiento, caché y env (6.3 — soporte)
- **Aislamiento por perfil:** estado por `profileId`, emisión a sala `profile:<id>`; suite existente `services/pytestRunner.test.js` y `services/runtimeRegistry.test.js` siguen en verde.
- **Caché:** memoria por perfil (`getCached/setCached`) + persistencia en `data/last-collection.json`; `/tests/cached` no re-ejecuta CLI.
- **Env inyectado:** `envVars` mergeados en `spawn(..., { env: { ...process.env, ...envVars, PLAYWRIGHT_JSON_OUTPUT_* } })`.

## Verificación E2E recomendada (requiere AUT activo)
> El AUT (`http://localhost:5000`, `http://localhost:8990`) no estaba disponible durante esta verificación, por lo que no se ejecutaron tests reales end-to-end.

1. Configurar perfil: `projectPath=/home/potlitel/Trabajo/EICMA/Agrimpex/playwright-kit-profesional`, `playwrightCmd="npx playwright"`.
2. `GET /api/tests/collect` y `GET /api/tests/cached` → árbol con `projects`.
3. `POST /api/tests/run` con 5 `testIds` (y opcional `project/grep/workers`) → eventos `execution:* / test:* / progress` en `profile:<id>`.
4. `GET /api/reports` y `GET /api/reports/:id` → resumen/detalle; `GET /api/reports/:id/assets/playwright-report/index.html` si existe HTML.
5. `POST /api/tests/abort` durante corrida → `execution:aborted`.
6. Validación desde UI (cuando `contract-client`/vistas estén implementadas): colectar → seleccionar 5 → correr → revisar reporte + assets.
