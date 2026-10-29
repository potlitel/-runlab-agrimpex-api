## Purpose

Expone el árbol de tests de un proyecto Playwright (archivos → casos, con projects detectados) para que la UI lo liste, seleccione y ejecute sin abrir la terminal.

## ADDED Requirements

### Requirement: Colección de tests vía el CLI de Playwright
El sistema SHALL colectar los tests del proyecto ejecutando el comando de listado de Playwright en la raíz del proyecto configurada y SHALL devolver un árbol de archivos con sus casos, incluyendo el conteo total.

#### Scenario: Colección exitosa
- **WHEN** el proyecto tiene `playwright.config` válido con tests escritos
- **THEN** la respuesta contiene el árbol archivos → tests y un `total` igual al número de casos listados

#### Scenario: Proyecto sin tests
- **WHEN** el comando de listado no encuentra tests en la ruta configurada
- **THEN** el sistema devuelve un error elegante con mensaje accionable, sin caer el proceso del servidor

#### Scenario: Comando no resoluble
- **WHEN** `playwrightCmd` apunta a un ejecutable inexistente
- **THEN** el error incluye una pista de corrección (instalar browsers o corregir la ruta del comando)

### Requirement: Detección de projects
El sistema SHALL exponer los projects definidos en la configuración del proyecto (por ejemplo chromium, inbond, air-freight, logistic) para que la ejecución pueda filtrar por ellos.

#### Scenario: Projects presentes
- **WHEN** la configuración define varios projects
- **THEN** la colección incluye la lista de projects detectados

### Requirement: Caché de colección
El sistema SHALL servir la última colección exitosa sin re-ejecutar el comando cuando se solicite la vista en caché.

#### Scenario: Colección cacheada
- **WHEN** existe una colección previa exitosa y se solicita la cached
- **THEN** se devuelve la misma sin ejecutar el CLI de Playwright