-- ============================================================
-- 001_esquema.sql — esquema relacional completo (MariaDB 11.x / MySQL 8)
-- Deportes · Medina Sidonia. Ver docs/DISENO-produccion-segura.md §2.
-- Principios: PK BIGINT internas; secretos hasheados (contraseña scrypt,
-- cookie y tokens de correo como SHA-256); la qr_seed es el único secreto en
-- claro y vive en `carnets` (solo la leen /api/mi/qr y /api/torno/socios);
-- borrado lógico donde hay histórico; los DATE son días de Europe/Madrid
-- calculados en Node; los DATETIME(3) son UTC.
-- Lo ejecuta migrar.js dentro de una transacción (cada fichero = 1 versión).
-- ============================================================

CREATE TABLE IF NOT EXISTS migraciones (
  version     SMALLINT UNSIGNED NOT NULL PRIMARY KEY,
  nombre      VARCHAR(120) NOT NULL,
  aplicada_en DATETIME(3) NOT NULL DEFAULT CURRENT_TIMESTAMP(3)
) ENGINE=InnoDB DEFAULT CHARSET=utf8mb4 COLLATE=utf8mb4_unicode_ci;

-- ---------- USUARIOS Y AUTENTICACIÓN ----------
CREATE TABLE usuarios (
  id                  BIGINT UNSIGNED NOT NULL AUTO_INCREMENT PRIMARY KEY,
  legacy_id           VARCHAR(24) NULL,                 -- 'u-xxxxxxxx' del blob (solo referencia)
  email               VARCHAR(254) NOT NULL,            -- normalizado: trim + minúsculas
  email_verificado_en DATETIME(3) NULL,                 -- NULL => no puede iniciar sesión
  nombre              VARCHAR(120) NOT NULL,
  telefono            VARCHAR(20) NOT NULL DEFAULT '',
  fecha_nacimiento    DATE NULL,                        -- edad mínima 16 en el torno
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
  tipo          ENUM('verificar_email','recuperar_clave','invitacion','cambiar_email','desbloquear') NOT NULL,
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
  nfc_uid        VARCHAR(20) NULL,                      -- UID decimal REAL de la pulsera (6-20 dígitos); lo asigna el admin. Nunca se muestra al socio.
  nfc_id_legacy  CHAR(12) NULL,                         -- 'NFC-XXXXXXXX' solo compatibilidad; no se emiten nuevos
  qr_uid         CHAR(10) NOT NULL,                     -- identificador PROPIO del QR (10 dígitos aleatorios). Es el prefijo del QR; NO es el UID físico.
  qr_seed        CHAR(32) NOT NULL,                     -- 16 B hex (crypto.randomBytes). SECRETO: solo /api/mi/qr y /api/torno/socios
  qr_fijo        VARCHAR(24) NULL,                      -- reservado al carnet Wallet (fase futura)
  emitido_en     DATETIME(3) NOT NULL DEFAULT CURRENT_TIMESTAMP(3),
  seed_rotada_en DATETIME(3) NULL,
  revocado_en    DATETIME(3) NULL,
  UNIQUE KEY uq_carnets_usuario (usuario_id),
  UNIQUE KEY uq_carnets_nfc_uid (nfc_uid),
  UNIQUE KEY uq_carnets_nfc_legacy (nfc_id_legacy),
  UNIQUE KEY uq_carnets_qr_uid (qr_uid),
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
CREATE TABLE instalaciones (                            -- ids = lib/catalogo.js; UPSERT al arrancar (nunca pisa precios)
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

CREATE TABLE clases (                                   -- sembrada una vez desde lib/catalogo.js; luego la edita el admin
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
  hora_inicio_min    SMALLINT UNSIGNED NOT NULL,        -- minutos desde medianoche
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

CREATE TABLE gimnasio_franjas (                         -- capacidad por franja (cubre el caso global)
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

CREATE TABLE registro_actividad (                       -- auditoría completa (antes msd_automatizaciones, máx 200)
  id               BIGINT UNSIGNED NOT NULL AUTO_INCREMENT PRIMARY KEY,
  ts               DATETIME(3) NOT NULL DEFAULT CURRENT_TIMESTAMP(3),
  tipo             VARCHAR(30) NOT NULL,                -- sistema, auth, abono, clases, reservas, usuarios, acceso, finanzas, gimnasio, correo
  texto            VARCHAR(400) NOT NULL,
  actor_usuario_id BIGINT UNSIGNED NULL,                -- NULL = automático
  entidad          VARCHAR(30) NULL,
  entidad_id       VARCHAR(40) NULL,
  ip               VARCHAR(45) NULL,
  KEY ix_registro_ts (ts),
  KEY ix_registro_tipo (tipo, ts),
  CONSTRAINT fk_registro_actor FOREIGN KEY (actor_usuario_id) REFERENCES usuarios(id) ON DELETE SET NULL
) ENGINE=InnoDB DEFAULT CHARSET=utf8mb4 COLLATE=utf8mb4_unicode_ci;

CREATE TABLE ajustes (                                  -- reserva_desde_dias, reserva_dias_ventana, abono_precio_mes, aforo_max, ...
  clave            VARCHAR(64) NOT NULL PRIMARY KEY,
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
