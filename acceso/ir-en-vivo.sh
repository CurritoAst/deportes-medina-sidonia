#!/usr/bin/env bash
# ==========================================================================
# Pasa el torno de modo SEGURO (solo-escucha) a APERTURA REAL.
# Quita MSD_SOLO_ESCUCHA del fichero de configuración y reinicia el servicio.
#
# Uso:  sudo bash acceso/ir-en-vivo.sh
# Para volver al modo seguro:  añade  MSD_SOLO_ESCUCHA=1  en /etc/acceso-torno.env
# y  sudo systemctl restart acceso-torno
# ==========================================================================
set -euo pipefail
[ "$(id -u)" -eq 0 ] || { echo "Usa sudo:  sudo bash acceso/ir-en-vivo.sh" >&2; exit 1; }

ENV=/etc/acceso-torno.env
[ -f "$ENV" ] || { echo "No existe $ENV. ¿Instalaste el servicio?" >&2; exit 1; }

# Comenta cualquier línea MSD_SOLO_ESCUCHA activa
sed -i 's/^[[:space:]]*MSD_SOLO_ESCUCHA=1/#MSD_SOLO_ESCUCHA=1/' "$ENV"
systemctl restart acceso-torno

echo "Modo APERTURA activado: el torno ya abre de verdad."
echo "Registro en directo:  sudo journalctl -u acceso-torno -f"
