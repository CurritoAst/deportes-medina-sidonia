/* ==========================================================================
   Deportes · Medina Sidonia — generador de códigos QR
   Implementación propia (modo byte, corrección M, versiones 1–5) sin
   dependencias externas. Devuelve un SVG escalable y nítido.
   ========================================================================== */

const MSDQr = (function () {
  'use strict';

  /* ---------- Aritmética en GF(256), polinomio 0x11D ---------- */

  const EXP = new Uint8Array(512);
  const LOG = new Uint8Array(256);
  (function () {
    let x = 1;
    for (let i = 0; i < 255; i++) {
      EXP[i] = x;
      LOG[x] = i;
      x <<= 1;
      if (x & 0x100) x ^= 0x11D;
    }
    for (let i = 255; i < 512; i++) EXP[i] = EXP[i - 255];
  })();

  const gfMul = (a, b) => (a === 0 || b === 0) ? 0 : EXP[LOG[a] + LOG[b]];

  /* Polinomio generador Reed-Solomon de grado n */
  function generadorRS(n) {
    let poli = [1];
    for (let i = 0; i < n; i++) {
      const nuevo = new Array(poli.length + 1).fill(0);
      for (let j = 0; j < poli.length; j++) {
        nuevo[j] ^= gfMul(poli[j], EXP[i]);
        nuevo[j + 1] ^= poli[j];
      }
      poli = nuevo;
    }
    return poli.reverse(); // coeficientes de mayor a menor grado
  }

  function eccRS(datos, nEcc) {
    const gen = generadorRS(nEcc);
    const resto = new Array(nEcc).fill(0);
    for (const b of datos) {
      const factor = b ^ resto.shift();
      resto.push(0);
      if (factor !== 0) {
        for (let i = 0; i < nEcc; i++) {
          resto[i] ^= gfMul(gen[i + 1], factor);
        }
      }
    }
    return resto;
  }

  /* ---------- Parámetros por versión (nivel de corrección M) ----------
     [códigos totales, nº bloques, datos por bloque, ecc por bloque] */
  const VERSIONES = {
    1: { total: 26, bloques: 1, datos: 16, ecc: 10, alinea: [] },
    2: { total: 44, bloques: 1, datos: 28, ecc: 16, alinea: [6, 18] },
    3: { total: 70, bloques: 1, datos: 44, ecc: 26, alinea: [6, 22] },
    4: { total: 100, bloques: 2, datos: 32, ecc: 18, alinea: [6, 26] },
    5: { total: 134, bloques: 2, datos: 43, ecc: 24, alinea: [6, 30] }
  };

  /* ---------- Construcción de la secuencia de bits ---------- */

  function aBytesUtf8(texto) {
    return Array.from(new TextEncoder().encode(texto));
  }

  function construirCodigos(texto) {
    const bytes = aBytesUtf8(texto);
    let version = null;
    for (const v of [1, 2, 3, 4, 5]) {
      const cap = VERSIONES[v].bloques * VERSIONES[v].datos - 2; // cabecera modo+longitud
      if (bytes.length <= cap) { version = v; break; }
    }
    if (!version) throw new Error('Texto demasiado largo para el QR (máx. 84 bytes)');

    const p = VERSIONES[version];
    const capacidadDatos = p.bloques * p.datos;

    // Bits: modo byte (0100) + longitud (8 bits en v1-9) + datos + terminador
    const bits = [];
    const meterBits = (valor, n) => {
      for (let i = n - 1; i >= 0; i--) bits.push((valor >> i) & 1);
    };
    meterBits(0b0100, 4);
    meterBits(bytes.length, 8);
    bytes.forEach((b) => meterBits(b, 8));
    meterBits(0, Math.min(4, capacidadDatos * 8 - bits.length)); // terminador
    while (bits.length % 8 !== 0) bits.push(0);

    const codigos = [];
    for (let i = 0; i < bits.length; i += 8) {
      let b = 0;
      for (let j = 0; j < 8; j++) b = (b << 1) | bits[i + j];
      codigos.push(b);
    }
    // Relleno alterno hasta completar capacidad
    const relleno = [0xEC, 0x11];
    for (let i = 0; codigos.length < capacidadDatos; i++) codigos.push(relleno[i % 2]);

    // División en bloques + ECC + intercalado
    const bloquesDatos = [];
    const bloquesEcc = [];
    for (let b = 0; b < p.bloques; b++) {
      const trozo = codigos.slice(b * p.datos, (b + 1) * p.datos);
      bloquesDatos.push(trozo);
      bloquesEcc.push(eccRS(trozo, p.ecc));
    }
    const final = [];
    for (let i = 0; i < p.datos; i++) {
      for (const bl of bloquesDatos) if (i < bl.length) final.push(bl[i]);
    }
    for (let i = 0; i < p.ecc; i++) {
      for (const bl of bloquesEcc) final.push(bl[i]);
    }
    return { version, codigos: final };
  }

  /* ---------- Matriz de módulos ---------- */

  function construirMatriz(version, codigos) {
    const n = version * 4 + 17;
    // matriz: -1 libre, 0 claro, 1 oscuro; funcional: true si es zona reservada
    const m = Array.from({ length: n }, () => new Array(n).fill(-1));
    const funcional = Array.from({ length: n }, () => new Array(n).fill(false));

    const poner = (f, c, v) => { m[f][c] = v; funcional[f][c] = true; };

    // Patrones de posición (3 esquinas) con separador
    const finder = (fila, col) => {
      for (let df = -1; df <= 7; df++) {
        for (let dc = -1; dc <= 7; dc++) {
          const f = fila + df, c = col + dc;
          if (f < 0 || f >= n || c < 0 || c >= n) continue;
          const dentro = df >= 0 && df <= 6 && dc >= 0 && dc <= 6;
          const anillo = dentro && (df === 0 || df === 6 || dc === 0 || dc === 6);
          const centro = dentro && df >= 2 && df <= 4 && dc >= 2 && dc <= 4;
          poner(f, c, (anillo || centro) ? 1 : 0);
        }
      }
    };
    finder(0, 0);
    finder(0, n - 7);
    finder(n - 7, 0);

    // Patrones de alineamiento
    const al = VERSIONES[version].alinea;
    for (const fa of al) {
      for (const ca of al) {
        if (funcional[fa][ca]) continue; // no pisar los finders
        for (let df = -2; df <= 2; df++) {
          for (let dc = -2; dc <= 2; dc++) {
            const borde = Math.max(Math.abs(df), Math.abs(dc));
            poner(fa + df, ca + dc, borde !== 1 ? 1 : 0);
          }
        }
      }
    }

    // Líneas de sincronismo
    for (let i = 8; i < n - 8; i++) {
      if (!funcional[6][i]) poner(6, i, i % 2 === 0 ? 1 : 0);
      if (!funcional[i][6]) poner(i, 6, i % 2 === 0 ? 1 : 0);
    }

    // Módulo oscuro fijo + reserva de las zonas de formato
    poner(4 * version + 9, 8, 1);
    for (let i = 0; i < 9; i++) {
      if (!funcional[8][i]) poner(8, i, 0);
      if (!funcional[i][8]) poner(i, 8, 0);
    }
    for (let i = 0; i < 8; i++) {
      if (!funcional[8][n - 1 - i]) poner(8, n - 1 - i, 0);
      if (!funcional[n - 1 - i][8]) poner(n - 1 - i, 8, 0);
    }

    // Colocación de datos en zigzag (de derecha a izquierda, saltando la col. 6)
    let bitIdx = 0;
    const totalBits = codigos.length * 8;
    const bitEn = (i) => (codigos[i >> 3] >> (7 - (i & 7))) & 1;

    for (let col = n - 1, subida = true; col > 0; col -= 2, subida = !subida) {
      if (col === 6) col = 5;
      for (let paso = 0; paso < n; paso++) {
        const f = subida ? n - 1 - paso : paso;
        for (const c of [col, col - 1]) {
          if (funcional[f][c] || m[f][c] !== -1) continue;
          const bit = bitIdx < totalBits ? bitEn(bitIdx) : 0;
          bitIdx++;
          // Máscara 0: (fila + columna) par
          m[f][c] = ((f + c) % 2 === 0) ? bit ^ 1 : bit;
        }
      }
    }

    // Información de formato: nivel M (00) + máscara 0, con BCH y XOR estándar
    const datoFormato = (0b00 << 3) | 0; // M, máscara 0
    let resto = datoFormato << 10;
    for (let i = 14; i >= 10; i--) {
      if ((resto >> i) & 1) resto ^= 0x537 << (i - 10);
    }
    const formato = ((datoFormato << 10) | resto) ^ 0x5412;
    const bitF = (i) => (formato >> i) & 1;

    // Copia 1: alrededor del finder superior izquierdo
    for (let i = 0; i <= 5; i++) m[8][i] = bitF(14 - i);
    m[8][7] = bitF(8);
    m[8][8] = bitF(7);
    m[7][8] = bitF(6);
    for (let i = 0; i <= 5; i++) m[i][8] = bitF(i);
    // Copia 2: junto a los otros dos finders
    for (let i = 0; i <= 7; i++) m[n - 1 - i][8] = bitF(14 - i);
    for (let i = 0; i <= 7; i++) m[8][n - 8 + i] = bitF(7 - i);

    return m;
  }

  /* ---------- SVG ---------- */

  function comoSvg(texto, opciones) {
    const { version, codigos } = construirCodigos(texto);
    const m = construirMatriz(version, codigos);
    const n = m.length;
    const margen = 4;
    const lado = n + margen * 2;
    const color = (opciones && opciones.color) || '#241F17';

    let camino = '';
    for (let f = 0; f < n; f++) {
      for (let c = 0; c < n; c++) {
        if (m[f][c] === 1) camino += `M${c + margen} ${f + margen}h1v1h-1z`;
      }
    }
    return `<svg xmlns="http://www.w3.org/2000/svg" viewBox="0 0 ${lado} ${lado}" shape-rendering="crispEdges" role="img" aria-label="Código QR del carnet deportivo">` +
      `<rect width="${lado}" height="${lado}" fill="#FFFFFF"/>` +
      `<path d="${camino}" fill="${color}"/></svg>`;
  }

  return { comoSvg };
})();
