#!/usr/bin/env bash
# ==========================================================================
# Buscador de pines del relé: pulsa GPIO por GPIO para descubrir a cuál está
# cableado cada relé (útil con un HAT de pinout desconocido). Escucha el CLIC.
#
# Uso:  sudo bash acceso/buscar-pines.sh
# Personaliza la lista:  MSD_PINES_BUSCAR=17,27,22 sudo -E bash acceso/buscar-pines.sh
# ==========================================================================
set -euo pipefail
[ "$(id -u)" -eq 0 ] || { echo "Usa sudo:  sudo bash acceso/buscar-pines.sh" >&2; exit 1; }

DIR="$(cd "$(dirname "$0")/.." && pwd)"

# Libera el GPIO parando el servicio mientras barremos
systemctl stop acceso-torno 2>/dev/null || true

# Carga backend/polaridad de la configuración instalada (los pines los barre solo)
set -a
[ -f /etc/acceso-torno.env ] && . /etc/acceso-torno.env
set +a

node "$DIR/acceso/acceso.js" --buscar-pines

systemctl start acceso-torno 2>/dev/null || true
echo "Servicio de nuevo en marcha."
