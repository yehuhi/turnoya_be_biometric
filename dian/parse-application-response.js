// dian/parse-application-response.js
const { Buffer } = require('buffer');
const xml2js = require('xml2js');

async function parseDianApplicationResponse(base64Xml) {
  if (!base64Xml) return null;

  const xmlString = Buffer.from(base64Xml, 'base64').toString('utf8');

  const parser = new xml2js.Parser({ explicitArray: false });
  const xml = await parser.parseStringPromise(xmlString);

  const appResp = xml.ApplicationResponse || xml['sts:ApplicationResponse'] || xml;

  const issueDate = appResp['cbc:IssueDate'] || appResp.IssueDate;
  const issueTime = appResp['cbc:IssueTime'] || appResp.IssueTime;

  let description;
  try {
    const docResp = appResp['cac:DocumentResponse'] || appResp.cac?.DocumentResponse;
    const response = docResp?.['cac:Response'] || docResp?.cac?.Response;
    description = response?.['cbc:Description'] || response?.cbc?.Description;
  } catch (e) {
    description = null;
  }

  return {
    issueDate,   // YYYY-MM-DD
    issueTime,   // HH:mm:ss-05:00
    description, // suele contener "Documento Validado por la DIAN"
    rawXml: xmlString,
  };
}

module.exports = { parseDianApplicationResponse };
