## Why

El backend de línea base (QADash) colecta y ejecuta proyectos **pytest** y guarda reportes JSON propios. RunLab Agrimpex debe conducir la **suite Playwright** del kit (`playwright-kit-profesional`: 526 tests, 67 archivos, 4 projects) sin romper el contrato REST + Socket.io que el front ya consume, para que la UI de referencia funcione sin cambios.

## What Changes

- Reemplazar la colección `pytest --collect-only` por `npx playwright test --list`, parseada a árbol archivos → tests, incluyendo los 4 projects (`chromium`, `inbond`, `air-freight`, `logistic`).
- Reemplazar el runner por-nodeid de pytest por `spawn` de `npx playwright test <paths> [--project=X] [-g "filtro"] --reporter=json`, parseando el NDJSON del reporter JSON y mapeándolo a los **mismos eventos Socket.io** de la referencia (`test:started`, `test:completed`, `progress`, `execution:started/completed/aborted`).
- Persistir por run: reporte JSON propio (compatibilidad con `/api/reports`) + copiar/servir assets de Playwright (`playwright-report/` HTML, `test-results/`: screenshots, `trace.zip`, videos).
- Configuración: nuevo campo `playwrightCmd` (proyecto, workers) y proyectos detectados; `pytestCmd` queda deprecado.
- Aborto: misma semántica por perfil (SIGTERM al proceso hijo).

## Capabilities

### New Capabilities
- `test-collection`: colectar y exponer el árbol de tests de un proyecto Playwright (`--list`), con caché y detección de projects.
- `test-execution`: ejecutar una selección de tests (archivos/carpetas/filtro/project) con streaming en vivo, aborto y resumen agregado.
- `run-artifacts`: persistir el reporte JSON de cada run y servir los assets de Playwright (HTML report, screenshots, traces, videos).

### Modified Capabilities
_(ninguna — repo sin specs previas; la paridad de contrato se mantiene)_

## Impact

- Archivos: `services/testCollector.js`, `services/pytestRunner.js` (→ `services/playwrightRunner.js`), `routes/tests.js`, `routes/config.js`, `config.example.json`.
- Sin cambios en `profileAdmin`, `env`, `docker`, `schedules`, `errors`, `automation`, `system` (paridad de módulos se mantiene).
- Sin dependencias nuevas (`child_process` nativo).
- El front de referencia (dash-front) sigue funcionando sin modificaciones: el contrato API/Socket no cambia.
