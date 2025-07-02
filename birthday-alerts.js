const admin = require('firebase-admin');
const { sendBirthdayAlert, sendBirthdayListToAdmin } = require('./socket-io'); // Importamos las funciones de socket-io

// Función para obtener la fecha en la zona horaria de Colombia (ajuste manual a UTC-5)
const getTodayInColombia = () => {
  const today = new Date(); // Fecha y hora actuales en UTC
  today.setHours(today.getHours() - 5); // Ajuste a UTC-5 para Colombia
  return today;
};

// Función para obtener la fecha de los próximos dos días
const getNextDaysInColombia = (days = 2) => {
  const today = getTodayInColombia(); // Fecha de hoy
  today.setDate(today.getDate() + days); // Sumamos los días que necesitamos (2 días)
  return today;
};

// Función para emitir alertas de cumpleaños a clientes cuando se logean
const sendBirthdayAlerts = async (userId, userType, socket, io) => {
  const db = admin.firestore();
  const userRef = db.collection('users').doc(userId);
  const userSnapshot = await userRef.get();
  const user = userSnapshot.data();

  if (user) {
    const today = getTodayInColombia(); // Obtener la fecha de hoy
    const nextTwoDays = getNextDaysInColombia(2); // Obtener la fecha de los próximos dos días
    const birthdate = new Date(user.birthdate);

    // Verificar si el usuario tiene cumpleaños hoy
    if (birthdate.getDate() === today.getDate() && birthdate.getMonth() === today.getMonth()) {
      console.log(`¡Feliz cumpleaños a ${user.fullName}!`);
      
      // Emitir la alerta de cumpleaños solo al cliente
      if (userType === 'client') {
        sendBirthdayAlert(io, { message: `¡Feliz cumpleaños, ${user.fullName}! 🎉` });
      }
    }
    
    // Si el tipo de usuario es admin, enviar la lista de clientes con cumpleaños hoy y los próximos 2 días
    if (userType === 'admin') {
      sendBirthdayListToAdmin(io, today, nextTwoDays); // Enviar lista de clientes con cumpleaños hoy y en los próximos 2 días
    }
  } else {
    console.log('Usuario no encontrado');
  }
};

// Función para enviar la lista de cumpleaños a todos los clientes con cumpleaños en los próximos 2 días al admin
const sendBirthdayListToAdmin = async (io, today, nextTwoDays) => {
  const db = admin.firestore();
  const usersRef = db.collection('users');
  const snapshot = await usersRef.get();

  const usersWithBirthdayInNextTwoDays = [];

  snapshot.forEach((doc) => {
    const user = doc.data();
    const birthdate = new Date(user.birthdate);

    // Solo comparamos el mes y el día, no el año, y verificamos si el cumpleaños está dentro de los próximos 2 días
    if (
      (birthdate.getDate() === today.getDate() && birthdate.getMonth() === today.getMonth()) || // Cumpleaños hoy
      (birthdate.getDate() === nextTwoDays.getDate() && birthdate.getMonth() === nextTwoDays.getMonth()) // Cumpleaños dentro de los próximos 2 días
    ) {
      usersWithBirthdayInNextTwoDays.push(user);
    }
  });

  // Enviar la lista de clientes con cumpleaños en los próximos 2 días al admin
  if (usersWithBirthdayInNextTwoDays.length > 0) {
    io.emit('admin_birthday_list', { message: 'Clientes con cumpleaños hoy y los próximos 2 días:', data: usersWithBirthdayInNextTwoDays });
    console.log(`Lista de cumpleaños enviada al admin con ${usersWithBirthdayInNextTwoDays.length} usuarios.`);
  } else {
    console.log('No hay usuarios con cumpleaños hoy o en los próximos 2 días.');
  }
};

module.exports = { sendBirthdayAlerts, sendBirthdayListToAdmin };
