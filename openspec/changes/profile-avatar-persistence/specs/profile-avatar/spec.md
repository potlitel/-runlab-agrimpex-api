# Spec Delta

## Purpose

Definir la persistencia, validación y ciclo de vida del avatar asociado a cada perfil del dashboard, para que la UI pueda recuperar un avatar estable tras reinicios, listados y duplicados.

## ADDED Requirements

### Requirement: Persistencia del avatar en el perfil

El backend SHALL persistir un objeto `avatar` con las propiedades `style` y `seed` en cada entrada de perfil de `profiles/index.json`, y SHALL devolverlo en las respuestas de listado y mutación.

#### Scenario: Crear perfil con avatar

- **WHEN** se crea un perfil con un avatar válido
- **THEN** la entrada persistida contiene `avatar.style` y `avatar.seed` y la respuesta de creación incluye el mismo avatar

#### Scenario: Listar perfiles con avatar

- **WHEN** se consulta el listado de perfiles
- **THEN** cada perfil incluye su avatar persistido y el perfil activo conserva su identificador

#### Scenario: Avatar tras reinicio

- **WHEN** el proceso se reinicia y vuelve a leer el índice de perfiles
- **THEN** cada perfil conserva el avatar previamente guardado

### Requirement: Validación del avatar

El backend SHALL rechazar con estado `400` toda creación o actualización cuyo avatar falte, use un estilo no permitido o contenga una semilla inválida.

#### Scenario: Avatar ausente en el alta

- **WHEN** se intenta crear un perfil sin `avatar`
- **THEN** el backend responde `400` y no crea el perfil

#### Scenario: Estilo no permitido

- **WHEN** se envía un avatar con un `style` fuera de la lista permitida
- **THEN** el backend responde `400` con un mensaje que identifica el campo inválido

#### Scenario: Semilla inválida

- **WHEN** se envía un avatar con `seed` vacía, no textual o fuera del límite de longitud
- **THEN** el backend responde `400` y no persiste el cambio

### Requirement: Actualización de nombre y avatar

El backend SHALL permitir actualizar el nombre y/o el avatar de un perfil existente en una sola operación y SHALL conservar el endpoint de renombrado por compatibilidad.

#### Scenario: Actualizar solo el avatar

- **WHEN** se envía una actualización con un avatar válido y sin nombre
- **THEN** el backend reemplaza el avatar y mantiene el nombre actual

#### Scenario: Actualizar nombre y avatar

- **WHEN** se envía una actualización con nombre y avatar válidos
- **THEN** el backend persiste ambos cambios de forma atómica y devuelve el perfil actualizado

#### Scenario: Renombrado compatible

- **WHEN** se invoca el endpoint de renombrado existente con un nombre válido
- **THEN** el backend actualiza el nombre sin alterar el avatar

#### Scenario: Perfil inexistente

- **WHEN** se intenta actualizar el avatar de un perfil que no existe
- **THEN** el backend responde `404` y no modifica el índice

### Requirement: Avatar en el duplicado

El backend SHALL copiar el avatar del perfil de origen al duplicar un perfil, salvo que la solicitud incluya un avatar explícito válido.

#### Scenario: Duplicado sin avatar explícito

- **WHEN** se duplica un perfil sin enviar avatar
- **THEN** el perfil duplicado conserva el mismo avatar que el perfil de origen

#### Scenario: Duplicado con avatar explícito

- **WHEN** se duplica un perfil enviando un avatar válido distinto
- **THEN** el perfil duplicado usa el avatar enviado y el perfil de origen no cambia

### Requirement: Compatibilidad con perfiles heredados

El backend SHALL aceptar índices de perfiles sin campo `avatar` y SHALL asignarles un avatar por defecto determinista al normalizar, exponiéndolo en las respuestas y persistiéndolo en la siguiente escritura.

#### Scenario: Perfil heredado sin avatar

- **WHEN** el índice leído contiene un perfil sin `avatar`
- **THEN** el backend expone un avatar por defecto derivado del identificador del perfil

#### Scenario: Fallback determinista

- **WHEN** se lee dos veces el mismo perfil heredado sin avatar
- **THEN** el avatar por defecto expuesto es idéntico en ambas lecturas

#### Scenario: Persistencia de la normalización

- **WHEN** se realiza una mutación posterior sobre un índice con perfiles heredados
- **THEN** el avatar por defecto queda escrito en `profiles/index.json` para esos perfiles

### Requirement: Contrato documentado

La documentación OpenAPI/Swagger SHALL describir el esquema `avatar` y los endpoints de alta, actualización y duplicado que lo aceptan o devuelven.

#### Scenario: Esquema documentado

- **WHEN** se consulta la documentación de la API
- **THEN** el esquema de perfil incluye `avatar.style` y `avatar.seed` con sus restricciones

#### Scenario: Endpoints documentados

- **WHEN** se consulta la documentación de `profile-admin`
- **THEN** figuran el alta con avatar, la actualización de nombre/avatar y el duplicado con herencia de avatar
