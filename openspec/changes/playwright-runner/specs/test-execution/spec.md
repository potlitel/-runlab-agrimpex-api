## Purpose

Conduce la ejecución de una selección de tests Playwright con streaming en vivo por Socket.io, aborto y resumen agregado, manteniendo el contrato de eventos de la referencia.

## ADDED Requirements

### Requirement: Ejecución de una selección de tests
El sistema SHALL aceptar una selección de tests (archivos, carpetas o IDs), un filtro de título, un project y un número de workers, y SHALL ejecutar el CLI de Playwright con reporter JSON.

#### Scenario: Ejecución por archivo
- **WHEN** se solicita correr un archivo de spec
- **THEN** el proceso se ejecuta con ese path y emite progreso en vivo

#### Scenario: Filtro por project
- **WHEN** se indica un project
- **THEN** la invocación incluye `--project=<project>` y solo corre ese subconjunto

### Requirement: Streaming de progreso
El sistema SHALL emitir por la sala `profile:<id>` los eventos `execution:started`, `test:started`, `test:completed`, `progress` y `execution:completed`, con status y duración por test.

#### Scenario: Test fallido
- **WHEN** un caso termina en fallo
- **THEN** `test:completed` incluye status `failed`, el mensaje de error y la referencia a attachments (screenshot/trace)

### Requirement: Aborto de ejecución
El sistema SHALL abortar la ejecución en curso del perfil al recibir la señal, terminando el proceso hijo y emitiendo `execution:aborted`.

#### Scenario: Aborto manual
- **WHEN** el usuario cancela una corrida en curso
- **THEN** el proceso hijo se termina y se emite `execution:aborted` con el avance parcial

### Requirement: Aislamiento por perfil
El sistema SHALL permitir una ejecución activa por perfil sin que el estado ni los eventos se crucen entre perfiles.

#### Scenario: Corridas simultáneas en dos perfiles
- **WHEN** dos perfiles ejecutan al mismo tiempo
- **THEN** cada sala recibe únicamente los eventos de su propio perfil

### Requirement: Inyección de entorno
El sistema SHALL inyectar al proceso las variables de entorno guardadas del proyecto, gestionadas por el módulo de variables.

#### Scenario: Rutas de CSV desde el entorno
- **WHEN** el perfil define rutas de CSV en su `.env`
- **THEN** el proceso Playwright las recibe y los tests de ingestión las consumen