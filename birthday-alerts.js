const admin = require('firebase-admin');
const { sendBirthdayAlert } = require('./socket-io'); // Importamos las funciones de socket-io

// Función para obtener la fecha en la zona horaria de Colombia (ajuste manual a UTC-5)
const getTodayInColombia = () => {
  const today = new Date(); // Fecha y hora actuales en UTC
  today.setHours(today.getHours() - 5); // Ajuste a UTC-5 para Colombia
  return today;
};

// Función para enviar alertas de cumpleaños a clientes cuando se logean
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

      // Revisar si hay una alerta activa en la colección 'birthdayAlerts'
      const birthdayAlertsRef = db.collection('birthdayAlerts');
      const alertsSnapshot = await birthdayAlertsRef.where('active', '==', true)
        .where('startDate', '<=', today) // StartDate debe ser menor o igual a hoy
        .where('endDate', '>=', today)  // EndDate debe ser mayor o igual a hoy
        .get();

      if (!alertsSnapshot.empty) {
        // Si la alerta está activa y el día está dentro del rango
        alertsSnapshot.forEach(async (alertDoc) => {
          const alertData = alertDoc.data();
          const customerClassifications = alertData.customerClassifications || [];

          // Iteramos sobre los IDs de los grupos de clientes
          for (const groupId of customerClassifications) {
            const groupRef = db.collection('clientClassifications').doc(groupId);
            const groupSnapshot = await groupRef.get();

            if (groupSnapshot.exists) {
              const group = groupSnapshot.data();
              const clientIds = group.users; // Array con los IDs de los usuarios

              // Verificar si el usuario está en el grupo
              if (clientIds.includes(userId)) {
                console.log(`Enviando alerta de cumpleaños a ${user.fullName} con detalles completos.`);

                // Crear el mensaje con la información necesaria
                const alertMessage = {
                  message: alertData.message, // Mensaje de la alerta
                  messageName: alertData.name,
                  designTemplateId: alertData.designTemplateId,
                  startDate: alertData.startDate,
                  endDate: alertData.endDate,
                  items: alertData.items,
                  phone: user.phoneNumber, // Asegúrate de tener el número de teléfono correcto
                  name: user.fullName, // Nombre del usuario
                };

                // Imprimir el mensaje que estamos enviando
                console.log(`Enviando alerta a ${user.fullName} con el mensaje:`, alertMessage);

                // Enviar la alerta completa al cliente
                sendBirthdayAlert(io, alertMessage); // Enviar la alerta completa
              }
            }
          }
        });
      } else {
        console.log(`No hay alertas de cumpleaños activas para el usuario ${user.fullName}.`);
        // Enviar mensaje genérico de cumpleaños
        const genericMessage = `¡Feliz cumpleaños de parte de Don Bigotes Barbería, ${user.fullName}! 🎉`;
        sendBirthdayAlert(io, { message: genericMessage });
      }
    }
  } else {
    console.log('Usuario no encontrado');
  }
};

// Función que envía la lista de cumpleaños a los admin
const sendBirthdayListToAdmin = async (io) => {
  try {
    const today = new Date(); // Obtener la fecha de hoy
    console.log(`Buscando cumpleaños para hoy: ${today.toDateString()}`); // Log para verificar si la función se está llamando

    const db = admin.firestore();
    const usersRef = db.collection('users');
    const snapshot = await usersRef.get();  // Obtener todos los usuarios

    const usersWithBirthdayToday = [];  // Lista de usuarios con cumpleaños hoy

    snapshot.forEach((doc) => {
      const user = doc.data();
      const birthdateStr = user.birthdate;

      // Verificar si el campo `birthdate` existe y es un string
      if (!birthdateStr || typeof birthdateStr !== 'string') {
        console.log(`El usuario ${user.fullName} no tiene fecha de nacimiento definida o la tiene mal formateada.`);
        return; // Saltar si no tiene fecha de nacimiento
      }

      const birthdate = new Date(birthdateStr); // Convertir la fecha a un objeto Date

      // Verificar si la fecha es válida
      if (isNaN(birthdate)) {
        console.log(`Fecha de cumpleaños no válida para ${user.fullName}: ${birthdateStr}`);
        return; // Saltar si la fecha es inválida
      }

      // Solo comparamos el mes y el día, no el año, y verificamos si el cumpleaños es hoy
      if (birthdate.getDate() === today.getDate() && birthdate.getMonth() === today.getMonth()) {
        console.log(`Usuario con cumpleaños encontrado: ${user.fullName} - ${birthdateStr}`);
        usersWithBirthdayToday.push(user);  // Añadir el usuario a la lista
      }
    });

    // Enviar la lista de cumpleaños hoy al admin si hay usuarios
    if (usersWithBirthdayToday.length > 0) {
      io.emit('admin_birthday_list', { 
        message: 'Clientes con cumpleaños hoy:', 
        data: usersWithBirthdayToday 
      });

      console.log(`Lista de cumpleaños enviada al admin con ${usersWithBirthdayToday.length} usuarios.`);
    } else {
      console.log('No hay usuarios con cumpleaños hoy.');
    }
  } catch (error) {
    console.error('Error en sendBirthdayListToAdmin:', error);
  }
};

module.exports = { sendBirthdayAlerts, sendBirthdayListToAdmin };
