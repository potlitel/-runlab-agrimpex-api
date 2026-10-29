## 1. Preparación y validación del entorno

- [ ] 1.1 Verificar que `playwrightCmd` resuelve y `npx playwright --version` funciona; comprobar con `node -e "require('child_process').spawnSync('npx',['playwright','--version'])"` → salida con versión.

## 2. test-collection — Colección de tests

- [ ] 2.1 Crear `services/playwrightCollector.js` (reemplaza `testCollector.js`) que exponga `collectTests(projectPath, playwrightCmd)` ejecutando `npx playwright test --list` en `projectPath` y parseando la salida a árbol archivos→tests con projects detectados; verificar con `node -e "require('./services/playwrightCollector').collectTests('/path/kit','npx playwright')"` → JSON con `files`, `total`, `projects`.
- [ ] 2.2 Actualizar `routes/tests.js` para usar `playwrightCollector` en `GET /tests/collect` y `GET /tests/cached`; probar con `curl /api/tests/collect` → JSON con árbol y `total`.
- [ ] 2.3 Implementar caché en memoria por perfil (reutilizando patrón `runtimeRegistry`); verificar `GET /tests/cached` devuelve la misma colección sin re-ejecutar CLI.

## 3. test-execution — Ejecución y streaming

- [ ] 3.1 Crear `services/playwrightRunner.js` (reemplaza `pytestRunner.js`) con `runTests(io, profileId, testIds, projectPath, playwrightCmd, envVars, paramsByTest)` que spawnea `npx playwright test <paths> [--project=X] [-g "filter"] --reporter=json` y parsea NDJSON línea a línea mapeando `testStarted/testEnded` a eventos socket `test:started`, `test:completed`, `progress`, `execution:completed/aborted`.
- [ ] 3.2 Implementar mapeo de status: `passed`→`passed`, `failed`→`failed`, `skipped`→`skipped`, `flaky`→`failed` con nota; extraer `error`, `duration`, `attachments` (screenshot/trace/video paths).
- [ ] 3.3 Implementar aborto (`SIGTERM` al proceso) y aislamiento por perfil (estado por `profileId`); probar aborto manual con `POST /api/tests/abort` o evento socket → `execution:aborted` emitido.
- [ ] 3.4 Inyectar `envVars` del perfil (`.env` gestionado por `envManager`) al spawn; verificar que `process.env` del proceso hijo incluye `PLAYWRIGHT_*` y variables del proyecto.

## 4. run-artifacts — Persistencia y assets

- [ ] 4.1 Al finalizar `runTests`, persistir reporte JSON en `profiles/<id>/reports/<runId>.json` con `summary` y `tests[]`; verificar que `GET /api/reports` lista el nuevo run con `summary`.
- [ ] 4.2 Al finalizar, copiar `playwright-report/` y `test-results/` del run al directorio del reporte (`profiles/<id>/reports/<runId>/assets/`); servir estáticos bajo `/api/reports/:id/assets/*`; verificar `curl /api/reports/:id/assets/playwright-report/index.html` → HTML.
- [ ] 4.3 Endpoint para descargar trace.zip/screenshot de un test fallido; probar `curl /api/reports/:id/assets/test-results/<test-id>/trace.zip` → archivo válido.

## 5. Configuración y detección de projects

- [ ] 5.1 Añadir campo `playwrightCmd` a `config.example.json` y validación en `POST /config/validate`; deprecar `pytestCmd` con aviso en logs.
- [ ] 5.2 En `playwrightCollector`, detectar projects leyendo `playwright.config.ts` (o ejecutando `npx playwright test --list --reporter=json` que ya incluye projects) y exponer en colección; verificar `GET /api/tests/collect` incluye lista de projects.
- [ ] 5.3 En `runTests`, aceptar `--project=<project>` y `-g "<filtro>"` via `paramsByTest` y `testIds`; probar ejecución filtrada por project y por grep.

## 6. Validación integral y tests

- [ ] 6.1 Ejecutar suite completa del kit (`playwright-kit-profesional`) desde la UI: colectar → seleccionar 5 tests → correr → verificar reporte con passed/failed + assets; durar < 5 min.
- [ ] 6.2 Ejecutar `npm test` del backend (tests existentes) → 27/27 pass; no regresiones en módulos no tocados (env, docker, schedules, etc.).
- [ ] 6.3 Probar aborto, aislamiento por perfil, caché, env inyectado; documentar comando de verificación en README del change.