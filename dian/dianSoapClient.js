// dian/dianSoapClient.js
const axios = require('axios');
const { dianConfig } = require('./dian.config');

function buildBasicAuthHeader() {
  if (!dianConfig.basicUser || !dianConfig.basicPass) return null;
  const token = Buffer.from(`${dianConfig.basicUser}:${dianConfig.basicPass}`).toString('base64');
  return `Basic ${token}`;
}

/**
 * Llamada genérica a un servicio SOAP de la DIAN
 * @param {Object} params
 * @param {string} params.action - SOAPAction completo
 * @param {string} params.body   - Envelope XML completo
 */
async function callDianSoap({ action, body }) {
  if (!action) {
    throw new Error('SOAP action es obligatorio');
  }

  const url = dianConfig.baseUrl;

  const headers = {
    // IMPORTANTE: Content-Type con action="..." como pide la guía
    'Content-Type': `application/soap+xml;charset=UTF-8;action="${action}"`,
  };

  const basicAuth = buildBasicAuthHeader();
  if (basicAuth) {
    headers['Authorization'] = basicAuth;
  }

  try {
    const response = await axios.post(url, body, {
      headers,
      timeout: 30000,
    });

    return response.data; // XML en string
  } catch (error) {
    console.error('❌ Error al consumir servicio DIAN:', error?.response?.data || error.message);
    throw error;
  }
}

module.exports = {
  callDianSoap,
};
