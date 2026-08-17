#!/usr/bin/env bash
# ==========================================================================
# Prueba de cableado del relé usando la configuración instalada.
# Para el servicio, dispara cada relé/LED por turnos (con los pines de
# /etc/acceso-torno.env) y vuelve a arrancar el servicio.
#
# Uso:  sudo bash acceso/test-rele.sh
# Si un relé no cierra: edita MSD_PIN_* / MSD_RELE_ACTIVO_BAJO / MSD_GPIO en
# /etc/acceso-torno.env y vuelve a lanzarlo.
# ==========================================================================
set -euo pipefail
[ "$(id -u)" -eq 0 ] || { echo "Usa sudo:  sudo bash acceso/test-rele.sh" >&2; exit 1; }

DIR="$(cd "$(dirname "$0")/.." && pwd)"

# Libera el GPIO parando el servicio mientras probamos
systemctl stop acceso-torno 2>/dev/null || true

# Carga la misma configuración que usa el servicio
set -a
[ -f /etc/acceso-torno.env ] && . /etc/acceso-torno.env
set +a

node "$DIR/acceso/acceso.js" --test-rele

# Vuelve a arrancar el servicio
systemctl start acceso-torno 2>/dev/null || true
echo "Servicio de nuevo en marcha."
