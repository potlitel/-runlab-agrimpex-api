## Purpose

Persistir el resultado de cada ejecución y servir los assets de Playwright (reporte HTML, screenshots, traces, videos) para revisión posterior y enlaces compartibles.

## ADDED Requirements

### Requirement: Reporte JSON por ejecución
El sistema SHALL persistir un reporte JSON por run con resumen (total, passed, failed, skipped, duration) y detalle por test, bajo el workspace del perfil.

#### Scenario: Fin de ejecución
- **WHEN** una corrida termina
- **THEN** existe un reporte con id, timestamp, resumen y resultados por test, listado por el módulo de reportes

### Requirement: Assets de Playwright
El sistema SHALL capturar el HTML report y los assets de fallo (screenshots, trace.zip, videos) generados por la corrida y asociarlos al run.

#### Scenario: Fallo con trace
- **WHEN** un test falla y genera trace
- **THEN** el run expone la referencia al trace y al screenshot del fallo

### Requirement: Servicio de assets
El sistema SHALL servir los assets del run (reporte HTML y evidencia de fallos) mediante endpoints descargables o visualizables.

#### Scenario: Reporte HTML de un run
- **WHEN** se solicita el reporte HTML de un run
- **THEN** se devuelve el HTML estático de Playwright correspondiente a ese run