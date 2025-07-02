const axios = require('axios');

// Función para interactuar con Retell AI
const getRetellAIData = async (message) => {
  try {
    const response = await axios.post('https://api.retellai.com/endpoint', {
      data: message,
    }, {
      headers: { 'Authorization': 'Bearer your-api-key' }
    });
    return response.data;
  } catch (error) {
    console.error('Error al obtener datos de Retell AI', error);
  }
};

module.exports = { getRetellAIData };
