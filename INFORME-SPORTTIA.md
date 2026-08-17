# Informe de accesibilidad — sistema de reservas actual (Sporttia)

Auditoría automática realizada el 29-07-2026 con axe-core 4.10.2 (reglas WCAG
2.1 niveles A y AA), sobre las páginas públicas accesibles sin sesión.

## Resultados

| Página | Violaciones | Detalle |
|---|---|---|
| `www.sporttia.com` (portada) | **8** | `color-contrast` (grave, 4 elementos) · `link-name` — enlaces sin texto discernible para lector de pantalla (grave, 4 elementos) |
| `app.sporttia.com/scs/1527/profile` (centro de Medina Sidonia) | **8** | Los mismos patrones: contraste insuficiente y enlaces sin nombre accesible |

**Declaración de accesibilidad (obligatoria según el RD 1112/2018): no se ha
encontrado publicada** en ninguna de las dos páginas.

Comparativa con el prototipo de esta propuesta, misma herramienta y mismas
reglas, mismo día: **0 violaciones** en la web pública, el área personal, la
parrilla de reservas y el panel de gestión, con declaración de accesibilidad ya
publicada en el pie.

## Cautelas honestas

- Es una auditoría **automática y de las páginas públicas**: el flujo interno de
  reserva (con sesión) no se ha podido auditar. Una revisión completa requiere
  recorrerlo con teclado y lector de pantalla.
- axe-core detecta una parte de los problemas de accesibilidad (los
  comprobables por máquina); la cifra real solo puede ser igual o mayor.
- Esto **no es un reproche al proveedor**: la obligación legal de accesibilidad
  (WCAG 2.1 AA, UNE-EN 301549) y de publicar la declaración **recae en el
  Ayuntamiento**, no en Sporttia (RD 1112/2018, aplicable a los sitios a través
  de los que se prestan servicios públicos).

## Cómo usarlo (del documento de estrategia, §4.1)

> «He mirado el sistema de reservas desde el punto de vista de accesibilidad,
> porque el RD 1112/2018 os obliga a nivel AA y la responsabilidad es vuestra,
> no del proveedor. Os dejo el informe. No es un problema de nadie en
> particular, pero es algo que os pueden reclamar y ahora mismo no tenéis la
> declaración publicada. Os enseño cómo se resuelve.»

Y a continuación: encender el lector de pantalla y reservar una pista en el
prototipo sin mirar la pantalla.
