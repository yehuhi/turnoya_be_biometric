// dian/qr.js
function buildDianQrUrl(cufe, ambiente = 'prod') {
  const baseUrl =
    ambiente === 'hab'
      ? 'https://catalogo-vpfe-hab.dian.gov.co/document/searchqr'
      : 'https://catalogo-vpfe.dian.gov.co/document/searchqr';

  return `${baseUrl}?documentkey=${encodeURIComponent(cufe)}`;
}

module.exports = { buildDianQrUrl };
