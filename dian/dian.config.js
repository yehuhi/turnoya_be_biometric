// dian/dian.config.js
require('dotenv').config();

const DIAN_ENV = process.env.DIAN_ENV || 'hab';

const DIAN_ENDPOINTS = {
  hab: process.env.DIAN_HAB_URL || 'https://vpfe-hab.dian.gov.co/WcfDianCustomerServices.svc',
  prod: process.env.DIAN_PROD_URL || 'https://vpfe.dian.gov.co/WcfDianCustomerServices.svc',
};

// Acciones SOAP del servicio WcfDianCustomerServices
const DIAN_SOAP_ACTIONS = {
  getAcquirer: 'http://wcf.dian.colombia/IWcfDianCustomerServices/GetAcquirer',
  // aquí luego puedes añadir:
  // getStatus: 'http://wcf.dian.colombia/IWcfDianCustomerServices/GetStatus',
  // etc.
};

const dianConfig = {
  env: DIAN_ENV,
  baseUrl: DIAN_ENDPOINTS[DIAN_ENV],
  basicUser: process.env.DIAN_BASIC_USER,
  basicPass: process.env.DIAN_BASIC_PASS,
};

module.exports = {
  dianConfig,
  DIAN_SOAP_ACTIONS,
};
