// dian/numeracion-config.js

// En la práctica esto vendría de Firestore o SQL, según el NIT / sede / prefijo
// const numeracionConfig = {
//   salonHermesCentro: {
//     nit: '900123456',
//     prefix: 'FEH',
//     resolutionNumber: '012345678901234',
//     resolutionDate: '2025-01-15',      // fecha resolución DIAN
//     fromNumber: 1,
//     toNumber: 999999999,
//     validFrom: '2025-02-01',
//     validTo: '2027-01-31',
//   },
//   // ... otros salones / prefijos ...
// };

// function getNumeracionForSalon(salonId) {
//   return numeracionConfig[salonId];
// }

// module.exports = { getNumeracionForSalon };


// dian/numeracion-config.js
const admin = require('firebase-admin');

/**
 * Obtiene la configuración de numeración DIAN para un salón desde Firestore.
 *
 * Espera un documento en la colección "dianNumeration" con al menos:
 *  - salonId
 *  - nit
 *  - prefix
 *  - resolutionNumber
 *  - resolutionDate
 *  - fromNumber
 *  - toNumber
 *  - validFrom
 *  - validTo
 *  - currentConsecutive (opcional)
 */
async function getNumeracionForSalon(salonId) {
  const db = admin.firestore();

  // Puedes filtrar también por status === 'active' si lo agregas
  let query = db.collection('dianNumeration')
    .where('salonId', '==', salonId);

  // Si usas un campo status, puedes agregar:
  // query = query.where('status', '==', 'active');

  const snapshot = await query.limit(1).get();

  if (snapshot.empty) {
    console.log(`⚠️ No se encontró numeración en Firestore para salonId=${salonId}`);
    return null;
  }

  const doc = snapshot.docs[0];
  const data = doc.data();

  // Armamos el objeto en el formato que espera el resto del código
  return {
    salonId,
    nit: data.nit,
    prefix: data.prefix,
    resolutionNumber: data.resolutionNumber,
    resolutionDate: data.resolutionDate,
    fromNumber: data.fromNumber,
    toNumber: data.toNumber,
    validFrom: data.validFrom,
    validTo: data.validTo,
    currentConsecutive: data.currentConsecutive || data.fromNumber || 1,
  };
}

module.exports = {
  getNumeracionForSalon,
};
