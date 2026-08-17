# Investigación previa a la reunión — Epicsa y Sporttia

Investigación con fuentes, 29-07-2026. Responde a las gestiones 1 y 2 del
documento de estrategia (§9) y de la lista del documento de competencia (§6).

## 1. ¿Tiene Epicsa un módulo de reservas deportivas? — NO (y hay más)

**Conclusión operativa:** EPICSA no ofrece hoy un producto propio de reservas
de instalaciones deportivas. Lo que hizo históricamente (2013–2014, Plan
Reactiva de la Diputación, línea de 380.000 € para municipios de <20.000
habitantes) fue **desplegar la plataforma privada Sporttia** en los portales de
18–21 ayuntamientos pequeños. Es muy probable que el Sporttia de Medina Sidonia
proceda de aquel despliegue provincial.

Confirmado con fuente:
- Nota de prensa de la Diputación (29-11-2013): Epicsa proveería herramientas
  de reserva deportiva a municipios menores dentro del Plan Reactiva.
- Noticia de la Diputación (15-05-2014): «incorporadas, en los portales web de
  21 Ayuntamientos, herramientas para gestionar y reservar instalaciones
  deportivas municipales».
- Presentación del nuevo CPD de EPICSA (11-02-2025): declara dar cobertura a
  «alquiler de pistas deportivas» entre sus >100 aplicaciones, **sin producto
  identificado**.

No encontrado (que también es un dato):
- El catálogo de servicios actual de EPICSA no lista ningún módulo de reservas
  deportivas (MOAD, padrón, sede electrónica… sí; deportes, no).
- Ninguna mención a deportes/reservas/Sporttia en sus noticias 2025–2026.
- Ninguna licitación relacionada con deportes en su perfil de contratante
  (86 contratos publicados).

**Cómo usarlo en la reunión:** «Epicsa no tiene producto propio de reservas;
lo que os llegó en su día fue Sporttia a través del plan provincial. Esto que
os enseño es vuestro: código y datos del Ayuntamiento, y migrable a Epicsa el
día que ellos asuman algo así.»

## 2. Sporttia en Medina Sidonia: qué tienen y qué contrato hay

**Qué tienen desplegado (confirmado por la API pública de Sporttia, centro 1527):**
- Cliente **directo** del Ayuntamiento (CIF P1102300I) desde **2018**, con TPV
  e IBAN municipales — no vía Diputación (Medina Sidonia NO está en DipuSport).
- Módulos: `booking` (pistas), `activity` (34 actividades 2025-26 con
  inscripción online y aforos — gimnasio en 10 franjas de 22 plazas, Ciclo
  Indoor, Pilates, Tonofit, Voleibol), `purse` (monedero), `receipt` (recibos)
  y `device`: **un torno físico con pulseras/QR/tarjeta, activo desde
  19-05-2021, con antipassback, en el Gimnasio del Pabellón**.
- 8 instalaciones reservables: Pádel Pista 1 y 2, Pista de Tenis, Fútbol 7
  Pista 1 (Cantina) y Pista 2, Pista del Pabellón, Salas del Pabellón y
  Gimnasio del Pabellón. **La piscina cubierta NO está en Sporttia** (la
  gestiona la empresa municipal Medina Global).
- ~2.750 seguidores del centro y 256 usuarios en el grupo de alquiler online.

**El contrato: NO aparece publicado** ni en la Plataforma de Contratación del
Sector Público, ni en Gobierto (35 contratos del Ayuntamiento revisados), ni
en el perfil del contratante. El proveedor es **Social Cloud S.L.**
(B90061284, Lebrija), con ~87 adjudicaciones públicas por ~1,66 M€ y contratos
típicos de **1.300–1.700 €/año** en otros municipios. Lectura del documento de
competencia (§3): esto apunta a **contratación menor recurrente** (ventana
anual, barrera de salida baja) o a un modelo por comisión — y en el peor caso
es la «tercera casilla» del documento: una prestación sin expediente publicado,
que a Secretaría le interesa regularizar.

**Implicaciones para la propuesta:** (1) la sustitución debe cubrir pistas +
actividades con aforos + monedero + torno — **todo eso ya está replicado en la
demo, incluido el torno con pulsera/QR**; (2) los datos semilla de la demo usan
ya los nombres reales de las 8 instalaciones; (3) el precio de referencia del
incumbente es de cientos, no miles, de euros al año: el argumento no es precio,
es accesibilidad + PLID + propiedad del código y de los datos.

## 3. Accesibilidad del sistema actual

Ver `INFORME-SPORTTIA.md`: 8 violaciones graves WCAG 2.1 A/AA por página en las
páginas públicas (contraste y enlaces sin nombre accesible) y **sin declaración
de accesibilidad publicada**, frente a 0 violaciones del prototipo. La
obligación y el riesgo de reclamación son del Ayuntamiento (RD 1112/2018).
