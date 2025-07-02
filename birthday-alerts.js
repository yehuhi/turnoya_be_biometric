const { isToday } = require('date-fns');
const { parseISO } = require('date-fns'); // Para parsear fechas ISO si es necesario
const cron = require('node-cron');
const admin = require('firebase-admin');

// Función para obtener la fecha en la zona horaria de Colombia (ajuste manual a UTC-5)
const getTodayInColombia = () => {
  const today = new Date(); // Fecha y hora actuales en UTC
  today.setHours(today.getHours() - 5); // Ajuste a UTC-5 para Colombia
  return today;
};

const sendBirthdayAlerts = async (io) => {
  const db = admin.firestore();
  const usersRef = db.collection('users');
  const snapshot = await usersRef.get();
  
  const today = getTodayInColombia(); // Hora de Colombia (UTC-5)
  const usersWithBirthdayToday = [];

  snapshot.forEach((doc) => {
    const user = doc.data();
    const birthdate = new Date(user.birthdate); // Asumiendo que birthdate es una cadena tipo "1988-07-02"

    // Solo comparamos el mes y el día, no el año
    const todayDate = new Date(today);
    if (birthdate.getDate() === todayDate.getDate() && birthdate.getMonth() === todayDate.getMonth()) {
      usersWithBirthdayToday.push(user);
    }
  });

  usersWithBirthdayToday.forEach((user) => {
    io.emit('birthday_alert', { message: `¡Feliz cumpleaños, ${user.fullName}! 🎉` });
  });

  console.log(`Enviado alerta de cumpleaños a ${usersWithBirthdayToday.length} usuarios.`);
};

// Configurar la tarea para que se ejecute todos los días a las 9 AM (hora Colombia)
cron.schedule('0 9 * * *', () => {
  console.log('Ejecutando tarea de cumpleaños...');
  sendBirthdayAlerts(io);  
});

module.exports = { sendBirthdayAlerts };
