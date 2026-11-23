const PORT = process.env.PORT || 3001;

const spec = {
  openapi: '3.0.3',
  info: {
    title: 'RunLab Agrimpex API',
    version: '1.0.0',
    description:
      'API REST del backend RunLab Agrimpex (QA Dashboard). ' +
      'Las rutas bajo `/api` (excepto `/api/profile-admin` y `/api/system`) se resuelven por perfil mediante el header `X-Profile-Id`; si no se envía, se usa el perfil activo. ' +
      'Algunos módulos pueden responder 403 cuando la feature correspondiente está deshabilitada para el perfil. ' +
      'Los eventos en tiempo real se transmiten por Socket.io (sala `profile:<id>`), fuera de este spec REST.',
  },
  servers: [{ url: `http://localhost:${PORT}`, description: 'Servidor local' }],
  tags: [
    { name: 'Profile Admin', description: 'Gestión global de perfiles (no requiere X-Profile-Id)' },
    { name: 'System', description: 'Actualización del dashboard/repos (no requiere X-Profile-Id)' },
    { name: 'Config', description: 'Configuración del perfil/proyecto' },
    { name: 'Features', description: 'Feature flags por perfil' },
    { name: 'Tests', description: 'Catálogo y ejecución de tests Playwright' },
    { name: 'Env', description: 'Archivos .env y variables del proyecto' },
    { name: 'Entornos', description: 'Entornos guardados por perfil (/api/profiles)' },
    { name: 'Reports', description: 'Reportes y analítica de ejecuciones' },
    { name: 'Automation', description: 'Configuración y tareas de automatización/instalación' },
    { name: 'Schedules', description: 'Calendarización de ejecuciones' },
    { name: 'Docker', description: 'Operaciones Docker/Selenium grid' },
    { name: 'TxtData', description: 'Datos TXT del perfil/proyecto' },
    { name: 'JsonData', description: 'Datos JSON y snapshots' },
    { name: 'Errors', description: 'Imágenes/artefactos de errores' },
  ],
  components: {
    securitySchemes: {
      ProfileId: {
        type: 'apiKey',
        in: 'header',
        name: 'X-Profile-Id',
        description:
          'ID del perfil a operar (p. ej. "perfil-1"). Opcional: si se omite, resolveProfile usa el perfil activo.',
      },
    },
    parameters: {
      ProfileIdHeader: {
        name: 'X-Profile-Id',
        in: 'header',
        required: false,
        schema: { type: 'string' },
        description: 'ID del perfil. Si se omite, se usa el perfil activo.',
      },
      ProfileIdPath: {
        name: 'id',
        in: 'path',
        required: true,
        schema: { type: 'string' },
        description: 'ID del perfil',
      },
      EntornoNamePath: {
        name: 'name',
        in: 'path',
        required: true,
        schema: { type: 'string' },
        description: 'Nombre del entorno guardado',
      },
      ReportIdPath: {
        name: 'id',
        in: 'path',
        required: true,
        schema: { type: 'string' },
        description: 'ID del reporte/ejecución',
      },
      ScheduleIdPath: {
        name: 'id',
        in: 'path',
        required: true,
        schema: { type: 'string' },
        description: 'ID del schedule',
      },
    },
    schemas: {
      Error: {
        type: 'object',
        properties: {
          error: { type: 'string' },
          message: { type: 'string' },
          raw: { type: 'string' },
        },
      },
      Success: {
        type: 'object',
        properties: {
          success: { type: 'boolean' },
          message: { type: 'string' },
        },
      },
      Profile: {
        type: 'object',
        properties: {
          id: { type: 'string' },
          name: { type: 'string' },
          createdAt: { type: 'string' },
        },
        additionalProperties: true,
      },
      Config: {
        type: 'object',
        properties: {
          projectPath: { type: 'string' },
          envPath: { type: 'string' },
          playwrightCmd: { type: 'string' },
          pytestCmd: { type: 'string' },
          txtFolderPath: { type: 'string' },
          seleniumRemoteUrl: { type: 'string' },
          errorImagesPath: { type: 'string' },
          jsonDataPath: { type: 'string' },
          projectFeatures: {
            type: 'object',
            properties: {
              mcp: {
                type: 'object',
                properties: {
                  detected: { type: 'boolean' },
                  signals: { type: 'array', items: { type: 'string' } },
                },
              },
            },
            additionalProperties: true,
          },
        },
        additionalProperties: true,
      },
      TestCollection: {
        type: 'object',
        properties: {
          timestamp: { type: 'string', nullable: true },
          files: { type: 'object', additionalProperties: { type: 'array', items: { type: 'string' } } },
          total: { type: 'integer' },
          projects: { type: 'array', items: { type: 'string' } },
          errorFiles: { type: 'array', items: { type: 'object' } },
        },
      },
    },
  },
  security: [{ ProfileId: [] }],
  paths: {
    '/api/profile-admin': {
      get: {
        tags: ['Profile Admin'],
        summary: 'Listar perfiles y perfil activo',
        security: [],
        responses: {
          200: {
            description: 'Perfiles disponibles',
            content: {
              'application/json': {
                schema: {
                  type: 'object',
                  properties: {
                    activeProfileId: { type: 'string' },
                    profiles: { type: 'array', items: { $ref: '#/components/schemas/Profile' } },
                  },
                },
              },
            },
          },
        },
      },
      post: {
        tags: ['Profile Admin'],
        summary: 'Crear perfil',
        security: [],
        requestBody: {
          required: true,
          content: {
            'application/json': {
              schema: {
                type: 'object',
                required: ['name'],
                properties: { name: { type: 'string' } },
              },
            },
          },
        },
        responses: {
          200: { description: 'Perfil creado', content: { 'application/json': { schema: { $ref: '#/components/schemas/Profile' } } } },
          400: { description: 'Solicitud inválida', content: { 'application/json': { schema: { $ref: '#/components/schemas/Error' } } } },
        },
      },
    },
    '/api/profile-admin/{id}/rename': {
      patch: {
        tags: ['Profile Admin'],
        summary: 'Renombrar perfil',
        security: [],
        parameters: [{ $ref: '#/components/parameters/ProfileIdPath' }],
        requestBody: {
          required: true,
          content: {
            'application/json': {
              schema: { type: 'object', required: ['name'], properties: { name: { type: 'string' } } },
            },
          },
        },
        responses: { 200: { description: 'OK' }, 400: { description: 'Error' } },
      },
    },
    '/api/profile-admin/{id}/duplicate': {
      post: {
        tags: ['Profile Admin'],
        summary: 'Duplicar perfil',
        security: [],
        parameters: [{ $ref: '#/components/parameters/ProfileIdPath' }],
        requestBody: {
          required: true,
          content: {
            'application/json': {
              schema: { type: 'object', required: ['name'], properties: { name: { type: 'string' } } },
            },
          },
        },
        responses: { 200: { description: 'Perfil duplicado' }, 400: { description: 'Error' } },
      },
    },
    '/api/profile-admin/{id}/activate': {
      patch: {
        tags: ['Profile Admin'],
        summary: 'Activar perfil',
        security: [],
        parameters: [{ $ref: '#/components/parameters/ProfileIdPath' }],
        responses: { 200: { description: 'Perfil activado' }, 404: { description: 'No encontrado' } },
      },
    },
    '/api/profile-admin/{id}': {
      delete: {
        tags: ['Profile Admin'],
        summary: 'Eliminar perfil',
        security: [],
        parameters: [{ $ref: '#/components/parameters/ProfileIdPath' }],
        responses: { 200: { description: 'Eliminado' }, 409: { description: 'Conflicto (último perfil o en ejecución)' } },
      },
    },

    '/api/system/updates': {
      get: {
        tags: ['System'],
        summary: 'Consultar actualizaciones disponibles',
        security: [],
        responses: { 200: { description: 'Estado de actualizaciones' } },
      },
    },
    '/api/system/update': {
      post: {
        tags: ['System'],
        summary: 'Ejecutar actualización del sistema/repos',
        security: [],
        responses: { 200: { description: 'Resultado de actualización' }, 401: { description: 'No autorizado (token)' } },
      },
    },

    '/api/config': {
      get: {
        tags: ['Config'],
        summary: 'Obtener configuración del perfil',
        parameters: [{ $ref: '#/components/parameters/ProfileIdHeader' }],
        responses: {
          200: { description: 'Configuración', content: { 'application/json': { schema: { $ref: '#/components/schemas/Config' } } } },
        },
      },
      post: {
        tags: ['Config'],
        summary: 'Guardar configuración del perfil',
        parameters: [{ $ref: '#/components/parameters/ProfileIdHeader' }],
        requestBody: {
          required: true,
          content: { 'application/json': { schema: { $ref: '#/components/schemas/Config' } } },
        },
        responses: { 200: { description: 'Configuración guardada' }, 400: { description: 'Error de validación' } },
      },
    },
    '/api/config/validate': {
      post: {
        tags: ['Config'],
        summary: 'Validar rutas/configuración del proyecto',
        parameters: [{ $ref: '#/components/parameters/ProfileIdHeader' }],
        responses: { 200: { description: 'Resultado de validación' } },
      },
    },
    '/api/config/browse': {
      get: {
        tags: ['Config'],
        summary: 'Abrir diálogo nativo para seleccionar carpeta/archivo',
        parameters: [
          { $ref: '#/components/parameters/ProfileIdHeader' },
          { name: 'type', in: 'query', schema: { type: 'string', enum: ['folder', 'file'] } },
          { name: 'path', in: 'query', schema: { type: 'string' }, description: 'Ruta inicial sugerida' },
        ],
        responses: { 200: { description: 'Ruta seleccionada o cancelación' } },
      },
    },
    '/api/config/detect-env': {
      get: {
        tags: ['Config'],
        summary: 'Detectar archivo .env en el proyecto configurado',
        parameters: [{ $ref: '#/components/parameters/ProfileIdHeader' }],
        responses: { 200: { description: 'Resultado de detección' } },
      },
    },

    '/api/features': {
      get: {
        tags: ['Features'],
        summary: 'Obtener feature flags del perfil',
        parameters: [{ $ref: '#/components/parameters/ProfileIdHeader' }],
        responses: { 200: { description: 'Features del perfil' } },
      },
      post: {
        tags: ['Features'],
        summary: 'Actualizar feature flags del perfil',
        parameters: [{ $ref: '#/components/parameters/ProfileIdHeader' }],
        requestBody: { required: true, content: { 'application/json': { schema: { type: 'object', additionalProperties: true } } } },
        responses: { 200: { description: 'Features actualizadas' } },
      },
    },

    '/api/tests/cached': {
      get: {
        tags: ['Tests'],
        summary: 'Obtener catálogo cacheado (memoria/disco)',
        parameters: [{ $ref: '#/components/parameters/ProfileIdHeader' }],
        responses: {
          200: { description: 'Catálogo', content: { 'application/json': { schema: { $ref: '#/components/schemas/TestCollection' } } } },
        },
      },
    },
    '/api/tests/collect': {
      get: {
        tags: ['Tests'],
        summary: 'Recolectar catálogo de tests con Playwright (--list)',
        parameters: [{ $ref: '#/components/parameters/ProfileIdHeader' }],
        responses: {
          200: { description: 'Catálogo actualizado', content: { 'application/json': { schema: { $ref: '#/components/schemas/TestCollection' } } } },
          400: { description: 'Proyecto no configurado' },
          500: { description: 'Error de colección' },
        },
      },
    },
    '/api/tests/run': {
      post: {
        tags: ['Tests'],
        summary: 'Iniciar ejecución de tests',
        parameters: [{ $ref: '#/components/parameters/ProfileIdHeader' }],
        requestBody: {
          required: true,
          content: {
            'application/json': {
              schema: {
                type: 'object',
                required: ['testIds'],
                properties: {
                  testIds: { type: 'array', items: { type: 'string' } },
                  profileName: { type: 'string', description: 'Nombre de entorno guardado (entornos.json)' },
                  envFile: { type: 'string', description: 'Archivo .env relativo al proyecto' },
                  useDocker: { type: 'boolean' },
                  params: { type: 'object', additionalProperties: { type: 'string' } },
                  paramsByTest: { type: 'object', additionalProperties: { type: 'object', additionalProperties: { type: 'string' } } },
                  project: { type: 'string', description: 'Playwright project' },
                  grep: { type: 'string' },
                  workers: { oneOf: [{ type: 'integer' }, { type: 'string' }] },
                },
              },
            },
          },
        },
        responses: {
          200: { description: 'Ejecución iniciada' },
          400: { description: 'Solicitud inválida' },
          409: { description: 'Ya hay una ejecución en curso' },
          500: { description: 'Error al iniciar' },
        },
      },
    },
    '/api/tests/abort': {
      post: {
        tags: ['Tests'],
        summary: 'Abortar ejecución en curso',
        parameters: [{ $ref: '#/components/parameters/ProfileIdHeader' }],
        responses: { 200: { description: 'Abort solicitado' } },
      },
    },
    '/api/tests/status': {
      get: {
        tags: ['Tests'],
        summary: 'Estado de ejecución del perfil',
        parameters: [{ $ref: '#/components/parameters/ProfileIdHeader' }],
        responses: {
          200: { description: 'Estado', content: { 'application/json': { schema: { type: 'object', properties: { running: { type: 'boolean' } } } } } },
        },
      },
    },
    '/api/tests/file': {
      get: {
        tags: ['Tests'],
        summary: 'Leer archivo del proyecto configurado',
        parameters: [
          { $ref: '#/components/parameters/ProfileIdHeader' },
          { name: 'name', in: 'query', required: true, schema: { type: 'string' }, description: 'Ruta relativa al projectPath' },
        ],
        responses: { 200: { description: 'Contenido del archivo' }, 400: { description: 'Solicitud inválida' }, 403: { description: 'Acceso denegado' }, 404: { description: 'No encontrado' } },
      },
      post: {
        tags: ['Tests'],
        summary: 'Guardar contenido de archivo del proyecto',
        parameters: [{ $ref: '#/components/parameters/ProfileIdHeader' }],
        requestBody: {
          required: true,
          content: {
            'application/json': {
              schema: {
                type: 'object',
                required: ['name', 'content'],
                properties: { name: { type: 'string' }, content: { type: 'string' } },
              },
            },
          },
        },
        responses: { 200: { description: 'Archivo guardado' }, 400: { description: 'Solicitud inválida' }, 403: { description: 'Acceso denegado' }, 404: { description: 'No encontrado' } },
      },
    },

    '/api/env/files': {
      get: { tags: ['Env'], summary: 'Listar archivos .env del proyecto', parameters: [{ $ref: '#/components/parameters/ProfileIdHeader' }], responses: { 200: { description: 'Lista de archivos' } } },
    },
    '/api/env': {
      get: {
        tags: ['Env'],
        summary: 'Leer variables de un archivo .env',
        parameters: [
          { $ref: '#/components/parameters/ProfileIdHeader' },
          { name: 'file', in: 'query', schema: { type: 'string' }, description: 'Nombre/ruta de archivo .env (según implementación)' },
        ],
        responses: { 200: { description: 'Variables' } },
      },
      post: {
        tags: ['Env'],
        summary: 'Guardar variables en un archivo .env',
        parameters: [{ $ref: '#/components/parameters/ProfileIdHeader' }],
        requestBody: { required: true, content: { 'application/json': { schema: { type: 'object', additionalProperties: true } } } },
        responses: { 200: { description: 'Guardado' } },
      },
    },

    '/api/profiles': {
      get: { tags: ['Entornos'], summary: 'Listar entornos guardados del perfil', parameters: [{ $ref: '#/components/parameters/ProfileIdHeader' }], responses: { 200: { description: 'Entornos' } } },
    },
    '/api/profiles/{name}': {
      post: {
        tags: ['Entornos'],
        summary: 'Crear/guardar entorno',
        parameters: [{ $ref: '#/components/parameters/ProfileIdHeader' }, { $ref: '#/components/parameters/EntornoNamePath' }],
        requestBody: { content: { 'application/json': { schema: { type: 'object', additionalProperties: true } } } },
        responses: { 200: { description: 'Guardado' } },
      },
      delete: {
        tags: ['Entornos'],
        summary: 'Eliminar entorno',
        parameters: [{ $ref: '#/components/parameters/ProfileIdHeader' }, { $ref: '#/components/parameters/EntornoNamePath' }],
        responses: { 200: { description: 'Eliminado' } },
      },
    },
    '/api/profiles/{name}/rename': {
      patch: {
        tags: ['Entornos'],
        summary: 'Renombrar entorno',
        parameters: [{ $ref: '#/components/parameters/ProfileIdHeader' }, { $ref: '#/components/parameters/EntornoNamePath' }],
        requestBody: { content: { 'application/json': { schema: { type: 'object', properties: { newName: { type: 'string' }, name: { type: 'string' } }, additionalProperties: true } } } },
        responses: { 200: { description: 'Renombrado' } },
      },
    },

    '/api/reports': {
      get: { tags: ['Reports'], summary: 'Listar reportes del perfil', parameters: [{ $ref: '#/components/parameters/ProfileIdHeader' }], responses: { 200: { description: 'Lista de reportes' } } },
    },
    '/api/reports/analytics': {
      get: { tags: ['Reports'], summary: 'Obtener analítica agregada de reportes', parameters: [{ $ref: '#/components/parameters/ProfileIdHeader' }], responses: { 200: { description: 'Analítica' } } },
    },
    '/api/reports/analytics/export': {
      get: { tags: ['Reports'], summary: 'Exportar payload normalizado de analítica para PDF', parameters: [{ $ref: '#/components/parameters/ProfileIdHeader' }], responses: { 200: { description: 'Payload de exportación analítica' } } },
    },
    '/api/reports/{id}': {
      get: { tags: ['Reports'], summary: 'Obtener detalle de un reporte', parameters: [{ $ref: '#/components/parameters/ProfileIdHeader' }, { $ref: '#/components/parameters/ReportIdPath' }], responses: { 200: { description: 'Reporte' }, 404: { description: 'No encontrado' } } },
      delete: { tags: ['Reports'], summary: 'Eliminar reporte', parameters: [{ $ref: '#/components/parameters/ProfileIdHeader' }, { $ref: '#/components/parameters/ReportIdPath' }], responses: { 200: { description: 'Eliminado' } } },
    },
    '/api/reports/{id}/export': {
      get: { tags: ['Reports'], summary: 'Exportar payload normalizado de corrida para PDF', parameters: [{ $ref: '#/components/parameters/ProfileIdHeader' }, { $ref: '#/components/parameters/ReportIdPath' }], responses: { 200: { description: 'Payload de exportación de corrida' }, 404: { description: 'No encontrado' } } },
    },
    '/api/reports/{id}/download/json': {
      get: { tags: ['Reports'], summary: 'Descargar reporte en JSON', parameters: [{ $ref: '#/components/parameters/ProfileIdHeader' }, { $ref: '#/components/parameters/ReportIdPath' }], responses: { 200: { description: 'Archivo JSON' } } },
    },
    '/api/reports/{id}/download/html': {
      get: { tags: ['Reports'], summary: 'Descargar/exportar reporte en HTML', parameters: [{ $ref: '#/components/parameters/ProfileIdHeader' }, { $ref: '#/components/parameters/ReportIdPath' }], responses: { 200: { description: 'Archivo/HTML' } } },
    },

    '/api/automation/config': {
      get: { tags: ['Automation'], summary: 'Obtener configuración de automatización', parameters: [{ $ref: '#/components/parameters/ProfileIdHeader' }], responses: { 200: { description: 'Configuración' } } },
      post: { tags: ['Automation'], summary: 'Guardar configuración de automatización', parameters: [{ $ref: '#/components/parameters/ProfileIdHeader' }], requestBody: { required: true, content: { 'application/json': { schema: { type: 'object', additionalProperties: true } } } }, responses: { 200: { description: 'Guardado' } } },
    },
    '/api/automation/check': {
      get: { tags: ['Automation'], summary: 'Comprobar herramientas/estado de automatización', parameters: [{ $ref: '#/components/parameters/ProfileIdHeader' }], responses: { 200: { description: 'Resultado de chequeos' } } },
    },
    '/api/automation/status': {
      get: { tags: ['Automation'], summary: 'Estado de operaciones de automatización', parameters: [{ $ref: '#/components/parameters/ProfileIdHeader' }], responses: { 200: { description: 'Estado' } } },
    },
    '/api/automation/install': {
      post: { tags: ['Automation'], summary: 'Instalar dependencias/entorno de automatización', parameters: [{ $ref: '#/components/parameters/ProfileIdHeader' }], requestBody: { content: { 'application/json': { schema: { type: 'object', additionalProperties: true } } } }, responses: { 200: { description: 'Operación iniciada/resultado' } } },
    },
    '/api/automation/update': {
      post: { tags: ['Automation'], summary: 'Actualizar repositorio/proyecto de automatización', parameters: [{ $ref: '#/components/parameters/ProfileIdHeader' }], requestBody: { content: { 'application/json': { schema: { type: 'object', additionalProperties: true } } } }, responses: { 200: { description: 'Operación iniciada/resultado' } } },
    },
    '/api/automation/branches': {
      get: { tags: ['Automation'], summary: 'Listar ramas del repositorio configurado', parameters: [{ $ref: '#/components/parameters/ProfileIdHeader' }], responses: { 200: { description: 'Ramas' } } },
    },

    '/api/schedules': {
      get: { tags: ['Schedules'], summary: 'Listar schedules del perfil', parameters: [{ $ref: '#/components/parameters/ProfileIdHeader' }], responses: { 200: { description: 'Schedules' } } },
      post: { tags: ['Schedules'], summary: 'Crear schedule', parameters: [{ $ref: '#/components/parameters/ProfileIdHeader' }], requestBody: { required: true, content: { 'application/json': { schema: { type: 'object', additionalProperties: true } } } }, responses: { 200: { description: 'Creado' } } },
    },
    '/api/schedules/{id}': {
      put: { tags: ['Schedules'], summary: 'Actualizar schedule', parameters: [{ $ref: '#/components/parameters/ProfileIdHeader' }, { $ref: '#/components/parameters/ScheduleIdPath' }], requestBody: { required: true, content: { 'application/json': { schema: { type: 'object', additionalProperties: true } } } }, responses: { 200: { description: 'Actualizado' } } },
      delete: { tags: ['Schedules'], summary: 'Eliminar schedule', parameters: [{ $ref: '#/components/parameters/ProfileIdHeader' }, { $ref: '#/components/parameters/ScheduleIdPath' }], responses: { 200: { description: 'Eliminado' } } },
    },
    '/api/schedules/{id}/toggle': {
      patch: { tags: ['Schedules'], summary: 'Activar/desactivar schedule', parameters: [{ $ref: '#/components/parameters/ProfileIdHeader' }, { $ref: '#/components/parameters/ScheduleIdPath' }], responses: { 200: { description: 'Actualizado' } } },
    },
    '/api/schedules/{id}/run': {
      post: { tags: ['Schedules'], summary: 'Ejecutar schedule manualmente', parameters: [{ $ref: '#/components/parameters/ProfileIdHeader' }, { $ref: '#/components/parameters/ScheduleIdPath' }], responses: { 200: { description: 'Ejecución disparada' } } },
    },

    '/api/docker/check': {
      get: { tags: ['Docker'], summary: 'Comprobar disponibilidad de Docker', parameters: [{ $ref: '#/components/parameters/ProfileIdHeader' }], responses: { 200: { description: 'Estado Docker' } } },
    },
    '/api/docker/status': {
      get: { tags: ['Docker'], summary: 'Estado del entorno/grid Docker', parameters: [{ $ref: '#/components/parameters/ProfileIdHeader' }], responses: { 200: { description: 'Estado' } } },
    },
    '/api/docker/containers': {
      get: { tags: ['Docker'], summary: 'Listar contenedores', parameters: [{ $ref: '#/components/parameters/ProfileIdHeader' }], responses: { 200: { description: 'Contenedores' } } },
    },
    '/api/docker/run': {
      post: { tags: ['Docker'], summary: 'Iniciar/ejecutar entorno Docker', parameters: [{ $ref: '#/components/parameters/ProfileIdHeader' }], requestBody: { content: { 'application/json': { schema: { type: 'object', additionalProperties: true } } } }, responses: { 200: { description: 'Resultado' } } },
    },
    '/api/docker/stop': {
      post: { tags: ['Docker'], summary: 'Detener entorno Docker', parameters: [{ $ref: '#/components/parameters/ProfileIdHeader' }], requestBody: { content: { 'application/json': { schema: { type: 'object', additionalProperties: true } } } }, responses: { 200: { description: 'Resultado' } } },
    },

    '/api/txtdata': {
      get: { tags: ['TxtData'], summary: 'Obtener datos TXT', parameters: [{ $ref: '#/components/parameters/ProfileIdHeader' }], responses: { 200: { description: 'Datos' } } },
    },

    '/api/jsondata/tree': {
      get: { tags: ['JsonData'], summary: 'Obtener árbol de datos JSON', parameters: [{ $ref: '#/components/parameters/ProfileIdHeader' }], responses: { 200: { description: 'Árbol' } } },
    },
    '/api/jsondata/file': {
      get: { tags: ['JsonData'], summary: 'Leer archivo JSON de datos', parameters: [{ $ref: '#/components/parameters/ProfileIdHeader' }, { name: 'path', in: 'query', schema: { type: 'string' } }], responses: { 200: { description: 'Contenido' } } },
      post: { tags: ['JsonData'], summary: 'Guardar archivo JSON de datos', parameters: [{ $ref: '#/components/parameters/ProfileIdHeader' }], requestBody: { required: true, content: { 'application/json': { schema: { type: 'object', additionalProperties: true } } } }, responses: { 200: { description: 'Guardado' } } },
    },
    '/api/jsondata/snapshots': {
      get: { tags: ['JsonData'], summary: 'Listar snapshots', parameters: [{ $ref: '#/components/parameters/ProfileIdHeader' }], responses: { 200: { description: 'Snapshots' } } },
    },
    '/api/jsondata/snapshots/{name}': {
      post: { tags: ['JsonData'], summary: 'Crear snapshot', parameters: [{ $ref: '#/components/parameters/ProfileIdHeader' }, { $ref: '#/components/parameters/EntornoNamePath' }], responses: { 200: { description: 'Creado' } } },
      delete: { tags: ['JsonData'], summary: 'Eliminar snapshot', parameters: [{ $ref: '#/components/parameters/ProfileIdHeader' }, { $ref: '#/components/parameters/EntornoNamePath' }], responses: { 200: { description: 'Eliminado' } } },
    },

    '/api/errors/images': {
      get: { tags: ['Errors'], summary: 'Listar imágenes de error', parameters: [{ $ref: '#/components/parameters/ProfileIdHeader' }], responses: { 200: { description: 'Imágenes' } } },
    },
    '/api/errors/image': {
      get: { tags: ['Errors'], summary: 'Obtener imagen de error', parameters: [{ $ref: '#/components/parameters/ProfileIdHeader' }, { name: 'path', in: 'query', schema: { type: 'string' } }], responses: { 200: { description: 'Imagen/binario' }, 404: { description: 'No encontrada' } } },
    },
  },
};

module.exports = spec;
