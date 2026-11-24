# Design

## Context

`services/profileManager.js` normaliza y persiste `profiles/index.json`; las entradas actuales son `{ id, name, createdAt }`. `routes/profileAdmin.js` expone listado, alta, renombrado, duplicado, activación y borrado. Las pruebas usan directorios temporales vía `RUNLABQA_DATA_DIR`. Ver `proposal.md` para la motivación y `specs/profile-avatar/spec.md` para el comportamiento exigido.

El avatar no necesita renderizarse en el backend: la UI genera el SVG a partir de `{ style, seed }`. El backend solo lo valida, lo persiste y lo devuelve.

## Goals / Non-Goals

**Goals:**

- Persistir un avatar estable por perfil sin almacenar imágenes.
- Validar el avatar en las operaciones de alta y actualización.
- Permitir renombrar y cambiar avatar en una sola operación atómica sobre el índice.
- Normalizar índices heredados sin romper perfiles existentes.
- Documentar y probar el contrato.

**Non-Goals:**

- Generar o renderizar avatares en el servidor.
- Añadir dependencias de DiceBear al backend.
- Servir archivos de avatar o aceptar subidas.
- Cambiar el aislamiento por perfil, los archivos de configuración del perfil o el esquema de `config.json`.

## Decisions

### Forma y ubicación del avatar

Cada entrada de `profiles/index.json` incluye `avatar: { style, seed }`. `style` es un identificador de la lista permitida y `seed` una cadena de 1 a 64 caracteres.

- **Por qué en el índice:** el índice es la fuente que consume `GET /api/profile-admin`; evita lecturas adicionales por perfil y mantiene el avatar junto a la identidad que lista la UI.
- **Alternativas descartadas:** guardar el data URI (crece sin límite y duplica datos); guardar una URL externa (dependencia de red); guardar el avatar en `config.json` (ese archivo es configuración operativa del perfil, no identidad de la lista).
- **Lista permitida:** `AVATAR_STYLES = ['notionists', 'lorelei', 'micah', 'bottts']`, `DEFAULT_AVATAR_STYLE = 'notionists'`. Debe coincidir con el catálogo de la UI; se documenta y se cubre con pruebas en ambos repos.

### Validación estricta en la API, normalización para legados

Se separan dos funciones:

- `validateAvatar(value)` lanza un error con mensaje de campo si falta el objeto, el estilo no está permitido o la seed es vacía, no textual o supera 64 caracteres.
- `normalizeAvatar(value, fallbackSeed)` intenta validar y, si falla, devuelve `{ style: DEFAULT_AVATAR_STYLE, seed: fallbackSeed }`.

`readIndex()` aplica `normalizeAvatar` a cada perfil, de modo que las respuestas siempre incluyen avatar. `writeIndex()` vuelve a normalizar y persiste el fallback en la siguiente mutación. No se escribe en un `GET` para evitar efectos secundarios.

- **Por qué:** el contrato queda estricto para clientes nuevos sin romper índices antiguos.
- **Fallback determinista:** usar `profile.id` como seed garantiza el mismo avatar en cada lectura.

### Alta obligatoria y actualización atómica

- `POST /api/profile-admin` exige `avatar` y responde `400` si falta o es inválido. El servicio `createProfile` mantiene un fallback para llamadas internas y pruebas existentes; la ruta es la que impone la obligatoriedad.
- Se añade `PATCH /api/profile-admin/:id` con `{ name?, avatar? }`. Valida al menos un campo, actualiza ambos en memoria y escribe el índice una sola vez; devuelve la entrada actualizada. Responde `404` si el perfil no existe.
- `PATCH /api/profile-admin/:id/rename` se conserva y delega en la misma actualización; no altera el avatar.
- `POST /api/profile-admin/:id/duplicate` acepta `avatar` opcional. Sin override copia el avatar del origen (normalizado); con override valida y usa el enviado.

- **Por qué un `PATCH /:id`:** evita dos llamadas (renombrar + avatar) y estados intermedios inconsistentes.
- **Orden de rutas:** registrar `PATCH /:id` después de `PATCH /:id/rename` y `PATCH /:id/activate` para que Express no capture las rutas específicas con el comodín `:id`.
- **Compatibilidad:** `rename` sigue disponible para clientes antiguos; la UI nueva usa `PATCH /:id`.
- **Errores:** `400` para validación, `404` para perfil inexistente, `500` para fallos inesperados. El formato sigue `{ error: string }`.

### Documentación y pruebas

- Swagger: nuevo esquema `ProfileAvatar` (`style` enum, `seed` con `minLength`/`maxLength`), `avatar` requerido en `Profile`, y cuerpos actualizados para alta, `PATCH /:id` y duplicado.
- Pruebas de servicio: persistencia, validación, actualización atómica, duplicado con herencia/override, normalización de legados y estabilidad del fallback.
- Pruebas de ruta: alta sin avatar `400`, alta válida, `PATCH` de avatar, `PATCH` inválido, `404`, duplicado con avatar heredado y renombrado que conserva avatar.
- Las pruebas existentes que crean perfiles deben enviar un avatar válido; se actualiza el helper de creación.

## Risks / Trade-offs

- [Deriva entre la lista de estilos de API y UI] → lista documentada, pruebas en ambos repos y versiones exactas de DiceBear en la UI.
- [Alta obligatoria rompe clientes antiguos] → **BREAKING** intencional; desplegar UI y API juntas. Se evalúa una ventana con `PROFILE_AVATAR_OPTIONAL=1` solo si aparece un cliente externo.
- [Escrituras concurrentes al índice] → riesgo preexistente; la actualización atómica reduce el número de escrituras, no se introduce un lock nuevo.
- [Semilla controlada por el usuario] → solo se almacena y devuelve; no se usa en rutas de filesystem ni en HTML del backend; se limita longitud y se valida como string.
- [Perfiles heredados con datos corruptos] → `normalizeAvatar` cae al fallback por id en lugar de fallar el listado completo.
- [Rollback de la API] → la UI nueva pierde la edición de avatar y el alta con avatar; el índice conserva el campo y la UI anterior lo ignora.

## Migration Plan

1. Desplegar la API con normalización y validación; las entradas heredadas se exponen con fallback y se persisten en la siguiente mutación.
2. Desplegar la UI `profile-avatar-picker` en la misma ventana; el alta sin avatar deja de funcionar en clientes antiguos.
3. Verificar con un índice real que `GET /api/profile-admin` devuelve avatar para todos los perfiles y que crear/editar/duplicar lo conserva.
4. Rollback: restaurar la API y la UI anteriores; el campo `avatar` adicional en el índice es ignorado por la versión previa.
