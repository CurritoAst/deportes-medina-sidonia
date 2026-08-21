#!/usr/bin/env bash
# ==========================================================================
# Borra la CACHÉ DE SOCIOS y la COLA del torno y reinicia el servicio.
#
# POR QUÉ (seguridad): la caché de la Pi puede contener los 3 socios de
# DEMOSTRACIÓN (Carmen/Paco/Lucía), cuyas semillas de QR estuvieron publicadas
# en el repositorio. Mientras esa caché exista, cualquiera podría generar su QR
# y abrir el torno. Tras limpiar, la Pi queda con 0 socios hasta que sincronice
# socios REALES desde la web (estado correcto mientras no haya abonados reales).
#
# Uso:  sudo bash acceso/limpiar-demo.sh
# ==========================================================================
set -euo pipefail
[ "$(id -u)" -eq 0 ] || { echo "Usa sudo:  sudo bash acceso/limpiar-demo.sh" >&2; exit 1; }

AQUI="$(cd "$(dirname "$0")" && pwd)"
CACHE="${MSD_CACHE:-$AQUI/cache-socios.json}"
COLA="${MSD_COLA:-$AQUI/cola-accesos.json}"

systemctl stop acceso-torno || true
for f in "$CACHE" "$COLA"; do
  if [ -f "$f" ]; then rm -f "$f"; echo "Borrado: $f"; else echo "No existía: $f"; fi
done
systemctl start acceso-torno

echo "Hecho. La Pi arranca sin socios en caché; sincronizará los reales desde la web."
echo "Comprueba:  sudo journalctl -u acceso-torno -f   (debe salir 'Sincronizados N socios' o 'Caché local cargada: 0')"
