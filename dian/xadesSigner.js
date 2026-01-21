// dian/xadesSigner.js
const fs = require('fs');
const path = require('path');
const { DOMParser, XMLSerializer } = require('@xmldom/xmldom');
const { Crypto } = require('@peculiar/webcrypto');
const xadesjs = require('xadesjs');
const pem = require('pem');

// Configurar motor crypto para xadesjs (Node)
const crypto = new Crypto();
xadesjs.Application.setEngine('NodeJS', crypto);

/**
 * Convierte base64 a ArrayBuffer
 */
function base64ToArrayBuffer(base64) {
  const binaryString = Buffer.from(base64, 'base64').toString('binary');
  const len = binaryString.length;
  const bytes = new Uint8Array(len);
  for (let i = 0; i < len; i++) {
    bytes[i] = binaryString.charCodeAt(i);
  }
  return bytes.buffer;
}

/**
 * Lee el .p12/.pfx de la DIAN y devuelve { privateKey, certificate }
 * usando la librería 'pem'.
 */
function loadKeysFromPfx() {
  return new Promise((resolve, reject) => {
    try {
      const pfxPath = process.env.DIAN_CERT_PFX_PATH;
      const pfxPassword = process.env.DIAN_CERT_PFX_PASSWORD;

      if (!pfxPath || !pfxPassword) {
        return reject(
          new Error(
            'Faltan variables DIAN_CERT_PFX_PATH o DIAN_CERT_PFX_PASSWORD en .env'
          )
        );
      }

      const absolutePath = path.resolve(pfxPath);
      const pfxBuffer = fs.readFileSync(absolutePath);

      pem.readPkcs12(
        pfxBuffer,
        { p12Password: pfxPassword },
        (err, certData) => {
          if (err) return reject(err);

          // certData.key y certData.cert vienen en PEM
          const keyPem = certData.key;
          const certPem = certData.cert;

          // Limpiar encabezados PEM y quedarnos solo con base64
          const keyBase64 = keyPem
            .replace(/-----BEGIN [^-]+-----/g, '')
            .replace(/-----END [^-]+-----/g, '')
            .replace(/\s+/g, '');

          const certBase64 = certPem
            .replace(/-----BEGIN [^-]+-----/g, '')
            .replace(/-----END [^-]+-----/g, '')
            .replace(/\s+/g, '');

          resolve({
            privateKeyBase64: keyBase64,
            certificateBase64: certBase64,
          });
        }
      );
    } catch (e) {
      reject(e);
    }
  });
}

/**
 * Importa la clave privada en WebCrypto (pkcs8)
 */
async function importPrivateKey(privateKeyBase64) {
  const keyBuffer = base64ToArrayBuffer(privateKeyBase64);

  const key = await crypto.subtle.importKey(
    'pkcs8',
    keyBuffer,
    {
      name: 'RSASSA-PKCS1-v1_5',
      hash: { name: 'SHA-256' },
    },
    false,
    ['sign']
  );

  return key;
}

/**
 * Firma el XML UBL usando XAdES-BES y coloca ds:Signature
 * en ext:UBLExtensions/ext:UBLExtension[2]/ext:ExtensionContent.
 *
 * @param {string} xmlString - XML de la factura (fe:Invoice)
 * @returns {Promise<string>} XML firmado
 */
async function signInvoiceXmlForDian(xmlString) {
  // 1. Cargar claves desde PFX
  const { privateKeyBase64, certificateBase64 } = await loadKeysFromPfx();

  // 2. Importar la clave privada a WebCrypto
  const privateKey = await importPrivateKey(privateKeyBase64);

  // 3. Parsear el XML de la factura
  const xmlDoc = new DOMParser().parseFromString(xmlString, 'text/xml');
  const documentElement = xmlDoc.documentElement; // <fe:Invoice>

  // 4. Crear objeto SignedXml de xadesjs
  const signedXml = new xadesjs.SignedXml();

  // 5. Configurar referencia: firmamos TODO el documento (URI = "")
  const reference = new xadesjs.xml.Reference();
  reference.Uri = ''; // documento completo
  reference.Transforms.Add(
    new xadesjs.xml.XmlDsigEnvelopedSignatureTransform()
  );
  reference.Transforms.Add(
    new xadesjs.xml.XmlDsigC14NWithCommentsTransform()
  );
  signedXml.Signature.SignedInfo.References.Add(reference);

  // 6. Importar el certificado a KeyInfo
  const certRaw = Buffer.from(certificateBase64, 'base64');
  const x509 = new xadesjs.xml.X509Data();
  x509.AddCertificateRaw(certRaw);
  signedXml.Signature.KeyInfo.Add(x509);

  // 7. Firmar
  await signedXml.Sign(
    { name: 'RSASSA-PKCS1-v1_5' },
    privateKey,
    xmlDoc
  );

  // 8. Ubicar el nodo ds:Signature
  const signatureNode =
    xmlDoc.getElementsByTagName('ds:Signature')[0] ||
    xmlDoc.getElementsByTagName('Signature')[0];

  if (!signatureNode) {
    throw new Error('No se encontró ds:Signature en el XML firmado');
  }

  // 9. Mover la firma a ext:UBLExtensions/ext:UBLExtension[2]/ext:ExtensionContent
  const ublExtensions =
    xmlDoc.getElementsByTagName('ext:UBLExtensions')[0] ||
    xmlDoc.getElementsByTagName('UBLExtensions')[0];

  if (!ublExtensions) {
    throw new Error(
      'No se encontró ext:UBLExtensions en el XML. Revisa la plantilla UBL.'
    );
  }

  const extensions = ublExtensions.getElementsByTagName('ext:UBLExtension');
  if (!extensions || extensions.length < 2) {
    throw new Error(
      'Se esperaba al menos 2 ext:UBLExtension para insertar la firma.'
    );
  }

  const secondExtension = extensions[1];
  const extensionContent =
    secondExtension.getElementsByTagName('ext:ExtensionContent')[0];

  if (!extensionContent) {
    throw new Error(
      'No se encontró ext:ExtensionContent en la segunda UBLExtension.'
    );
  }

  // Eliminar la firma de su ubicación original (normalmente cuelga de la raíz)
  if (signatureNode.parentNode) {
    signatureNode.parentNode.removeChild(signatureNode);
  }

  // Insertarla dentro del ExtensionContent
  extensionContent.appendChild(signatureNode);

  // 10. Serializar XML final firmado
  const signedXmlString = new XMLSerializer().serializeToString(xmlDoc);
  return signedXmlString;
}

module.exports = {
  signInvoiceXmlForDian,
};
