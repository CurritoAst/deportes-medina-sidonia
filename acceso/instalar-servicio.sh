#!/usr/bin/env bash
# ==========================================================================
# Instala el servicio de acceso del torno como servicio de systemd, para que
# arranque SOLO al encender la Raspberry y se reinicie solo si falla.
#
# Uso (en la Raspberry, dentro del proyecto):
#     sudo bash acceso/instalar-servicio.sh
# ==========================================================================
set -euo pipefail

PROY_DIR="$(cd "$(dirname "$0")/.." && pwd)"
ENV_DEST=/etc/acceso-torno.env
UNIT_DEST=/etc/systemd/system/acceso-torno.service

if [ "$(id -u)" -ne 0 ]; then
  echo "Ejecútalo con sudo:  sudo bash acceso/instalar-servicio.sh" >&2
  exit 1
fi

# 1) ¿Node instalado?
if ! command -v node >/dev/null 2>&1; then
  echo "ERROR: Node no está instalado en la Raspberry." >&2
  echo "Instálalo (recomendado Node 18+):" >&2
  echo "  curl -fsSL https://deb.nodesource.com/setup_18.x | sudo -E bash - && sudo apt install -y nodejs" >&2
  exit 1
fi
echo "Node encontrado: $(node --version) en $(command -v node)"

# 2) Fichero de configuración (NO se sobreescribe si ya existe)
if [ ! -f "$ENV_DEST" ]; then
  cp "$PROY_DIR/acceso/acceso-torno.env" "$ENV_DEST"
  chmod 600 "$ENV_DEST"
  echo ">> Creado $ENV_DEST — EDÍTALO con tus IPs y pines antes de dar apertura real."
else
  echo ">> $ENV_DEST ya existe: se respeta tu configuración."
fi

# 3) Unit de systemd con la ruta REAL del proyecto
sed "s#/opt/deportes-medina-sidonia#${PROY_DIR}#g" \
    "$PROY_DIR/acceso/acceso-torno.service" > "$UNIT_DEST"
echo ">> Servicio instalado en $UNIT_DEST (proyecto en $PROY_DIR)"

# 4) Activar y arrancar
systemctl daemon-reload
systemctl enable acceso-torno >/dev/null 2>&1 || true
systemctl restart acceso-torno

echo
echo "==================================================================="
echo " Servicio de acceso instalado y arrancado (arranque automático ON)."
echo "==================================================================="
echo "  Estado:        sudo systemctl status acceso-torno"
echo "  Registro live: sudo journalctl -u acceso-torno -f"
echo "  Reiniciar:     sudo systemctl restart acceso-torno"
echo "  Parar:         sudo systemctl stop acceso-torno"
echo "  Editar config: sudo nano $ENV_DEST   (luego: sudo systemctl restart acceso-torno)"
echo
echo "SUGERENCIA: arranca primero en solo-escucha (MSD_SOLO_ESCUCHA=1 en el"
echo "fichero de config) para confirmar la lectura sin abrir nada; cuando esté"
echo "todo comprobado, comenta esa línea y reinicia el servicio."
