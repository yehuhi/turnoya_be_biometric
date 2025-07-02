const axios = require('axios');

// Función para obtener datos del control de huellas dactilares (Hikvision)
const getFingerprintData = async () => {
  try {
    const response = await axios.get('https://hikvision-api.com/fingerprint-data');
    return response.data;
  } catch (error) {
    console.error('Error al obtener datos de Hikvision', error);
  }
};

module.exports = { getFingerprintData };
