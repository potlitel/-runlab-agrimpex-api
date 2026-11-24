# Proposal

## Why

`profiles/index.json` solo guarda `id`, `name` y `createdAt`, de modo que la UI no puede persistir ni recuperar un avatar por perfil. Sin un avatar estable en el backend, cada cliente tendría que inventarlo y se perdería al reiniciar o al listar perfiles desde otro navegador.

## What Changes

- Extender cada entrada de perfil con `avatar: { style, seed }`, validando `style` contra una lista permitida y `seed` como cadena no vacía de longitud acotada.
- **BREAKING** Hacer obligatorio el avatar en `POST /api/profile-admin`: sin avatar válido responde `400`; los clientes anteriores deben enviar avatar.
- Añadir `PATCH /api/profile-admin/:id` para actualizar nombre y/o avatar de forma atómica; se conserva `PATCH /:id/rename` por compatibilidad.
- Copiar el avatar del perfil de origen en `POST /:id/duplicate`, salvo que se envíe uno explícito.
- Normalizar perfiles heredados sin avatar asignando un fallback determinista `{ style: 'notionists', seed: profile.id }` al leer y al escribir el índice.
- Actualizar la documentación Swagger y las pruebas del contrato.
- Depender del cambio espejo `profile-avatar-picker` en `runlab-agrimpex-ui`, que consume y muestra el avatar.

## Capabilities

### New Capabilities

- `profile-avatar`: persistencia, validación y ciclo de vida del avatar asociado a cada perfil del dashboard.

### Modified Capabilities

<!-- No hay specs principales existentes; el cambio introduce una capability nueva. -->

## Impact

- **Código**: `services/profileManager.js`, `routes/profileAdmin.js`, `routes/profileAdmin.test.js`, `swagger.js`.
- **Datos**: `profiles/index.json` agrega `avatar` a cada entrada; los índices existentes se normalizan al leerlos.
- **Contrato**: `Profile` expone `avatar`; alta, actualización y duplicado lo aceptan y devuelven.
- **Sistemas**: UI `runlab-agrimpex-ui` (cambio `profile-avatar-picker`).
