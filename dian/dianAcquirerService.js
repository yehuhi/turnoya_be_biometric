// dian/dianAcquirerService.js
const xml2js = require('xml2js');
const { callDianSoap } = require('./dianSoapClient');
const { DIAN_SOAP_ACTIONS } = require('./dian.config');

// Parser para XML → JSON
const parser = new xml2js.Parser({
  explicitArray: false,
  ignoreAttrs: false,
});

/**
 * Envelope SOAP para GetAcquirer (Request)
 */
function buildGetAcquirerEnvelope({ tipoDocumento, numeroDocumento }) {
  const envelope = `
  <soap:Envelope xmlns:soap="http://www.w3.org/2003/05/soap-envelope"
                 xmlns:wcf="http://wcf.dian.colombia">
    <soap:Header/>
    <soap:Body>
      <wcf:GetAcquirer>
        <wcf:identificationType>${tipoDocumento}</wcf:identificationType>
        <wcf:identificationNumber>${numeroDocumento}</wcf:identificationNumber>
      </wcf:GetAcquirer>
    </soap:Body>
  </soap:Envelope>
  `.trim();

  return envelope;
}

/**
 * Parsea el XML de respuesta de GetAcquirer a JSON simple
 */
async function parseGetAcquirerResponse(xmlResponse) {
  const parsed = await parser.parseStringPromise(xmlResponse);

  // Estructura que envía la DIAN (ejemplo que tú pegaste):
  //
  // s:Envelope
  //   s:Header ...
  //   s:Body
  //     GetAcquirerResponse
  //       GetAcquirerResult
  //         b:CorreoElectronico
  //         b:NombreRazonSocial
  //         b:StatusCode
  //
  const envelope = parsed['s:Envelope'] || parsed['Envelope'];
  if (!envelope) {
    throw new Error('No se encontró s:Envelope en la respuesta de DIAN');
  }

  const body = envelope['s:Body'] || envelope['Body'];
  if (!body) {
    throw new Error('No se encontró s:Body en la respuesta de DIAN');
  }

  const response = body['GetAcquirerResponse'];
  if (!response) {
    throw new Error('No se encontró GetAcquirerResponse en el Body');
  }

  const result = response['GetAcquirerResult'];
  if (!result) {
    throw new Error('No se encontró GetAcquirerResult en la respuesta');
  }

  const correo =
    result['b:CorreoElectronico'] ??
    result['CorreoElectronico'] ??
    null;

  const nombreRazonSocial =
    result['b:NombreRazonSocial'] ??
    result['NombreRazonSocial'] ??
    null;

  const statusCodeRaw =
    result['b:StatusCode'] ??
    result['StatusCode'] ??
    null;

  const statusCode = statusCodeRaw != null ? Number(statusCodeRaw) : null;

  return {
    email: correo,
    nombreRazonSocial,
    statusCode,
    raw: result, // por si quieres ver todo el objeto crudo
  };
}

/**
 * Llama al método GetAcquirer de la DIAN
 * y devuelve JSON listo para tu FE
 */
async function getAcquirerFromDian({ tipoDocumento, numeroDocumento }) {
  if (!tipoDocumento || !numeroDocumento) {
    throw new Error('tipoDocumento y numeroDocumento son obligatorios');
  }

  const body = buildGetAcquirerEnvelope({ tipoDocumento, numeroDocumento });

  // XML del SOAP Response
  const xmlResponse = await callDianSoap({
    action: DIAN_SOAP_ACTIONS.getAcquirer,
    body,
  });

  // Parseamos a JSON
  const acquirerData = await parseGetAcquirerResponse(xmlResponse);

  return acquirerData;
}

module.exports = {
  getAcquirerFromDian,
};
