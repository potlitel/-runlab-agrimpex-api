# RunLab Agrimpex — API

Backend del dashboard QA para gestionar y ejecutar la suite Playwright de Agrimpex.

## Contexto

- **Producto**: panel web para ejecutar la suite E2E del kit `playwright-kit-profesional` (526 tests, 67 archivos, 4 projects: chromium / inbond / air-freight / logistic) sin abrir la terminal.
- **Línea base**: adaptación de [QADash backend](https://github.com/hramses1/dash-backend) (MIT © hramses1). El contrato REST + Socket.io de la referencia se mantiene.
- **AUT**: Angular en `https://localhost:5000` + Symfony en `http://localhost:8990`. **El runner debe desplegarse en la máquina donde vive el AUT** (los tests golpean localhost).
- **Stack**: Node 18+, Express 4, Socket.io 4, CommonJS, tests con `node --test`.
- **Front hermano**: `runlab-agrimpex-ui` (React 19), servido en producción desde `dist/` por este backend.

## Recordatorios pendientes

- **[A4 — despliegue]** ✅ `middleware/serveFrontend.js` usa por default `RUNLABQA_DIST_DIR=../runlab-agrimpex-ui/dist` (antes apuntaba al repo base). `services/selfUpdate.js` usa `RUNLABQA_FRONTEND_DIR=../runlab-agrimpex-ui`.
- **[Backlog]** Pre-flight del AUT (healthcheck :5000/:8990 + seed auth) — change A2.
- **[Backlog dormido]** Webhook al chat, badge shields.io, filtro por task OpenSpec.

## Módulos (paridad QADash)

config, tests (collect/cached/run), features, variables/env, reports, automation, txtdata, jsondata, docker, schedules, errors, profile-admin, system.
