// dian/dianInvoiceBuilder.js

// Pequeño helper para escapar caracteres peligrosos en XML
function xmlEscape(value) {
  if (value === null || value === undefined) return '';
  return String(value)
    .replace(/&/g, '&amp;')
    .replace(/</g, '&lt;')
    .replace(/>/g, '&gt;')
    .replace(/"/g, '&quot;')
    .replace(/'/g, '&apos;');
}

function formatAmount(value) {
  const n = Number(value || 0);
  return n.toFixed(2);
}

/**
 * Construye un bloque TaxTotal a nivel de factura
 */
function buildHeaderTaxTotal(totals) {
  const taxAmount = formatAmount(totals.tax || 0);
  const currency = 'COP';

  return `
  <cac:TaxTotal>
    <cbc:TaxAmount currencyID="${currency}">${taxAmount}</cbc:TaxAmount>
    <cac:TaxSubtotal>
      <cbc:TaxableAmount currencyID="${currency}">${formatAmount(totals.subtotal || 0)}</cbc:TaxableAmount>
      <cbc:TaxAmount currencyID="${currency}">${taxAmount}</cbc:TaxAmount>
      <cac:TaxCategory>
        <cbc:Percent>19.00</cbc:Percent>
        <cac:TaxScheme>
          <cbc:ID>01</cbc:ID> <!-- 01 = IVA -->
          <cbc:Name>IVA</cbc:Name>
        </cac:TaxScheme>
      </cac:TaxCategory>
    </cac:TaxSubtotal>
  </cac:TaxTotal>
  `.trim();
}

/**
 * Construye las líneas de la factura (InvoiceLine)
 */
function buildInvoiceLines(items) {
  const currency = 'COP';

  return items
    .map((item, index) => {
      const lineId = index + 1;
      const qty = Number(item.quantity || 1);
      const unitPrice = Number(item.unitPrice || 0);
      const taxPercent = Number(item.taxPercent || 0);

      const lineBase = qty * unitPrice;
      const lineTax = taxPercent > 0 ? (lineBase * taxPercent) / 100 : 0;

      return `
  <cac:InvoiceLine>
    <cbc:ID>${lineId}</cbc:ID>
    <cbc:InvoicedQuantity unitCode="NIU">${qty}</cbc:InvoicedQuantity>
    <cbc:LineExtensionAmount currencyID="${currency}">${formatAmount(lineBase)}</cbc:LineExtensionAmount>
    <cac:TaxTotal>
      <cbc:TaxAmount currencyID="${currency}">${formatAmount(lineTax)}</cbc:TaxAmount>
      <cac:TaxSubtotal>
        <cbc:TaxableAmount currencyID="${currency}">${formatAmount(lineBase)}</cbc:TaxableAmount>
        <cbc:TaxAmount currencyID="${currency}">${formatAmount(lineTax)}</cbc:TaxAmount>
        <cac:TaxCategory>
          <cbc:Percent>${taxPercent.toFixed(2)}</cbc:Percent>
          <cac:TaxScheme>
            <cbc:ID>01</cbc:ID>
            <cbc:Name>IVA</cbc:Name>
          </cac:TaxScheme>
        </cac:TaxCategory>
      </cac:TaxSubtotal>
    </cac:TaxTotal>
    <cac:Item>
      <cbc:Description>${xmlEscape(item.description || '')}</cbc:Description>
    </cac:Item>
    <cac:Price>
      <cbc:PriceAmount currencyID="${currency}">${formatAmount(unitPrice)}</cbc:PriceAmount>
    </cac:Price>
  </cac:InvoiceLine>
      `.trim();
    })
    .join('\n');
}

/**
 * Construye el bloque del emisor (AccountingSupplierParty)
 */
function buildSupplierBlock(supplier) {
  // supplier viene del objeto que armamos en tu ruta
  const nit = supplier.nit;
  const dv = supplier.dv || '0';
  const regimen = supplier.regimen || '48'; // código régimen (ej: 48 = RGM)
  const responsabilidades = supplier.responsabilidadFiscal || ['R-99-PN'];

  return `
  <cac:AccountingSupplierParty>
    <cac:Party>
      <cac:PartyIdentification>
        <cbc:ID schemeID="31">${nit}</cbc:ID>
      </cac:PartyIdentification>
      <cac:PartyName>
        <cbc:Name>${xmlEscape(supplier.nombre || '')}</cbc:Name>
      </cac:PartyName>
      <cac:PhysicalLocation>
        <cac:Address>
          <cbc:ID>${xmlEscape(supplier.codigoMunicipio || '')}</cbc:ID>
          <cbc:CityName>${xmlEscape(supplier.municipio || '')}</cbc:CityName>
          <cbc:CountrySubentity>${xmlEscape(supplier.departamento || '')}</cbc:CountrySubentity>
          <cbc:AddressLine>
            <cbc:Line>${xmlEscape(supplier.direccion || '')}</cbc:Line>
          </cbc:AddressLine>
          <cac:Country>
            <cbc:IdentificationCode>${xmlEscape(supplier.codigoPais || 'CO')}</cbc:IdentificationCode>
          </cac:Country>
        </cac:Address>
      </cac:PhysicalLocation>
      <cac:PartyTaxScheme>
        <cbc:RegistrationName>${xmlEscape(supplier.nombre || '')}</cbc:RegistrationName>
        <cbc:CompanyID schemeID="31" schemeName="NIT">${nit}${dv}</cbc:CompanyID>
        <cac:TaxScheme>
          <cbc:ID>01</cbc:ID>
          <cbc:Name>IVA</cbc:Name>
        </cac:TaxScheme>
      </cac:PartyTaxScheme>
      <cac:PartyLegalEntity>
        <cbc:RegistrationName>${xmlEscape(supplier.nombre || '')}</cbc:RegistrationName>
        <cbc:CompanyID schemeID="31">${nit}${dv}</cbc:CompanyID>
        <cac:CorporateRegistrationScheme>
          <cbc:Name>${xmlEscape(regimen)}</cbc:Name>
        </cac:CorporateRegistrationScheme>
      </cac:PartyLegalEntity>
      <cac:Contact>
        <cbc:Telephone>${xmlEscape(supplier.telefono || '')}</cbc:Telephone>
        <cbc:ElectronicMail>${xmlEscape(supplier.email || '')}</cbc:ElectronicMail>
      </cac:Contact>
    </cac:Party>
  </cac:AccountingSupplierParty>
  <cac:TaxRepresentativeParty>
    <!-- Opcional, lo dejamos vacío por ahora -->
  </cac:TaxRepresentativeParty>
  `.trim();
}

/**
 * Construye el bloque del adquiriente (AccountingCustomerParty)
 */
function buildCustomerBlock(customer) {
  const tipoDoc = customer.tipoDocumento || '13';
  const numDoc = customer.numeroDocumento || '';
  const nombre = customer.nombre || '';
  const email = customer.email || '';

  return `
  <cac:AccountingCustomerParty>
    <cac:Party>
      <cac:PartyIdentification>
        <cbc:ID schemeID="${xmlEscape(tipoDoc)}">${xmlEscape(numDoc)}</cbc:ID>
      </cac:PartyIdentification>
      <cac:PartyName>
        <cbc:Name>${xmlEscape(nombre)}</cbc:Name>
      </cac:PartyName>
      <cac:PhysicalLocation>
        <cac:Address>
          <cbc:ID>${xmlEscape(customer.codigoMunicipio || '')}</cbc:ID>
          <cbc:CityName>${xmlEscape(customer.municipio || '')}</cbc:CityName>
          <cbc:CountrySubentity>${xmlEscape(customer.departamento || '')}</cbc:CountrySubentity>
          <cbc:AddressLine>
            <cbc:Line>${xmlEscape(customer.direccion || '')}</cbc:Line>
          </cbc:AddressLine>
          <cac:Country>
            <cbc:IdentificationCode>${xmlEscape(customer.codigoPais || 'CO')}</cbc:IdentificationCode>
          </cac:Country>
        </cac:Address>
      </cac:PhysicalLocation>
      <cac:PartyTaxScheme>
        <cbc:RegistrationName>${xmlEscape(nombre)}</cbc:RegistrationName>
        <cbc:CompanyID schemeID="${xmlEscape(tipoDoc)}">${xmlEscape(numDoc)}</cbc:CompanyID>
        <cac:TaxScheme>
          <cbc:ID>01</cbc:ID>
          <cbc:Name>IVA</cbc:Name>
        </cac:TaxScheme>
      </cac:PartyTaxScheme>
      <cac:Contact>
        <cbc:ElectronicMail>${xmlEscape(email)}</cbc:ElectronicMail>
      </cac:Contact>
    </cac:Party>
  </cac:AccountingCustomerParty>
  `.trim();
}

/**
 * Bloque de totales monetarios
 */
function buildLegalMonetaryTotal(totals) {
  const currency = 'COP';
  const subtotal = formatAmount(totals.subtotal || 0);        // Base sin impuestos
  const tax = formatAmount(totals.tax || 0);                  // IVA
  const grandTotal = formatAmount(totals.grandTotal || 0);    // Total a pagar

  return `
  <cac:LegalMonetaryTotal>
    <cbc:LineExtensionAmount currencyID="${currency}">${subtotal}</cbc:LineExtensionAmount>
    <cbc:TaxExclusiveAmount currencyID="${currency}">${subtotal}</cbc:TaxExclusiveAmount>
    <cbc:TaxInclusiveAmount currencyID="${currency}">${grandTotal}</cbc:TaxInclusiveAmount>
    <cbc:PayableAmount currencyID="${currency}">${grandTotal}</cbc:PayableAmount>
  </cac:LegalMonetaryTotal>
  `.trim();
}

/**
 * Bloque de medios de pago
 */
function buildPaymentMeans(payment, issueDate) {
  const paymentMeansCode = payment.paymentMeansCode || '10'; // Contado
  const dueDate = payment.paymentDueDate || issueDate;

  return `
  <cac:PaymentMeans>
    <cbc:PaymentMeansCode>${xmlEscape(paymentMeansCode)}</cbc:PaymentMeansCode>
    <cbc:PaymentDueDate>${xmlEscape(dueDate)}</cbc:PaymentDueDate>
  </cac:PaymentMeans>
  `.trim();
}

/**
 * Construye el XML UBL 2.1 completo para DIAN
 */
function buildInvoiceXml(invoiceData) {
  const {
    number,
    issueDate,
    issueTime,
    cufe,
    customer = {},
    supplier = {},
    payment = {},
    items = [],
    totals = {},
    numeracion = {},
    dian = {},
  } = invoiceData;

  const ambiente = dian.ambiente || '2'; // '1' prod, '2' habilitación
  const softwareId = dian.softwareId || '';
  const softwareSecurityCode = dian.softwareSecurityCode || '';

  const xml = `<?xml version="1.0" encoding="UTF-8"?>
<fe:Invoice
  xmlns:fe="http://www.dian.gov.co/contratos/facturaelectronica/v1"
  xmlns:ds="http://www.w3.org/2000/09/xmldsig#"
  xmlns:xades="http://uri.etsi.org/01903/v1.3.2#"
  xmlns:xades141="http://uri.etsi.org/01903/v1.4.1#"
  xmlns:cac="urn:oasis:names:specification:ubl:schema:xsd:CommonAggregateComponents-2"
  xmlns:cbc="urn:oasis:names:specification:ubl:schema:xsd:CommonBasicComponents-2"
  xmlns:ext="urn:oasis:names:specification:ubl:schema:xsd:CommonExtensionComponents-2"
  xmlns:xsi="http://www.w3.org/2001/XMLSchema-instance">
  <ext:UBLExtensions>
    <ext:UBLExtension>
      <ext:ExtensionContent>
        <!-- Aquí podrían ir extensiones adicionales de DIAN si las necesitas -->
      </ext:ExtensionContent>
    </ext:UBLExtension>
    <ext:UBLExtension>
      <ext:ExtensionContent>
        <!-- La firma XAdES se insertará aquí después (xadesSigner.js) -->
      </ext:ExtensionContent>
    </ext:UBLExtension>
  </ext:UBLExtensions>

  <cbc:UBLVersionID>UBL 2.1</cbc:UBLVersionID>
  <cbc:CustomizationID>10</cbc:CustomizationID>
  <cbc:ProfileID>DIAN 2.1: Factura Electrónica de Venta</cbc:ProfileID>
  <cbc:ProfileExecutionID>${ambiente}</cbc:ProfileExecutionID>

  <cbc:ID>${xmlEscape(number)}</cbc:ID>
  <cbc:UUID schemeID="1" schemeName="CUFE-SHA384">${xmlEscape(cufe)}</cbc:UUID>
  <cbc:IssueDate>${xmlEscape(issueDate)}</cbc:IssueDate>
  <cbc:IssueTime>${xmlEscape(issueTime)}</cbc:IssueTime>
  <cbc:InvoiceTypeCode>01</cbc:InvoiceTypeCode>
  <cbc:DocumentCurrencyCode>COP</cbc:DocumentCurrencyCode>
  <cbc:LineCountNumeric>${items.length}</cbc:LineCountNumeric>

  <!-- Datos de la numeración autorizada por DIAN -->
  <cbc:Note>Resolución ${xmlEscape(
    numeracion.resolutionNumber || ''
  )} del ${xmlEscape(numeracion.resolutionDate || '')}</cbc:Note>

  <cac:Signature>
    <cbc:ID>${xmlEscape(softwareId || 'ID-SIGN')}</cbc:ID>
    <cbc:Note>Software de facturación electrónica</cbc:Note>
    <cac:SignatoryParty>
      <cac:PartyIdentification>
        <cbc:ID>${xmlEscape(supplier.nit || '')}</cbc:ID>
      </cac:PartyIdentification>
      <cac:PartyName>
        <cbc:Name>${xmlEscape(supplier.nombre || '')}</cbc:Name>
      </cac:PartyName>
    </cac:SignatoryParty>
    <cac:DigitalSignatureAttachment>
      <cac:ExternalReference>
        <cbc:URI>#signature-${xmlEscape(number)}</cbc:URI>
      </cac:ExternalReference>
    </cac:DigitalSignatureAttachment>
  </cac:Signature>

  ${buildSupplierBlock(supplier)}

  ${buildCustomerBlock(customer)}

  ${buildPaymentMeans(payment, issueDate)}

  ${buildHeaderTaxTotal(totals)}

  ${buildLegalMonetaryTotal(totals)}

  ${buildInvoiceLines(items)}
</fe:Invoice>
`.trim();

  return xml;
}

module.exports = {
  buildInvoiceXml,
};
