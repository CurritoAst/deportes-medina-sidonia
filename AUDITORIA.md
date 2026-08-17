# AUDITORÍA — prototipo Deportes Medina Sidonia

Fase 0 del plan de demo. Respuestas directas a las seis preguntas, con el código delante.
Fecha: 29-07-2026.

## 1. ¿Dónde vive el estado y puede haber doble reserva?

**Hoy:** el estado vive en `localStorage` (claves `msd_*`) y, cuando se sirve con
`node server.js`, se sincroniza con un almacén central (`data/estado.json`) vía
una API de estado con eventos SSE. La escritura es **último-gana por clave
completa**: dos personas confirmando el mismo tramo con milisegundos de
diferencia **sí podían quedarse ambas con la reserva** (cada cliente valida
contra su copia local y sube el array entero).

**Resuelto en esta fase:** la confirmación pasa ahora por `POST /api/reservar`;
el servidor (Node, un solo hilo = serialización natural) comprueba el tramo
contra el estado central y responde **409 «Esa hora ya está cogida»** al segundo
que llega. Sin servidor (doble clic en `index.html`), se mantiene la validación
local — suficiente para un solo dispositivo, y así se documenta.

## 2. ¿Qué protege realmente `admin.html`?

**Solo el cliente.** El fichero se sirve a cualquiera; el contenido se pinta
únicamente si hay una sesión con rol `admin` en `localStorage` (login con hash
SHA-256+sal, pero verificado en el navegador). Un usuario técnico con la
consola abierta puede leer los almacenes compartidos. Para una demo es
suficiente y no engaña a nadie; para producción la autorización debe ocurrir
en servidor/BD. → `PENDIENTES.md`, fase siguiente.

## 3. axe-core (WCAG 2.1 A + AA), 29-07-2026

| Superficie | Violaciones |
|---|---|
| Web pública (`#/`) | **0** |
| Vista de acceso (formularios) | **0** |
| Panel de administración (con sesión) | **0** |

Además ya existen: enlace de salto al contenido funcional, foco gestionado en
cambios de vista y modales, `aria-current`, `aria-describedby` en errores,
patrón de pestañas con teclado, contraste AA verificado en la fase anterior,
`prefers-reduced-motion` respetado y `noindex` en el panel.

**Pendiente honesto:** pasada manual con NVDA/VoiceOver real (aquí solo se ha
verificado por teclado y por árbol de accesibilidad). Guion paso a paso en §F4.

## 4. Qué hay en el panel de administración (no se pudo ver desde fuera)

Seis secciones tras el login: **Panel** (KPIs: abonados en vigor, reservas
próximas, clases completas, personas en cola, accesos del día, ingresos
estimados + últimas automatizaciones) · **Reservas** (tabla de todas las
reservas con filtros por instalación/próximas, cancelación con aviso, export
CSV) · **Clases y colas** (ocupación por clase, personas inscritas y en espera,
bajas con promoción automática de la cola) · **Abonados** (búsqueda, estado del
abono, carnet NFC/QR, alta/renovación/baja, export CSV) · **Torno de acceso**
(simulador de pulsera NFC y QR con validación de firma, lector real con cámara
vía jsQR, registro de accesos, export CSV) · **Automatización** (registro de
todo lo que el sistema hace solo).

## 5. Qué se conserva, qué se reescribe, qué falta

**Se conserva:** arquitectura vanilla servida por `server.js` (estáticos + API
+ SSE), módulos `auth/sync/qr`, accesibilidad, PWA, torno con cámara,
notificaciones, buscador, CSV, sensación de app (View Transitions, hoja
inferior).

**Se reescribe en esta fase:** paleta y tipografía al sistema del documento de
diseño (cal/añil/piedra/luz/granate, IBM Plex Mono, base 17 px) · el paso de
elegir pista+hora se sustituye por **la parrilla** · la ocupación simulada pasa
de aleatoria a **verosímil** (tardes llenas, mañanas vacías, sábado por la
mañana a tope) · el lenguaje económico pasa a **liquidación de precio público**
(sin «facturas»).

**Falta y se añade ahora:** reserva atómica en servidor · bloqueos de pista con
aviso automático · panel de ocupación PLID con informe imprimible · páginas
legales y declaración de accesibilidad (con `[PENDIENTE]`) · modo demo (roles
rápidos + reinicio) · dossier.

**Falta y queda para la fase siguiente (no sale en los 6 minutos):** pasarela
Redsys/carta de pago · padrón · ENS · sorteo con acta · ordenanza versionada ·
tarifas por colectivo · antiacaparamiento · notificaciones fehacientes ·
despliegue con dominio propio (requiere cuenta/dominio del propietario).

## 6. Instalaciones, deportes y horarios ya en el prototipo

Complejo Deportivo Prado de la Feria · L–V 9:00–23:00, S–D 9:00–21:00 (en el
pie y en el motor de tramos). Pádel 1 y 2 (90', 4 €, luz +2 €) · Tenis 1 y 2
(60', 3 €, luz +2 €) · Fútbol 7 césped artificial (60', 25 €, luz +6 €) ·
Pabellón cubierto (60', 16 €) · Piscina climatizada 3 calles (60', 2,50 €) ·
Sala fitness (90', 2,50 €). Suplemento de luz desde las 19:00 en exteriores.
10 clases dirigidas con aforos, monitores y listas de espera.

## Preguntas que solo puede responder el propietario

1. ¿Nombres y número reales de pistas del complejo? (los actuales son
   plausibles pero no verificados; la web municipal daba error 500).
2. ¿Tarifas de la ordenanza fiscal vigente y hora exacta del suplemento de luz?
3. ¿Hay ya contacto con el técnico de deportes? ¿Qué tiene Sporttia desplegado
   exactamente (solo pistas, o también actividades y torno)?
4. Nombre del autor para el pie («desarrollado por …») y dominio deseado.
