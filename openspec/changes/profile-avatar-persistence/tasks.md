# Tasks

## 1. Modelo y persistencia

- [x] 1.1 Añadir en `services/profileManager.js` las constantes `AVATAR_STYLES`/`DEFAULT_AVATAR_STYLE`, `validateAvatar` y `normalizeAvatar`; cubrir con pruebas de estilo inválido, seed vacía, seed no textual, seed mayor a 64 caracteres y fallback determinista.
- [x] 1.2 Aplicar `normalizeAvatar` en `normalizeIndex`/`readIndex` y asegurar que `writeIndex` persiste el fallback; verificar con un índice heredado que el avatar expuesto es estable entre lecturas y que la siguiente mutación lo escribe.
- [x] 1.3 Extender `createProfile` para aceptar y persistir `avatar` (con fallback interno), añadir `updateProfile(id, { name?, avatar? })` y hacer que `renameProfile` delegue sin tocar el avatar; verificar con pruebas de servicio.
- [x] 1.4 Extender `duplicateProfile` para copiar el avatar del origen o aceptar un override validado; verificar que el original no cambia y que el duplicado conserva o reemplaza el avatar según corresponda.

## 2. Rutas HTTP

- [x] 2.1 Exigir `avatar` válido en `POST /api/profile-admin` y responder `400` cuando falte o sea inválido; verificar con pruebas de ruta de alta sin avatar, alta válida y respuesta con avatar.
- [x] 2.2 Añadir `PATCH /api/profile-admin/:id` con `{ name?, avatar? }`, respuesta con el perfil actualizado, `400` por validación y `404` por perfil inexistente; verificar actualización solo de avatar, nombre+avatar y renombrado compatible que conserva avatar.
- [x] 2.3 Aceptar `avatar` opcional en `POST /api/profile-admin/:id/duplicate` y validarlo; verificar duplicado con herencia, con override y con override inválido `400`.
- [x] 2.4 Actualizar el helper de creación de `routes/profileAdmin.test.js` y las pruebas existentes para enviar un avatar válido; ejecutar `npm test` y confirmar que no hay regresiones.

## 3. Documentación

- [x] 3.1 Añadir el esquema `ProfileAvatar` (style enum, seed 1..64) y `avatar` requerido en `Profile` dentro de `swagger.js`; verificar con `node -e "const s=require('./swagger'); console.log(s.components.schemas.ProfileAvatar, s.components.schemas.Profile.required)"`.
- [x] 3.2 Documentar en Swagger los cuerpos y respuestas de `POST /api/profile-admin`, `PATCH /api/profile-admin/{id}` y `POST /api/profile-admin/{id}/duplicate`; verificar que `/api/openapi.json` expone los tres endpoints con avatar.
- [x] 3.3 Añadir en `README.md` una nota sobre `avatar` en `profiles/index.json`, la lista de estilos permitidos y el carácter obligatorio del alta; verificar que la sección coincide con la validación implementada.

## 4. Integración y verificación

- [x] 4.1 Ejecutar `npm test` completo y corregir cualquier regresión en migración, perfiles o rutas.
- [x] 4.2 Con la UI `profile-avatar-picker` aplicada, probar el ciclo completo crear → editar avatar → duplicar → reiniciar API → listar; verificar que el avatar se conserva y que el fallback de legados aparece.
- [x] 4.3 Revisar el índice real `profiles/index.json` tras una mutación y confirmar que cada entrada incluye `avatar.style` y `avatar.seed` sin alterar los demás archivos del perfil.

## Workflow follow-up

- Archivar el cambio cuando la revisión y las pruebas estén aprobadas.
- Sincronizar la spec `profile-avatar` a las specs principales al archivar.
