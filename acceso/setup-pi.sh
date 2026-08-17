#!/usr/bin/env bash
# ==========================================================================
# Instalación TODO-EN-UNO del torno en una Raspberry Pi limpia.
# Instala Node, descarga el proyecto y deja el servicio con arranque automático,
# ya configurado con las IPs de la instalación. Arranca en modo SEGURO
# (solo-escucha: registra pero no abre) hasta que calibres el relé.
#
# Uso en la Pi (una sola vez):
#     curl -fsSL https://raw.githubusercontent.com/CurritoAst/deportes-medina-sidonia/main/acceso/setup-pi.sh | sudo bash
# o, si ya tienes el proyecto clonado:
#     sudo bash acceso/setup-pi.sh
# ==========================================================================
set -euo pipefail

REPO=https://github.com/CurritoAst/deportes-medina-sidonia.git
DEST=/opt/deportes-medina-sidonia

if [ "$(id -u)" -ne 0 ]; then
  echo "Ejecútalo con sudo. Ejemplo:" >&2
  echo "  curl -fsSL https://raw.githubusercontent.com/CurritoAst/deportes-medina-sidonia/main/acceso/setup-pi.sh | sudo bash" >&2
  exit 1
fi

echo "== 1/4 · Node =="
if ! command -v node >/dev/null 2>&1; then
  echo "Instalando Node 22 (NodeSource)…"
  curl -fsSL https://deb.nodesource.com/setup_22.x | bash -
  apt-get install -y nodejs
fi
echo "Node: $(node --version)"

echo "== 2/4 · git =="
command -v git >/dev/null 2>&1 || apt-get install -y git

echo "== 3/4 · Proyecto en $DEST =="
if [ -d "$DEST/.git" ]; then
  git -C "$DEST" pull --ff-only || echo "(no se pudo actualizar; se usa lo que hay)"
else
  git clone "$REPO" "$DEST"
fi

echo "== 4/4 · Servicio (arranque automático) =="
bash "$DEST/acceso/instalar-servicio.sh"

echo
echo "======================================================================="
echo " LISTO. Al encender la Pi, el torno arranca solo."
echo " Ahora mismo está en modo SEGURO (solo-escucha): registra los pases pero"
echo " NO abre, para que confirmes la lectura sin riesgo."
echo "-----------------------------------------------------------------------"
echo " 1) Confirma la lectura:   sudo journalctl -u acceso-torno -f"
echo "    (pasa una tarjeta / QR y comprueba que aparece)"
echo " 2) Calibra el relé:       sudo bash $DEST/acceso/test-rele.sh"
echo "    (si algún relé no cierra, edita los pines en /etc/acceso-torno.env)"
echo " 3) Da apertura real:      sudo bash $DEST/acceso/ir-en-vivo.sh"
echo "======================================================================="
