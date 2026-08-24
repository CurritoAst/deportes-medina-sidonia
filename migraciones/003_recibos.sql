-- ============================================================================
-- 003_recibos.sql — recibos de la mensualidad del abono (domiciliación)
-- · El PRIMER pago se hace en recepción con tarjeta al dar el alta (recibo
--   'pagado' con metodo 'tarjeta'); las renovaciones en mostrador, igual.
-- · Las mensualidades de la renovación AUTOMÁTICA salen como 'domiciliacion'
--   en estado 'pendiente': el banco cobra por fuera y recepción marca
--   'pagado' o 'devuelto' cuando recaudación le pasa las devoluciones.
-- · Un recibo 'devuelto' abre un plazo (ajustes.impago_margen_dias): dentro
--   del plazo el torno AVISA; vencido el plazo, DENIEGA la entrada.
-- ============================================================================

CREATE TABLE recibos (
  id              BIGINT UNSIGNED NOT NULL AUTO_INCREMENT PRIMARY KEY,
  usuario_id      BIGINT UNSIGNED NOT NULL,
  abono_id        BIGINT UNSIGNED NULL,
  periodo         CHAR(7) NOT NULL,                     -- 'AAAA-MM' del mes que cubre
  concepto        VARCHAR(120) NOT NULL,
  importe         DECIMAL(8,2) NOT NULL DEFAULT 0,      -- ajustes.abono_precio_mes en ese momento
  metodo          ENUM('tarjeta','domiciliacion','mostrador') NOT NULL DEFAULT 'domiciliacion',
  estado          ENUM('pendiente','pagado','devuelto','anulado') NOT NULL DEFAULT 'pendiente',
  pagado_en       DATETIME(3) NULL,
  devuelto_en     DATETIME(3) NULL,                     -- no nulo <=> estado 'devuelto'; aquí empieza el plazo
  creado_en       DATETIME(3) NOT NULL DEFAULT CURRENT_TIMESTAMP(3),
  actualizado_en  DATETIME(3) NOT NULL DEFAULT CURRENT_TIMESTAMP(3) ON UPDATE CURRENT_TIMESTAMP(3),
  actualizado_por BIGINT UNSIGNED NULL,                 -- admin que lo marcó; NULL = tarea automática
  KEY ix_recibos_usuario (usuario_id, creado_en),
  KEY ix_recibos_estado (estado, devuelto_en),
  CONSTRAINT fk_recibos_usuario FOREIGN KEY (usuario_id) REFERENCES usuarios(id) ON DELETE CASCADE,
  CONSTRAINT fk_recibos_abono FOREIGN KEY (abono_id) REFERENCES abonos(id) ON DELETE SET NULL,
  CONSTRAINT fk_recibos_por FOREIGN KEY (actualizado_por) REFERENCES usuarios(id) ON DELETE SET NULL
) ENGINE=InnoDB DEFAULT CHARSET=utf8mb4 COLLATE=utf8mb4_unicode_ci;

INSERT INTO ajustes (clave, valor) VALUES ('impago_margen_dias', '7')
  ON DUPLICATE KEY UPDATE clave = clave;
