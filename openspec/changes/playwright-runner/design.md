## Context

La línea base (QADash) colecta con `pytest --collect-only` y ejecuta por nodeid. El kit objetivo es Playwright: 4 projects (chromium/inbond/air-freight/logistic), specs seriales y paralelos, workers 2 local / 4 CI, stubs GraphQL por fixtures y `storageState` de auth. El contrato REST + Socket.io de la referencia debe permanecer idéntico para que el front no cambie.

## Goals / Non-Goals

**Goals:**
- Swap del coleccionista y del runner sin alterar endpoints ni nombres de eventos.
- Assets de Playwright (HTML report, screenshots, traces, videos) asociados al run y servibles.
- Configuración con `playwrightCmd` y projects detectados.

**Non-Goals:**
- Pre-flight del AUT (change A2).
- Deep-links por run y embebido del Trace Viewer (change A3).
- Scheduler, Docker, env, automation: ya existen en la línea base, fuera de alcance.

## Decisions

- **D1 — CLI por spawn, no API programática:** se mantiene `spawn` del CLI `npx playwright test`, igual filosofía que la referencia con pytest; aislado de cambios internos de `@playwright/test`.
- **D2 — Reporter JSON (NDJSON):** parseo línea a línea; `testStarted` → `test:started`, `testEnded` → `test:completed` (status passed/failed/skipped; flaky se reporta como failed con nota), con duration, error y attachments. Los nombres de eventos socket son los de la referencia.
- **D3 — Identidad de test:** `<archivo>::<título>`, estable y legible; la selección viaja como paths + `-g` + `--project`.
- **D4 — Assets:** al finalizar, se copia `playwright-report/` y `test-results/` al workspace del run; los traces pesados se sirven bajo demanda.
- **D5 — Entorno:** reusar `envManager` del perfil e inyectar las variables al spawn.
- **D6 — Workers:** exponer `--workers` (default del kit: 2 en local).
- **D7 — Config:** `playwrightCmd` + `projects` detectados; `pytestCmd` deprecado con lectura tolerante.

## Risks / Trade-offs

- [NDJSON buffering en el pipe] → parse por líneas con buffer parcial.
- [Corridas largas sin señales al UI] → `progress` periódico + `test:output` del reporter line.
- [AUT caído] → la corrida falla rápido en conectividad; mitigación completa en A2 (pre-flight).
- [Deprecación de pytestCmd] → lectura tolerante + mensaje de migración en validate.