const express = require('express');
const http = require('http');
const socketIo = require('socket.io');
const cors = require('cors');
const admin = require('firebase-admin');
const xml2js = require('xml2js');
const { sendBirthdayAlerts, sendBirthdayListToAdmin } = require('./birthday-alerts');
const { sendDiscountAlert, sendBirthdayAlert, sendBarberAlert, sendAlertToClientGroup } = require('./socket-io');

// ⭐ IMPORTAR SERVICIO HIKVISION
const {
  checkDeviceStatus,
  getFingerprintData,
  processAttendanceEvent,
  registerUserInDevice,
  syncUsersToDevice,
  getAttendanceRecords,
} = require('./hikvision-service');

const app = express();
const server = http.createServer(app);

// Configuración de Socket.io
const io = socketIo(server, {
  cors: {
    origin: true,
    credentials: true,
  },
  transports: ['websocket'],
});

app.use(express.json());
app.use(express.text({ type: 'application/xml' })); // ⭐ Para recibir XML del webhook
app.use(cors());

// Conexión a Firebase (solo si no está inicializado)
let db;
try {
  // Intentar obtener la app por defecto
  db = admin.firestore();
} catch (error) {
  // Si no existe, inicializarla
  const serviceAccount = require('./firebase-config.json');
  admin.initializeApp({
    credential: admin.credential.cert(serviceAccount),
  });
  db = admin.firestore();
}

// ============================================
// ENDPOINTS HIKVISION
// ============================================

// Verificar estado del dispositivo
app.get('/api/hikvision/status', async (req, res) => {
  try {
    const status = await checkDeviceStatus();
    res.json(status);
  } catch (error) {
    res.status(500).json({
      success: false,
      error: error.message,
    });
  }
});

// Webhook para recibir eventos del dispositivo en tiempo real
app.post('/api/hikvision/webhook', async (req, res) => {
  try {
    console.log('📩 Webhook recibido de Hikvision');

    const parser = new xml2js.Parser({ explicitArray: false });
    const result = await parser.parseStringPromise(req.body);

    // Extraer información del evento
    const event = result.EventNotificationAlert;
    const eventType = event.eventType;

    // Solo procesar eventos de control de acceso
    if (eventType !== 'AccessControllerEvent') {
      return res.status(200).send('OK');
    }

    // Procesar el evento de asistencia
    await processAttendanceEvent(event, io);

    res.status(200).send('OK');
  } catch (error) {
    console.error('❌ Error en webhook:', error);
    res.status(500).send('Error');
  }
});

// Obtener registros de asistencia
app.get('/api/attendance/records', async (req, res) => {
  try {
    const filters = {
      cedula: req.query.cedula,
      collection: req.query.collection,
      startDate: req.query.startDate,
      endDate: req.query.endDate,
      limit: req.query.limit,
    };

    const result = await getAttendanceRecords(filters);
    res.json(result);
  } catch (error) {
    res.status(500).json({
      success: false,
      error: error.message,
    });
  }
});

// Obtener registros por usuario específico
app.get('/api/attendance/user/:cedula', async (req, res) => {
  try {
    const { cedula } = req.params;
    const limit = req.query.limit || 50;

    const result = await getAttendanceRecords({
      cedula,
      limit: parseInt(limit),
    });

    res.json(result);
  } catch (error) {
    res.status(500).json({
      success: false,
      error: error.message,
    });
  }
});

// Registrar un usuario en el dispositivo
app.post('/api/hikvision/register-user', async (req, res) => {
  try {
    const { cedula, fullName } = req.body;

    if (!cedula || !fullName) {
      return res.status(400).json({
        success: false,
        error: 'Cédula y nombre completo son requeridos',
      });
    }

    const result = await registerUserInDevice(cedula, fullName);
    res.json(result);
  } catch (error) {
    res.status(500).json({
      success: false,
      error: error.message,
    });
  }
});

// Sincronizar todos los usuarios al dispositivo
app.post('/api/hikvision/sync-users', async (req, res) => {
  try {
    const results = await syncUsersToDevice();
    res.json({
      success: true,
      message: 'Sincronización completada',
      results,
    });
  } catch (error) {
    res.status(500).json({
      success: false,
      error: error.message,
    });
  }
});

// ============================================
// SOCKET.IO - EVENTOS DE ASISTENCIA
// ============================================

io.on('connection', (socket) => {
  console.log('Cliente conectado');

  // Autenticación de usuario
  socket.on('authenticate', async (userId, userType) => {
    console.log(`Autenticado: ${userId}, Tipo: ${userType}`);
    
    // Unir al usuario a su sala personalizada
    socket.join(userId);

    try {
      if (userType === 'admin') {
        await sendBirthdayListToAdmin(io);
        
        // Enviar estado del dispositivo Hikvision a admins
        const deviceStatus = await checkDeviceStatus();
        socket.emit('hikvision:status', deviceStatus);
      } else if (userType === 'client') {
        await sendBirthdayAlerts(userId, userType, socket, io);
      }
    } catch (error) {
      console.log('Error en autenticación:', error);
    }
  });

  // Evento para solicitar registros de asistencia en tiempo real
  socket.on('attendance:subscribe', async (userId) => {
    console.log(`Usuario ${userId} suscrito a actualizaciones de asistencia`);
    socket.join(`attendance:${userId}`);
  });

  socket.on('disconnect', () => {
    console.log('Cliente desconectado');
  });
});

// ============================================
// LISTENERS DE FIRESTORE (TU CÓDIGO ORIGINAL)
// ============================================

// Escuchar cambios en la colección 'alerts'
db.collection('alerts').onSnapshot((snapshot) => {
  snapshot.docChanges().forEach(async (change) => {
    if (change.type === 'added' || change.type === 'modified') {
      const alertData = change.doc.data();
      console.log(`Alerta recibida: ${alertData.message}`);

      const clientClassifications = alertData.clientClassifications;
      if (!clientClassifications || clientClassifications.length === 0) {
        console.error('No se ha proporcionado ningún grupo de clientes');
        return;
      }

      try {
        for (const groupId of clientClassifications) {
          const groupRef = db.collection('clientClassifications').doc(groupId);
          const groupSnapshot = await groupRef.get();

          if (groupSnapshot.exists) {
            const group = groupSnapshot.data();
            const clientIds = group.users;

            if (!clientIds || clientIds.length === 0) {
              console.error(`El grupo ${groupId} no tiene clientes asignados`);
              continue;
            }

            const usersRef = db.collection(group.userType === 'Clientes' ? 'users' : 'workers');
            const clients = await usersRef
              .where(admin.firestore.FieldPath.documentId(), 'in', clientIds)
              .get();

            clients.forEach((clientDoc) => {
              const clientData = clientDoc.data();
              const clientId = clientDoc.id;

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

              sendAlertToClientGroup(io, clientId, alertMessage);
            });
          }
        }
      } catch (error) {
        console.error('Error al obtener los grupos:', error);
      }
    }
  });
});

// Escuchar cambios en la colección 'discounts'
db.collection('discounts').onSnapshot((snapshot) => {
  snapshot.docChanges().forEach(async (change) => {
    if (change.type === 'added' || change.type === 'modified') {
      const alertData = change.doc.data();
      console.log(`Alerta de descuento recibida: ${alertData.description}`);

      const clientClassifications = alertData.clientClassifications;
      if (!clientClassifications || clientClassifications.length === 0) {
        console.error('No se ha proporcionado ningún grupo de clientes');
        return;
      }

      try {
        for (const groupId of clientClassifications) {
          const groupRef = db.collection('clientClassifications').doc(groupId);
          const groupSnapshot = await groupRef.get();

          if (groupSnapshot.exists) {
            const group = groupSnapshot.data();
            const clientIds = group.users;

            if (!clientIds || clientIds.length === 0) {
              console.error(`El grupo ${groupId} no tiene clientes asignados`);
              continue;
            }

            const usersRef = db.collection(group.userType === 'Clientes' ? 'users' : 'workers');
            const clients = await usersRef
              .where(admin.firestore.FieldPath.documentId(), 'in', clientIds)
              .get();

            clients.forEach((clientDoc) => {
              const clientData = clientDoc.data();
              const clientId = clientDoc.id;

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

              sendAlertToClientGroup(io, clientId, alertMessage);
            });
          }
        }
      } catch (error) {
        console.error('Error al obtener los grupos:', error);
      }
    }
  });
});

// Escuchar cambios en la colección 'birthdayAlerts'
db.collection('birthdayAlerts').onSnapshot((snapshot) => {
  snapshot.docChanges().forEach(async (change) => {
    if (change.type === 'added' || change.type === 'modified') {
      const alertData = change.doc.data();
      console.log(`Alerta de cumpleaños recibida: ${alertData.message}`);

      const clientClassifications = alertData.customerClassifications;
      if (!clientClassifications || clientClassifications.length === 0) {
        console.error('No se ha proporcionado ningún grupo de clientes');
        return;
      }

      const today = new Date();
      const startDate = alertData.startDate.toDate();
      const endDate = alertData.endDate.toDate();

      if (today < startDate || today > endDate) {
        console.log('La fecha de hoy no está dentro del rango de la alerta');
        return;
      }

      try {
        for (const groupId of clientClassifications) {
          const groupRef = db.collection('clientClassifications').doc(groupId);
          const groupSnapshot = await groupRef.get();

          if (groupSnapshot.exists) {
            const group = groupSnapshot.data();
            const clientIds = group.users;

            if (!clientIds || clientIds.length === 0) {
              console.error(`El grupo ${groupId} no tiene clientes asignados`);
              continue;
            }

            const usersRef = db.collection(group.userType === 'Clientes' ? 'users' : 'workers');
            const clients = await usersRef
              .where(admin.firestore.FieldPath.documentId(), 'in', clientIds)
              .get();

            clients.forEach((clientDoc) => {
              const clientData = clientDoc.data();
              const clientId = clientDoc.id;

              const birthdateStr = clientData.birthdate;
              const birthdate = new Date(birthdateStr);

              if (
                birthdate.getDate() === today.getDate() &&
                birthdate.getMonth() === today.getMonth()
              ) {
                console.log(`Enviando alerta de cumpleaños a ${clientData.fullName}`);

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

                sendAlertToClientGroup(io, clientId, alertMessage);
              }
            });
          }
        }
      } catch (error) {
        console.error('Error al obtener los grupos:', error);
      }
    }
  });
});

// ============================================
// INICIAR SERVIDOR
// ============================================
const PORT = process.env.PORT || 5000;
const { startPolling } = require('./polling-service');

server.listen(PORT, async () => {
  console.log('='.repeat(50));
  console.log(`🚀 Servidor corriendo en puerto ${PORT}`);
  console.log('='.repeat(50));

  // Verificar conexión con Hikvision al iniciar
  const status = await checkDeviceStatus();
  if (status.connected) {
       // ⭐ NUEVO: Conectar al stream de eventos en tiempo real
    // connectToAlertStream(io);
    // const stopPolling = startAcsPolling(io);
  } else {
    console.log('❌ Dispositivo Hikvision NO conectado');
    console.log(`   Error: ${status.error}`);
  }

  console.log('='.repeat(50));
});