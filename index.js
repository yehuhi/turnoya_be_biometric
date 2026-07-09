// index.js - VERSIÓN MULTI-DISPOSITIVO
const express = require('express');
const http = require('http');
const socketIo = require('socket.io');
const cors = require('cors');
const admin = require('firebase-admin');
const xml2js = require('xml2js');
require('dotenv').config();

// Importar servicio Hikvision
const {
  DEVICES,
  getDeviceConfig,
  checkDeviceStatus,
  checkAllDevicesStatus,
  registerUserInDevice,
  syncUsersToDevice,
  getAttendanceRecords,
  processAttendanceEvent,
  getTodayAttendanceForUser,
  setStreamWarmup,
  scheduleAutoConvert,
  autoConvertPendingCheckIns,
} = require('./hikvision-k1t321-service');

const app = express();
const server = http.createServer(app);

// Socket.io
const io = socketIo(server, {
  cors: { origin: true, credentials: true },
  transports: ['websocket'],
});

app.use(cors());

// Firebase Admin
if (!admin.apps.length) {
  if (process.env.FIREBASE_SERVICE_ACCOUNT_JSON) {
    const serviceAccount = JSON.parse(process.env.FIREBASE_SERVICE_ACCOUNT_JSON);
    admin.initializeApp({ credential: admin.credential.cert(serviceAccount) });
    console.log('✅ Firebase Admin inicializado desde ENV');
  } else {
    const serviceAccount = require('./firebase-config.json');
    admin.initializeApp({ credential: admin.credential.cert(serviceAccount) });
    console.log('✅ Firebase Admin inicializado desde firebase-config.json (LOCAL)');
  }
}

const db = admin.firestore();
app.locals.db = db;

app.use(express.json({ limit: '2mb' }));

const SERVER_START_TIME = new Date();

// ============================================
// HIKVISION ENDPOINTS
// ============================================

app.get('/health', (req, res) => res.status(200).send('OK'));

// Ver todos los dispositivos configurados
app.get('/api/hikvision/devices', (req, res) => {
  const deviceList = DEVICES.map(d => ({
    id: d.id,
    name: d.name,
    ip: d.ip,
    location: d.location,
    brandId: d.brandId,
  }));
  
  res.json({
    success: true,
    count: deviceList.length,
    devices: deviceList,
  });
});

// Status de un dispositivo específico (deviceId opcional)
async function handleDeviceStatus(req, res) {
  try {
    const { deviceId } = req.params;
    const status = await checkDeviceStatus(deviceId);
    res.json(status);
  } catch (error) {
    res.status(500).json({ success: false, error: error.message });
  }
}
app.get('/api/hikvision/status', handleDeviceStatus);
app.get('/api/hikvision/status/:deviceId', handleDeviceStatus);

// Status de todos los dispositivos
app.get('/api/hikvision/status-all', async (req, res) => {
  try {
    const status = await checkAllDevicesStatus();
    res.json(status);
  } catch (error) {
    res.status(500).json({ success: false, error: error.message });
  }
});

// Sincronizar usuarios a un dispositivo específico (deviceId opcional)
async function handleSyncUsers(req, res) {
  try {
    const { deviceId } = req.params;
    console.log(`🔄 Endpoint sync-users llamado para dispositivo: ${deviceId || 'device_1'}`);
    const results = await syncUsersToDevice(deviceId || 'device_1');
    res.json({ success: true, message: 'Sincronización completada', results });
  } catch (error) {
    console.error('❌ Error en endpoint sync-users:', error);
    res.status(500).json({ success: false, error: error.message, stack: error.stack });
  }
}
app.post('/api/hikvision/sync-users', express.json({ limit: '2mb' }), handleSyncUsers);
app.post('/api/hikvision/sync-users/:deviceId', express.json({ limit: '2mb' }), handleSyncUsers);

// Registrar un usuario en un dispositivo específico
app.post('/api/hikvision/register-user', express.json({ limit: '2mb' }), async (req, res) => {
  try {
    const { cedula, fullName, deviceId } = req.body;
    if (!cedula || !fullName) {
      return res.status(400).json({ success: false, error: 'Cédula y nombre completo son requeridos' });
    }
    
    const deviceConfig = deviceId 
      ? DEVICES.find(d => d.id === deviceId) || DEVICES[0]
      : DEVICES[0];
      
    const result = await registerUserInDevice(cedula, fullName, deviceConfig);
    res.json(result);
  } catch (error) {
    res.status(500).json({ success: false, error: error.message });
  }
});

// GET para probar
app.get('/api/hikvision/webhook', (req, res) => res.status(200).send('OK'));
app.get('/api/hikvision/webhook/:deviceId', (req, res) => res.status(200).send('OK'));

// WEBHOOK (RAW) - Identifica el dispositivo por :deviceId en la URL
// (confiable, independiente de NAT/IP pública) con fallback a detección
// por IP solo para el webhook legacy sin deviceId en la ruta.
async function handleHikvisionWebhook(req, res) {
    res.status(200).send('OK');

    try {
      const webhookReceivedTime = new Date();

      const routeDeviceId = req.params.deviceId || null;

      // Detectar IP del dispositivo (solo se usa como fallback legacy)
      const deviceIP = (req.headers['x-forwarded-for'] ||
                       req.connection.remoteAddress ||
                       req.socket.remoteAddress ||
                       req.ip || '').replace('::ffff:', '');

      console.log('\n' + '█'.repeat(60));
      console.log(`📩 WEBHOOK RECIBIDO: ${webhookReceivedTime.toLocaleString('es-CO', { timeZone: 'America/Bogota' })}`);
      console.log(`📍 IP Origen: ${deviceIP}${routeDeviceId ? ` | 🏷️ deviceId (ruta): ${routeDeviceId}` : ''}`);
      console.log('█'.repeat(60));

      const bodyBuf = Buffer.isBuffer(req.body) ? req.body : Buffer.from(req.body || '');
      const bodyStr = bodyBuf.toString('utf8');

      const looksMultipartJson =
        bodyStr.includes('--MIME_boundary') ||
        bodyStr.includes('Content-Type: application/json') ||
        bodyStr.includes('"AccessControllerEvent"');

      const looksXml = bodyStr.includes('<?xml') || bodyStr.includes('<EventNotificationAlert');

      // MULTIPART/JSON
      if (looksMultipartJson) {
        console.log('📦 Formato multipart/JSON detectado');

        let eventData;
        
        try {
          const startIdx = bodyStr.indexOf('{');
          if (startIdx === -1) {
            console.log('⚠️ No se encontró JSON');
            return;
          }
          
          let parsed = false;
          let endIdx = bodyStr.lastIndexOf('}');
          
          while (endIdx > startIdx && !parsed) {
            try {
              const jsonStr = bodyStr.substring(startIdx, endIdx + 1);
              eventData = JSON.parse(jsonStr);
              parsed = true;
            } catch {
              endIdx = bodyStr.lastIndexOf('}', endIdx - 1);
            }
          }
          
          if (!parsed) {
            console.log('❌ No se pudo parsear JSON');
            return;
          }
          
        } catch (e) {
          console.log('❌ Error:', e.message);
          return;
        }

        const accessEvent = eventData.AccessControllerEvent || {};
        const eventTime = parseHikvisionDate(eventData.dateTime);
        const diffSec = (eventTime.getTime() - SERVER_START_TIME.getTime()) / 1000;

        if (diffSec < -60) {
          console.log('🗂️ HISTÓRICO - Ignorando');
          return;
        }

        const employeeId =
          accessEvent.employeeNoString ||
          accessEvent.cardNo ||
          (accessEvent.serialNo ? String(accessEvent.serialNo) : null) ||
          (eventData.serialNo ? String(eventData.serialNo) : null);

        // Identificador confiable del dispositivo (viene de la ruta del webhook)
        const normalizedEvent = {
          cedula: employeeId,
          method: accessEvent.currentVerifyMode || accessEvent.attendanceStatus || 'fingerPrint',
          timestamp: eventData.dateTime,
          dateTime: eventData.dateTime,
          deviceId: routeDeviceId, // ⭐ id del dispositivo (confiable, desde la URL)
          deviceIP: deviceIP, // IP de origen (solo fallback legacy)
          rawJSON: eventData,
        };

        if (!employeeId) {
          console.log('⚠️ Sin identificador - ignorado');
          return;
        }

        await processAttendanceEvent(normalizedEvent, io);
        console.log('✅ Evento procesado\n');
        return;
      }

      // XML
      if (looksXml) {
        console.log('📦 Formato XML detectado');
        
        const parser = new xml2js.Parser({ explicitArray: false });
        const result = await parser.parseStringPromise(bodyStr);
        const event = result.EventNotificationAlert;

        if (!event) {
          console.log('⚠️ XML sin EventNotificationAlert');
          return;
        }

        const eventTime = parseHikvisionDate(event.dateTime);
        const diffSec = (eventTime.getTime() - SERVER_START_TIME.getTime()) / 1000;

        if (diffSec < -60) {
          console.log('🗂️ HISTÓRICO XML - Ignorando');
          return;
        }

        const normalizedEvent = {
          cedula: event.employeeNoString || event.employeeNo || event.cardNo,
          method: event.attendanceStatus || event.currentVerifyMode || 'fingerPrint',
          timestamp: event.dateTime,
          dateTime: event.dateTime,
          deviceId: routeDeviceId, // ⭐ id del dispositivo (confiable, desde la URL)
          deviceIP: deviceIP, // IP de origen (solo fallback legacy)
          rawEvent: event,
        };

        if (!normalizedEvent.cedula) {
          console.log('⚠️ XML sin cédula/cardNo - ignorado');
          return;
        }

        await processAttendanceEvent(normalizedEvent, io);
        console.log('✅ Evento XML procesado\n');
        return;
      }

      console.log('⚠️ Formato desconocido');
    } catch (err) {
      console.error('❌ ERROR:', err);
    }
}

app.post('/api/hikvision/webhook', express.raw({ type: () => true, limit: '25mb' }), handleHikvisionWebhook);
app.post('/api/hikvision/webhook/:deviceId', express.raw({ type: () => true, limit: '25mb' }), handleHikvisionWebhook);

function parseHikvisionDate(dateStr) {
  if (!dateStr) return new Date();
  const s = String(dateStr).trim();
  const hasTZ = /([zZ]|[+-]\d\d:\d\d)$/.test(s);
  return new Date(hasTZ ? s : `${s}-05:00`);
}

// ============================================
// ATTENDANCE ENDPOINTS
// ============================================

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
    res.status(500).json({ success: false, error: error.message });
  }
});

app.get('/api/attendance/summary/today', async (req, res) => {
  try {
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
      const ts = data.timestamp?.toDate ? data.timestamp.toDate() : null;

      records.push({ id: doc.id, ...data, timestamp: ts });

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
    res.status(500).json({ success: false, error: error.message });
  }
});

app.get('/api/attendance/records', async (req, res) => {
  try {
    const filters = {
      cedula: req.query.cedula,
      collection: req.query.collection,
      eventType: req.query.eventType,
      brandId: req.query.brandId,
      location: req.query.location,
      deviceId: req.query.deviceId,
      startDate: req.query.startDate,
      endDate: req.query.endDate,
      limit: req.query.limit,
    };
    const result = await getAttendanceRecords(filters);
    res.json(result);
  } catch (error) {
    res.status(500).json({ success: false, error: error.message });
  }
});

// Endpoint manual para auto-conversión
app.post('/api/attendance/convert-pending', async (req, res) => {
  try {
    console.log('🔄 Conversión manual solicitada');
    const result = await autoConvertPendingCheckIns();
    res.json(result);
  } catch (error) {
    res.status(500).json({ success: false, error: error.message });
  }
});

// ============================================
// SOCKET.IO
// ============================================
io.on('connection', (socket) => {
  console.log('Cliente conectado');

  socket.on('authenticate', async (userId, userType) => {
    console.log(`Autenticado: ${userId}, Tipo: ${userType}`);
    socket.join(userId);

    if (userType === 'admin') {
      const deviceStatus = await checkAllDevicesStatus();
      socket.emit('hikvision:status', deviceStatus);
    }
  });

  socket.on('attendance:subscribe', async (userId) => {
    console.log(`Usuario ${userId} suscrito a asistencia`);
    socket.join(`attendance:${userId}`);
  });

  socket.on('disconnect', () => console.log('Cliente desconectado'));
});

// ============================================
// START
// ============================================
const PORT = process.env.PORT || 5000;

server.listen(PORT, async () => {
  console.log('='.repeat(60));
  console.log(`🚀 Servidor corriendo en puerto ${PORT}`);
  console.log('='.repeat(60));
  console.log('✅ Listo para recibir eventos Hikvision');
  console.log(`📍 Dispositivos configurados: ${DEVICES.length}`);
  DEVICES.forEach(d => {
    console.log(`   • ${d.name} (${d.ip}) - Location: ${d.location}`);
  });
  console.log('='.repeat(60));
  
  setStreamWarmup(true);
  
  // Iniciar auto-conversión inteligente
  scheduleAutoConvert();
  console.log('⏰ Auto-conversión inteligente activada (medianoche)');
  console.log('='.repeat(60));
});