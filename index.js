// index.js
const express = require('express');
const http = require('http');
const socketIo = require('socket.io');
const cors = require('cors');
const admin = require('firebase-admin');
const xml2js = require('xml2js');
require('dotenv').config();

// ⭐ IMPORTAR SERVICIO HIKVISION
const {
  checkDeviceStatus,
  registerUserInDevice,
  syncUsersToDevice,
  getAttendanceRecords,
  processAttendanceEvent,
  getTodayAttendanceForUser, // ✅ antes no lo estabas importando
  setStreamWarmup, // ✅ evita isStreamWarmedUp undefined
} = require('./hikvision-k1t321-service');

const app = express();
const server = http.createServer(app);

// Socket.io
const io = socketIo(server, {
  cors: { origin: true, credentials: true },
  transports: ['websocket'],
});

app.use(cors());

// ✅ Firebase Admin (ENV primero, fallback local opcional)
if (!admin.apps.length) {
  if (process.env.FIREBASE_SERVICE_ACCOUNT_JSON) {
    const serviceAccount = JSON.parse(process.env.FIREBASE_SERVICE_ACCOUNT_JSON);
    admin.initializeApp({ credential: admin.credential.cert(serviceAccount) });
    console.log('✅ Firebase Admin inicializado desde ENV');
  } else {
    // Solo local
    const serviceAccount = require('./firebase-config.json');
    admin.initializeApp({ credential: admin.credential.cert(serviceAccount) });
    console.log('✅ Firebase Admin inicializado desde firebase-config.json (LOCAL)');
  }
}

const db = admin.firestore();
app.locals.db = db;

// ✅ Body parsers globales (para tu app normal)
// (OJO: NO pongas express.text({type:'*/*'}) global, eso fue lo que te causó 413)
app.use(express.json({ limit: '2mb' })); // para APIs normales

// Timestamp inicio servidor
const SERVER_START_TIME = new Date();

// ============================================
// HIKVISION ENDPOINTS
// ============================================

// Healthcheck simple
app.get('/health', (req, res) => res.status(200).send('OK'));

// Verificar estado del dispositivo (si usas ISAPI hacia adentro)
app.get('/api/hikvision/status', async (req, res) => {
  try {
    const status = await checkDeviceStatus();
    res.json(status);
  } catch (error) {
    res.status(500).json({ success: false, error: error.message });
  }
});

// Sincronizar todos los usuarios al dispositivo (si lo usas)
app.post('/api/hikvision/sync-users', express.json({ limit: '2mb' }), async (req, res) => {
  try {
    console.log('🔄 Endpoint sync-users llamado');
    const results = await syncUsersToDevice();
    res.json({ success: true, message: 'Sincronización completada', results });
  } catch (error) {
    console.error('❌ Error en endpoint sync-users:', error);
    res.status(500).json({ success: false, error: error.message, stack: error.stack });
  }
});

// Registrar un usuario en el dispositivo (si lo usas)
app.post('/api/hikvision/register-user', express.json({ limit: '2mb' }), async (req, res) => {
  try {
    const { cedula, fullName } = req.body;
    if (!cedula || !fullName) {
      return res.status(400).json({ success: false, error: 'Cédula y nombre completo son requeridos' });
    }
    const result = await registerUserInDevice(cedula, fullName);
    res.json(result);
  } catch (error) {
    res.status(500).json({ success: false, error: error.message });
  }
});

// GET para probar desde navegador
app.get('/api/hikvision/webhook', (req, res) => res.status(200).send('OK'));

// ✅ WEBHOOK (RAW) — aquí subimos límite y aceptamos CUALQUIER Content-Type
app.post(
  '/api/hikvision/webhook',
  express.raw({ type: () => true, limit: '25mb' }), // ✅ evita 413 por fotos/adjuntos
  async (req, res) => {
    // Responde rápido para evitar retries del dispositivo
    res.status(200).send('OK');

    try {
      const webhookReceivedTime = new Date();
      console.log('\n' + '█'.repeat(60));
      console.log(`📩 WEBHOOK RECIBIDO: ${webhookReceivedTime.toLocaleString('es-CO', { timeZone: 'America/Bogota' })}`);
      console.log('█'.repeat(60));

      // Convertir body RAW a string
      const bodyBuf = Buffer.isBuffer(req.body) ? req.body : Buffer.from(req.body || '');
      const bodyStr = bodyBuf.toString('utf8');

      // =========
      // Detectores
      // =========
      const looksMultipartJson =
        bodyStr.includes('--MIME_boundary') ||
        bodyStr.includes('Content-Type: application/json') ||
        bodyStr.includes('"AccessControllerEvent"');

      const looksXml = bodyStr.includes('<?xml') || bodyStr.includes('<EventNotificationAlert');

      // =========================
      // 1) multipart/JSON (Hikvision)
      // =========================
      if (looksMultipartJson) {
        console.log('📦 Formato multipart/JSON detectado');

        // Extraer JSON dentro del body
        const jsonMatch = bodyStr.match(/\{[\s\S]*\}/);
        if (!jsonMatch) {
          console.log('⚠️ No se encontró JSON dentro del multipart');
          return;
        }

        let eventData;
        try {
          eventData = JSON.parse(jsonMatch[0]);
        } catch (e) {
          console.log('❌ JSON inválido dentro del multipart:', e.message);
          return;
        }

        const accessEvent = eventData.AccessControllerEvent || {};
        const eventTime = parseHikvisionDate(eventData.dateTime);
        const eventTimeColombia = eventTime.toLocaleString('es-CO', { timeZone: 'America/Bogota' });

        const diffSec = (eventTime.getTime() - SERVER_START_TIME.getTime()) / 1000;

        console.log('⏰ ANÁLISIS DE TIEMPO DEL EVENTO');
        console.log(`   Servidor inició:  ${SERVER_START_TIME.toLocaleString('es-CO', { timeZone: 'America/Bogota' })}`);
        console.log(`   Evento ocurrió:   ${eventTimeColombia}`);
        console.log(`   Diferencia:       ${(diffSec / 60).toFixed(1)} min`);

        // FILTRO históricos (margen -60s)
        if (diffSec < -60) {
          console.log('🗂️ HISTÓRICO - Ignorando (ocurrió antes de iniciar)');
          return;
        }

        // Identificador (cedula)
        const employeeId =
          accessEvent.employeeNoString ||
          accessEvent.cardNo ||
          (accessEvent.serialNo ? String(accessEvent.serialNo) : null) ||
          (eventData.serialNo ? String(eventData.serialNo) : null);

        const normalizedEvent = {
          cedula: employeeId,
          method: accessEvent.currentVerifyMode || accessEvent.attendanceStatus || 'fingerPrint',
          timestamp: eventData.dateTime,
          dateTime: eventData.dateTime,
          inAndOutType: accessEvent.inAndOutType,
          eventDescription: eventData.eventDescription,
          name: accessEvent.name,
          cardNo: accessEvent.cardNo,
          rawJSON: eventData,
        };

        if (!employeeId) {
          console.log('⚠️ Evento sin identificador (cedula/cardNo) - ignorado');
          return;
        }

        await processAttendanceEvent(normalizedEvent, io);
        console.log('✅ Evento JSON procesado\n');
        return;
      }

      // ==========
      // 2) XML (Hikvision)
      // ==========
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

        // Normalizar para el mismo procesador
        const normalizedEvent = {
          cedula: event.employeeNoString || event.employeeNo || event.cardNo,
          method: event.attendanceStatus || event.currentVerifyMode || 'fingerPrint',
          timestamp: event.dateTime,
          dateTime: event.dateTime,
          inAndOutType: event.inAndOutType,
          eventDescription: event.eventDescription || event.name,
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

      // Si no matchea nada
      console.log('⚠️ Formato desconocido - ignorado');
    } catch (err) {
      console.error('❌ ERROR EN WEBHOOK:', err);
    }
  }
);

// Helper: Hikvision a veces manda dateTime sin timezone.
// Si no trae Z o +/-, asumimos Colombia (-05:00)
function parseHikvisionDate(dateStr) {
  if (!dateStr) return new Date();
  const s = String(dateStr).trim();
  const hasTZ = /([zZ]|[+-]\d\d:\d\d)$/.test(s);
  return new Date(hasTZ ? s : `${s}-05:00`);
}

// ============================================
// ATTENDANCE ENDPOINTS
// ============================================

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
    res.status(500).json({ success: false, error: error.message });
  }
});

// Resumen de asistencia del día
app.get('/api/attendance/summary/today', async (req, res) => {
  try {
    const now = new Date();
    const startOfDay = new Date(now); startOfDay.setHours(0, 0, 0, 0);
    const endOfDay = new Date(now); endOfDay.setHours(23, 59, 59, 999);

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

// Obtener registros de asistencia (con filtros)
app.get('/api/attendance/records', async (req, res) => {
  try {
    const filters = {
      cedula: req.query.cedula,
      collection: req.query.collection,
      eventType: req.query.eventType,
      brandId: req.query.brandId,
      location: req.query.location,
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

// ============================================
// SOCKET.IO
// ============================================
io.on('connection', (socket) => {
  console.log('Cliente conectado');

  socket.on('authenticate', async (userId, userType) => {
    console.log(`Autenticado: ${userId}, Tipo: ${userType}`);
    socket.join(userId);

    if (userType === 'admin') {
      const deviceStatus = await checkDeviceStatus();
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
  console.log('='.repeat(50));
  console.log(`🚀 Servidor corriendo en puerto ${PORT}`);
  console.log('='.repeat(50));
  console.log('✅ Listo para recibir eventos Hikvision en: /api/hikvision/webhook');
  console.log('✅ Healthcheck: /health');
  console.log('='.repeat(50));

  // ✅ Si algún día vuelves a usar stream, define warmup desde aquí:
  setStreamWarmup(true);
});
