# Diseño final y plan por fases — Deportes Medina Sidonia (de prototipo a producción segura)

## 1. Resumen ejecutivo

Hoy toda la autenticación, los roles y la lógica de negocio viven en el navegador y el servidor es un "disco compartido" (`GET /api/estado` devuelve hashes, UIDs y semillas QR de todos; `PUT /api/estado/:clave` acepta cualquier cosa; `POST /api/reiniciar` borra la base sin auth). El cambio es de arquitectura, no de retoque: **el servidor pasa a ser la única fuente de verdad** (MariaDB relacional con migraciones, transacciones y UNIQUEs que garantizan la atomicidad), **la autenticación se hace en servidor** (scrypt nativo, sesiones en BD con cookie HttpOnly, verificación de email y recuperación por el SMTP de Plesk), **cada endpoint comprueba el rol** y devuelve solo lo suyo (el hash y la `qr_seed` jamás salen al navegador), y el **front se convierte en vistas que piden datos** a una API JSON (sin `localStorage` de datos ajenos, sin modo demo, sin siembra). El **torno** sigue validando offline con su caché, pero se autentica con un token de servicio y baja solo lo que necesita de `GET /api/torno/socios`; el **QR dinámico se genera en servidor** con el mismo módulo `lib/token.js` que valida la Pi (paridad bit a bit, vector de prueba fijo). Regla nueva: **pistas online; clases y gimnasio solo presenciales** (el vecino consulta). Cero dependencias nuevas: se queda `mysql2` y todo lo demás es Node nativo (`crypto.scrypt`, `net/tls` para SMTP, SSE, router propio). El plan va en 8 fases verticales; cada una se despliega en Plesk con el sistema funcionando y el torno se cambia en un solo paso controlado (F3).

### Decisiones de arbitraje (donde los cinco análisis discrepaban)

| Tema | Decisión | Por qué |
|---|---|---|
| Hash de contraseña | `crypto.scrypt` N=2^15, r=8, p=3, keylen 32, sal 16 B, `maxmem` 64 MiB explícito; formato con parámetros para rehash | Medido ≈150 ms / 32 MiB, OWASP-equivalente; sin módulos nativos (bcrypt/argon2 son frágiles en Plesk) |
| Cookie | `__Host-msd_sid` en HTTPS (`msd_sid` en dev http); HttpOnly; Secure; SameSite=Lax; Path=/ | Lax no rompe el enlace del correo; `__Host-` evita cookies plantadas desde otros subdominios de *.plesk.page |
| CSRF | Sin token sincronizador: cabecera obligatoria `X-Requested-With: MSD` + comprobación de `Origin`/`Sec-Fetch-Site` + solo `application/json` + SameSite=Lax | Más simple y suficiente: el servidor nunca emite CORS, así que un tercero no puede poner la cabecera |
| Token del torno | Variable de entorno `MSD_TOKEN_TORNO` (lista `nombre:token,...`), comparación por SHA-256 + `timingSafeEqual`; sin tabla `dispositivos` | Un torno hoy; rotación = añadir segundo token, cambiar la Pi, quitar el viejo |
| Rate limit | En memoria (1 instancia) + bloqueo por cuenta persistido en `usuarios.bloqueado_hasta` | Sobrevive a reinicios de Passenger sin tabla `intentos_login` |
| Cuenta sin verificar | No puede iniciar sesión (403 `email_no_verificado`); el admin puede verificar a mano | Más claro que "entra pero no puede hacer nada" |
| Lote de QR | `GET /api/mi/qr` devuelve 20 ventanas (10 min); el front repide cuando quedan 3 | Cubre mala cobertura en la puerta sin recrear una semilla de larga duración |
| Monitor↔clase | Columna `clases.monitor_usuario_id` (un monitor por clase) | Es lo que hay hoy; sin tabla N:M |
| Tarifas | Columnas `precio`/`suplemento_luz` en `instalaciones`, `precio_mes` en `clases`, `abono_precio_mes` en `ajustes`; la reserva guarda su precio | Sin tabla de vigencias; el histórico lo da la reserva |
| Borrado de usuario | Soft-delete anonimizado; sesiones/tokens en cascada; accesos conservan la fila con `usuario_id` NULL | No perder auditoría (RGPD: minimización, no destrucción) |
| Abono del vecino | Solo consulta (alta/renovación/baja/autorrenovar en el panel) | El pago es presencial; coherente con clases/gimnasio |
| Eventos de la cola offline | `evento_uid` UNIQUE generado en la Pi; el servidor responde 200 si ya existe; `usuario_id` se re-resuelve por `raw` y queda NULL si no casa (nunca 400 ni 500) | Idempotencia sin mensajes envenenados |
| Fechas | `DATE` = día de Europe/Madrid calculado en Node; `DATETIME(3)` = UTC; pool con `timezone:'Z'`, `dateStrings:['DATE']` y `SET time_zone='+00:00'` al conectar | DATE llega como `'YYYY-MM-DD'` (lo que compara el torno), DATETIME como `Date` |
| Datos demo | No se importan; `DELETE FROM estado` en F2 (con dump previo), `DROP TABLE estado` en F7 | Decidido con el usuario |

---

## 2. Esquema de BD final (MariaDB 11.8, InnoDB, utf8mb4_unicode_ci)

Principios: PK `BIGINT UNSIGNED AUTO_INCREMENT` internas; `legacy_id` solo como referencia (no se importa nada); secretos siempre hasheados (contraseña scrypt, cookie y tokens de correo como SHA-256); la `qr_seed` es el único secreto en claro y vive en `carnets`, tabla que la web nunca selecciona salvo para `/api/mi/qr` y `/api/torno/socios`; borrado lógico donde hay histórico; todo en transacción. Fichero: `migraciones/001_esquema.sql`.

```sql
-- ============================================================
-- 001_esquema.sql — esquema relacional completo
-- ============================================================
SET NAMES utf8mb4;
SET time_zone = '+00:00';

CREATE TABLE migraciones (
  version     SMALLINT UNSIGNED NOT NULL PRIMARY KEY,
  nombre      VARCHAR(120) NOT NULL,
  aplicada_en DATETIME(3) NOT NULL DEFAULT CURRENT_TIMESTAMP(3)
) ENGINE=InnoDB DEFAULT CHARSET=utf8mb4 COLLATE=utf8mb4_unicode_ci;

-- ---------- USUARIOS Y AUTENTICACIÓN ----------
CREATE TABLE usuarios (
  id                  BIGINT UNSIGNED NOT NULL AUTO_INCREMENT PRIMARY KEY,
  legacy_id           VARCHAR(24) NULL,                 -- 'u-xxxxxxxx' del blob (referencia)
  email               VARCHAR(254) NOT NULL,            -- normalizado: trim + minúsculas
  email_verificado_en DATETIME(3) NULL,                 -- NULL => no puede iniciar sesión
  nombre              VARCHAR(120) NOT NULL,
  telefono            VARCHAR(20) NOT NULL DEFAULT '',
  fecha_nacimiento    DATE NULL,                        -- hoy birthdate; edad mínima 16 en el torno
  rol                 ENUM('vecino','monitor','admin') NOT NULL DEFAULT 'vecino',
  clave_hash          VARCHAR(255) NOT NULL,            -- 'scrypt$15$8$3$<sal b64url>$<hash b64url>'
  clave_cambiada_en   DATETIME(3) NULL,
  debe_cambiar_clave  TINYINT(1) NOT NULL DEFAULT 0,    -- 1 tras bootstrap o clave temporal del admin
  fallos_login        TINYINT UNSIGNED NOT NULL DEFAULT 0,
  bloqueado_hasta     DATETIME(3) NULL,                 -- bloqueo temporal tras N fallos (persistente)
  ultimo_login_en     DATETIME(3) NULL,
  acepta_normas_en    DATETIME(3) NULL,                 -- consentimiento del registro
  creado_en           DATETIME(3) NOT NULL DEFAULT CURRENT_TIMESTAMP(3),
  actualizado_en      DATETIME(3) NOT NULL DEFAULT CURRENT_TIMESTAMP(3) ON UPDATE CURRENT_TIMESTAMP(3),
  eliminado_en        DATETIME(3) NULL,                 -- soft-delete: se anonimiza (email 'borrado-<id>@eliminado.local')
  UNIQUE KEY uq_usuarios_email (email),
  UNIQUE KEY uq_usuarios_legacy (legacy_id),
  KEY ix_usuarios_rol (rol, eliminado_en)
) ENGINE=InnoDB DEFAULT CHARSET=utf8mb4 COLLATE=utf8mb4_unicode_ci;

CREATE TABLE sesiones (
  id             CHAR(64) NOT NULL PRIMARY KEY,         -- SHA-256 hex del id que viaja en la cookie
  usuario_id     BIGINT UNSIGNED NOT NULL,
  creada_en      DATETIME(3) NOT NULL DEFAULT CURRENT_TIMESTAMP(3),
  ultimo_uso_en  DATETIME(3) NOT NULL DEFAULT CURRENT_TIMESTAMP(3),   -- se actualiza como mucho cada 5 min
  expira_en      DATETIME(3) NOT NULL,                  -- min(creada+absoluto, ultimo_uso+inactividad)
  ip             VARCHAR(45) NULL,
  user_agent     VARCHAR(255) NULL,
  KEY ix_sesiones_usuario (usuario_id),
  KEY ix_sesiones_expira (expira_en),
  CONSTRAINT fk_sesiones_usuario FOREIGN KEY (usuario_id) REFERENCES usuarios(id) ON DELETE CASCADE
) ENGINE=InnoDB DEFAULT CHARSET=utf8mb4 COLLATE=utf8mb4_unicode_ci;

CREATE TABLE tokens_correo (
  id            BIGINT UNSIGNED NOT NULL AUTO_INCREMENT PRIMARY KEY,
  usuario_id    BIGINT UNSIGNED NOT NULL,
  tipo          ENUM('verificar_email','recuperar_clave','invitacion','cambiar_email') NOT NULL,
  token_hash    CHAR(64) NOT NULL,                      -- SHA-256 del token (32 B base64url) del enlace
  email_destino VARCHAR(254) NOT NULL,
  creado_en     DATETIME(3) NOT NULL DEFAULT CURRENT_TIMESTAMP(3),
  expira_en     DATETIME(3) NOT NULL,                   -- verificar 24 h · recuperar 1 h · invitación 7 d
  usado_en      DATETIME(3) NULL,
  ip            VARCHAR(45) NULL,
  UNIQUE KEY uq_tokens_hash (token_hash),
  KEY ix_tokens_usuario (usuario_id, tipo, usado_en),
  CONSTRAINT fk_tokens_usuario FOREIGN KEY (usuario_id) REFERENCES usuarios(id) ON DELETE CASCADE
) ENGINE=InnoDB DEFAULT CHARSET=utf8mb4 COLLATE=utf8mb4_unicode_ci;

-- ---------- ABONOS, CARNETS, ACCESOS ----------
CREATE TABLE abonos (                                   -- estado ACTUAL del abono (1 fila por persona)
  id             BIGINT UNSIGNED NOT NULL AUTO_INCREMENT PRIMARY KEY,
  usuario_id     BIGINT UNSIGNED NOT NULL,
  activo         TINYINT(1) NOT NULL DEFAULT 1,         -- 0 = dado de baja
  desde          DATE NOT NULL,
  hasta          DATE NOT NULL,                         -- inclusive; vigente <=> activo=1 AND hasta >= hoyMadrid
  auto_renovar   TINYINT(1) NOT NULL DEFAULT 0,
  creado_en      DATETIME(3) NOT NULL DEFAULT CURRENT_TIMESTAMP(3),
  actualizado_en DATETIME(3) NOT NULL DEFAULT CURRENT_TIMESTAMP(3) ON UPDATE CURRENT_TIMESTAMP(3),
  baja_en        DATETIME(3) NULL,
  UNIQUE KEY uq_abonos_usuario (usuario_id),
  KEY ix_abonos_vigencia (activo, hasta),
  CONSTRAINT fk_abonos_usuario FOREIGN KEY (usuario_id) REFERENCES usuarios(id) ON DELETE CASCADE
) ENGINE=InnoDB DEFAULT CHARSET=utf8mb4 COLLATE=utf8mb4_unicode_ci;

CREATE TABLE abono_movimientos (                        -- histórico de altas/renovaciones/bajas (finanzas)
  id            BIGINT UNSIGNED NOT NULL AUTO_INCREMENT PRIMARY KEY,
  abono_id      BIGINT UNSIGNED NOT NULL,
  tipo          ENUM('alta','renovacion','renovacion_auto','reactivacion','baja','caducidad') NOT NULL,
  desde         DATE NULL,
  hasta         DATE NULL,
  importe       DECIMAL(8,2) NOT NULL DEFAULT 0,        -- ajustes.abono_precio_mes en ese momento
  realizado_por BIGINT UNSIGNED NULL,                   -- admin; NULL = tarea automática
  creado_en     DATETIME(3) NOT NULL DEFAULT CURRENT_TIMESTAMP(3),
  KEY ix_mov_abono (abono_id, creado_en),
  CONSTRAINT fk_mov_abono FOREIGN KEY (abono_id) REFERENCES abonos(id) ON DELETE CASCADE,
  CONSTRAINT fk_mov_admin FOREIGN KEY (realizado_por) REFERENCES usuarios(id) ON DELETE SET NULL
) ENGINE=InnoDB DEFAULT CHARSET=utf8mb4 COLLATE=utf8mb4_unicode_ci;

CREATE TABLE carnets (                                  -- credenciales de acceso; sobreviven a bajas/reactivaciones
  id             BIGINT UNSIGNED NOT NULL AUTO_INCREMENT PRIMARY KEY,
  usuario_id     BIGINT UNSIGNED NOT NULL,
  nfc_uid        VARCHAR(20) NULL,                      -- UID decimal real de la pulsera (6-20 dígitos); lo asigna el admin
  nfc_id_legacy  CHAR(12) NULL,                         -- 'NFC-XXXXXXXX' solo compatibilidad; no se emiten nuevos
  qr_seed        CHAR(32) NOT NULL,                     -- 16 B hex (crypto.randomBytes). SECRETO: solo /api/mi/qr y /api/torno/socios
  qr_fijo        VARCHAR(24) NULL,                      -- reservado al carnet Wallet (fase futura)
  emitido_en     DATETIME(3) NOT NULL DEFAULT CURRENT_TIMESTAMP(3),
  seed_rotada_en DATETIME(3) NULL,
  revocado_en    DATETIME(3) NULL,
  UNIQUE KEY uq_carnets_usuario (usuario_id),
  UNIQUE KEY uq_carnets_nfc_uid (nfc_uid),
  UNIQUE KEY uq_carnets_nfc_legacy (nfc_id_legacy),
  UNIQUE KEY uq_carnets_qr_fijo (qr_fijo),
  CONSTRAINT fk_carnets_usuario FOREIGN KEY (usuario_id) REFERENCES usuarios(id) ON DELETE CASCADE
) ENGINE=InnoDB DEFAULT CHARSET=utf8mb4 COLLATE=utf8mb4_unicode_ci;

CREATE TABLE accesos (                                  -- histórico COMPLETO (hoy se recorta a 300)
  id             BIGINT UNSIGNED NOT NULL AUTO_INCREMENT PRIMARY KEY,
  ts             DATETIME(3) NOT NULL,                  -- momento real del paso (lo manda el torno; la cola offline lo conserva)
  usuario_id     BIGINT UNSIGNED NULL,
  metodo         ENUM('qr','nfc') NOT NULL,
  resultado      ENUM('ok','denegado') NOT NULL,
  motivo         VARCHAR(120) NOT NULL,
  direccion      ENUM('entrada','salida') NOT NULL,
  raw            VARCHAR(64) NOT NULL DEFAULT '',
  avisos         VARCHAR(255) NOT NULL DEFAULT '',      -- JSON array de avisos del torno ('fuera de hora de gym', 'entrada sin salida')
  origen         ENUM('torno','panel') NOT NULL DEFAULT 'torno',
  dispositivo    VARCHAR(40) NOT NULL DEFAULT '',       -- nombre del token del torno ('torno-pabellon')
  evento_uid     CHAR(32) NULL,                         -- UUID sin guiones generado en la Pi => reenvíos idempotentes
  recibido_en    DATETIME(3) NOT NULL DEFAULT CURRENT_TIMESTAMP(3),
  UNIQUE KEY uq_accesos_evento (evento_uid),
  KEY ix_accesos_ts (ts),
  KEY ix_accesos_usuario (usuario_id, ts),
  KEY ix_accesos_aforo (resultado, direccion, ts),
  CONSTRAINT fk_accesos_usuario FOREIGN KEY (usuario_id) REFERENCES usuarios(id) ON DELETE SET NULL
) ENGINE=InnoDB DEFAULT CHARSET=utf8mb4 COLLATE=utf8mb4_unicode_ci;

-- ---------- CATÁLOGO ----------
CREATE TABLE instalaciones (                            -- ids = js/data.js; UPSERT al arrancar (nunca pisa precios)
  id                VARCHAR(20) NOT NULL PRIMARY KEY,   -- 'padel','tenis','futbol7','pabellon','sala','gimnasio'
  nombre            VARCHAR(80) NOT NULL,
  exterior          TINYINT(1) NOT NULL DEFAULT 0,
  duracion_min      SMALLINT UNSIGNED NOT NULL,
  precio            DECIMAL(8,2) NOT NULL,
  suplemento_luz    DECIMAL(8,2) NOT NULL DEFAULT 0,
  unidad            VARCHAR(20) NOT NULL,
  reservable_online TINYINT(1) NOT NULL DEFAULT 1,      -- gimnasio = 0 (solo presencial)
  orden             TINYINT UNSIGNED NOT NULL DEFAULT 0,
  activa            TINYINT(1) NOT NULL DEFAULT 1,
  actualizado_en    DATETIME(3) NOT NULL DEFAULT CURRENT_TIMESTAMP(3) ON UPDATE CURRENT_TIMESTAMP(3)
) ENGINE=InnoDB DEFAULT CHARSET=utf8mb4 COLLATE=utf8mb4_unicode_ci;

CREATE TABLE pistas (
  id             VARCHAR(30) NOT NULL PRIMARY KEY,      -- 'padel-1','futbol7-2','pabellon-central',...
  instalacion_id VARCHAR(20) NOT NULL,
  nombre         VARCHAR(80) NOT NULL,
  orden          TINYINT UNSIGNED NOT NULL DEFAULT 0,
  activa         TINYINT(1) NOT NULL DEFAULT 1,
  KEY ix_pistas_inst (instalacion_id),
  CONSTRAINT fk_pistas_inst FOREIGN KEY (instalacion_id) REFERENCES instalaciones(id) ON DELETE RESTRICT
) ENGINE=InnoDB DEFAULT CHARSET=utf8mb4 COLLATE=utf8mb4_unicode_ci;

CREATE TABLE clases (                                   -- sembrada una vez desde CLASES de js/data.js; luego la edita el admin
  id                 VARCHAR(30) NOT NULL PRIMARY KEY,  -- slug 'pilates','ciclo',...
  nombre             VARCHAR(80) NOT NULL,
  lugar              VARCHAR(80) NOT NULL,
  espacio            ENUM('sala','pabellon') NOT NULL,
  dias_texto         VARCHAR(80) NOT NULL,              -- 'Lunes y miércoles'
  hora_texto         VARCHAR(40) NOT NULL,              -- '09:30 – 10:20'
  monitor_usuario_id BIGINT UNSIGNED NULL,              -- sustituye la coincidencia por nombre
  monitor_nombre     VARCHAR(80) NOT NULL DEFAULT '',   -- texto para mostrar si no hay usuario monitor
  aforo              SMALLINT UNSIGNED NOT NULL,
  precio_mes         DECIMAL(8,2) NOT NULL,
  icono              VARCHAR(30) NOT NULL DEFAULT 'i-personas',
  orden              TINYINT UNSIGNED NOT NULL DEFAULT 0,
  activa             TINYINT(1) NOT NULL DEFAULT 1,
  actualizado_en     DATETIME(3) NOT NULL DEFAULT CURRENT_TIMESTAMP(3) ON UPDATE CURRENT_TIMESTAMP(3),
  KEY ix_clases_monitor (monitor_usuario_id),
  CONSTRAINT fk_clases_monitor FOREIGN KEY (monitor_usuario_id) REFERENCES usuarios(id) ON DELETE SET NULL
) ENGINE=InnoDB DEFAULT CHARSET=utf8mb4 COLLATE=utf8mb4_unicode_ci;

-- ---------- RESERVAS Y BLOQUEOS ----------
CREATE TABLE reservas (
  id                 BIGINT UNSIGNED NOT NULL AUTO_INCREMENT PRIMARY KEY,
  legacy_id          VARCHAR(24) NULL,
  localizador        CHAR(8) NOT NULL,                  -- 'MS-XXXXX' generado en SERVIDOR con crypto (reintento si choca)
  usuario_id         BIGINT UNSIGNED NOT NULL,
  pista_id           VARCHAR(30) NOT NULL,
  fecha              DATE NOT NULL,
  hora_inicio_min    SMALLINT UNSIGNED NOT NULL,        -- minutos desde medianoche (hoy r.hora)
  hora_fin_min       SMALLINT UNSIGNED NOT NULL,        -- inicio + instalaciones.duracion_min (calculado en servidor)
  precio             DECIMAL(8,2) NOT NULL,             -- calculado en servidor (precio + luz si exterior y hora >= hora_luz)
  con_luz            TINYINT(1) NOT NULL DEFAULT 0,
  nombre_titular     VARCHAR(120) NOT NULL,
  estado             ENUM('confirmada','cancelada','anulada') NOT NULL DEFAULT 'confirmada',  -- anulada = por bloqueo
  origen             ENUM('web','panel') NOT NULL DEFAULT 'web',
  creada_por         BIGINT UNSIGNED NULL,              -- admin si origen='panel'
  creada_en          DATETIME(3) NOT NULL DEFAULT CURRENT_TIMESTAMP(3),
  cancelada_en       DATETIME(3) NULL,
  cancelada_por      BIGINT UNSIGNED NULL,
  motivo_cancelacion VARCHAR(120) NULL,
  activa             TINYINT(1) GENERATED ALWAYS AS (IF(estado = 'confirmada', 1, NULL)) STORED,  -- NULL no choca en UNIQUE
  UNIQUE KEY uq_reservas_hueco (pista_id, fecha, hora_inicio_min, activa),   -- solo las confirmadas compiten por el hueco
  UNIQUE KEY uq_reservas_localizador (localizador),
  UNIQUE KEY uq_reservas_legacy (legacy_id),
  KEY ix_reservas_usuario (usuario_id, fecha),
  KEY ix_reservas_dia (fecha, pista_id, estado),
  CONSTRAINT ck_reservas_rango CHECK (hora_inicio_min < hora_fin_min AND hora_fin_min <= 1440),
  CONSTRAINT fk_reservas_usuario FOREIGN KEY (usuario_id) REFERENCES usuarios(id) ON DELETE RESTRICT,
  CONSTRAINT fk_reservas_pista FOREIGN KEY (pista_id) REFERENCES pistas(id) ON DELETE RESTRICT,
  CONSTRAINT fk_reservas_creada_por FOREIGN KEY (creada_por) REFERENCES usuarios(id) ON DELETE SET NULL
) ENGINE=InnoDB DEFAULT CHARSET=utf8mb4 COLLATE=utf8mb4_unicode_ci;
-- Confirmación atómica (ver §4): BEGIN; SELECT bloqueos solapados FOR UPDATE; SELECT reservas confirmadas solapadas FOR UPDATE;
-- INSERT; COMMIT. ER_DUP_ENTRY en uq_reservas_hueco => 409 'Esa hora ya está cogida.'

CREATE TABLE bloqueos (
  id            BIGINT UNSIGNED NOT NULL AUTO_INCREMENT PRIMARY KEY,
  legacy_id     VARCHAR(24) NULL,
  pista_id      VARCHAR(30) NOT NULL,
  fecha         DATE NOT NULL,
  desde_min     SMALLINT UNSIGNED NOT NULL,
  hasta_min     SMALLINT UNSIGNED NOT NULL,
  motivo        VARCHAR(120) NOT NULL,
  creado_por    BIGINT UNSIGNED NULL,
  creado_en     DATETIME(3) NOT NULL DEFAULT CURRENT_TIMESTAMP(3),
  levantado_en  DATETIME(3) NULL,                       -- soft: el informe PLID conserva histórico
  levantado_por BIGINT UNSIGNED NULL,
  UNIQUE KEY uq_bloqueos_legacy (legacy_id),
  KEY ix_bloqueos_pista_dia (pista_id, fecha, levantado_en),
  CONSTRAINT ck_bloqueos_rango CHECK (desde_min < hasta_min AND hasta_min <= 1440),
  CONSTRAINT fk_bloqueos_pista FOREIGN KEY (pista_id) REFERENCES pistas(id) ON DELETE RESTRICT,
  CONSTRAINT fk_bloqueos_creado_por FOREIGN KEY (creado_por) REFERENCES usuarios(id) ON DELETE SET NULL
) ENGINE=InnoDB DEFAULT CHARSET=utf8mb4 COLLATE=utf8mb4_unicode_ci;
-- Crear bloqueo (transacción): INSERT bloqueo; UPDATE reservas SET estado='anulada', cancelada_en=NOW(3), motivo_cancelacion=?
-- WHERE pista_id=? AND fecha=? AND estado='confirmada' AND hora_inicio_min<? AND hora_fin_min>?; INSERT notificaciones por afectada.

-- ---------- CLASES (inscripción SOLO por el admin) Y GIMNASIO POR HORAS ----------
CREATE TABLE inscripciones_clase (
  id           BIGINT UNSIGNED NOT NULL AUTO_INCREMENT PRIMARY KEY,
  clase_id     VARCHAR(30) NOT NULL,
  usuario_id   BIGINT UNSIGNED NOT NULL,
  estado       ENUM('inscrita','espera','baja') NOT NULL DEFAULT 'inscrita',
  desde        DATETIME(3) NOT NULL DEFAULT CURRENT_TIMESTAMP(3),   -- orden de la cola
  nota         VARCHAR(200) NOT NULL DEFAULT '',
  creada_por   BIGINT UNSIGNED NULL,                    -- admin (alta presencial)
  promovida_en DATETIME(3) NULL,                        -- espera -> inscrita (automática por antigüedad al quedar plaza)
  baja_en      DATETIME(3) NULL,
  baja_por     BIGINT UNSIGNED NULL,
  activa       TINYINT(1) GENERATED ALWAYS AS (IF(estado IN ('inscrita','espera'), 1, NULL)) STORED,
  UNIQUE KEY uq_insc_viva (clase_id, usuario_id, activa),          -- una inscripción viva por clase y persona
  KEY ix_insc_clase (clase_id, estado, desde),
  KEY ix_insc_usuario (usuario_id, estado),
  CONSTRAINT fk_insc_clase FOREIGN KEY (clase_id) REFERENCES clases(id) ON DELETE RESTRICT,
  CONSTRAINT fk_insc_usuario FOREIGN KEY (usuario_id) REFERENCES usuarios(id) ON DELETE CASCADE,
  CONSTRAINT fk_insc_admin FOREIGN KEY (creada_por) REFERENCES usuarios(id) ON DELETE SET NULL
) ENGINE=InnoDB DEFAULT CHARSET=utf8mb4 COLLATE=utf8mb4_unicode_ci;
-- Aforo real = COUNT(estado='inscrita'); inscritosBase/colaBase (simulación demo) desaparecen.

CREATE TABLE gimnasio_franjas (                         -- hoy msd_gimnasio_cfg; capacidad por franja (cubre el caso global)
  id           SMALLINT UNSIGNED NOT NULL AUTO_INCREMENT PRIMARY KEY,
  hora_inicio  TIME NOT NULL,                           -- '09:00:00' ... '21:00:00'
  duracion_min SMALLINT UNSIGNED NOT NULL DEFAULT 60,
  capacidad    SMALLINT UNSIGNED NOT NULL DEFAULT 20,
  activa       TINYINT(1) NOT NULL DEFAULT 1,
  UNIQUE KEY uq_franja_hora (hora_inicio)
) ENGINE=InnoDB DEFAULT CHARSET=utf8mb4 COLLATE=utf8mb4_unicode_ci;

CREATE TABLE gimnasio_inscripciones (
  id         BIGINT UNSIGNED NOT NULL AUTO_INCREMENT PRIMARY KEY,
  legacy_id  VARCHAR(24) NULL,
  usuario_id BIGINT UNSIGNED NOT NULL,
  franja_id  SMALLINT UNSIGNED NOT NULL,
  desde      DATETIME(3) NOT NULL DEFAULT CURRENT_TIMESTAMP(3),   -- antigüedad: decide asignado/espera; mover = UPDATE franja_id, desde=NOW(3)
  nota       VARCHAR(200) NOT NULL DEFAULT '',
  creada_por BIGINT UNSIGNED NULL,
  baja_en    DATETIME(3) NULL,
  baja_por   BIGINT UNSIGNED NULL,
  activa     TINYINT(1) GENERATED ALWAYS AS (IF(baja_en IS NULL, 1, NULL)) STORED,
  UNIQUE KEY uq_gim_usuario_viva (usuario_id, activa),             -- una hora por socio
  UNIQUE KEY uq_gim_legacy (legacy_id),
  KEY ix_gim_franja (franja_id, baja_en, desde),
  CONSTRAINT fk_gim_usuario FOREIGN KEY (usuario_id) REFERENCES usuarios(id) ON DELETE CASCADE,
  CONSTRAINT fk_gim_franja FOREIGN KEY (franja_id) REFERENCES gimnasio_franjas(id) ON DELETE RESTRICT,
  CONSTRAINT fk_gim_admin FOREIGN KEY (creada_por) REFERENCES usuarios(id) ON DELETE SET NULL
) ENGINE=InnoDB DEFAULT CHARSET=utf8mb4 COLLATE=utf8mb4_unicode_ci;
-- Estado calculado (idéntico a js/gimnasio.js:63-73), no se guarda:
-- SELECT i.*, f.capacidad, ROW_NUMBER() OVER (PARTITION BY i.franja_id ORDER BY i.desde, i.id) pos
--   FROM gimnasio_inscripciones i JOIN gimnasio_franjas f ON f.id=i.franja_id WHERE i.baja_en IS NULL;
-- estado = pos <= capacidad ? 'asignado' : 'espera'; posicion = pos - capacidad.

-- ---------- NOTIFICACIONES, AUDITORÍA, AJUSTES, CORREO ----------
CREATE TABLE notificaciones (
  id         BIGINT UNSIGNED NOT NULL AUTO_INCREMENT PRIMARY KEY,
  usuario_id BIGINT UNSIGNED NOT NULL,
  ts         DATETIME(3) NOT NULL DEFAULT CURRENT_TIMESTAMP(3),
  tipo       VARCHAR(30) NOT NULL DEFAULT 'aviso',      -- reserva, abono, clase, gimnasio, sistema
  texto      VARCHAR(300) NOT NULL,
  leida_en   DATETIME(3) NULL,
  KEY ix_notif_usuario (usuario_id, leida_en, ts),
  CONSTRAINT fk_notif_usuario FOREIGN KEY (usuario_id) REFERENCES usuarios(id) ON DELETE CASCADE
) ENGINE=InnoDB DEFAULT CHARSET=utf8mb4 COLLATE=utf8mb4_unicode_ci;

CREATE TABLE registro_actividad (                       -- hoy msd_automatizaciones (máx 200) -> auditoría completa
  id               BIGINT UNSIGNED NOT NULL AUTO_INCREMENT PRIMARY KEY,
  ts               DATETIME(3) NOT NULL DEFAULT CURRENT_TIMESTAMP(3),
  tipo             VARCHAR(30) NOT NULL,                -- sistema, auth, abono, clases, reservas, usuarios, acceso, finanzas, solicitudes, gimnasio, correo
  texto            VARCHAR(400) NOT NULL,
  actor_usuario_id BIGINT UNSIGNED NULL,                -- NULL = automático
  entidad          VARCHAR(30) NULL,
  entidad_id       VARCHAR(40) NULL,
  ip               VARCHAR(45) NULL,
  KEY ix_registro_ts (ts),
  KEY ix_registro_tipo (tipo, ts),
  CONSTRAINT fk_registro_actor FOREIGN KEY (actor_usuario_id) REFERENCES usuarios(id) ON DELETE SET NULL
) ENGINE=InnoDB DEFAULT CHARSET=utf8mb4 COLLATE=utf8mb4_unicode_ci;

CREATE TABLE ajustes (                                  -- hoy msd_config + msd_tarifas.abono + constantes del código
  clave            VARCHAR(64) NOT NULL PRIMARY KEY,    -- reserva_desde_dias, reserva_dias_ventana, abono_precio_mes, aforo_max,
                                                        -- edad_minima, hora_luz, horario_laborable, horario_finde, max_reservas_futuras,
                                                        -- cancelacion_min_horas, tarea_diaria_ultimo_dia
  valor            JSON NOT NULL,
  actualizado_en   DATETIME(3) NOT NULL DEFAULT CURRENT_TIMESTAMP(3) ON UPDATE CURRENT_TIMESTAMP(3),
  actualizado_por  BIGINT UNSIGNED NULL,
  CONSTRAINT fk_ajustes_por FOREIGN KEY (actualizado_por) REFERENCES usuarios(id) ON DELETE SET NULL
) ENGINE=InnoDB DEFAULT CHARSET=utf8mb4 COLLATE=utf8mb4_unicode_ci;

CREATE TABLE correos_salida (                           -- outbox SMTP: sobrevive a reinicios de Passenger; bucle cada 30 s
  id           BIGINT UNSIGNED NOT NULL AUTO_INCREMENT PRIMARY KEY,
  para         VARCHAR(254) NOT NULL,
  asunto       VARCHAR(200) NOT NULL,
  cuerpo_texto TEXT NOT NULL,
  creado_en    DATETIME(3) NOT NULL DEFAULT CURRENT_TIMESTAMP(3),
  enviado_en   DATETIME(3) NULL,
  intentos     TINYINT UNSIGNED NOT NULL DEFAULT 0,
  proximo_en   DATETIME(3) NOT NULL DEFAULT CURRENT_TIMESTAMP(3),  -- backoff: +10 s, +1 min, +5 min, +30 min, +2 h
  ultimo_error VARCHAR(255) NULL,
  KEY ix_correos_pendientes (enviado_en, proximo_en)
) ENGINE=InnoDB DEFAULT CHARSET=utf8mb4 COLLATE=utf8mb4_unicode_ci;

INSERT INTO migraciones (version, nombre) VALUES (1, '001_esquema');
```

**`002_semillas.sql`** (catálogo, no datos personales): `instalaciones`/`pistas` desde `js/data.js` con `gimnasio.reservable_online=0`; `clases` desde CLASES (sin `inscritosBase/colaBase`, `monitor_usuario_id` NULL, `monitor_nombre` = texto actual); `gimnasio_franjas` 09:00..21:00 capacidad 20; `ajustes`: `reserva_desde_dias=0`, `reserva_dias_ventana=14`, `abono_precio_mes=18`, `aforo_max=40`, `edad_minima=16`, `hora_luz=19`, `horario_laborable=[9,23]`, `horario_finde=[9,21]`, `max_reservas_futuras=2`, `cancelacion_min_horas=24`.
**`003_limpiar_demo.sql`** (F2): `DELETE FROM estado;` (dump previo con el gestor de BD de Plesk). **`004_retirar_legacy.sql`** (F7): `DROP TABLE estado;`.

**Runner `migrar.js`** (mysql2, sin nada más): `SELECT GET_LOCK('msd_migraciones',30)`; lee `migraciones/*.sql` ordenados; para cada versión ausente en `migraciones` ejecuta el fichero en una transacción (`multipleStatements` solo en esa conexión) y registra; `RELEASE_LOCK`. `server.js` lo ejecuta en `arrancar()` antes de `listen` (como hoy `asegurarTabla`); también `node migrar.js`. `/api/salud` informa `esquema_version`. Arranque además hace UPSERT de `instalaciones`/`pistas` desde `lib/catalogo.js` (`INSERT ... ON DUPLICATE KEY UPDATE nombre, duracion_min, exterior, unidad, orden` — nunca precio).

**Pool mysql2 (`lib/bd.js`)**: `connectionLimit: 10`, `charset: utf8mb4`, `timezone: 'Z'`, `dateStrings: ['DATE']`, `namedPlaceholders: true`, `supportBigNumbers: false`; en `pool.on('connection', c => c.query("SET time_zone='+00:00'"))`. Helper `enTransaccion(async conn => {...})` con retry único ante `ER_LOCK_DEADLOCK`.

---

## 3. Autenticación

### 3.1 Hash de contraseña (`lib/clave.js`)
- `crypto.scrypt(clave, sal, 32, {N: 32768, r: 8, p: 3, maxmem: 64*1024*1024})` (promisificado; corre en el threadpool). Formato PHC propio: `scrypt$15$8$3$<sal b64url>$<hash b64url>`. `verificar()` parsea N,r,p,sal del string, compara con `timingSafeEqual`, devuelve `{ok, rehash}`; si los parámetros guardados difieren de los vigentes, rehash en ese login (permite bajar a 2^14/8/5 si el VPS va justo, o subir, sin migrar).
- Semáforo global: máx. 3 scrypt en vuelo, cola ≤ 50, 503 `{error:'ocupado'}` si desborda. `UV_THREADPOOL_SIZE=4` en Plesk.
- Anti-enumeración por tiempo: si el email no existe se verifica contra un hash dummy generado al arrancar.
- Política: 10-128 caracteres, sin reglas de composición; rechazar si contiene la parte local del email o el nombre, o está en una lista de 50 comunes (`lib/claves-comunes.js`). `minlength` 8→10 en `index.html`/`admin.html`.

### 3.2 Sesiones y cookie (`lib/sesion.js`)
- Id = `randomBytes(32).toString('base64url')`; en BD `sesiones.id = sha256(id)`. Cookie `__Host-msd_sid=<id>; Path=/; Secure; HttpOnly; SameSite=Lax; Max-Age=<absoluto>`. HTTPS detectado por `x-forwarded-proto === 'https'` o `MSD_HTTPS=1`; en dev http se emite `msd_sid` sin Secure (y el log avisa).
- Caducidad: vecino inactividad 14 d / absoluto 30 d; monitor y admin 12 h / 7 d. `ultimo_uso_en` se escribe como mucho cada 5 min. Una consulta por petición: `SELECT s.*, u.id, u.rol, u.nombre, u.email_verificado_en, u.eliminado_en FROM sesiones s JOIN usuarios u ... WHERE s.id=? AND s.expira_en > ?` (la fecha la pasa Node). El rol se lee siempre de `usuarios`.
- Login crea sesión nueva (rotación); cambio de contraseña, restablecimiento, cambio de rol por admin y baja → `DELETE` de todas las sesiones del usuario (salvo la actual en el cambio voluntario); logout → `DELETE` + `Set-Cookie Max-Age=0`. Purga horaria de caducadas.

### 3.3 CSRF y cabeceras
- Toda petición no-GET con cookie exige `X-Requested-With: MSD` y `Content-Type: application/json`; se rechaza (403) si `Sec-Fetch-Site === 'cross-site'` o si `Origin`/`Referer` no coincide con `MSD_URL_PUBLICA` (en dev `http://localhost:8137`). El servidor nunca emite cabeceras CORS. Nunca se muta estado en GET: los enlaces de correo llevan el token en el fragmento `#/verificar?token=…` y es la SPA quien hace POST. Las rutas Bearer (torno) no pasan por CSRF.
- Cabeceras globales (Node, y duplicadas en "Directivas adicionales de Apache" de Plesk porque Apache sirve los estáticos antes que Node): `Content-Security-Policy: default-src 'self'; script-src 'self'; style-src 'self' 'unsafe-inline'; img-src 'self' data: blob:; media-src 'self' blob:; connect-src 'self'; frame-ancestors 'none'; base-uri 'self'; form-action 'self'; object-src 'none'` · `X-Content-Type-Options: nosniff` · `X-Frame-Options: DENY` · `Referrer-Policy: strict-origin-when-cross-origin` · `Permissions-Policy: camera=(self), microphone=(), geolocation=()` · `Strict-Transport-Security: max-age=15552000` solo con HTTPS · `Cache-Control: no-store` en `/api/*`.
- Estáticos por lista blanca: `index.html`, `admin.html`, `legal.html`, `accesibilidad.html`, `dossier.html`, `css/`, `js/` (sin `demo.js`, `qr-prueba.js`, `sync.js`, `token.js`), `icono*`, `manifest.webmanifest`, `sw.js`; 404 para todo lo demás (`server.js`, `almacen.js`, `acceso/`, `data/`, `*.md`, `.git`, `node_modules`). Reglas Apache equivalentes en Plesk.

### 3.4 Rate limit (`lib/limite.js`, memoria, 1 instancia)
Map clave→ventana deslizante, poda cada 60 s, tope 50 000 claves. IP del cliente: último valor de `X-Forwarded-For` SOLO si `req.socket.remoteAddress` es loopback/ausente; si no, la del socket. Reglas: login 20/15 min por IP; 5 fallos por email → `usuarios.bloqueado_hasta` escalonado 15 min → 60 min (persistente, aciertos reinician); registro 5/h por IP; recuperar y reenviar-verificación 3/h por email y 10/h por IP; verificar/restablecer 10/h por IP; `/api/mi/qr` 30/min por sesión; Bearer inválido 10/min por IP; resto `/api` 300/min por IP. Respuesta 429 `{error:'demasiados_intentos', reintentarEn}` + `Retry-After`. `/api/salud` (admin) muestra qué cabeceras de proxy llegan.

### 3.5 Verificación de email, recuperación, SMTP (`lib/correo.js`)
- Token = `randomBytes(32)` base64url; en BD solo SHA-256; un solo uso; al emitir uno nuevo se invalidan los anteriores del mismo tipo. Caducidad: verificar 24 h, recuperar 1 h, invitación 7 d.
- Registro → usuario con `email_verificado_en NULL` + correo con `MSD_URL_PUBLICA/#/verificar?token=…` → la SPA hace `POST /api/auth/verificar` → verificado + sesión. Login sin verificar → 403 `email_no_verificado` + botón reenviar. Email ya registrado → mismo 202 y al dueño le llega "alguien intentó registrarse con tu correo".
- Recuperar → siempre 202; `#/restablecer?token=…` → `POST /api/auth/restablecer {token, clave}` → hash nuevo, token usado, todas las sesiones borradas, correo de aviso, sesión nueva.
- Cliente SMTP propio (~150 líneas, `net` + `tls`): `EHLO` → `STARTTLS` (587) o TLS implícito (465) → `AUTH PLAIN` → `MAIL FROM`/`RCPT TO`/`DATA` con dot-stuffing, parser multilínea, timeout 15 s por paso; cabeceras From/To/Subject (RFC 2047), Date, Message-ID, MIME text/plain utf-8 base64, `Auto-Submitted`. Variables: `MSD_SMTP_HOST` (hostname de correo de Plesk con certificado válido, no `localhost`), `MSD_SMTP_PORT`, `MSD_SMTP_USER`, `MSD_SMTP_PASS`, `MSD_SMTP_DE`, `MSD_URL_PUBLICA`. Sin `MSD_SMTP_HOST` → modo dev: imprime por consola y anexa a `<MSD_DATA_DIR>/correos-salientes.log` (fuera de httpdocs). Los envíos van a `correos_salida` (outbox) y un bucle cada 30 s envía pendientes con backoff; fallos a `registro_actividad` tipo `correo` (el admin los ve).

### 3.6 Primer admin (sin siembra, sin clave por defecto)
1. `node scripts/crear-admin.js --email x --nombre "Y"` (contraseña por stdin sin eco) → scrypt, `email_verificado_en=NOW`, rol admin.
2. Sin SSH: al arrancar, **solo si no existe ningún admin** y están `MSD_BOOTSTRAP_ADMIN_EMAIL` + `MSD_BOOTSTRAP_ADMIN_CLAVE` (≥ 12), se crea verificado con `debe_cambiar_clave=1`, se anota en `registro_actividad` y el log dice "borra las variables". Con admin existente se ignoran siempre.

### 3.7 Endpoints `/api/auth/*` (cuerpo JSON ≤ 10 KB)

| Endpoint | Cuerpo → Respuesta |
|---|---|
| `POST /api/auth/registro` | `{nombre,email,telefono,clave,birthdate?,aceptaNormas:true}` → 202 `{ok}` (rol siempre vecino) |
| `POST /api/auth/verificar` | `{token}` → 200 `{usuario}` + cookie |
| `POST /api/auth/reenviar-verificacion` | `{email}` → 202 |
| `POST /api/auth/entrar` | `{email,clave}` → 200 `{usuario}` + cookie · 401 `credenciales` · 403 `email_no_verificado` · 423 `bloqueado {hasta}` · 429 |
| `POST /api/auth/salir` / `salir-todas` | → 204 + cookie borrada |
| `GET /api/auth/yo` | → 200 `{usuario, sinLeer, servidorMs}` · 401 (lo llama la SPA al arrancar) |
| `PATCH /api/auth/perfil` | `{nombre,telefono}` → 200 `{usuario}` |
| `POST /api/auth/clave` | `{actual,nueva}` → 204 (revoca las demás sesiones) |
| `POST /api/auth/recuperar` | `{email}` → 202 |
| `POST /api/auth/restablecer` | `{token,clave}` → 200 `{usuario}` + cookie |

Forma de `usuario` hacia el navegador (lista blanca): `{id, nombre, email, telefono, rol, verificado, debeCambiarClave, birthdate, abono:{activo,desde,hasta,autoRenovar,nfcUltimos4}|null, gimnasio:{franja,estado,posicion}|null, clases:[{claseId,estado,posicion}]}`. Nunca `clave_hash`, `qr_seed`, ni `nfc_uid` completo (el UID completo solo en respuestas de admin).

---

## 4. API por rol y middleware

### 4.1 Middleware (`lib/http.js`, Node puro)
Tabla de rutas `[{metodo, patron: RegExp con grupos, acceso: 'publico'|'sesion'|['monitor','admin']|['admin']|'torno', esquema, maxBytes, handler}]`. Despachador: (1) emparejar o 404 (todo `/api/*` no registrado → 404; denegar por defecto); (2) `acceso !== 'publico'` → `autenticarSesion` (cookie) o `autenticarTorno` (Bearer) → 401 (`WWW-Authenticate: Bearer` en torno); rol no incluido → 403; (3) no-GET con cookie → comprobación CSRF (§3.3); (4) `leerJson(req, maxBytes, esquema)` → 415 si no es JSON, 413 si excede, 400 `{error, campo}` si falla el esquema o trae claves desconocidas; (5) `handler(ctx)` con `ctx = {req,res,params,cuerpo,sesion|torno,ip}`. Todo dentro de `try/catch` → 500 `{error:'interno'}` sin pila y log; `process.on('unhandledRejection')` con log (sin exit); `decodeURIComponent` protegido (hoy `/%` tumba el proceso). `responder(res, codigo, obj)` siempre JSON + `no-store`. Errores `{error:'texto legible', codigo:'RESERVA_OCUPADA'}`.
`lib/validar.js`: esquemas declarativos `{campo:{tipo:'texto'|'entero'|'decimal'|'enum'|'fecha'|'bool'|'id'|'email'|'telefono', min,max,regex,valores,requerido}}`; fecha real y en Europe/Madrid; ids `^[a-z0-9-]{1,40}$`; email ≤ 254 minúsculas; teléfono `^(\+34)?[6-9]\d{8}$` o vacío.
`lib/fechas.js`: `hoyMadrid()`, `minutosAhoraMadrid()`, `sumarMes(fecha, n)` (misma regla que `js/auth.js:39-44`), `aFechaSql(Date)`.
Proyecciones explícitas (`lib/vistas.js`): `vistaUsuarioPropio`, `vistaUsuarioAdmin`, `vistaSocioTorno`, `vistaAccesoMonitor`, `vistaReserva`… con listas blancas; nunca `SELECT *` serializado. Test automático que recorre todas las rutas con un usuario de cada rol y falla si alguna respuesta contiene `hash`, `sal`, `qr_seed`, `qrSeed`, `clave`, `token`.

### 4.2 Endpoints

**Público**

| Endpoint | Método | Qué hace | Devuelve |
|---|---|---|---|
| `/api/salud` | GET | Diagnóstico (más detalle con sesión admin) | `{ok, backend, esquema_version, torno:{ultimoContacto}…}` |
| `/api/catalogo` | GET | Sustituye `data.js`+`msd_tarifas`+`msd_config`+`msd_gimnasio_cfg` | `{instalaciones:[{id,nombre,exterior,duracionMin,precio,suplementoLuz,unidad,reservableOnline,pistas}], clases:[{id,nombre,lugar,diasTexto,horaTexto,monitorNombre,aforo,inscritos,enEspera,precioMes}], horario, horaLuz, reservaDesdeDias, reservaDiasVentana, abonoPrecioMes, gimnasio:{franjas:[{id,hora,capacidad,ocupadas}]}}` |
| `/api/disponibilidad?fecha=&instalacion=` | GET | Tramos reales por pista (fin de la ocupación simulada); con sesión marca `tuya` | `{fecha, pistas:[{pistaId, tramos:[{hora,estado:'libre'|'ocupada'|'bloqueada'|'tuya'|'pasada',motivo?,luz,precio}]}]}` |
| `/api/aforo` | GET | Entradas−salidas `ok` del día Madrid | `{dentro, entradas, salidas, aforoMax}` |
| `/api/eventos` | GET (SSE) | Anónimo: solo `aforo` y `disponibilidad`; con sesión: filtrado por rol | ver §4.3 |

**Vecino (sesión; los monitor/admin también)**

| Endpoint | Método | Qué hace | Devuelve |
|---|---|---|---|
| `/api/mi/reservas` | GET | Confirmadas futuras + últimas 20 pasadas/canceladas | `[reserva]` |
| `/api/reservas` | POST `{pistaId,fecha,hora}` | Transacción: pista activa y reservable online, tramo en horario del día, fecha en ventana y no pasada, sin bloqueo solapado (`FOR UPDATE`), sin solape, límite `max_reservas_futuras`, precio/luz/fin/localizador calculados en servidor; `INSERT` (UNIQUE hueco → 409) | 201 `{reserva}` · 409 `RESERVA_OCUPADA|PISTA_BLOQUEADA` · 422 `FUERA_DE_VENTANA|LIMITE|NO_RESERVABLE` |
| `/api/reservas/:id` | DELETE | `UPDATE ... estado='cancelada' WHERE id=? AND usuario_id=? AND estado='confirmada' AND inicio > ahora + cancelacion_min_horas` (404 si no es suya) | 204 · 422 `TARDE` |
| `/api/mi/accesos` | GET | Últimos 50 propios (sin `raw`) | `[{ts,direccion,resultado,motivo}]` |
| `/api/mi/notificaciones` · `/leidas` | GET · POST | Propias, últimas 30 · marca leídas | `[...]` · 204 |
| `/api/mi/qr` | GET | Lote de códigos calculado en servidor (§5.3); exige abono vigente y carnet no revocado | `{nfcUid, desdeT, ventana:30, codigos:[20], servidorMs}` · 403 `SIN_ABONO` |
| `/api/mi/solicitud-info` | POST `{texto}` | Aviso al admin (registro tipo `solicitudes`) | 202 |

**Monitor (rol monitor o admin)**

| Endpoint | Método | Qué hace | Devuelve |
|---|---|---|---|
| `/api/monitor/panel` | GET | Aforo + últimos 20 accesos con nombre (sin raw/UID) | `{aforo, accesos:[{ts,nombre,direccion,resultado,motivo,avisos}]}` |
| `/api/monitor/clases` | GET | Clases con `monitor_usuario_id = yo` (admin: todas) | `[{clase, inscritos:[{nombre}], espera:[{nombre,posicion}]}]` |

**Admin** (todo escribe en `registro_actividad` con actor e IP)

| Endpoint | Método | Qué hace |
|---|---|---|
| `/api/admin/usuarios?q=&rol=&abono=vigente\|caducado\|sin&pagina=` | GET | Lista paginada (`vistaUsuarioAdmin`: con nfcUid, verificado, creado, último acceso; sin hash/seed) |
| `/api/admin/usuarios/:id` | GET | Detalle + reservas + gimnasio + clases + últimos accesos |
| `/api/admin/usuarios` | POST `{nombre,email,telefono,rol,birthdate,claveTemporal?}` | Crea verificado; sin clave → correo de invitación (7 d); con clave temporal → `debe_cambiar_clave=1` |
| `/api/admin/usuarios/:id` | PATCH `{nombre,telefono,birthdate,email}` | Editar; email → token `cambiar_email` |
| `/api/admin/usuarios/:id/rol` | PATCH `{rol}` | No a sí mismo; nunca 0 admins; revoca sesiones del afectado |
| `/api/admin/usuarios/:id/verificar` | POST | Marca verificado (alta presencial sin correo) |
| `/api/admin/usuarios/:id/clave` | POST `{claveTemporal?}` | Enlace de recuperación por correo o clave temporal; revoca sesiones |
| `/api/admin/usuarios/:id` | DELETE | Soft-delete anonimizado; no a sí mismo ni al último admin; cancela reservas futuras, baja de clases/gym, libera `nfc_uid`, revoca carnet |
| `/api/admin/usuarios/:id/abono` | POST `{meses=1, autoRenovar, nfcUid?}` | Alta o reactivación (`hasta = sumarMes(max(hasta,hoy), meses)`), movimiento `alta/reactivacion`; crea carnet con `qr_seed` nueva si no existe (conserva UID/seed si ya había) |
| `.../abono/renovar` · `.../abono/baja` · `.../abono` PATCH `{autoRenovar}` | POST · POST · PATCH | Renovar (+n meses) · baja (`activo=0`) · preferencia |
| `/api/admin/usuarios/:id/carnet` | PUT `{nfcUid}` | Asigna UID real (UNIQUE → 409 `UID_EN_USO {de:nombre}`) |
| `/api/admin/usuarios/:id/carnet/liberar` · `/rotar-qr` | POST | `nfc_uid=NULL` (pulsera recuperada) · semilla nueva (móvil perdido) |
| `/api/admin/torno/lecturas-desconocidas` | GET | Accesos denegados 'Carnet no reconocido' últimos 5 min (modo alta de pulseras) |
| `/api/admin/torno/validar` | POST `{lectura,direccion}` | Valida en servidor con `lib/token.js` + `acceso/reglas.js` y registra con `origen='panel'` (sustituye simulador y cámara del panel) |
| `/api/admin/torno/estado` | GET | `{ultimoContacto, ip, version, desfaseMs, enLinea}` |
| `/api/admin/reservas?desde=&hasta=&instalacion=&usuario=&pagina=` · `.csv` | GET | Listado y CSV generados en servidor |
| `/api/admin/reservas` | POST `{usuarioId,pistaId,fecha,hora,ignorarVentana?}` | Misma transacción que el vecino, `origen='panel'` |
| `/api/admin/reservas/:id` | DELETE `{motivo}` | Cancela + notifica al titular |
| `/api/admin/bloqueos` · `/:id` | GET/POST `{pistaId,fecha,desdeMin,hastaMin,motivo}` · DELETE | Transacción: inserta, anula reservas solapadas, notifica; respuesta trae `afectadas` · levanta (soft) |
| `/api/admin/ajustes` · `/api/admin/tarifas` | GET/PUT | Ajustes validados · `{instalaciones:{id:{precio,suplementoLuz}}, clases:{id:precioMes}, abono}` |
| `/api/admin/clases` · `/:id` | GET · PATCH `{aforo,lugar,diasTexto,horaTexto,precioMes,monitorUsuarioId,activa}` | Lista con inscritos/espera con nombres · edición |
| `/api/admin/clases/:id/inscripciones` · `/:usuarioId` | POST `{usuarioId,nota}` · DELETE | Servidor decide `inscrita|espera` por aforo (UNIQUE viva → 409) y notifica · baja + promoción del primero de la cola en la misma transacción + notificación |
| `/api/admin/gimnasio` | GET | Franjas con asignados y espera (nombre, nota, desde) |
| `/api/admin/gimnasio/inscripciones` · `/:id` | POST `{usuarioId,franjaId,nota}` · PATCH `{franjaId\|nota}` · DELETE | Exige abono vigente; UNIQUE usuario viva → 409 'ya tiene hora' · mover pone `desde=NOW` · baja (el ascendido se calcula y se notifica) |
| `/api/admin/gimnasio/franjas` | PUT `[{id?,hora,capacidad,activa}]` | Configuración |
| `/api/admin/accesos?desde=&hasta=&usuario=&resultado=&pagina=` · `.csv` | GET | Con `raw`/UID |
| `/api/admin/resumen` · `/api/admin/ocupacion?semanas=` · `/api/admin/registro?tipo=&pagina=` | GET | KPIs en SQL · PLID con datos reales · auditoría |
| `/api/admin/tareas/ejecutar` | POST | Lanza la tarea diaria a mano |

**Torno (Bearer `MSD_TOKEN_TORNO`)** — ver §5: `GET /api/torno/socios` (ETag/304), `POST /api/torno/acceso`, `GET /api/torno/ping`.

### 4.3 SSE (`/api/eventos`)
Exige sesión salvo para temas públicos. El servidor guarda por conexión `{usuarioId, rol}`; máx. 2 conexiones por sesión; latido cada 25 s; `id:` incremental; `X-Accel-Buffering: no`. Eventos **sin datos sensibles** (señales para refetch), `event: cambio`:
- todos: `{tipo:'disponibilidad', fecha, pistaId}`, `{tipo:'aforo', dentro}`
- solo al usuario afectado: `{tipo:'mi', que:'reservas'|'notificaciones'|'perfil'|'gimnasio'|'clases'}`
- monitor/admin: `{tipo:'acceso', evento:{ts,nombre,direccion,resultado,motivo,avisos}}` (único con payload; ya autenticado)
- admin: `{tipo:'admin', seccion:'abonados'|'reservas'|'gimnasio'|'clases'|'bloqueos'|'ajustes'|'registro'|'torno'}`
- transición (F2-F6): `{tipo:'legado', clave:'msd_*'}` → el front repide `/api/bootstrap` para esa clave.

### 4.4 Tareas programadas en servidor (sustituyen a `ejecutarAutomatizaciones` del navegador)
`setInterval` cada 60 s: si `hoyMadrid() !== ajustes.tarea_diaria_ultimo_dia` → en transacción: caducar abonos vencidos sin autorrenovar (movimiento `caducidad`, notificación), renovar los `auto_renovar` (movimiento `renovacion_auto`), purgar sesiones/tokens caducados y `correos_salida` enviados > 30 d, anotar `registro_actividad`, actualizar el ajuste. También al arrancar.

---

## 5. Torno

### 5.1 Token de servicio
- `MSD_TOKEN_TORNO` en el panel Node de Plesk: `torno-pabellon:<64 hex>` (lista separada por comas para rotación: el servidor acepta todos). Generar con `node -e "console.log(require('crypto').randomBytes(32).toString('hex'))"`. `autenticarTorno(req)`: `Authorization: Bearer x` → compara `sha256(x)` con cada `sha256(token)` por `timingSafeEqual`; 401 + `WWW-Authenticate: Bearer`; fallos 10/min por IP → 429. Guarda en memoria `torno = {nombre, ultimoContacto, ip, version, desfaseMs}` (expuesto en `/api/admin/torno/estado`, "Torno en línea hace 40 s").
- Pi: `MSD_TOKEN_TORNO` en `/etc/acceso-torno.env` (0600); `acceso/config.js` lee `cfg.TOKEN`; `pedir()` añade la cabecera **solo si el host de destino es el de `cfg.WEB`** (no reenviar el token en redirecciones a otro host), `req.setTimeout(8000)`, cabecera `X-Torno-Version` (hash del commit). 401/403 en la sync → log explícito "TOKEN DEL TORNO RECHAZADO (revisa MSD_TOKEN_TORNO)" y se conserva la caché (distinto de "sin red"). Aviso en rojo si lleva > 30 min sin sincronizar.

### 5.2 `GET /api/torno/socios` (Bearer, `no-store`, ETag)
Respuesta `{version:2, generado:<epochMs>, socios:[{id, nombre, nfcUid, nfcId, qrSeed, activo, hasta:'YYYY-MM-DD', birthdate:'YYYY-MM-DD'|'', gym:{franja:'10:00', fin:'11:00'}|null}]}` — los mismos campos que hoy indexa `acceso.js:138-146` (en `acceso.js` solo cambian URL, cabecera, y se añade `gym`). SQL: `usuarios JOIN abonos JOIN carnets LEFT JOIN gimnasio_inscripciones` (solo filas con carnet no revocado y `nfc_uid` o `nfc_id_legacy`; incluye inactivos/caducados para dar motivos útiles; `gym` solo si el estado calculado es `asignado`; `eliminado_en IS NULL`). ETag = sha256 de `(COUNT, MAX(actualizado_en))` de usuarios/abonos/carnets/gimnasio → `If-None-Match` → 304 (la sync puede bajar a 60 s sin coste). `generado` permite a la Pi medir desfase de reloj y avisar si > 20 s. Único endpoint que devuelve `qrSeed`. `GET /api/torno/ping` → `{ok, ahora}`.

`POST /api/torno/acceso` (Bearer): cuerpo `{evento:{id?, ts, usuarioId|null, metodo, resultado, motivo, direccion, raw, avisos?:[]}}` (mismo contrato que hoy + `id` UUID y `avisos`). El servidor valida forma, `ts` en `[ahora−30 d, ahora+5 min]`, re-resuelve `usuario_id` por `raw` (`nfc_uid`, `nfc_id_legacy` o prefijo del payload dinámico) — no se fía del id del torno; NULL si no casa —, guarda `dispositivo`, y ante `ER_DUP_ENTRY` en `evento_uid` responde 200 `{ok, duplicado:true}` (idempotente). Difunde `{tipo:'acceso'}` a monitor/admin y `{tipo:'aforo'}` a todos. Hasta que la Pi mande `id`, dedupe por `(raw, direccion, ts±2 s)`.

### 5.3 QR dinámico sin semilla en el navegador (paridad garantizada)
- `acceso/token.js` se mueve a **`lib/token.js`** (único módulo; `acceso/token.js` queda como `module.exports = require('../lib/token')` para que la Pi, que hace `git pull` del mismo repo, use literalmente el mismo fichero). `js/token.js` se elimina de las páginas (incluido el fallback FNV). Algoritmo intocable: `código = HMAC-SHA256(Buffer.from(seedHex,'utf8'), nfcUid+'|'+T)`, `readUInt32BE(0) % 1e8` a 8 dígitos, `T = floor(epochMs/1000/30)`, tolerancia ±2, `esDinamico` = numérico y longitud ≥ 12. `test/token.test.js` (`node --test`): `codigo('1399878112','a1b2c3d4e5f60001',59000000) === '71580974'`.
- `GET /api/mi/qr` (sesión, abono vigente, carnet no revocado): `{nfcUid, desdeT: T_actual, ventana: 30, codigos: [20 códigos T..T+19], servidorMs}`. El front calcula `offset = servidorMs − Date.now()`, `T = floor((Date.now()+offset)/30000)`, pinta `nfcUid + codigos[T−desdeT]`, cuenta atrás local, y repide cuando quedan 3 ventanas y hay red. Sin red y agotado: "Sin cobertura: acerca tu pulsera o pide ayuda en recepción" + últimos 4 dígitos del UID. Coste de una filtración del lote: 10 min de acceso de esa persona (frente a la semilla perpetua de hoy). Rate limit 30/min.
- Emisión de carnet solo por el admin (§4.2); `qr_seed = randomBytes(16).toString('hex')` (32 hex, mismo formato que hoy para que el HMAC use los bytes UTF-8 del string). El UID completo deja de mostrarse en carnet/perfil (solo últimos 4; el QR con el UID desnudo abre el torno por el match-first).
- Futuro Wallet: `carnets.qr_fijo` con payload distinto del UID desnudo (prefijo + uid + firma estática) para que `procesarLectura` lo distinga y pueda aplicar anti-passback estricto; no toca el algoritmo dinámico.

### 5.4 Reglas compartidas, hora de gimnasio y anti-passback (`acceso/reglas.js`, Node puro, sin estado)
`validar(socio, {direccion, hoy, ahoraMin, ultimo}) → {resultado, motivo, avisos}`. Lo usan la Pi y `POST /api/admin/torno/validar`. Reglas: no reconocido → denegado; salida → ok; `!activo` → 'Abono dado de baja'; `hasta < hoy` → 'Abono caducado'; edad < 16 → denegado; si no → ok.
- **Hora de gimnasio: AVISAR por defecto** (`MSD_GYM_MODO=avisar|denegar`, default avisar): el torno es la puerta de todo el complejo (pistas, clases, recepción), así que fuera de `[inicio−15 min, fin]` el resultado es `ok` con `avisos:['Fuera de su hora de gimnasio (10:00–11:00)']`; sin franja no hay aviso. El panel de monitor/admin lo pinta en ámbar.
- **Anti-passback**: estado local `ultimos[socioId]={entradaMs,salidaMs}` en memoria + `acceso/estado-torno.json` (0600); segunda ENTRADA sin SALIDA intermedia → si < 90 s (`MSD_ANTIPASSBACK_MS`) **denegado** 'Ya ha entrado hace un momento' (pasar la pulsera al de detrás); si más → ok con aviso 'Entrada sin salida previa'; reset por salida o a las 04:00. Endurecer a denegar siempre solo cuando se cablee el sensor de giro (`paso:true`).

### 5.5 Sync y cola offline
- Sync: `setInterval` 60 s con ETag, flag `sincronizando` contra solape, **sync-on-miss** (lectura numérica 'no reconocido' → sync inmediata con throttle 10 s y revalidación: la pulsera recién asignada en recepción entra a la primera). Caché versionada `{version:2, generado, socios}` con `cargarCacheDisco` tolerante al formato antiguo (array); ficheros con `{mode:0o600}`. Salvaguarda de hoy (0 socios → conservar caché) se mantiene, pero 401/403 se loguean aparte.
- Cola: `id = randomUUID()` por evento; reintentar solo ante red/timeout/5xx/401/429; ante otro 4xx descartar y loguear; tope 5000 (descarta los más antiguos avisando); corregir la carrera de `vaciarCola` (`cola = quedan.concat(cola.slice(pendientes.length))`); se vacía tras una sync con 200/304.
- Repo: `acceso/cache-socios.json`, `cola-accesos.json`, `estado-torno.json` en `.gitignore` y borrados del árbol; `acceso-torno.env` sin Render y con `MSD_TOKEN_TORNO=` comentado; `instalar-servicio.sh` avisa si falta el token; `lector-mock.js` lee socios de un fichero local en vez de los demo.

---

## 6. Front

**Principio**: el front deja de tener "almacenes" y pasa a ser vistas async que piden datos; `localStorage` solo para caché de lectura (`msd_yo_cache`, `msd_ui`, `msd_cache_catalogo`, `msd_cache_disponibilidad:<fecha>`, `msd_cache_mis_reservas`, `msd_qr_lote`) con `ts` y caducidad ≤ 24 h; nunca datos ajenos ni secretos; se borra todo al cerrar sesión; limpieza única de claves legadas en el primer arranque (`msd_version=2`).

**Módulos nuevos/reescritos**
- `js/api.js` (`MSDApi`): `api(metodo, ruta, cuerpo)` con `credentials:'same-origin'`, `Content-Type: application/json`, `X-Requested-With: MSD`, `cache:'no-store'`; 401 → vacía `yo`, `pintarSesion()`, `#/acceso` 'Tu sesión ha caducado'; 403 → 'Sin permiso'; 409/422 → devuelve el cuerpo a la vista; 429 → mensaje con `Retry-After`; red caída → banda 'Sin conexión' y caché si la hay. Único lugar con `fetch(` (grep al terminar).
- `js/auth.js` reescrito como cliente de sesión conservando el namespace `MSDAuth` y las firmas que ya usan `app.js`/`admin.js`: `listo` = `GET /api/auth/yo`; `sesionActual()` síncrono sobre el objeto cacheado; `entrar`, `registrar`, `salir`, `actualizarPerfil`, `cambiarClave`, `recuperar`, `restablecer`, `reenviarVerificacion`; `cargaQrDinamica()` → lote de `/api/mi/qr`; `usuarios()`/`buscarPorId()` solo para admin sobre `GET /api/admin/usuarios`. Desaparecen `hashTexto`, `nuevaSal`, `sembrar`, `entrarDemo`, `migrarCarnets`, `saneaUsuarios`, `validarAcceso*`, `anotarAcceso`, `asegurarCarnet`, `activarAbono`, `ejecutarAutomatizaciones`, `aforoHoy`.
- `js/tiempo-real.js` (`MSDEventos`): `EventSource('/api/eventos')`, `on(tipo, cb)`, reconexión con backoff; ante un evento relevante para la vista actual repide SOLO esa vista con debounce 300 ms; el acceso en vivo del panel/monitor se pinta con el payload del evento. Sustituye a `js/sync.js` y al listener `storage`.
- Fuera: `js/sync.js`, `js/demo.js`, `js/token.js` (de las páginas), `js/qr-prueba.js` + `qr-prueba.html`, `js/data.js` reducido a iconos (el catálogo viene de `/api/catalogo`), `js/gimnasio.js` reducido a `etiqueta()`; `js/qr.js` se mantiene (solo pinta el payload).

**Por pantalla (web vecinos, `index.html` + `js/app.js`)**
- Acceso/registro: login contra `POST /api/auth/entrar` con mensaje único 'Correo o contraseña incorrectos' (adaptar `app.js:1079` que enfocaba por `campo`); registro → pantalla 'Revisa tu correo' + 'Reenviar'; enlace 'He olvidado mi contraseña' (`index.html:419`); rutas nuevas `#/recuperar`, `#/restablecer?token=`, `#/verificar?token=` ('verificando…' → resultado). Quitar credenciales impresas (`index.html:425`), 'Sin crear cuenta' (`:316`), 'Prototipo de demostración' (`:574`). Si `debeCambiarClave` → forzar `#/perfil` cambio de clave.
- Inicio/buscador/parrilla: `GET /api/catalogo` + `GET /api/disponibilidad?fecha=`; eliminar ocupación simulada (`app.js:51-59, 323-334, 347`); aforo de `GET /api/aforo` y evento `aforo`.
- Confirmar reserva: `POST /api/reservas {pistaId,fecha,hora}`; éxito, `.ics` y 'Mis reservas' SOLO con la respuesta; sin fallback offline (`app.js:1735`), sin empuje de `msd_reservas` (`:1739`), botón deshabilitado hasta respuesta; el precio del resumen sale del mismo catálogo que usa el servidor.
- Mis reservas: `GET /api/mi/reservas`; cancelar `DELETE /api/reservas/:id`.
- Clases (solo consulta): `htmlTarjetaClase` sin Inscribirme/Cola/Baja; muestra ocupación + 'Inscripción presencial en la oficina de deportes'; con sesión, insignia 'Estás inscrito' / 'En lista de espera · puesto N' desde `yo().clases`. Borrar `inscribirse/ponerseEnCola/darseDeBaja/promocionarCola` (`app.js:931-976, 406-437`), `ajustesClases` (`:137-153`), handlers `:2041-2043`, bloque de baja en Mis reservas (`:887-914` → solo lectura), CTA 'Ver actividades e inscribirme' (`:1204`), textos `index.html:163, 270, 375, 402`, filtro 'con-plazas' con conteo real.
- Perfil/carnet: datos de `yo()`; abono solo consulta (sin alta/renovar/baja/autorrenovar, `app.js:1386-1414`); carnet con `/api/mi/qr` (§5.3), UID solo últimos 4, imprimir = nombre + vigencia; accesos `GET /api/mi/accesos`; gimnasio desde `yo().gimnasio`; campana `GET /api/mi/notificaciones` + `POST .../leidas`; 'Pedir información' → `POST /api/mi/solicitud-info`.
- Monitor: `GET /api/monitor/panel` y `GET /api/monitor/clases` (requiere `monitor_usuario_id` asignado en el panel; hasta entonces 'sin clases asignadas').

**Panel (`admin.html` + `js/admin.js`)**: login con `POST /api/auth/entrar` + `GET /api/auth/yo`; si no es admin, 'Esta cuenta no tiene permisos' (la API responde 403 igualmente); todo 401/403 → volver al login sin vistas a medias; nada del panel en `localStorage`. Secciones → `/api/admin/*` (tabla §4.2): resumen, reservas (+manual sin fallback, CSV en servidor), abonados (+carnet con UID real, 'modo alta' con lecturas desconocidas, verificar a mano, invitación), clases (alta/baja presencial; quitar 'Simular una baja'), gimnasio, tarifas/ajustes, bloqueos (la respuesta trae `afectadas`), torno (desaparecen 'Simular a un abonado' y 'Escanear su QR'; la cámara y el campo manual envían la lectura cruda a `POST /api/admin/torno/validar`; estado del torno en línea), accesos (+CSV), automatizaciones → registro, PLID → `GET /api/admin/ocupacion` con datos reales. Botones deshabilitados durante la petición; estados 'Cargando…', 'Reintentar', 'Sin conexión'.

**PWA (`sw.js`)**: `CACHE` → `msd-v4`; seguir sin cachear `/api/`; no cachear respuestas con `Set-Cookie`; fallback a `index.html` solo para navegaciones (no para `admin.html` ni assets); quitar `js/token.js`, `js/sync.js`, `js/demo.js` de `NUCLEO`. CSP por `<meta>` se mantiene alineada con la cabecera del servidor.

---

## 7. Dependencias

| Paquete | Uso | Justificación |
|---|---|---|
| `mysql2` ^3.11 (ya existe) | pool, transacciones, `namedPlaceholders`, `dateStrings` por tipo | única dependencia; ya desplegada y funcionando en Plesk |

Todo lo demás con Node ≥ 18 nativo (Plesk: 22): `crypto.scrypt/randomBytes/randomUUID/createHmac/timingSafeEqual` (hash, tokens, sesiones, HMAC del QR, Bearer), `net`/`tls` (cliente SMTP mínimo: STARTTLS + AUTH PLAIN contra un único servidor conocido), `http` + router propio (`lib/http.js`), validación declarativa propia (`lib/validar.js`), SSE nativo, `node:test` para pruebas. **Descartados y por qué**: `bcrypt`/`argon2` (módulos nativos; `npm install` en Plesk solo funciona desde el botón del panel y las prebuilds fallan con nodenv), `bcryptjs` (lento, trunca a 72 B), `nodemailer` (0 deps y puro JS: sería la única excepción aceptable si el Postfix de Plesk exigiera algo que el cliente mínimo no cubra), `express`/`helmet`/`express-rate-limit` (un router de 120 líneas y cabeceras fijas no lo justifican), frameworks de front (fuera por consigna). Sin devDependencies; Playwright se usa como está hoy (fuera del `package.json` del despliegue).

---

## 8. Plan por fases (cada fase se despliega en Plesk con el sistema funcionando)

Convenciones: `[S]` servidor, `[F]` front, `[P]` Pi, `[D]` BD/ops. Pruebas: `node --test test/` en local + BD `deportes_pruebas` de Plesk (o MariaDB portable), Playwright para los recorridos de UI, y comprobación manual en el dominio temporal.

### F0 — Hotfix inmediato (½ día, sin tocar el front salvo `<script>`)
- `[S] server.js`: borrar `POST /api/reiniciar`; `try/catch` alrededor de `decodeURIComponent` + `try/catch` global del manejador + `process.on('unhandledRejection')`; estáticos por lista blanca (cierra `server.js`, `almacen.js`, `acceso/`, `data/`, `*.md`, `.git`); cabeceras de seguridad (§3.3); `Cache-Control: no-store` en `/api`.
- `[F]` quitar `<script src="js/demo.js">` de `index.html:601` y `admin.html:428` y las credenciales impresas (`index.html:425`, `admin.html:120`, `README.md:27-35`); `sw.js` → `msd-v4`.
- `[D]` Plesk: directivas Apache que bloqueen `/acceso/`, `/data/`, `/.git`, `/node_modules`, `*.js` de raíz, `*.md`, `*.env`; confirmar 1 instancia de Passenger; pedir Let's Encrypt.
- Prueba: `curl -X POST /api/reiniciar` → 404; `curl /server.js` → 404; `curl /%` no tumba el proceso; la web y el torno siguen igual.

### F1 — Cimientos de servidor y BD (sin cambio visible)
- `[S]` nuevos `lib/bd.js` (pool §2), `lib/fechas.js`, `lib/token.js` (movido; `acceso/token.js` re-exporta), `lib/http.js` (router + middleware), `lib/validar.js`, `lib/vistas.js`, `lib/catalogo.js` (instalaciones/pistas espejo de `js/data.js`), `migrar.js`, `migraciones/001_esquema.sql`, `002_semillas.sql`; `server.js` ejecuta `migrar.js` antes de `listen`, monta el router nuevo junto a las rutas legadas (que siguen intactas), UPSERT del catálogo; `/api/salud` con `esquema_version`.
- Tests: `test/token.test.js` (vector `71580974`), `test/validar.test.js`, `test/fechas.test.js` (31 ene + 1 mes, cambio de hora), `test/http.test.js` (404 por defecto, 415/413).
- Prueba en `deportes_pruebas`: arranca, crea tablas, `SHOW TABLES`; despliegue en prod: `/api/salud` muestra `esquema_version: 2`; web y torno iguales.

### F2 — Auth en servidor, sesión en el front, fin del modo demo
- `[S]` `lib/clave.js`, `lib/sesion.js`, `lib/limite.js`, `lib/correo.js` + bucle de `correos_salida`, rutas `/api/auth/*` y `/api/admin/usuarios*` (sin abono aún), `scripts/crear-admin.js` + bootstrap por entorno, `003_limpiar_demo.sql` (dump previo). **Capa de compatibilidad**: `GET /api/bootstrap` (sesión) devuelve las claves `msd_*` aún no migradas de `estado` filtradas por rol (vecino: solo lo suyo); `PUT /api/estado/:clave` exige sesión (admin cualquier clave no migrada; vecino solo `msd_reservas` y `msd_notificaciones`, hueco temporal documentado que cierra F4); `GET /api/estado` público pasa a devolver solo `{msd_usuarios: []}` (forma torno; vacío hasta F3); SSE exige sesión y emite `{tipo:'legado', clave}`. Variables nuevas en Plesk: `MSD_URL_PUBLICA`, `MSD_SMTP_*`, `MSD_BOOTSTRAP_ADMIN_*`.
- `[F]` `js/api.js`, `js/auth.js` reescrito, `js/tiempo-real.js`; borrar `js/sync.js`, `js/demo.js`, `.demo-barra`, siembra/migraciones/`ejecutarAutomatizaciones`; pantallas de verificación/recuperación/restablecer; login del panel; limpieza de claves legadas; `app.js`/`admin.js` cargan `localStorage` desde `/api/bootstrap` (resto de pantallas sin cambios); `sw.js` → `msd-v5`.
- Prueba: registro → correo real en Gmail/Outlook → verificar → entrar → cookie `__Host-msd_sid`; login erróneo 5 veces → 423; `GET /api/auth/yo` sin cookie → 401; `PUT /api/estado/msd_bloqueos` como vecino → 403; test de fuga de secretos; bootstrap del admin real y borrado de variables; Playwright: registro/login/recuperar. Torno: sigue con su caché (no hay socios todavía).

### F3 — Abonados, carnet con QR en servidor y torno con token
- `[S]` rutas admin de abono/carnet/torno (§4.2), `/api/mi/qr`, `/api/torno/socios|acceso|ping`, `/api/admin/torno/validar` con `acceso/reglas.js`; `POST /api/acceso` legado escribe ya en tabla `accesos`; `msd_accesos` del bootstrap se compone desde la tabla (monitor/admin últimos 50, vecino los suyos); variable `MSD_TOKEN_TORNO`; flag `MSD_TORNO_EXIGIR_TOKEN=0` al desplegar (GET `/api/estado`/POST `/api/acceso` sin token siguen vivos unas horas).
- `[P]` `acceso/acceso.js`: URL `/api/torno/socios`, cabecera Bearer condicionada al host, timeout, `X-Torno-Version`, caché v2, sync 60 s + ETag + sync-on-miss, `id` por evento, cola robusta, `reglas.js`, gym avisar, anti-passback; `acceso/config.js` (`TOKEN`, `GYM_MODO`, `ANTIPASSBACK_MS`); `.gitignore`; `acceso-torno.env` sin Render. En la Pi: `git pull`, editar `/etc/acceso-torno.env` (`MSD_WEB=https://<dominio>`, `MSD_TOKEN_TORNO=…`), borrar `cache-socios.json` y `cola-accesos.json`, `systemctl restart acceso-torno`, comprobar en journal 'Sincronizados N socios' y en el panel 'Torno en línea'. Después: `MSD_TORNO_EXIGIR_TOKEN=1` y retirar `GET /api/estado` y `POST /api/acceso` sin token.
- `[F]` panel abonados/carnet/torno; carnet del vecino con `/api/mi/qr`; quitar `js/token.js` de las páginas, autoservicio de abono y 'Simular a un abonado'/'Escanear su QR'; UID últimos 4.
- Prueba: admin da de alta abono + pulsera real → en ≤ 60 s aparece en `cache-socios.json`; vecino abre carnet → QR del servidor → el torno real abre; `test/token.test.js` en servidor y Pi; cola offline (desconectar la Pi, pasar 3 pulseras, reconectar → 3 accesos sin duplicados aunque se reenvíe); `curl /api/torno/socios` sin Bearer → 401; test de fuga (ninguna respuesta con sesión contiene `qrSeed`).

### F4 — Catálogo, disponibilidad, reservas, bloqueos, ajustes/tarifas, notificaciones, SSE tipado
- `[S]` `/api/catalogo`, `/api/disponibilidad`, `/api/aforo`, `/api/reservas` (transacción + UNIQUE), `/api/mi/reservas|notificaciones|solicitud-info`, `/api/admin/reservas*|bloqueos*|ajustes|tarifas`, eventos `disponibilidad|mi|admin`; las claves `msd_reservas/msd_bloqueos/msd_config/msd_tarifas/msd_notificaciones` salen del bootstrap y el PUT compat queda **solo admin** (`msd_inscripciones`, `msd_clases_ajustes`, `msd_gimnasio*`, `msd_automatizaciones`).
- `[F]` inicio/buscador/parrilla/confirmar/mis reservas/campana con la API; fin de la simulación; panel reservas/bloqueos/tarifas/ventana; `js/data.js` reducido.
- Prueba: dos navegadores reservan el mismo hueco a la vez → uno 201, otro 409; bloqueo anula reservas y notifica; Playwright reserva/cancela; el evento `disponibilidad` repinta la parrilla del otro navegador.

### F5 — Clases en BD (solo presencial) y gimnasio por horas
- `[S]` `/api/admin/clases*`, `/api/admin/gimnasio*`, `/api/monitor/clases`, `yo().clases/gimnasio`, promoción de colas en transacción, socios en `/api/torno/socios` con `gym`; salen del bootstrap `msd_inscripciones`, `msd_clases_ajustes`, `msd_gimnasio*`.
- `[F]` clases solo lectura; panel clases/gimnasio sobre la API; `js/gimnasio.js` mínimo.
- Prueba: baja en clase llena → el primero de la cola pasa a inscrito y recibe notificación; `uq_gim_usuario_viva` → 409; el torno avisa fuera de hora.

### F6 — Monitor, accesos/auditoría/CSV/PLID y cierre de la capa de compatibilidad
- `[S]` `/api/monitor/panel`, `/api/admin/accesos*`, `/api/admin/resumen|ocupacion|registro`, CSVs en servidor, tarea diaria; `GET /api/bootstrap` y `PUT /api/estado/:clave` → 410 JSON; `msd_automatizaciones` → `registro_actividad`.
- `[F]` panel monitor, accesos, registro, PLID; borrar todo resto de lectura de `localStorage` de datos; grep de `fetch(` y de `msd_` en `js/`.
- Prueba: test de fuga completo; Playwright de todas las secciones por rol; `GET /api/estado` → 404.

### F7 — Retirada definitiva y endurecimiento
- `[D]` `004_retirar_legacy.sql` (`DROP TABLE estado`) tras comprobar 2 semanas; purga programada; copia de seguridad de BD en Plesk.
- `[S]` borrar `almacen.js` (modo fichero) o dejarlo solo para dev local; revisar CSP (intentar quitar `'unsafe-inline'` de `style-src` con una pasada de estilos inline → clases); `README.md` (variables, scripts, orden de despliegue, Pi).
- `[P]` valorar `User=` dedicado en el `.service` (probar `pinctrl` en el pabellón).
- Pendiente de negocio (no bloquea): ¿pases del día para quien reserva pista sin abono? Carnet Wallet (`qr_fijo`). Anti-passback estricto con sensor de giro.

---

## 9. Riesgos y mitigaciones

| Riesgo | Mitigación concreta |
|---|---|
| **Torno a ciegas** si `/api/estado` se cierra antes de actualizar la Pi | Orden F3: servidor con `/api/torno/*` + flag `MSD_TORNO_EXIGIR_TOKEN=0` → actualizar Pi y env → journal 'Sincronizados N' + panel 'Torno en línea' → flag a 1 → retirar legado. La Pi distingue 401 de 'sin red' y conserva caché. |
| **Paridad del QR** (cualquier cambio en seed utf-8, `uid|T`, BE, mod 1e8, ventana 30, ±2 rompe todos los QR) | Un único `lib/token.js` requerido por servidor y Pi (mismo repo), vector fijo `71580974` en `node --test` en ambos lados, `generado`/`ping` para medir desfase, NTP en la Pi. |
| **Carnet sin cobertura** (hoy el QR se generaba offline) | Lote de 20 ventanas (10 min), T del servidor (desaparece el 'caducado' por reloj del móvil), mensaje claro, pulsera NFC como vía principal; no ampliar el lote. |
| **Ids/semillas antiguas en la Pi** (`cache-socios.json` con `u-…` y seeds demo) | Borrar caché y cola al actualizar; el servidor re-resuelve `usuario_id` por `raw` y deja NULL si no casa; seeds demo nunca se reutilizan (carnets nuevos con `randomBytes`). |
| **Duplicados de la cola offline** | `evento_uid` UNIQUE + 200 idempotente; dedupe por `(raw, direccion, ts±2 s)` hasta que la Pi mande `id`; reintento solo ante red/5xx/401/429; tope 5000. |
| **Atomicidad con handlers async** (ya no hay "una petición de principio a fin") | UNIQUE `uq_reservas_hueco`, `uq_gim_usuario_viva`, `uq_insc_viva`, `uq_carnets_nfc_uid`, `uq_usuarios_email` + transacciones con `FOR UPDATE`; `ER_DUP_ENTRY` → 409 (mismo mensaje que hoy). |
| **Varias instancias de Passenger** (rate limit, semáforo scrypt, SSE en memoria) | Sesiones y bloqueo de cuenta en BD; forzar `PassengerMinInstances 1` / `PassengerMaxPoolSize 1` antes de producción; plan B si algún día hay varias: tabla `eventos` sondeada cada 1-2 s para SSE. |
| **SSE por rol** (antes se difundían blobs enteros a cualquiera) | Eventos tipados sin datos salvo `acceso` (autenticado); `mi` enrutado solo al afectado; máx. 2 conexiones por sesión; debounce 300 ms y refetch solo de la vista visible. |
| **PWA con JS viejo** (`msd-v3` cachea `auth.js`/`sync.js` que llaman a `/api/estado`) | Bump de `CACHE` en cada fase; endpoints retirados responden 410 JSON; limpieza única de claves legadas (contienen hashes y seeds de la demo en cada dispositivo). |
| **Cookie Secure sin HTTPS** en el dominio temporal | No abrir registro sin Let's Encrypt; `Secure`/HSTS condicionados a `x-forwarded-proto` o `MSD_HTTPS`; comprobar que Apache reenvía la cabecera. |
| **IP del cliente tras nginx→Apache→Passenger** | Último valor de XFF solo si el socket es loopback; límite también por email; nunca bloqueo duro largo (15→60 min) para que nadie deje fuera al admin. |
| **Correo que no llega** (SMTP de Plesk en spam / deshabilitado en *.plesk.page) | SPF/DKIM en el dominio real, pruebas con Gmail/Outlook, outbox con reintentos y fallos visibles en el registro, vía presencial siempre (admin verifica y crea con invitación o clave temporal). |
| **scrypt en hosting compartido** | 32 MiB × 3 en vuelo; cola con tope y 503; formato con parámetros permite bajar a 2^14/8/5 sin migrar. |
| **Zona horaria** (MariaDB/Node probablemente en UTC) | `DATE` calculado en Node con Intl Europe/Madrid y pasado como parámetro; `DATETIME` UTC con `SET time_zone='+00:00'`; `dateStrings:['DATE']`; tests de fechas límite. |
| **Migraciones al arranque** (si fallan, Passenger reinicia en bucle) | Transacción por fichero, `GET_LOCK`, probar primero en `deportes_pruebas`, `/api/salud` con versión, `estado` se vacía (con dump) y solo se borra en F7. |
| **Secretos en httpdocs/repo** (Apache sirve antes que Node) | Credenciales solo en variables del panel Node y `/etc/acceso-torno.env`; logs en `MSD_DATA_DIR`; lista blanca de estáticos + reglas Apache; sacar caché/cola/env del repo. |
| **Bootstrap por entorno** | Solo si no hay admin; `debe_cambiar_clave=1`; anotado en auditoría; borrar las variables tras el primer arranque. |
| **Regla nueva clases/gimnasio presencial** | Retirar botones/textos/handlers listados en §6 (buscar `data-inscribir|data-cola|data-baja|inscrib` en js/html y actualizar Playwright); promoción de colas y emisión de carnet solo en servidor por admin. |
| **Monitores sin clases** (hoy por substring de nombre) | `clases.monitor_usuario_id` asignado desde el panel (F5); hasta entonces mensaje 'sin clases asignadas'. |
| **Crecimiento de tablas** (`accesos`, `registro_actividad` ya no se recortan) | ~70k filas/año: trivial; índices `ix_accesos_ts`/`ix_accesos_aforo` + LIMIT; purga horaria de sesiones/tokens y de `correos_salida`. |
| **Datos demo ya repartidos** (hashes, seeds `a1b2c3d4e5f6000N`, clave `MedinaAdmin2026` en el repo) | No se importan; limpieza de `localStorage`; admin real con clave nueva; ningún carnet real reutiliza esas seeds; `README` sin credenciales. |