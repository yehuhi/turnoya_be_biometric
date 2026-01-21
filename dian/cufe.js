// dian/cufe.js
const crypto = require('crypto');

/**
 * ⚠️ Ajusta la concatenación EXACTA a lo que dice el Anexo Técnico.
 */
function buildCufeSeed(invoice, config) {
  const {
    invoiceNumber,
    issueDate,      // YYYY-MM-DD
    issueTime,      // HH:mm:ss-05:00
    totalInvoice,
    totalTax,
    otherTaxes,
    emitterNIT,
    buyerDocType,
    buyerDocNumber,
  } = invoice;

  const softwareSecurityCode = config.softwareSecurityCode;

  const seed = [
    invoiceNumber,
    issueDate,
    issueTime,
    totalInvoice,
    totalTax,
    otherTaxes,
    emitterNIT,
    buyerDocType,
    buyerDocNumber,
    softwareSecurityCode,
  ].join('');

  return seed;
}

function generateCUFE(invoice, config) {
  const seed = buildCufeSeed(invoice, config);
  const hash = crypto.createHash('sha384');
  hash.update(seed, 'utf8');
  return hash.digest('hex').toUpperCase();
}

module.exports = { generateCUFE };
