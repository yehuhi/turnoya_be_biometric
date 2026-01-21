// dian/dianInvoiceService.js
const AdmZip = require('adm-zip');
const xml2js = require('xml2js');
const axios = require('axios');
const fs = require('fs');
const path = require('path');

const { buildInvoiceXml } = require('./dianInvoiceBuilder');      // tu plantilla UBL
const { signInvoiceXmlForDian } = require('./xadesSigner');       // firma XAdES
const { dianConfig, DIAN_SOAP_ACTIONS } = require('./dian.config');
const { parseDianApplicationResponse } = require('./parse-application-response');

// Parser para SOAP de DIAN
const parser = new xml2js.Parser({
  explicitArray: false,
  ignoreAttrs: false,
});

/**
 * Comprime el XML en ZIP y devuelve base64
 */
function zipInvoiceXml(xmlString, fileName) {
  const zip = new AdmZip();
  zip.addFile(`${fileName}.xml`, Buffer.from(xmlString, 'utf8'));
  const zipBuffer = zip.toBuffer();
  const zipBase64 = zipBuffer.toString('base64');
  return { zipBuffer, zipBase64 };
}

/**
 * ⚠️ AQUÍ VA EL HEADER SOAP FIRMADO
 * Por ahora es un placeholder. Más adelante se puede firmar también
 * el envelope SOAP con WS-Security si la DIAN lo exige.
 */
function buildSignedSoapHeaderSendBillSync() {
  return `
  <soap:Header>
    <!--
      TODO: Pegar aquí tu wsse:Security + wsa:Action + wsa:To
      si la DIAN exige WS-Security a nivel de SOAP.
      De momento dejamos el header mínimo (wsa).
    -->
    <wsa:Action>http://wcf.dian.colombia/IWcfDianCustomerServices/SendBillSync</wsa:Action>
    <wsa:To>${dianConfig.baseUrl}</wsa:To>
  </soap:Header>
  `.trim();
}

/**
 * Envelope SOAP completo para SendBillSync
 */
function buildSendBillSyncEnvelope({ fileName, zipBase64 }) {
  const header = buildSignedSoapHeaderSendBillSync();

  const envelope = `
  <soap:Envelope xmlns:soap="http://www.w3.org/2003/05/soap-envelope"
                 xmlns:wsa="http://www.w3.org/2005/08/addressing"
                 xmlns:wcf="http://wcf.dian.colombia">
    ${header}
    <soap:Body>
      <wcf:SendBillSync>
        <wcf:fileName>${fileName}.zip</wcf:fileName>
        <wcf:contentFile>${zipBase64}</wcf:contentFile>
      </wcf:SendBillSync>
    </soap:Body>
  </soap:Envelope>
  `.trim();

  return envelope;
}

/**
 * Envía el SOAP a la DIAN
 */
async function callDianSendBillSync(envelope) {
  const url = dianConfig.baseUrl;

  const headers = {
    'Content-Type': `application/soap+xml;charset=UTF-8;action="${DIAN_SOAP_ACTIONS.sendBillSync}"`,
  };

  // Si tienes usuario/clave DIAN para Basic Auth, los usamos
  if (process.env.DIAN_BASIC_USER && process.env.DIAN_BASIC_PASS) {
    const basicToken = Buffer.from(
      `${process.env.DIAN_BASIC_USER}:${process.env.DIAN_BASIC_PASS}`
    ).toString('base64');

    headers.Authorization = `Basic ${basicToken}`;
  }

  const response = await axios.post(url, envelope, {
    headers,
    timeout: 60000,
  });

  return response.data; // SOAP XML string
}

/**
 * Parsea el SOAP de respuesta y devuelve un objeto sendBillResult
 * con los campos importantes.
 */
async function parseSendBillSyncResponse(soapXml) {
  const parsed = await parser.parseStringPromise(soapXml);

  const envelope = parsed['s:Envelope'] || parsed['Envelope'];
  if (!envelope) {
    throw new Error('No se encontró Envelope en respuesta DIAN');
  }

  const body = envelope['s:Body'] || envelope['Body'];
  if (!body) {
    throw new Error('No se encontró Body en respuesta DIAN');
  }

  const resp =
    body['SendBillSyncResponse'] ||
    body['wcf:SendBillSyncResponse'] ||
    body['ns2:SendBillSyncResponse'] ||
    body.SendBillSyncResponse;

  if (!resp) {
    throw new Error('No se encontró SendBillSyncResponse en respuesta DIAN');
  }

  const result =
    resp['SendBillSyncResult'] ||
    resp['wcf:SendBillSyncResult'] ||
    resp['ns2:SendBillSyncResult'] ||
    resp.Result;

  if (!result) {
    throw new Error('No se encontró SendBillSyncResult en respuesta DIAN');
  }

  const IsValid = result.IsValid || result['b:IsValid'];
  const StatusCode = result.StatusCode || result['b:StatusCode'];
  const StatusDescription = result.StatusDescription || result['b:StatusDescription'];
  const XmlBase64Bytes = result.XmlBase64Bytes || result['b:XmlBase64Bytes'] || null;
  const XmlBytes = result.XmlBytes || result['b:XmlBytes'] || null;
  const XmlDocumentKey = result.XmlDocumentKey || result['b:XmlDocumentKey'] || null;

  return {
    IsValid,
    StatusCode,
    StatusDescription,
    XmlBase64Bytes,
    XmlBytes,
    XmlDocumentKey,
    raw: result,
  };
}

/**
 * ESTE ES EL "sendInvoiceToDian" FINAL.
 *
 * invoiceData: lo que necesitas para armar el XML (lo que recibes del FE)
 * fileName: nombre base del XML/ZIP (ej: FEH000001)
 */
async function sendInvoiceToDian(invoiceData, fileName) {
  // 1) SIEMPRE: construir XML UBL 2.1 con tu plantilla
  const unsignedXml = buildInvoiceXml(invoiceData);

  // Guardar XML sin firmar en disco para debug (opcional pero muy útil)
  const outDir = path.join(__dirname, '../tmp_xml');
  if (!fs.existsSync(outDir)) {
    fs.mkdirSync(outDir, { recursive: true });
  }
  fs.writeFileSync(path.join(outDir, `${fileName}-unsigned.xml`), unsignedXml, 'utf8');

  // 2) SI MODO MOCK ESTÁ ACTIVADO → NO LLAMAR A LA DIAN
  if (process.env.DIAN_MOCK_MODE === 'true') {
    console.log('⚠️ DIAN_MOCK_MODE = true → simulando envío a DIAN');

    // Usamos el CUFE que ya calculaste antes, o generamos uno fake
    const cufeSimulado = invoiceData.cufe || `MOCK_CUFE_${fileName}`;

    // Fecha/hora simuladas de aceptación
    const now = new Date();
    const issueDate = now.toISOString().slice(0, 10); // YYYY-MM-DD
    const issueTime = now.toISOString().slice(11, 19) + '-05:00';

    return {
      IsValid: true,
      StatusCode: '00',
      StatusDescription: 'MOCK - Documento Validado por la DIAN (simulado)',
      XmlDocumentKey: cufeSimulado,
      acceptanceInfo: {
        issueDate,
        issueTime,
        description: 'MOCK - Documento Validado por la DIAN',
        rawXml: '<ApplicationResponse>MOCK</ApplicationResponse>',
      },
      soapResponseRaw: '<MOCK>SendBillSync SOAP Response</MOCK>',
      sendBillRaw: {},
      xmlEnviado: unsignedXml,
    };
  }

  // 3) MODO REAL (DIAN_MOCK_MODE != 'true'): aquí sí usamos TODO el flujo real

  // 3.1) Firmar XML con XAdES-EPES usando el certificado DIAN
  const signedXml = await signInvoiceXmlForDian(unsignedXml);

  // Guardar XML firmado para debug
  fs.writeFileSync(path.join(outDir, `${fileName}-signed.xml`), signedXml, 'utf8');

  // 3.2) Comprimir XML firmado en ZIP y pasarlo a base64
  const { zipBase64 } = zipInvoiceXml(signedXml, fileName);

  // 3.3) Construir envelope SOAP con header (luego podemos firmar WS-Security si hace falta)
  const envelope = buildSendBillSyncEnvelope({ fileName, zipBase64 });

  // 3.4) Enviar SOAP a la DIAN
  const soapResponse = await callDianSendBillSync(envelope);

  // 3.5) Parsear respuesta SOAP → SendBillSyncResult
  const sendBillResult = await parseSendBillSyncResponse(soapResponse);

  const {
    IsValid,
    StatusCode,
    StatusDescription,
    XmlBase64Bytes,
    XmlBytes,
    XmlDocumentKey,
  } = sendBillResult;

  // 3.6) Si fue válido, parsear ApplicationResponse (aceptación DIAN)
  let acceptanceInfo = null;

  if (IsValid && (StatusCode === '00' || StatusCode === 0)) {
    acceptanceInfo = await parseDianApplicationResponse(XmlBase64Bytes || XmlBytes);
  }

  // 3.7) Devolver TODO listo para que la ruta lo guarde en Firestore
  return {
    IsValid,
    StatusCode,
    StatusDescription,
    XmlDocumentKey,   // CUFE oficial si la DIAN lo envía
    acceptanceInfo,   // { issueDate, issueTime, description, rawXml }
    soapResponseRaw: soapResponse,
    sendBillRaw: sendBillResult.raw,
    xmlEnviado: signedXml,
  };
}

module.exports = {
  sendInvoiceToDian,
};
