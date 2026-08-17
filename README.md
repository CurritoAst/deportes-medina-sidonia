# Deportes · Medina Sidonia — plataforma de reservas

Prototipo completo de plataforma deportiva municipal para sustituir a Sporttia,
pensado para el Complejo Deportivo Prado de la Feria de Medina Sidonia (Cádiz).

## Cómo abrirlo

**Modo completo (recomendado)** — con servidor propio, datos compartidos entre
dispositivos y actualizaciones en directo:

```
node server.js
```

- **Web de vecinos**: http://localhost:8137
- **Panel de administración**: http://localhost:8137/admin.html
- **Desde el móvil** (misma wifi): la consola muestra la dirección, p. ej. `http://192.168.1.40:8137`

Los datos se guardan en `data/estado.json` y todos los dispositivos conectados
ven los cambios al momento (reservas, colas, accesos por el torno…) gracias a
eventos en directo (SSE). Además la web es una **PWA**: desde el móvil puedes
«Añadir a pantalla de inicio» y usarla como una app, incluso sin conexión.

**Modo simple** — doble clic en `index.html`: funciona igual pero solo en ese
navegador (localStorage), sin compartir datos.

## Cuentas de demostración

| Rol | Correo | Contraseña |
|---|---|---|
| Administración | `admin@medinasidonia.es` | `MedinaAdmin2026` |
| Vecina (abono en vigor) | `carmen@correo.es` | `Vecina2026` |
| Vecino (abono sin renovación automática) | `paco@correo.es` | `Vecino2026` |
| Vecina (abono caducado) | `lucia@correo.es` | `Vecina2026` |

## Qué incluye

### Web de vecinos
- **Buscador de huecos** en la portada: elige día y hora y te enseña todo lo
  libre del complejo; un toque y entras en la reserva con el tramo ya elegido.
- **Reserva de pistas en 3 pasos** (pádel, tenis, fútbol 7, pabellón, piscina,
  sala fitness) con disponibilidad de 14 días, suplemento de luz y localizador.
  La disponibilidad es solo para personas registradas.
- **Campana de notificaciones**: te avisa cuando la cola te da plaza, cuando tu
  abono se renueva o caduca, y cada reserva confirmada.
- **Añadir al calendario**: descarga la reserva en formato .ics desde la
  confirmación o desde «Mis reservas», y **«Reservar otra vez»** repite una
  reserva pasada en dos toques.
- **Cuenta de usuario**: registro e inicio de sesión (hash SHA-256 + sal),
  perfil editable, cambio de contraseña.
- **Clases dirigidas** con inscripción online y **lista de espera** con puesto;
  cuando se libera una plaza, la siguiente persona entra y queda avisada
  automáticamente.
- **Carnet deportivo digital**: abono mensual del gimnasio (18 €/mes) con
  **código QR real y escaneable** (generador propio, sin librerías) y **pulsera
  NFC virtual**, renovación automática opcional e historial de accesos.

### Panel de administración
- **Panel** con KPIs: abonados, reservas, clases completas, colas, accesos e
  ingresos estimados.
- **Reservas** de todos los vecinos, con cancelación.
- **Clases y colas**: ocupación, personas inscritas y en espera, bajas con
  promoción automática de la cola.
- **Abonados**: altas, renovaciones y bajas de abonos con emisión de carnet.
- **Torno de la pasarela de acceso**: simulador que lee pulseras NFC y códigos
  QR, valida abono y firma, anima la apertura/denegación y registra cada acceso.
  Incluye **lector real con cámara**: enfoca el QR del carnet (por ejemplo desde
  el móvil de un vecino) y el torno lo valida al instante.
- **Registro de automatización**: todo lo que el sistema hace solo (renovaciones,
  caducidades, avisos de cola, recibos).
- **Exportar CSV** de reservas, abonados y accesos (compatible con Excel), e
  **imprimir el carnet** desde el perfil del vecino.
- **Búsqueda y filtros**: busca abonados por nombre o correo y filtra las
  reservas por instalación o solo las próximas.
- **Responsive de verdad**: en el móvil las tablas se convierten en tarjetas
  legibles; auditado sin desbordamientos de 320 px a escritorio.

## Estructura

```
server.js          Servidor Node sin dependencias: estáticos + API de estado + SSE + registro de accesos
data/estado.json   Datos compartidos (lo crea el servidor)
index.html         Web pública (inicio, reservar, clases, mis reservas, acceso, perfil)
admin.html         Panel de administración
manifest.webmanifest · sw.js · icono.svg   PWA instalable y con soporte sin conexión
css/styles.css     Sistema de diseño completo (cal, albero, verde botella; Fraunces + Public Sans)
js/data.js         Instalaciones, precios, horarios y clases
js/qr.js           Generador de códigos QR propio (modo byte, ECC M, v1–5) validado con jsQR
js/token.js        Código QR DINÁMICO (rotatorio tipo TOTP, HMAC-SHA256) — navegador
js/sync.js         Sincronización con el servidor (descarga inicial, subida y SSE)
js/auth.js         Usuarios, sesión, abonos, torno (UID real, edad, aforo) y automatizaciones
js/app.js          Web pública: enrutado, reservas, clases, cola, perfil, carnet con QR dinámico
js/admin.js        Panel: KPIs, gestión, torno con cámara, asignación de UID, CSV y registro
js/vendor/jsQR.js  Lector de QR para la cámara (jsQR, licencia MIT)

acceso/            SERVICIO DE ACCESO del torno físico (Node puro, corre junto al torno)
  acceso.js        Cliente TCP a los lectores del HF5122, dedup, validación, caché local, relé
  token.js         Mismo QR dinámico que js/token.js pero para Node (deben coincidir)
  config.js        Configuración (IPs/puertos de lectores, pines GPIO, modos)
  lector-mock.js   Lector SIMULADO para desarrollar y probar sin el hardware real
```

## Torno de acceso real

El torno físico (lectores NFC/QR sobre un HF5122 en `192.168.1.35`, puertos TCP
`8899` entrada y `9999` salida) se integra con un **servicio de acceso** aparte,
en `acceso/`, que reemplaza al controlador del instalador. A diferencia de aquel
(que dependía de una nube por MQTT y no abría sin internet), la decisión es
**local**: valida contra una caché de socios que sobrevive a cortes de red.

```
node server.js                 # 1) la web, en :8137
node acceso/lector-mock.js     # 2) lector simulado (o el torno real por red)
node acceso/acceso.js          # 3) el servicio de acceso
```

En el `mock` interactivo: `e <uid>` pasa una tarjeta por entrada, `qe carmen`
manda el QR dinámico de un socio, `s <uid>` una salida. Para el torno real:
`MSD_HOST_ENTRADA=192.168.1.35 MSD_HOST_SALIDA=192.168.1.35 node acceso/acceso.js`.
Modo solo-escucha (no abre ni registra, solo imprime): `MSD_SOLO_ESCUCHA=1`.

### Relé de apertura (GPIO)

El disparo del relé es configurable por variables de entorno; por defecto
**simula** (no toca hardware). Prueba de cableado sin tarjetas:
`node acceso/acceso.js --test-rele` (dispara cada relé y LED por turnos).

| Variable | Para qué | Valores |
|---|---|---|
| `MSD_GPIO` | Método de acceso al GPIO | `sim` (def.) · `pinctrl` (Pi OS reciente) · `raspi-gpio` (Pi OS antiguo) · `sysfs` |
| `MSD_GPIO_NUM` | Numeración de los pines | `bcm` (def.) · `board` (pin físico del header) |
| `MSD_RELE_ACTIVO_BAJO` | Polaridad (relés Waveshare suelen serlo) | `1` = activo-bajo |
| `MSD_PIN_ENTRADA` / `MSD_PIN_SALIDA` | Pin del relé de cada sentido | nº (def. 26 / 20) |
| `MSD_PIN_LED_VERDE` / `MSD_PIN_LED_ROJO` | LEDs (opcionales) | nº |
| `MSD_PULSO_MS` | Duración del pulso de apertura | ms (def. 600) |

Ejemplo en la Raspberry del torno:
`MSD_GPIO=raspi-gpio MSD_RELE_ACTIVO_BAJO=1 MSD_PIN_ENTRADA=26 MSD_PIN_SALIDA=20 node acceso/acceso.js`

### Arranque automático en la Raspberry (systemd)

Para que el servicio arranque solo al encender la Pi y se reinicie solo si
falla, hay un instalador de un comando. En la Raspberry, dentro del proyecto:

```
sudo bash acceso/instalar-servicio.sh
```

Crea el servicio `acceso-torno` (systemd) y deja la configuración en
`/etc/acceso-torno.env` (IPs de los lectores, web, pines del relé…), fácil de
editar sin tocar código. Comandos:

```
sudo systemctl status acceso-torno       # estado
sudo journalctl -u acceso-torno -f        # registro en directo
sudo nano /etc/acceso-torno.env           # cambiar config
sudo systemctl restart acceso-torno       # aplicar cambios
```

Requiere Node en la Pi (`sudo apt install -y nodejs`, o Node 18+ de NodeSource).
Consejo: empieza con `MSD_SOLO_ESCUCHA=1` en el fichero de config para validar la
lectura sin abrir nada; cuando esté comprobado, coméntalo y reinicia.

> Si reutilizas la misma Raspberry del instalador, **desactiva antes su sistema**
> (el de Sporttia arrancaba por cron cada minuto: `sudo crontab -e` y quita/comenta
> la línea de `sdaemon`), para que no compita por el lector ni por el relé.

Novedades frente al sistema anterior:
- **QR dinámico** (rotatorio cada 30 s, firmado, **numérico** para que cualquier
  lector lo transmita): una captura del QR deja de valer a los segundos.
- **UID real** de tarjeta (decimal ~10 díg.) y **control de edad** (mín. 16).
- **Aforo en tiempo real** en la portada: entradas − salidas del día.
- **Registro de accesos** con sentido (entrada/salida), método y valor leído.
- **Aviso en vivo** en el panel cuando alguien pasa por el torno.

## Notas de seguridad (prototipo)

Todo lo que se pinta pasa por escapado HTML y todo lo que se lee de localStorage
se valida contra un esquema estricto; ambas páginas llevan Content-Security-Policy.
Aun así, la autenticación vive en el navegador (no hay servidor): para producción
harían falta un backend con sesiones, pagos y avisos reales por correo.

Sobre el **QR dinámico**: el código rotatorio ya derrota al robo por captura de
pantalla (el fallo del QR estático anterior). Para el modelo de amenaza completo,
en producción la **semilla** de cada socio debe vivir solo en el servidor —hoy,
como el resto del estado del prototipo, se descarga al navegador— y el código lo
generaría y validaría el backend con sesión de servidor. El **servicio de acceso**
(`acceso/`) ya valida en local contra su caché, que es lo correcto para que el
torno siga abriendo sin red.

> Prototipo de demostración: no es la web oficial del Ayuntamiento de Medina Sidonia.
