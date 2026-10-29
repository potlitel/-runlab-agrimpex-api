# RunLab Agrimpex — API

> **Línea base:** adaptación de [QADash backend](https://github.com/hramses1/dash-backend)
> (MIT, © hramses1). Producto: panel QA para gestionar y ejecutar la suite
> Playwright de Agrimpex. La interfaz vive en el repo hermano `runlab-agrimpex-ui`.

API REST y servidor de WebSocket del dashboard. Se encarga de colectar y ejecutar
los tests de un proyecto de automatización, guardar los reportes y transmitir el
progreso en vivo al navegador.

## Qué hace

- Lista los tests de un proyecto pytest y los ejecuta uno por uno.
- Emite el progreso por Socket.io para que el dashboard lo pinte en vivo.
- Guarda un reporte JSON de cada ejecución y calcula estadísticas.
- Edita el `.env` del proyecto y guarda distintos entornos reutilizables.
- Clona el repo de automatización, crea su `venv` e instala sus dependencias.
- Levanta y para el contenedor de Selenium con Docker.
- Programa ejecuciones automáticas por día y hora.
- Lee archivos `.txt` y `.json` del proyecto y las capturas de los fallos.

## Requisitos

| Herramienta | Versión | Para qué | Obligatoria |
|---|---|---|---|
| Node.js | 18 o superior | Correr este backend y construir el frontend | Sí |
| Git | cualquiera | Clonar los repos y el proyecto de automatización | Sí |
| Python | 3.8 o superior | Correr el proyecto de automatización | Sí |
| `pytest` | el que use tu proyecto | Colectar y ejecutar los tests | Sí, dentro del proyecto de automatización |
| `virtualenv` | cualquiera | Solo si el instalador automático crea el `venv` (`pip install virtualenv`) | No |
| Docker (con `docker compose`) | cualquiera | Solo si tus tests usan Selenium Grid en contenedor | No |

El backend no incluye ningún proyecto de tests: ejecuta **el tuyo**. Más abajo
está cómo apuntarlo.

## Puesta en marcha

### 1. Clonar los dos repos en la misma carpeta

Los repos tienen que quedar como hermanos y **con estos nombres**, porque el
backend ubica el frontend por su ruta relativa (`../qadash-frontend`).

```bash
mkdir qadash && cd qadash
git clone https://github.com/hramses1/dash-backend.git qadash-backend
git clone https://github.com/hramses1/dash-front.git qadash-frontend
```

Si prefieres otra estructura, mira las variables `QADASH_DIST_DIR` y
`QADASH_FRONTEND_DIR` más abajo.

### 2. Construir el frontend

```bash
cd qadash-frontend
npm install
npm run build
```

Esto genera `qadash-frontend/dist`, que el backend sirve solo.

### 3. Arrancar el backend

```bash
cd ../qadash-backend
npm install
npm start
```

### 4. Abrir el dashboard

Entra a **http://localhost:3001**. Al primer arranque se crea un perfil llamado
"Perfil 1". Si ves el dashboard, todo está bien; el siguiente paso es
configurar tu proyecto de pruebas.

> Si en consola aparece `[frontend] no hay build en ...`, falta el paso 2 o los
> repos no están como hermanos. El backend sigue funcionando, pero solo
> responde `/api`.

### Modo desarrollo

Para tocar el código con recarga automática, corre los dos en terminales
separadas:

```bash
# Terminal 1 - backend
cd qadash-backend && npm run dev

# Terminal 2 - frontend
cd qadash-frontend && npm run dev
```

Abre **http://localhost:5173**. Vite hace proxy de `/api` y `/socket.io` hacia
el backend en el puerto 3001, así que el backend tiene que estar corriendo.

## Conectar tu proyecto de pruebas

Todo esto se hace desde la interfaz, en **Configuración** (`/settings`). No hay
que editar archivos a mano.

Tienes dos caminos:

**A. Ya tienes el proyecto en tu máquina.** Rellena la tarjeta *Rutas del
Proyecto* (campos abajo).

**B. Quieres que QADash lo descargue.** Usa la tarjeta *Instalación de
Automatización*:

1. *Paso 1*: verifica los requisitos del sistema (Python, Git, virtualenv).
2. *Paso 2*: pon la *URL del repositorio de GitHub* y la *Ruta de instalación*,
   y pulsa **Guardar configuración**.
3. Pulsa **Instalar automatización**. QADash clona el repo, crea el `venv` e
   instala `requirements.txt`. Después, **Actualizar repo** hace `git pull` de la
   rama que indiques.

Al terminar, la tarjeta *Rutas del Proyecto* queda lista para usar esa carpeta.

### Campos de *Rutas del Proyecto*

| Campo | Qué poner |
|---|---|
| Ruta absoluta al proyecto de automatización | Carpeta raíz del proyecto (donde está `pytest.ini` o `conftest.py`) |
| Ruta al archivo .env del proyecto | El `.env` del proyecto. El botón de la lupa lo detecta solo |
| Comando pytest | Ruta al pytest **del venv del proyecto**. Windows: `.\venv\Scripts\pytest.exe`. Linux y macOS: `./venv/bin/pytest` |
| Selenium Grid (URL remota) | Opcional, solo con Docker. Ejemplo: `http://localhost:4444/wd/hub`. Ver la sección siguiente |
| Carpeta de archivos .txt | Opcional. Datos de prueba en texto, para el módulo de datos TXT |
| Carpeta de datos JSON (dataTest) | Opcional. Para el editor de datos JSON |
| Carpeta de imágenes de error | Opcional. Donde tus tests guardan las capturas. Por defecto `reports/errors` dentro del proyecto |

> **El entorno virtual del proyecto tiene que llamarse `venv`**, porque QADash
> siempre usa el pytest de esa carpeta.

Pulsa **Validar ruta** para comprobar que pytest corre ahí y luego **Guardar**.
Después ve a **Dashboard**: ahí se colectan y ejecutan los tests.

### Repo privado

Si el repo de automatización es privado, la URL lleva un token:
`https://<TOKEN>@github.com/tu-org/tu-repo.git`. Ese valor se guarda **en texto
plano** en `profiles/<id>/automation-config.json`. Esa carpeta está en
`.gitignore`, pero no la subas ni la compartas. Usa un token de solo lectura.

## Selenium con Docker (opcional)

Si tus tests corren en un navegador dentro de un contenedor, QADash puede
levantarlo y esperar a que esté sano antes de ejecutar.

Lo que tu proyecto de automatización necesita:

1. Un `docker-compose.yml` (o `compose.yml`) en su carpeta raíz.
2. Un servicio llamado exactamente **`selenium`** (por ejemplo con una imagen
   `selenium/standalone-*`). QADash ejecuta `docker compose up -d --wait selenium`,
   así que conviene que tenga `healthcheck`.
3. Que publique el puerto del grid y, si quieres ver el navegador en vivo, el
   puerto **7900** (noVNC).
4. Que su `conftest.py` use `webdriver.Remote` cuando exista la variable de
   entorno `SELENIUM_REMOTE_URL`. QADash la inyecta con el valor que pusiste en
   *URL de Selenium Grid*; si la dejas vacía, el proyecto debería caer a Chrome
   local.

El comando se ejecuta con el nombre de proyecto `qadash-<id-del-perfil>`, así
que varios perfiles pueden tener su propio grid sin pisarse.

La vista **Docker** del dashboard muestra el navegador en vivo a través del
proxy `/novnc` del backend (puerto 7900). La contraseña de noVNC es `secret`,
que es la que traen por defecto las imágenes `selenium/standalone-*`.

En Windows y macOS necesitas Docker Desktop abierto. En Linux el daemon corre
como servicio, y si ves "permiso denegado" sobre `docker.sock`:

```bash
sudo usermod -aG docker $USER
# cierra sesión, vuelve a entrar y reinicia el backend
```

## Variables de entorno

Todas son opcionales. Se definen al arrancar el backend, por ejemplo
`PORT=4000 npm start` (Linux/macOS) o `$env:PORT=4000; npm start` (PowerShell).

| Variable | Por defecto | Para qué sirve |
|---|---|---|
| `PORT` | `3001` | Puerto del servidor |
| `UPDATE_TOKEN` | (sin valor) | Habilita actualizar el dashboard desde la UI. Sin esta variable, ese endpoint responde 503 |
| `QADASH_DATA_DIR` | la carpeta del backend | Dónde se guardan perfiles, configuración y reportes |
| `QADASH_DIST_DIR` | `../qadash-frontend/dist` | Dónde está el build del frontend |
| `QADASH_FRONTEND_DIR` | `../qadash-frontend` | Repo del frontend, para la auto-actualización |
| `QADASH_NOVNC_HOST` | `127.0.0.1` | Host del noVNC del contenedor Selenium |
| `QADASH_NOVNC_PORT` | `7900` | Puerto del noVNC |

Si cambias el puerto con `PORT`, el proxy de desarrollo del frontend
(`qadash-frontend/vite.config.js`) sigue apuntando a `3001`; ajústalo ahí.

## Seguridad: úsalo en una red de confianza

QADash **ejecuta comandos en la máquina donde corre**: lanza pytest, clona
repos, instala dependencias, edita archivos `.env` y levanta contenedores. El
backend **no tiene autenticación** y tiene CORS abierto.

- No lo expongas a internet sin ponerle delante un proxy con autenticación o una
  VPN.
- `UPDATE_TOKEN` es la única protección propia, y solo cubre el endpoint de
  actualización: ese endpoint ejecuta `git pull` y `npm install`, o sea código
  del repo remoto. Si el dashboard queda expuesto y la variable no está
  definida, nadie puede dispararlo. Define un valor largo y aleatorio.

## Actualizar

Hay dos formas:

- **Desde la UI**: con `UPDATE_TOKEN` definido, la tarjeta *Actualizar QA Dash*
  de Configuración hace `git pull` y `npm install` en los dos repos
  (**Buscar** y luego **Actualizar todo**). Pide el token al pulsar el botón.
  Solo se habilita si hay commits nuevos y los repos no tienen cambios locales.
- **Con cron**: [`scripts/auto-update.sh`](scripts/auto-update.sh) mantiene el
  servidor al día con GitHub. Es un ejemplo pensado para un servidor Linux
  concreto: **revisa y adapta** `BASE`, el `PATH` de Node y el nombre del
  proceso antes de usarlo (las instrucciones de cron están en el encabezado del
  script).

## Tests

```bash
npm test
```

Usa el runner nativo de Node (`node --test`), sin librerías extra. Los archivos
de test viven junto al código que prueban, con el sufijo `.test.js`.

## Problemas comunes

| Síntoma | Causa y solución |
|---|---|
| `[frontend] no hay build en ...` | Falta `npm run build` en el frontend, o los repos no son hermanos. Ver *Puesta en marcha* |
| `EADDRINUSE` al arrancar | El puerto 3001 está ocupado. Usa `PORT=4000 npm start` |
| Pantalla en blanco con `npm run dev` del frontend | El backend no está corriendo en el puerto 3001 |
| *Project path not configured* al ejecutar | Falta la ruta del proyecto en Configuración |
| La colección de tests sale vacía o falla | El comando de pytest apunta a un ejecutable que no existe, o pytest no está instalado en ese `venv`. Usa **Validar** |
| `Python no encontrado` en el instalador | Instala Python y que `python` o `python3` esté en el `PATH` |
| El instalador no encuentra virtualenv | `pip install virtualenv` |
| `Docker no responde` | Abre Docker Desktop, o en Linux revisa `systemctl status docker` y el grupo `docker` |
| Un módulo responde 403 o no aparece en el menú | Ese módulo está apagado en el perfil. Actívalo en Configuración |

## Perfiles

Cada proyecto de automatización es un **perfil** con su propio workspace: su
configuración, sus entornos, sus reportes y sus tests programados. Los perfiles
se pueden crear, renombrar, duplicar y borrar, y varios pueden estar corriendo
tests a la vez sin pisarse.

El frontend manda el header `X-Profile-Id` en cada petición y el middleware
`resolveProfile` traduce ese id a las rutas del perfil, que quedan en
`req.profile`.

En disco:

```
profiles/
├── index.json              lista de perfiles y cuál está activo
└── <id-del-perfil>/
    ├── config.json             rutas del proyecto y comando pytest
    ├── automation-config.json  repo a clonar y dónde instalarlo
    ├── features.json           módulos activos de este perfil
    ├── entornos.json           juegos de variables guardados
    ├── schedules.json          ejecuciones programadas
    ├── data/last-collection.json  caché de la última colección de tests
    └── reports/                un JSON por ejecución
```

Nada de esto se versiona: se crea solo al arrancar el servidor. Si no hay
ningún perfil, se crea "Perfil 1" automáticamente.

Los archivos `config.example.json` y `automation-config.example.json` de la raíz
solo ilustran el formato de esos JSON; **no hace falta copiarlos**, la
configuración se hace desde la interfaz.

## Módulos activables

Cada perfil decide qué partes del dashboard usa. Las rutas de un módulo apagado
responden 403 gracias al middleware `requireFeature`, y el frontend las esconde
del menú.

Los módulos son: `variables`, `reports`, `txtData`, `jsonData`, `errorImages`,
`docker` y `schedules`. Los tests y la configuración están siempre activos.

## Estructura

```
routes/        una ruta de Express por área de la API
middleware/    resolución de perfil, módulos activos, proxy de noVNC, frontend
services/      la lógica de verdad: pytest, docker, perfiles, scheduler, etc.
scripts/       utilidades de operación (auto-update.sh)
server.js      monta todo y arranca el servidor
```

El orden en `server.js` importa: `profileAdmin` y `system` van antes de
`resolveProfile` porque operan sobre los perfiles, no dentro de uno. Y el
fallback que sirve el frontend va al final, porque si no se tragaría `/api`.

## API

Todas las rutas cuelgan de `/api`. Las marcadas con módulo solo responden si ese
módulo está activo en el perfil.

### Configuración y tests

| Método y ruta | Qué hace |
|---|---|
| `GET/POST /config` | Leer y guardar la configuración del perfil |
| `POST /config/validate` | Comprobar que pytest puede correr en esa ruta |
| `GET /config/browse` | Abrir el selector de carpetas/archivos del sistema |
| `GET /config/detect-env` | Buscar el `.env` dentro del proyecto |
| `GET /tests/collect` | Colectar los tests con `pytest --collect-only` |
| `GET /tests/cached` | Devolver la última colección sin volver a correr pytest |
| `POST /tests/run` | Ejecutar los tests seleccionados |
| `GET/POST /features` | Leer y guardar los módulos activos |

### Reportes (módulo `reports`)

| Método y ruta | Qué hace |
|---|---|
| `GET /reports` | Listado de ejecuciones |
| `GET /reports/analytics` | Estadísticas acumuladas |
| `GET /reports/:id` | Un reporte completo |
| `GET /reports/:id/download/json` | Descargar el JSON |
| `GET /reports/:id/download/html` | Descargar el reporte en HTML |
| `DELETE /reports/:id` | Borrar un reporte |

### Variables de entorno (módulo `variables`)

| Método y ruta | Qué hace |
|---|---|
| `GET /env/files` | Archivos `.env` encontrados en el proyecto |
| `GET/POST /env` | Leer y guardar el `.env` |
| `GET /profiles` | Entornos guardados |
| `POST /profiles/:name` | Guardar el `.env` actual como entorno |
| `PATCH /profiles/:name/rename` | Renombrar un entorno |
| `DELETE /profiles/:name` | Borrar un entorno |

### Automatización

| Método y ruta | Qué hace |
|---|---|
| `GET /automation/check` | Verificar Python, Git, virtualenv y Docker |
| `GET/POST /automation/config` | Repo y carpeta de instalación |
| `POST /automation/install` | Clonar, crear el venv e instalar dependencias |
| `POST /automation/update` | `git pull` de la rama indicada |
| `GET /automation/branches` | Ramas del repo remoto |
| `GET /automation/install-status` | Qué falta por instalar |
| `POST /automation/setup-venv` | Solo crear el entorno virtual |
| `POST /automation/setup-deps` | Solo instalar `requirements.txt` |

### Docker (módulo `docker`)

| Método y ruta | Qué hace |
|---|---|
| `GET /docker/check` | Docker instalado y daemon activo |
| `GET /docker/status` | Estado del grid de Selenium |
| `GET /docker/containers` | Contenedores levantados |
| `POST /docker/run` | Levantar el grid |
| `POST /docker/stop` | Pararlo |
| `POST /docker/start-desktop` | Arrancar Docker Desktop (Windows y macOS) |

### Resto

| Método y ruta | Qué hace |
|---|---|
| `GET/POST /schedules`, `PUT/DELETE /schedules/:id` | Ejecuciones programadas (módulo `schedules`) |
| `PATCH /schedules/:id/toggle`, `POST /schedules/:id/run` | Activar y disparar a mano |
| `GET /txtdata` | Contenido de los `.txt` como tabla (módulo `txtData`) |
| `GET /jsondata/tree`, `GET/POST /jsondata/file` | Datos JSON del proyecto (módulo `jsonData`) |
| `GET /jsondata/snapshots`, `POST/DELETE /jsondata/snapshots/:name` | Versiones guardadas de un JSON |
| `GET /errors/images`, `GET /errors/image` | Capturas de los fallos (módulo `errorImages`) |
| `GET /profile-admin`, `POST /profile-admin` | Listar y crear perfiles |
| `PATCH /profile-admin/:id/rename`, `/activate`, `POST /:id/duplicate`, `DELETE /:id` | Gestión de perfiles |
| `GET /system/updates`, `POST /system/update` | Estado y actualización del propio dashboard |

## Eventos de WebSocket

Al conectarse, el cliente manda `profile:join` con el id del perfil que quiere
mirar. El servidor emite a la sala de ese perfil, no en broadcast, para que dos
perfiles corriendo a la vez no se mezclen.

| Evento | Cuándo se emite |
|---|---|
| `execution:started` | Empieza una ejecución |
| `execution:preparing` | Se está levantando el grid de Selenium |
| `execution:prepare-failed` | Falló esa preparación |
| `test:started` | Empieza un test |
| `test:completed` | Termina un test, con su resultado |
| `test:output` | Salida de consola de un test |
| `progress` | Progreso general de la ejecución |
| `execution:completed` | Terminó la ejecución |
| `execution:aborted` | Se canceló |
| `automation:progress` / `automation:log` | Progreso y logs de la instalación |
| `automation:done` / `automation:failed` | Fin de la instalación |
| `automation:update-progress` / `-done` / `-failed` | Lo mismo para el `git pull` |
| `env:progress` / `env:log` | Preparación del entorno virtual |
| `env:venv-done` / `env:deps-done` / `env:failed` | Fin de cada paso del entorno |
| `docker:started` / `docker:log` / `docker:exit` | Contenedores de Docker |
| `schedule:run` / `schedule:log` | Ejecuciones programadas |
| `profiles:status` | Qué perfiles están corriendo tests |
| `system:update` | Progreso de la actualización del dashboard |

## Licencia

MIT.

## Convención de nombres de changes (OpenSpec)

Los changes en este repo siguen la convención: **el nombre del change = la capability principal que introduce** (sustantivo, kebab-case).

| Change | Capability principal | Qué significa |
|---|---|---|
| `playwright-runner` | `playwright-runner` | Es el *runner* que ejecuta Playwright (colección + ejecución + assets). El nombre refleja el **producto** que se entrega: un runner de Playwright. Las 3 capabilities que introduce (`test-collection`, `test-execution`, `run-artifacts`) giran en torno a **correr Playwright**. En OpenSpec el nombre del change suele coincidir con la *capability root* o el tema central del delta. |

> **Regla práctica**: el nombre del change = sustantivo que nombra la capability principal (no verbos como `add-...` ni prefijos `feat-`). Sirve como clave de búsqueda en `openspec list`.
