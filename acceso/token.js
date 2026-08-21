/* ==========================================================================
   Deportes · Medina Sidonia — código QR dinámico (Raspberry del torno)
   Reexporta el módulo ÚNICO lib/token.js, que es el mismo que usa el servidor
   para generar el QR del carnet. Así la paridad está garantizada: no hay dos
   implementaciones que puedan divergir.
   ========================================================================== */

'use strict';

module.exports = require('../lib/token.js');
