const express = require('express');
const http = require('http');
const socketIo = require('socket.io');
const cors = require('cors');
const admin = require('firebase-admin');
const xml2js = require('xml2js');
require('dotenv').config();

// const { sendBirthdayAlerts, sendBirthdayListToAdmin } = require('./birthday-alerts');
// const { sendDiscountAlert, sendBirthdayAlert, sendBarberAlert, sendAlertToClientGroup } = require('./socket-io');

// ⭐ IMPORTAR SERVICIO HIKVISION
const {
  checkDeviceStatus,
  connectToAlertStream,
  registerUserInDevice,
  syncUsersToDevice,
  getAttendanceRecords,
  processAttendanceEvent, // ⬅️ AGREGAR ESTA LÍNEA
} = require('./hikvision-k1t321-service');

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

app.use(cors());

let isStreamWarmedUp = true; 

//⭐ ENDPOINTS SIN BODY (ANTES de body-parser)
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

// Sincronizar todos los usuarios al dispositivo
app.post('/api/hikvision/sync-users', express.raw({ type: () => true }), async (req, res) => {
  try {
    console.log('🔄 Endpoint sync-users llamado');
    
    const results = await syncUsersToDevice();
    
    res.json({
      success: true,
      message: 'Sincronización completada',
      results,
    });
  } catch (error) {
    console.error('❌ Error en endpoint sync-users:', error);
    res.status(500).json({
      success: false,
      error: error.message,
      stack: error.stack,
    });
  }
});

// Registrar un usuario en el dispositivo
app.post('/api/hikvision/register-user', express.json(), async (req, res) => {
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

app.use(express.json());
app.use(express.text({ type: '*/*' })); // ⭐ Cambiado para aceptar cualquier tipo
app.use(express.raw({ type: 'application/xml' })); // ⭐ Agregar esta línea


// Conexión a Firebase (solo si no está inicializado)
// let db;
// try {
//   // Intentar obtener la app por defecto
//   db = admin.firestore();
// } catch (error) {
//   // Si no existe, inicializarla
//   const serviceAccount = require('./firebase-config.json');
//   admin.initializeApp({
//     credential: admin.credential.cert(serviceAccount),
//   });
//   db = admin.firestore();
// }

// app.locals.db = db;


// ✅ Conexión a Firebase (ENV primero, fallback local opcional)
let db;

if (!admin.apps.length) {
  if (process.env.FIREBASE_SERVICE_ACCOUNT_JSON) {
    const serviceAccount = JSON.parse(process.env.FIREBASE_SERVICE_ACCOUNT_JSON);
    admin.initializeApp({
      credential: admin.credential.cert(serviceAccount),
    });
    console.log("✅ Firebase Admin inicializado desde ENV");
  } else {
    // ✅ SOLO para desarrollo local (no lo subas a GitHub)
    const serviceAccount = require('./firebase-config.json');
    admin.initializeApp({
      credential: admin.credential.cert(serviceAccount),
    });
    console.log("✅ Firebase Admin inicializado desde firebase-config.json (LOCAL)");
  }
}

db = admin.firestore();
app.locals.db = db;



// Timestamp de inicio del servidor en UTC
const SERVER_START_TIME = new Date();
const SERVER_START_UTC = SERVER_START_TIME.toISOString();


// ============================================
// ENDPOINTS HIKVISION
// ============================================

app.get('/api/hikvision/webhook', (req, res) => {
  res.status(200).send('OK');
});


// Webhook para recibir eventos del dispositivo en tiempo real
app.post('/api/hikvision/webhook', async (req, res) => {
  try {
    const webhookReceivedTime = new Date();
    
    console.log('\n' + '█'.repeat(60));
    console.log(`📩 WEBHOOK RECIBIDO: ${webhookReceivedTime.toLocaleString('es-CO', { timeZone: 'America/Bogota' })}`);
    console.log('█'.repeat(60));
    
    let xmlString = '';
    
    if (Buffer.isBuffer(req.body)) {
      xmlString = req.body.toString('utf8');
    } else if (typeof req.body === 'string') {
      xmlString = req.body;
    }
    
    if (xmlString.includes('--MIME_boundary') || xmlString.includes('Content-Type: application/json')) {
      console.log('📦 Formato multipart/JSON detectado');
      
      const jsonMatch = xmlString.match(/\{[\s\S]*\}/);
      if (jsonMatch) {
        const jsonStr = jsonMatch[0];
        
        try {
          const eventData = JSON.parse(jsonStr);
          const accessEvent = eventData.AccessControllerEvent || {};
          
          // ⭐ CONVERTIR TIMESTAMP DEL EVENTO A UTC
          const eventTime = new Date(eventData.dateTime);
          const eventTimeUTC = eventTime.toISOString();
          const eventTimeColombia = eventTime.toLocaleString('es-CO', { timeZone: 'America/Bogota' });
          
          // ⭐ CALCULAR DIFERENCIA EN SEGUNDOS (usando UTC)
          const timeDifferenceMs = eventTime.getTime() - SERVER_START_TIME.getTime();
          const timeDifferenceSeconds = timeDifferenceMs / 1000;
          const timeDifferenceMinutes = timeDifferenceSeconds / 60;
          const timeDifferenceHours = timeDifferenceMinutes / 60;
          
          console.log('\n' + '═'.repeat(60));
          console.log('⏰ ANÁLISIS DE TIEMPO DEL EVENTO');
          console.log('═'.repeat(60));
          console.log('🇨🇴 Tiempos en hora de Colombia:');
          console.log(`   Servidor inició:  ${SERVER_START_TIME.toLocaleString('es-CO', { timeZone: 'America/Bogota' })}`);
          console.log(`   Evento ocurrió:   ${eventTimeColombia}`);
          
          // Mostrar diferencia de forma legible
          if (Math.abs(timeDifferenceHours) >= 1) {
            console.log(`   Diferencia:       ${timeDifferenceHours.toFixed(1)} horas`);
          } else if (Math.abs(timeDifferenceMinutes) >= 1) {
            console.log(`   Diferencia:       ${timeDifferenceMinutes.toFixed(1)} minutos`);
          } else {
            console.log(`   Diferencia:       ${timeDifferenceSeconds.toFixed(0)} segundos`);
          }
          
          console.log('\n📊 Clasificación:');
          
          let eventClassification = '';
          let shouldProcess = false;
          
          // ⭐ FILTRO 1: WARMUP (primeros 15 segundos después de conectar el stream)
          if (!isStreamWarmedUp) {
            eventClassification = '⏳ WARMUP - Ignorando';
            shouldProcess = false;
            console.log(`   ${eventClassification}`);
            console.log('   (El dispositivo está enviando eventos buffereados del día anterior)');
          }
          // ⭐ FILTRO 2: HISTÓRICO (ocurrió ANTES de iniciar el servidor)
          // Margen de -60 segundos por diferencias de sincronización de reloj
          else if (timeDifferenceSeconds < -60) {
            eventClassification = '🗂️  HISTÓRICO - Ignorando';
            shouldProcess = false;
            console.log(`   ${eventClassification}`);
            
            if (Math.abs(timeDifferenceHours) >= 1) {
              console.log(`   (Ocurrió ${Math.abs(timeDifferenceHours).toFixed(1)} horas ANTES de iniciar)`);
            } else {
              console.log(`   (Ocurrió ${Math.abs(timeDifferenceMinutes).toFixed(1)} minutos ANTES de iniciar)`);
            }
            console.log('   Este evento ya pasó cuando el servidor estaba apagado');
          }
          // ✅ EVENTO VÁLIDO - Procesar SIEMPRE (sin límite superior)
          else {
            eventClassification = '✅ TIEMPO REAL - Procesando';
            shouldProcess = true;
            
            if (timeDifferenceSeconds < 0) {
              // Evento ocurrió justo antes de iniciar (dentro del margen de 60s)
              console.log(`   ${eventClassification}`);
              console.log(`   (Ocurrió ${Math.abs(timeDifferenceSeconds).toFixed(0)} segundos ANTES de iniciar - dentro del margen)`);
            } else if (timeDifferenceSeconds < 60) {
              // Evento muy reciente
              console.log(`   ${eventClassification}`);
              console.log(`   (Ocurrió ${timeDifferenceSeconds.toFixed(0)} segundos después de iniciar)`);
            } else if (timeDifferenceMinutes < 60) {
              // Evento en la última hora
              console.log(`   ${eventClassification}`);
              console.log(`   (Ocurrió ${timeDifferenceMinutes.toFixed(1)} minutos después de iniciar)`);
            } else {
              // Evento hace varias horas
              console.log(`   ${eventClassification}`);
              console.log(`   (Ocurrió ${timeDifferenceHours.toFixed(1)} horas después de iniciar)`);
            }
          }
          
          console.log('═'.repeat(60) + '\n');
          
          // Si no debe procesarse, retornar
          if (!shouldProcess) {
            return res.status(200).send('OK');
          }
          
          // ⭐ EXTRAER IDENTIFICADOR CON MÚLTIPLES FALLBACKS
          const employeeId = accessEvent.employeeNoString || 
                             accessEvent.cardNo || 
                             accessEvent.serialNo?.toString() || 
                             eventData.serialNo?.toString();
          
          console.log('🔍 DATOS DEL EVENTO:');
          console.log(`   Identificador:    ${employeeId || '❌ NO DETECTADO'}`);
          console.log(`   Método:           ${accessEvent.currentVerifyMode || 'unknown'}`);
          console.log(`   Major Event:      ${accessEvent.majorEventType}`);
          console.log(`   Sub Event:        ${accessEvent.subEventType}`);
          
          // ⭐ CREAR EVENTO NORMALIZADO
          const event = {
            eventType: 'AccessControllerEvent',
            employeeNoString: employeeId,
            employeeNo: employeeId,
            cedula: employeeId,
            dateTime: eventData.dateTime,
            timestamp: eventData.dateTime,
            attendanceStatus: accessEvent.currentVerifyMode || accessEvent.attendanceStatus || 'fingerPrint',
            currentVerifyMode: accessEvent.currentVerifyMode || 'unknown',
            eventDescription: eventData.eventDescription,
            name: accessEvent.name,
            cardNo: accessEvent.cardNo,
            inAndOutType: accessEvent.inAndOutType,
            method: accessEvent.currentVerifyMode || 'fingerprint',
            rawJSON: eventData,
          };
          
          console.log('\n🔄 EVENTO CONVERTIDO:');
          console.log(JSON.stringify({
            cedula: event.cedula,
            method: event.method,
            timestamp: event.timestamp,
            currentVerifyMode: event.currentVerifyMode
          }, null, 2));
          
          // ⭐ VALIDAR Y PROCESAR
          if (employeeId) {
            console.log('\n🚀 Procesando evento...');
            await processAttendanceEvent(event, io);
            console.log('✅ Evento procesado correctamente\n');
          } else {
            console.log('\n⚠️  ADVERTENCIA: Evento sin identificador válido');
            console.log('   Posibles causas:');
            console.log('   - Usuario no registrado en el dispositivo');
            console.log('   - Huella no registrada o no reconocida');
            console.log('   - Tarjeta RFID no configurada\n');
          }
          
          return res.status(200).send('OK');
          
        } catch (parseError) {
          console.error('❌ Error parseando JSON:', parseError.message);
          return res.status(200).send('OK');
        }
      }
    }
    
    // Intentar como XML si no es multipart
    if (xmlString.includes('<?xml')) {
      const parser = new xml2js.Parser({ explicitArray: false });
      const result = await parser.parseStringPromise(xmlString);
      const event = result.EventNotificationAlert;
      
      if (event && (event.eventType === 'AccessControllerEvent' || event.eventType?.includes('Access'))) {
        const eventTime = new Date(event.dateTime);
        const timeDifferenceSeconds = (eventTime.getTime() - SERVER_START_TIME.getTime()) / 1000;
        
        // Solo filtrar warmup e históricos
        if (!isStreamWarmedUp || timeDifferenceSeconds < -60) {
          console.log('⏭️ XML: Evento filtrado');
          return res.status(200).send('OK');
        }
        
        await processAttendanceEvent(event, io);
      }
    }

    res.status(200).send('OK');
    
  } catch (error) {
    console.error('❌ ERROR EN WEBHOOK:', error.message);
    res.status(200).send('OK');
  }
});

// Ver registros del día de un usuario
app.get('/api/attendance/today/:userId', async (req, res) => {
  try {
    const { userId } = req.params;
    const records = await getTodayAttendanceForUser(userId);

    res.json({
      success: true,
      userId,
      date: new Date().toLocaleDateString('es-CO'),
      count: records.length,
      records,
    });
  } catch (error) {
    res.status(500).json({
      success: false,
      error: error.message,
    });
  }
});

// Resumen de asistencia del día
app.get('/api/attendance/summary/today', async (req, res) => {
  try {
    const db = getDb();
    
    const now = new Date();
    const startOfDay = new Date(now);
    startOfDay.setHours(0, 0, 0, 0);
    
    const endOfDay = new Date(now);
    endOfDay.setHours(23, 59, 59, 999);

    const snapshot = await db
      .collection('attendance')
      .where('timestamp', '>=', admin.firestore.Timestamp.fromDate(startOfDay))
      .where('timestamp', '<=', admin.firestore.Timestamp.fromDate(endOfDay))
      .orderBy('timestamp', 'desc')
      .get();

    const records = [];
    const usersPresent = new Set();
    const checkIns = [];
    const checkOuts = [];

    snapshot.forEach(doc => {
      const data = doc.data();
      records.push({
        id: doc.id,
        ...data,
        timestamp: data.timestamp.toDate(),
      });

      if (data.eventType === 'check_in') {
        checkIns.push(data);
        usersPresent.add(data.userId);
      } else if (data.eventType === 'check_out') {
        checkOuts.push(data);
        usersPresent.delete(data.userId);
      }
    });

    res.json({
      success: true,
      date: now.toLocaleDateString('es-CO'),
      summary: {
        totalRecords: records.length,
        totalCheckIns: checkIns.length,
        totalCheckOuts: checkOuts.length,
        currentlyPresent: usersPresent.size,
      },
      records,
    });
  } catch (error) {
    res.status(500).json({
      success: false,
      error: error.message,
    });
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

// ============================================
// RUTAS DIAN - FACTURACIÓN ELECTRÓNICA
// ============================================
const dianRoutes = require('./dian/dian.routes');
app.use('/api/dian', dianRoutes);


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
        // await sendBirthdayListToAdmin(io);
        
        // Enviar estado del dispositivo Hikvision a admins
        const deviceStatus = await checkDeviceStatus();
        socket.emit('hikvision:status', deviceStatus);
      } else if (userType === 'client') {
        // await sendBirthdayAlerts(userId, userType, socket, io);
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
// INICIAR SERVIDOR
// ============================================
const PORT = process.env.PORT || 5000;
// const { startPolling } = require('./polling-service');

// server.listen(PORT, async () => {
//   console.log('='.repeat(50));
//   console.log(`🚀 Servidor corriendo en puerto ${PORT}`);
//   console.log('='.repeat(50));

//   const status = await checkDeviceStatus();
//   if (status.connected) {
//     console.log('✅ DS-K1T321MFWX-B conectado');
    
//     // ⭐ Iniciar stream de eventos
//     connectToAlertStream(io);
//   } else {
//     console.log('❌ Dispositivo NO conectado');
//     console.log(`   Error: ${status.error}`);
//   }

//   console.log('='.repeat(50));
// });

server.listen(PORT, async () => {
  console.log('='.repeat(50));
  console.log(`🚀 Servidor corriendo en puerto ${PORT}`);
  console.log('='.repeat(50));

  console.log('✅ Listo para recibir eventos Hikvision en: /api/hikvision/webhook');
  console.log('✅ Healthcheck: /health');
  console.log('='.repeat(50));
});
