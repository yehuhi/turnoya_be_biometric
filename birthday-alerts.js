const admin = require('firebase-admin');
const { sendBirthdayAlert, sendBirthdayListToAdmin } = require('./socket-io'); // Importamos las funciones de socket-io

// Función para obtener la fecha en la zona horaria de Colombia (ajuste manual a UTC-5)
const getTodayInColombia = () => {
  const today = new Date(); // Fecha y hora actuales en UTC
  today.setHours(today.getHours() - 5); // Ajuste a UTC-5 para Colombia
  return today;
};

// Función para emitir alertas de cumpleaños a clientes cuando se logean
const sendBirthdayAlerts = async (userId, userType, socket, io) => {
  const db = admin.firestore();
  const userRef = db.collection('users').doc(userId);
  const userSnapshot = await userRef.get();
  const user = userSnapshot.data();

  if (user) {
    const today = new Date();
    const birthdate = new Date(user.birthdate);

    // Verificar si el usuario tiene cumpleaños hoy
    if (birthdate.getDate() === today.getDate() && birthdate.getMonth() === today.getMonth()) {
      console.log(`¡Feliz cumpleaños a ${user.fullName}!`);
      
      // Emitir la alerta de cumpleaños solo al cliente
      if (userType === 'client') {
        sendBirthdayAlert(io, { message: `¡Feliz cumpleaños, ${user.fullName}! 🎉` });
      }
    }
  } else {
    console.log('Usuario no encontrado');
  }

  // Si el tipo de usuario es admin, enviar la lista de clientes con cumpleaños hoy
  if (userType === 'admin') {
    sendBirthdayListToAdmin(io); // Enviar lista de todos los clientes con cumpleaños
  }
};

module.exports = { sendBirthdayAlerts };
