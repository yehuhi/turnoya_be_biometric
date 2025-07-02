const admin = require('firebase-admin');
const { sendBirthdayAlert } = require('./socket-io'); // Importamos las funciones de socket-io

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
    const birthdateStr = user.birthdate;

    // Verificar si el campo `birthdate` existe y es un string
    if (!birthdateStr || typeof birthdateStr !== 'string') {
      console.log(`El usuario ${user.fullName} no tiene fecha de nacimiento definida o la tiene mal formateada.`);
      return;
    }

    // Intentamos convertir `birthdateStr` a un objeto Date
    const birthdate = new Date(birthdateStr); // Convertir la fecha a un objeto Date

    // Verificar si la fecha es válida
    if (isNaN(birthdate)) {
      console.log(`Fecha de cumpleaños no válida para ${user.fullName}: ${birthdateStr}`);
      return; // Saltar si la fecha es inválida
    }

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

// FUNCION QUE ENVÍA LA LISTA DE CUMPLEAÑOS A LOS ADMIN
const sendBirthdayListToAdmin = async (io, today, nextTwoDays) => {
  const db = admin.firestore();
  const usersRef = db.collection('users');
  const snapshot = await usersRef.get();

  const usersWithBirthdayInNextTwoDays = [];

  snapshot.forEach((doc) => {
    const user = doc.data();
    const birthdateStr = user.birthdate;

    // Verificar si el campo `birthdate` existe y es un string
    if (!birthdateStr || typeof birthdateStr !== 'string') {
      console.log(`El usuario ${user.fullName} no tiene fecha de nacimiento definida o la tiene mal formateada.`);
      return; // Saltar si no tiene fecha de nacimiento
    }

    // Intentamos convertir `birthdateStr` a un objeto Date
    const birthdate = new Date(birthdateStr); // Convertir la fecha a un objeto Date

    // Verificar si la fecha es válida
    if (isNaN(birthdate)) {
      console.log(`Fecha de cumpleaños no válida para ${user.fullName}: ${birthdateStr}`);
      return; // Saltar si la fecha es inválida
    }

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
