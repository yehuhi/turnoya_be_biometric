const admin = require('firebase-admin');
const { sendBirthdayAlert } = require('./socket-io'); // Importamos las funciones de socket-io

// Función para obtener la fecha en la zona horaria de Colombia (ajuste manual a UTC-5)
const getTodayInColombia = () => {
  const today = new Date(); // Fecha y hora actuales en UTC
  today.setHours(today.getHours() - 5); // Ajuste a UTC-5 para Colombia
  return today;
};

// Función para obtener todos los clientes con cumpleaños hoy
const sendBirthdayListToAdmin = async (io) => {
  const db = admin.firestore();
  const usersRef = db.collection('users');
  const snapshot = await usersRef.get();

  const usersWithBirthdayToday = [];

  snapshot.forEach((doc) => {
    const user = doc.data();
    const birthdate = new Date(user.birthdate);

    // Solo comparamos el mes y el día, no el año
    const today = getTodayInColombia();
    if (birthdate.getDate() === today.getDate() && birthdate.getMonth() === today.getMonth()) {
      usersWithBirthdayToday.push(user);
    }
  });

  // Emitir la lista de cumpleaños al admin
  if (usersWithBirthdayToday.length > 0) {
    io.emit('admin_birthday_list', { message: 'Clientes con cumpleaños hoy:', data: usersWithBirthdayToday });
    console.log(`Lista de cumpleaños enviada al admin con ${usersWithBirthdayToday.length} usuarios.`);
  } else {
    console.log('No hay usuarios con cumpleaños hoy.');
  }
};

// Función para emitir alertas de cumpleaños a clientes cuando se logean
const sendBirthdayAlerts = async (userId, userType, socket, io) => {
  const db = admin.firestore();
  const userRef = db.collection('users').doc(userId);
  const userSnapshot = await userRef.get();
  const user = userSnapshot.data();

  if (user) {
    const today = getTodayInColombia(); // Obtener la fecha de hoy
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
};

module.exports = { sendBirthdayAlerts, sendBirthdayListToAdmin };
