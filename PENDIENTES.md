# PENDIENTES — lo que solo el propietario puede decidir o aportar

Nada de esta lista se ha inventado. Donde aparece `[PENDIENTE: …]` en la web o
en los documentos, falta un dato real que debe venir de ti o del Ayuntamiento.

## Datos que faltan (búscalos con Ctrl+F por «PENDIENTE»)

| Dónde | Qué falta |
|---|---|
| `legal.html` | Nombre del autor · órgano titular · CIF y dirección · contacto del DPD · plazos de conservación · encargado de tratamiento |
| `accesibilidad.html` | Órgano responsable · buzón/teléfono/oficina de accesibilidad · unidad responsable · resultado de la pasada manual con NVDA/VoiceOver |
| `dossier.html` | Nombre y contacto del autor · verificación de Epicsa · precio del piloto · coste de operación mensual · URL estable |
| Pie de `index.html` | Nombre del autor |

## Decisiones y gestiones previas a la reunión (del documento de estrategia)

1. Confirmar qué tiene **Sporttia** desplegado exactamente y leer su contrato
   (perfil del contratante / portal de transparencia).
2. Llamada para saber si **Epicsa** tiene módulo de reservas deportivas.
3. Media hora con el **técnico de deportes**.
4. **Ordenanza fiscal** vigente: tarifas, colectivos, suplemento de luz.
5. Confirmar el estado del **PLID** municipal.

## Técnica — fase siguiente (no visible en los 6 minutos, no construido)

- **Despliegue estable con dominio propio.** El túnel de Cloudflare se cae al
  apagar el equipo y su subdominio aleatorio resta credibilidad. Necesita:
  comprar dominio + cuenta en un proveedor (p. ej. VPS pequeño o PaaS) — ambos
  requieren cuentas del propietario. El servidor actual (`node server.js`) se
  despliega tal cual en cualquier VPS con Node.
- Autenticación y autorización **en servidor** (hoy el panel se protege en el
  cliente; suficiente para demo, insuficiente para producción — dicho en
  `AUDITORIA.md` §2).
- Pasarela Redsys / carta de pago · integración con el padrón · ENS ·
  sorteo con acta verificable · ordenanza versionada · tarifas por colectivo ·
  antiacaparamiento · notificaciones fehacientes · hardware del torno.

## Pasada manual de accesibilidad (guion para hacerla tú)

1. **Teclado:** Tab hasta «Saltar al contenido» → Enter · Tab hasta la parrilla
   → flechas para moverte entre huecos → Enter en uno libre → completar el
   formulario → confirmar. Verificado automatizadamente; repítelo a mano.
2. **Lector de pantalla (NVDA en Windows / VoiceOver en iPhone):** el mismo
   recorrido. Cada celda anuncia pista, horario, estado, precio y suplemento.
   Anota el resultado en `accesibilidad.html`.
