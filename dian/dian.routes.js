// dian/dian.routes.js
const express = require('express');
const admin = require('firebase-admin');

const { getAcquirerFromDian } = require('./dianAcquirerService');
const { sendInvoiceToDian } = require('./dianInvoiceService');
const { getNumeracionForSalon } = require('./numeracion-config');
const { generateCUFE } = require('./cufe');
const { buildDianQrUrl } = require('./qr');

const router = express.Router();

// ==================================
// 1) GET ACQUIRER (ya lo tenías)
// ==================================
router.post('/adquiriente', async (req, res) => {
  try {
    const { tipoDocumento, numeroDocumento } = req.body;

    const acquirerData = await getAcquirerFromDian({
      tipoDocumento,
      numeroDocumento,
    });

    return res.status(200).json({
      ok: true,
      data: acquirerData,
    });
  } catch (error) {
    console.error('❌ Error en /api/dian/adquiriente:', error);

    return res.status(500).json({
      ok: false,
      message: 'Error consultando adquiriente en DIAN',
      error: error.message,
    });
  }
});

// ==================================
// 2) CREAR + ENVIAR FACTURA
// ==================================
router.post('/facturas', async (req, res) => {
  const db = admin.firestore();
  const payload = req.body;

  try {
    const {
      salonId,
      invoiceNumber,
      issueDate,
      issueTime,
      customer,
      items = [],
      totals = {},
    } = payload;

    if (!salonId || !invoiceNumber || !issueDate || !issueTime) {
      return res.status(400).json({
        ok: false,
        message: 'salonId, invoiceNumber, issueDate e issueTime son requeridos',
      });
    }

    // ⬇️ AHORA SÍ: leer numeración desde Firestore (getNumeracionForSalon ES async)
    const salonConfig = await getNumeracionForSalon(salonId);

    if (!salonConfig) {
      return res.status(400).json({
        ok: false,
        message: `No hay configuración de numeración para el salón: ${salonId}`,
      });
    }

    // Normalizar totales a número
    const safeTotals = {
      subtotal: Number(totals.subtotal || 0),
      tax: Number(totals.tax || 0),
      grandTotal: Number(totals.grandTotal || 0),
    };

    // =============================
    // 1) Construir numeración y supplier
    // =============================
    const numeracion = {
      nit: salonConfig.nit,
      prefix: salonConfig.prefix,
      resolutionNumber: salonConfig.resolutionNumber,
      resolutionDate: salonConfig.resolutionDate,
      fromNumber: salonConfig.fromNumber,
      toNumber: salonConfig.toNumber,
      validFrom: salonConfig.validFrom,
      validTo: salonConfig.validTo,
      currentConsecutive: salonConfig.currentConsecutive,
    };

    const supplier = {
      nit: salonConfig.nit,
      dv: salonConfig.dv || '1',
      nombre: salonConfig.businessName || 'SALON DEMO',
      regimen: salonConfig.regimen || '48',
      responsabilidadFiscal: salonConfig.responsabilidades || ['R-99-PN'],
      direccion: salonConfig.address || '',
      departamento: salonConfig.department || '',
      municipio: salonConfig.city || '',
      codigoMunicipio: salonConfig.cityCode || '',
      codigoPais: salonConfig.country || 'CO',
      telefono: salonConfig.phone || '',
      email: salonConfig.email || '',
    };

    // =============================
    // 2) Calcular CUFE
    // =============================
    const cufe = generateCUFE(
      {
        invoiceNumber,
        issueDate,
        issueTime,
        totalInvoice: safeTotals.grandTotal.toFixed(2),
        totalTax: safeTotals.tax.toFixed(2),
        otherTaxes: '0.00',
        emitterNIT: salonConfig.nit,
        buyerDocType: customer.tipoDocumento,
        buyerDocNumber: customer.numeroDocumento,
      },
      {
        softwareSecurityCode: process.env.DIAN_TECHNICAL_KEY,
      }
    );

    // =============================
    // 3) Datos de software DIAN
    // =============================
    const dianConfig = {
      softwareId: process.env.DIAN_SOFTWARE_ID || 'SOFTWARE_ID_DEMO',
      softwareSecurityCode: process.env.DIAN_TECHNICAL_KEY || 'SECURITY_CODE_DEMO',
      ambiente: process.env.DIAN_ENV === 'prod' ? '1' : '2', // 1=prod, 2=hab
    };

    // =============================
    // 4) Data para el XML UBL + DIAN
    // =============================
    const invoiceDataForXml = {
      number: invoiceNumber,
      issueDate,
      issueTime,
      cufe,
      customer: {
        ...customer,
      },
      supplier,
      payment: {
        paymentMeansCode: payload.paymentMeansCode || '10', // 10 = contado
        paymentDueDate: payload.paymentDueDate || issueDate,
      },
      items,
      totals: safeTotals,
      numeracion,
      dian: dianConfig,
    };

    // =============================
    // 5) Enviar a DIAN (real o MOCK)
    // =============================
    const dianResult = await sendInvoiceToDian(invoiceDataForXml, invoiceNumber);

    // CUFE final: si DIAN devuelve uno, lo usamos; si no, usamos el local
    const cufeFinal = dianResult.XmlDocumentKey || cufe;

    // =============================
    // 6) URL del QR DIAN
    // =============================
    const ambienteQr = process.env.DIAN_ENV === 'prod' ? 'prod' : 'hab';
    const qrUrl = buildDianQrUrl(cufeFinal, ambienteQr);

    // =============================
    // 7) Documento para Firestore
    // =============================
    const now = admin.firestore.Timestamp.now();
    const invoiceDoc = {
      salonId,
      invoiceNumber,
      issueDate,
      issueTime,
      customer,
      items,
      totals: safeTotals,
      supplier,
      numeracion,
      cufe: cufeFinal,
      qrUrlDian: qrUrl,
      createdAt: now,
      dian: {
        statusCode: dianResult.StatusCode,
        statusMessage: dianResult.StatusDescription,
        isValid: dianResult.IsValid,
        acceptanceDate: dianResult.acceptanceInfo?.issueDate || null,
        acceptanceTime: dianResult.acceptanceInfo?.issueTime || null,
        applicationResponseDescription: dianResult.acceptanceInfo?.description || null,
        applicationResponseXml: dianResult.acceptanceInfo?.rawXml || null,
        sendBillSoapRaw: dianResult.soapResponseRaw || null,
      },
    };

    // =============================
    // 8) Guardar en Firestore
    // =============================
    const docRef = db.collection('invoicesDian').doc(invoiceNumber);
    await docRef.set(invoiceDoc);

    const snapshot = await docRef.get();
    const savedData = snapshot.data();

    // =============================
    // 9) Responder al FE
    // =============================
    return res.status(200).json({
      ok: true,
      invoice: {
        id: docRef.id,
        ...savedData,
      },
    });
  } catch (error) {
    console.error('❌ Error en /api/dian/facturas:', error);

    return res.status(500).json({
      ok: false,
      message: 'Error creando/enviando factura a DIAN',
      error: error.message,
    });
  }
});

module.exports = router;
