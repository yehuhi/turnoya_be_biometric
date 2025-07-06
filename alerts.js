const cron = require('node-cron');
const admin = require('firebase-admin');
const { sendDiscountAlert, sendAlertToClientGroup } = require('./socket-io'); // Importamos las funciones de socket-io

// Función para programar el envío de la alerta
const scheduleAlert = async (alertData, io) => {
  const whenToSend = new Date(alertData.whenToSend); // La fecha de envío seleccionada por el admin
  const groupId = alertData.groupId; // El ID del grupo de clientes al que se enviará la alerta

  // Obtener los usuarios del grupo (clientClassifications)
  const groupRef = admin.firestore().collection('clientClassifications').doc(groupId);
  const groupSnapshot = await groupRef.get();
  
  if (!groupSnapshot.exists) {
    console.error('El grupo no existe');
    return;
  }

  const group = groupSnapshot.data();
  const clientIds = group.users; // Array con los IDs de los clientes

  // Verifica que el grupo tenga clientes asignados
  if (!clientIds || clientIds.length === 0) {
    console.error(`El grupo ${groupId} no tiene clientes asignados`);
    return;
  }

  // Definir cron job basado en la frecuencia de la alerta
  switch (alertData.frequency) {
    case 'once':
      // Si es "una vez", ejecutamos en la fecha y hora exactas seleccionadas
      cron.schedule(`${whenToSend.getMinutes()} ${whenToSend.getHours()} ${whenToSend.getDate()} ${whenToSend.getMonth() + 1} *`, () => {
        sendAlertToGroup(clientIds, alertData, io); // Enviar alerta al grupo
      });
      break;

    case 'daily':
      // Si es "diario", ejecutamos todos los días a la misma hora seleccionada
      cron.schedule(`${whenToSend.getMinutes()} ${whenToSend.getHours()} * * *`, () => {
        sendAlertToGroup(clientIds, alertData, io);
      });
      break;

    case 'weekly':
      // Si es "semanal", ejecutamos una vez a la semana en la fecha y hora seleccionadas
      cron.schedule(`${whenToSend.getMinutes()} ${whenToSend.getHours()} ${whenToSend.getDate()} * *`, () => {
        sendAlertToGroup(clientIds, alertData, io);
      });
      break;

    case 'monthly':
      // Si es "mensual", ejecutamos una vez al mes en la fecha y hora seleccionadas
      cron.schedule(`${whenToSend.getMinutes()} ${whenToSend.getHours()} ${whenToSend.getDate()} * *`, () => {
        sendAlertToGroup(clientIds, alertData, io);
      });
      break;

    case 'yearly':
      // Si es "anual", ejecutamos una vez al año en la fecha y hora seleccionadas
      cron.schedule(`${whenToSend.getMinutes()} ${whenToSend.getHours()} ${whenToSend.getDate()} ${whenToSend.getMonth() + 1} *`, () => {
        sendAlertToGroup(clientIds, alertData, io);
      });
      break;
  }
};

// Función para emitir la alerta a los grupos seleccionados
const sendAlertToGroup = async (clientIds, alertData, io) => {
  // Obtener los datos de los clientes (usuarios o empleados)
  const usersRef = admin.firestore().collection(alertData.userType === 'Clientes' ? 'users' : 'workers');
  
  const clients = await usersRef.where(admin.firestore.FieldPath.documentId(), 'in', clientIds).get();

  // Emitir la alerta a cada cliente
  clients.forEach(clientDoc => {
    const clientData = clientDoc.data();
    // console.log(`Enviando alerta a ${clientData.fullName} (ID: ${clientData.id})`);

    // Crear el mensaje con la información necesaria
    const alertMessage = {
      message: alertData.message,
      messageName: alertData.name,
      designTemplateId: alertData.designTemplateId,
      startDate: alertData.startDate,
      endDate: alertData.endDate,
      items: alertData.items,
      phone: clientData.phoneNumber || clientData.phone,
      name: clientData.fullName || 'Desconocido',
    };

    // Emitir la alerta solo al cliente
    sendAlertToClientGroup(io, clientData.id, alertMessage); // Emitir alerta solo al cliente
  });
};

module.exports = { scheduleAlert };
