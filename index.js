const express = require('express');
const http = require('http');
const socketIo = require('socket.io');
const cors = require('cors');
const admin = require('firebase-admin');
const { sendBirthdayAlerts, sendBirthdayListToAdmin } = require('./birthday-alerts'); // Importar sendBirthdayAlerts y sendBirthdayListToAdmin
const { sendDiscountAlert, sendBirthdayAlert, sendBarberAlert, sendAlertToClientGroup } = require('./socket-io'); // Asegúrate de que esta línea esté correcta

const app = express();
const server = http.createServer(app);

// Configuración de Socket.io
const io = socketIo(server, {
  cors: {
    origin: true,
    // origin: 'https://turnoyapp.netlify.app', // URL del frontend
    // methods: ['GET', 'POST'],
    // allowedHeaders: ['Content-Type'],
    credentials: true,
  },
  transports: ['websocket'], // Forzar el uso de WebSocket
});

app.use(express.json());
app.use(cors()); // Agregar CORS para las peticiones HTTP

// Conexión a Firebase
const serviceAccount = require('./firebase-config.json');
admin.initializeApp({
  credential: admin.credential.cert(serviceAccount),
});

// Escuchar cambios en la colección 'alerts' de Firestore
const db = admin.firestore();
db.collection('alerts').onSnapshot((snapshot) => {
  snapshot.docChanges().forEach(async (change) => {
    if (change.type === 'added' || change.type === 'modified') {
      const alertData = change.doc.data();

      console.log(`Alerta recibida: ${alertData.message}`);

      // Verifica que clientClassifications esté presente
      const clientClassifications = alertData.clientClassifications;
      if (!clientClassifications || clientClassifications.length === 0) {
        console.error('No se ha proporcionado ningún grupo de clientes para esta alerta');
        return;
      }

      try {
        // Iterar sobre cada grupo de clientes
        for (const groupId of clientClassifications) {
          const groupRef = db.collection('clientClassifications').doc(groupId);
          const groupSnapshot = await groupRef.get();
          
          if (groupSnapshot.exists) {
            const group = groupSnapshot.data();
            const clientIds = group.users; // Array con los IDs de los clientes

            // Verifica que el grupo tenga clientes asignados
            if (!clientIds || clientIds.length === 0) {
              console.error(`El grupo ${groupId} no tiene clientes asignados`);
              continue;
            }

            // Obtener los datos de los clientes o empleados
            const usersRef = db.collection(group.userType === 'Clientes' ? 'users' : 'workers');
            const clients = await usersRef.where(admin.firestore.FieldPath.documentId(), 'in', clientIds).get();

            // Emitir la alerta a cada cliente
                clients.forEach(clientDoc => {
                const clientData = clientDoc.data();
                const clientId = clientDoc.id;  // Accedemos al ID del documento correctamente
                // console.log(`Enviando alerta a ${clientData.fullName} (ID: ${clientId})`);

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
                sendAlertToClientGroup(io, clientId, alertMessage); // Emitir alerta solo al cliente
                });

          } else {
            console.error(`No se encontró el grupo con ID: ${groupId}`);
          }
        }
      } catch (error) {
        console.error('Error al obtener los grupos o los clientes:', error);
      }
    }
  });
});


// Escuchar cambios en la colección 'discounts' de Firestore
db.collection('discounts').onSnapshot((snapshot) => {
  snapshot.docChanges().forEach(async (change) => {
    if (change.type === 'added' || change.type === 'modified') {
      const alertData = change.doc.data();
      console.log(`Alerta de descuento recibida: ${alertData.description}`);

      // Obtener los grupos de clientes a los que se enviará la alerta
      const clientClassifications = alertData.clientClassifications;
      if (!clientClassifications || clientClassifications.length === 0) {
        console.error('No se ha proporcionado ningún grupo de clientes para esta alerta');
        return;
      }

      try {
        // Iterar sobre cada grupo de clientes
        for (const groupId of clientClassifications) {
          const groupRef = db.collection('clientClassifications').doc(groupId);
          const groupSnapshot = await groupRef.get();

          if (groupSnapshot.exists) {
            const group = groupSnapshot.data();
            const clientIds = group.users; // Array con los IDs de los clientes

            // Verificar que el grupo tenga clientes asignados
            if (!clientIds || clientIds.length === 0) {
              console.error(`El grupo ${groupId} no tiene clientes asignados`);
              continue;
            }

            // Obtener los datos de los clientes o empleados
            const usersRef = db.collection(group.userType === 'Clientes' ? 'users' : 'workers');
            const clients = await usersRef.where(admin.firestore.FieldPath.documentId(), 'in', clientIds).get();

            // Emitir la alerta a cada cliente
            clients.forEach(clientDoc => {
              const clientData = clientDoc.data();
              const clientId = clientDoc.id;  // Accedemos al ID del documento correctamente
            //   console.log(`Enviando alerta a ${clientData.fullName} (ID: ${clientId})`);

              // Crear el mensaje con la información necesaria
              const alertMessage = {
                message: alertData.description,
                messageName: alertData.name,
                designTemplateId: alertData.designTemplateId,
                startDate: alertData.startDate,
                endDate: alertData.endDate,
                items: alertData.items,
                phone: clientData.phoneNumber || clientData.phone,
                name: clientData.fullName || 'Desconocido',
              };

              // Emitir la alerta solo al cliente
              sendAlertToClientGroup(io, clientId, alertMessage); // Emitir alerta solo al cliente
            });
          } else {
            console.error(`No se encontró el grupo con ID: ${groupId}`);
          }
        }
      } catch (error) {
        console.error('Error al obtener los grupos o los clientes:', error);
      }
    }
  });
});


// Escuchar cambios en la colección 'birthdayAlerts' de Firestore
db.collection('birthdayAlerts').onSnapshot((snapshot) => {
  snapshot.docChanges().forEach(async (change) => {
    if (change.type === 'added' || change.type === 'modified') {
      const alertData = change.doc.data();
      console.log(`Alerta de cumpleaños recibida: ${alertData.message}`);

      // Verificar si el grupo está presente
      const clientClassifications = alertData.customerClassifications;
      if (!clientClassifications || clientClassifications.length === 0) {
        console.error('No se ha proporcionado ningún grupo de clientes para esta alerta de cumpleaños');
        return;
      }

      const today = new Date(); // Obtener la fecha de hoy
      const startDate = alertData.startDate.toDate(); // Convertir a objeto Date
      const endDate = alertData.endDate.toDate(); // Convertir a objeto Date

      // Verificar si la fecha de hoy está dentro del rango de la alerta
      if (today < startDate || today > endDate) {
        console.log('La fecha de hoy no está dentro del rango de la alerta');
        return; // Si no está dentro del rango, no enviamos la alerta
      }

      try {
        // Iterar sobre cada grupo de clientes
        for (const groupId of clientClassifications) {
          const groupRef = db.collection('clientClassifications').doc(groupId);
          const groupSnapshot = await groupRef.get();

          if (groupSnapshot.exists) {
            const group = groupSnapshot.data();
            const clientIds = group.users;

            // Verificar si el grupo tiene clientes asignados
            if (!clientIds || clientIds.length === 0) {
              console.error(`El grupo ${groupId} no tiene clientes asignados`);
              continue;
            }

            // Obtener los datos de los clientes o empleados
            const usersRef = db.collection(group.userType === 'Clientes' ? 'users' : 'workers');
            const clients = await usersRef.where(admin.firestore.FieldPath.documentId(), 'in', clientIds).get();

            // Emitir la alerta a cada cliente
            clients.forEach(clientDoc => {
              const clientData = clientDoc.data();
              const clientId = clientDoc.id;

              // Verificar si el cumpleaños es hoy
              const birthdateStr = clientData.birthdate;
              const birthdate = new Date(birthdateStr);
              console.log(`Fecha de cumpleaños de ${clientData.fullName}: ${birthdate}`);

              if (birthdate.getDate() === today.getDate() && birthdate.getMonth() === today.getMonth()) {
                console.log(`Enviando alerta de CUMPLEANOS a ${clientData.fullName} (ID: ${clientId})`);

                // Si el cliente está en el grupo, enviar todos los detalles de la alerta
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
                sendAlertToClientGroup(io, clientId, alertMessage);
              }
            });
          } else {
            console.error(`No se encontró el grupo con ID: ${groupId}`);
          }
        }
      } catch (error) {
        console.error('Error al obtener los grupos o los clientes:', error);
      }
    }
  });
});


// Función que maneja la autenticación
io.on('connection', (socket) => {
  console.log('Cliente conectado');
  
  socket.on('authenticate', async (userId, userType) => {
    console.log(`Autenticado: ${userId}, Tipo de usuario: ${userType}`);
    try {
      if (userType === 'admin') {
        await sendBirthdayListToAdmin(io); // Enviar la lista de cumpleaños a los admin
      } else if (userType === 'client') {
        await sendBirthdayAlerts(userId, userType, socket, io); // Verificar y enviar alertas de cumpleaños
      }
    } catch (error) {
      console.log('Error al manejar la autenticación del usuario:', error);
    }
  });

  socket.on('disconnect', () => {
    console.log('Cliente desconectado');
  });
});






// Evento cuando un cliente se conecta
io.on('connection', (socket) => {
  console.log('Cliente conectado');

  // Evento para cuando el cliente se autentica (por ejemplo, con su ID de usuario)
  socket.on('authenticate', async (userId, userType) => {
    console.log(`Autenticado: ${userId}, Tipo de usuario: ${userType}`);
    try {
      // Si el tipo de usuario es admin, le enviamos todos los clientes con cumpleaños hoy
      if (userType === 'admin') {
        await sendBirthdayListToAdmin(io); // Enviar la lista de cumpleaños a los admin
      } else if (userType === 'client') {
        // Si el tipo de usuario es cliente, verificar si tiene cumpleaños hoy y enviar la alerta
        await sendBirthdayAlerts(userId, userType, socket, io);
      }
    } catch (error) {
      console.log('Error al manejar la autenticación del usuario:', error);
    }
  });

  socket.on('disconnect', () => {
    console.log('Cliente desconectado');
  });
});

// Configura el servidor para escuchar
const PORT = process.env.PORT || 5000;
server.listen(PORT, () => {
  console.log(`Servidor corriendo en puerto ${PORT}`);
});
