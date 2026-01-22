// hikvision-k1t321-service.js
const axios = require('axios');
const crypto = require('crypto');
const Dicer = require('dicer');
const xml2js = require('xml2js');
const fs = require('fs');
const path = require('path');
const admin = require('firebase-admin');

// Carpeta evidencias
const EVIDENCE_DIR = path.join(__dirname, 'attendance-evidence');
if (!fs.existsSync(EVIDENCE_DIR)) fs.mkdirSync(EVIDENCE_DIR, { recursive: true });

const getDb = () => admin.firestore();

// ============================
// CONFIG
// ============================
const DEVICE_CONFIG = {
  ip: process.env.HIKVISION_IP || '192.168.1.13',
  port: parseInt(process.env.HIKVISION_PORT, 10) || 80,
  username: process.env.HIKVISION_USERNAME || 'admin',
  password: process.env.HIKVISION_PASSWORD || '12345',
  brandId: process.env.HIKVISION_BRAND_ID || 'brand',
  location: process.env.HIKVISION_LOCATION || 'location',
};

const baseURL = `http://${DEVICE_CONFIG.ip}:${DEVICE_CONFIG.port}/ISAPI`;

// Anti doble huella (30s por defecto)
const COOLDOWN_SECONDS = parseInt(process.env.ATTENDANCE_COOLDOWN_SECONDS || '30', 10);

// Warmup control (para stream; no rompe si no lo usas)
let isStreamWarmedUp = true;
function setStreamWarmup(value) {
  isStreamWarmedUp = !!value;
}

// ============================
// DIGEST AUTH SIMPLE
// ============================
async function digestRequest(method, url, options = {}) {
  const firstResponse = await axios({
    method,
    url,
    ...options,
    validateStatus: (status) => status === 401 || (status >= 200 && status < 300),
  });

  if (firstResponse.status !== 401) return firstResponse;

  const authHeader = firstResponse.headers['www-authenticate'];
  if (!authHeader || !authHeader.includes('Digest')) throw new Error('Digest auth no disponible');

  const realm = /realm="([^"]+)"/.exec(authHeader)?.[1] || '';
  const nonce = /nonce="([^"]+)"/.exec(authHeader)?.[1] || '';
  const qop = /qop="([^"]+)"/.exec(authHeader)?.[1] || 'auth';

  const ha1 = crypto.createHash('md5').update(`${DEVICE_CONFIG.username}:${realm}:${DEVICE_CONFIG.password}`).digest('hex');
  const ha2 = crypto.createHash('md5').update(`${method.toUpperCase()}:${new URL(url).pathname}`).digest('hex');
  const nc = '00000001';
  const cnonce = crypto.randomBytes(8).toString('hex');
  const response = crypto.createHash('md5').update(`${ha1}:${nonce}:${nc}:${cnonce}:${qop}:${ha2}`).digest('hex');

  return axios({
    method,
    url,
    ...options,
    headers: {
      ...options.headers,
      Authorization: `Digest username="${DEVICE_CONFIG.username}", realm="${realm}", nonce="${nonce}", uri="${new URL(url).pathname}", qop=${qop}, nc=${nc}, cnonce="${cnonce}", response="${response}"`,
    },
  });
}

// ============================
// FIND USER
// ============================
const findUserByCedula = async (cedula) => {
  const db = getDb();

  const barbersSnapshot = await db.collection('barbers').where('cedula', '==', cedula).limit(1).get();
  if (!barbersSnapshot.empty) {
    const doc = barbersSnapshot.docs[0];
    return { found: true, collection: 'barbers', id: doc.id, data: doc.data() };
  }

  const workersSnapshot = await db.collection('workers').where('cedula', '==', cedula).limit(1).get();
  if (!workersSnapshot.empty) {
    const doc = workersSnapshot.docs[0];
    return { found: true, collection: 'workers', id: doc.id, data: doc.data() };
  }

  return { found: false };
};

// ============================
// AUTH VALIDATION
// ============================
const validateUserAuthorization = (userData) => {
  const authorizedLocations = userData.authorizedLocations || [];
  const brandIds = userData.brandIds || [];

  const hasLocationAccess = authorizedLocations.includes(DEVICE_CONFIG.location);
  const hasBrandAccess = brandIds.includes(DEVICE_CONFIG.brandId);

  return {
    isAuthorized: hasLocationAccess && hasBrandAccess,
    hasLocationAccess,
    hasBrandAccess,
    authorizedLocations,
    brandIds,
  };
};

// ============================
// SAVE ATTENDANCE
// ============================
const saveAttendanceRecord = async (data) => {
  const db = getDb();
  const attendanceRef = db.collection('attendance');
  const docRef = await attendanceRef.add({
    ...data,
    createdAt: admin.firestore.FieldValue.serverTimestamp(),
  });
  console.log('✅ Registro guardado en Firestore:', docRef.id);
  return docRef.id;
};

// ============================
// COOLDOWN CHECK (ANTI DOBLE HUELLA)
// ============================
async function isWithinCooldown(userId, eventTimestamp) {
  const db = getDb();

  // Buscamos el último registro del usuario (sin necesidad del rango del día)
  const snap = await db
    .collection('attendance')
    .where('userId', '==', userId)
    .orderBy('timestamp', 'desc')
    .limit(1)
    .get();

  if (snap.empty) return { blocked: false };

  const last = snap.docs[0].data();
  const lastTs = last.timestamp?.toDate ? last.timestamp.toDate() : null;
  if (!lastTs) return { blocked: false };

  const diffSec = (eventTimestamp.getTime() - lastTs.getTime()) / 1000;
  if (diffSec >= 0 && diffSec < COOLDOWN_SECONDS) {
    return {
      blocked: true,
      diffSec,
      lastEventType: last.eventType,
      lastTs,
    };
  }

  return { blocked: false, diffSec, lastTs };
}

// ============================
// EVENT TYPE DETERMINATION (CHECK_IN / CHECK_OUT)
// ============================
async function determineEventType(userId, eventTimestamp) {
  const db = getDb();

  const startOfDay = new Date(eventTimestamp);
  startOfDay.setHours(0, 0, 0, 0);

  const endOfDay = new Date(eventTimestamp);
  endOfDay.setHours(23, 59, 59, 999);

  const lastRecordSnapshot = await db
    .collection('attendance')
    .where('userId', '==', userId)
    .where('timestamp', '>=', admin.firestore.Timestamp.fromDate(startOfDay))
    .where('timestamp', '<=', admin.firestore.Timestamp.fromDate(endOfDay))
    .orderBy('timestamp', 'desc')
    .limit(1)
    .get();

  if (lastRecordSnapshot.empty) return 'check_in';

  const lastRecord = lastRecordSnapshot.docs[0].data();
  return lastRecord.eventType === 'check_in' ? 'check_out' : 'check_in';
}

// ============================
// PROCESS EVENT (WEBHOOK + STREAM)
// ============================
async function processAttendanceEvent(eventData, io) {
  try {
    // Normalización para que funcione con JSON y XML
    const cedula =
      eventData.cedula ||
      eventData.employeeNoString ||
      eventData.employeeNo ||
      eventData.cardNo;

    const method =
      eventData.method ||
      eventData.attendanceStatus ||
      eventData.currentVerifyMode ||
      'fingerPrint';

    const tsStr =
      eventData.timestamp ||
      eventData.dateTime ||
      new Date().toISOString();

    const eventTimestamp = parseHikvisionDate(tsStr);

    if (!cedula) {
      console.warn('⚠️ Evento sin cédula - IGNORADO');
      return;
    }

    // Validar cedula (evitar serialNo del dispositivo)
    const cedulaNumber = parseInt(cedula, 10);
    if (isNaN(cedulaNumber) || cedulaNumber < 1000) {
      console.warn(`⚠️ Identificador inválido (${cedula}) - probablemente serialNo - IGNORADO`);
      return;
    }

    if (method === 'invalid' || method === 'unknown') {
      console.warn(`⚠️ Método inválido (${method}) - IGNORADO`);
      return;
    }

    console.log(`\n🔍 Buscando usuario con cédula: ${cedula}`);
    const user = await findUserByCedula(String(cedula));

    if (!user.found) {
      console.warn(`⚠️ Usuario con cédula ${cedula} NO ENCONTRADO`);
      if (io) {
        io.emit('attendance:unknown_user', {
          cedula,
          timestamp: eventTimestamp,
          method,
          message: `Usuario con cédula ${cedula} intentó marcar pero no está en el sistema`,
        });
      }
      return;
    }

    // Validar autorización
    const authorization = validateUserAuthorization(user.data);
    if (!authorization.isAuthorized) {
      console.warn(`❌ ACCESO NO AUTORIZADO: ${user.data.fullName} (${cedula})`);
      if (io) {
        io.emit('attendance:unauthorized_access', {
          cedula,
          fullName: user.data.fullName,
          timestamp: eventTimestamp,
          location: DEVICE_CONFIG.location,
          brandId: DEVICE_CONFIG.brandId,
          reason: !authorization.hasLocationAccess ? 'location_not_authorized' : 'brand_not_authorized',
        });
      }
      return;
    }

    // ✅ Anti doble huella (30s)
    const cooldown = await isWithinCooldown(user.id, eventTimestamp);
    if (cooldown.blocked) {
      console.warn(
        `⏱️ COOLDOWN (${COOLDOWN_SECONDS}s): Ignorando marca duplicada. ` +
        `Última hace ${cooldown.diffSec.toFixed(1)}s (last=${cooldown.lastEventType})`
      );
      return;
    }

    const determinedEventType = await determineEventType(user.id, eventTimestamp);

    const attendanceData = {
      userId: user.id,
      userCollection: user.collection,
      cedula: user.data.cedula,
      fullName: user.data.fullName,
      email: user.data.email || '',
      phoneNumber: user.data.phoneNumber || user.data.phone || '',
      role: user.data.role || '',
      userType: user.data.userType || '',
      userTypeName: user.data.userTypeName || user.data.role || '',

      branch: user.data.branch || user.data.companies || '',
      branchName: user.data.branchName || '',

      brandId: DEVICE_CONFIG.brandId,
      location: DEVICE_CONFIG.location,

      timestamp: admin.firestore.Timestamp.fromDate(eventTimestamp),
      eventType: determinedEventType,
      verificationMethod: method || 'fingerPrint',

      deviceId: DEVICE_CONFIG.ip,
      status: 'success',
    };

    console.log(`💾 Guardando asistencia: ${attendanceData.fullName} (${attendanceData.eventType})`);
    const recordId = await saveAttendanceRecord(attendanceData);

    if (io) {
      io.emit('attendance:new_record', {
        id: recordId,
        ...attendanceData,
        timestamp: eventTimestamp,
      });
    }

    return recordId;
  } catch (error) {
    console.error('❌ Error procesando evento:', error);
  }
}

// Hikvision date parsing (sin timezone => Colombia)
function parseHikvisionDate(dateStr) {
  const s = String(dateStr || '').trim();
  if (!s) return new Date();
  const hasTZ = /([zZ]|[+-]\d\d:\d\d)$/.test(s);
  return new Date(hasTZ ? s : `${s}-05:00`);
}

// ============================
// DEVICE STATUS
// ============================
async function checkDeviceStatus() {
  try {
    const response = await digestRequest('GET', `${baseURL}/System/deviceInfo`, { timeout: 5000 });
    return { success: true, connected: true, deviceInfo: response.data, brandId: DEVICE_CONFIG.brandId, location: DEVICE_CONFIG.location };
  } catch (error) {
    return { success: false, connected: false, error: error.message };
  }
}

// ============================
// REGISTER / SYNC USERS (si lo usas)
// ============================
async function registerUserInDevice(cedula, fullName) {
  try {
    const userJSON = {
      UserInfo: {
        employeeNo: cedula,
        name: fullName,
        userType: 'normal',
        Valid: { enable: true, beginTime: '2025-01-01T00:00:00', endTime: '2035-12-31T23:59:59' },
        doorRight: '1',
      },
    };

    const response = await digestRequest('POST', `${baseURL}/AccessControl/UserInfo/Record?format=json`, {
      data: userJSON,
      headers: { 'Content-Type': 'application/json' },
    });

    return { success: true, data: response.data };
  } catch (error) {
    return { success: false, error: error.message };
  }
}

async function syncUsersToDevice() {
  const db = getDb();
  const results = { success: [], errors: [], skipped: [] };

  const syncCollection = async (collectionName) => {
    const snapshot = await db.collection(collectionName).where('active', '==', true).get();

    for (const doc of snapshot.docs) {
      const user = doc.data();
      if (!user.cedula || !user.fullName) {
        results.skipped.push({ id: doc.id, collection: collectionName, name: user.fullName || 'Sin nombre', reason: 'Falta cédula o nombre' });
        continue;
      }

      const auth = validateUserAuthorization(user);
      if (!auth.isAuthorized) {
        results.skipped.push({
          id: doc.id,
          collection: collectionName,
          cedula: user.cedula,
          name: user.fullName,
          reason: !auth.hasLocationAccess ? 'Location no autorizada' : 'Brand no autorizada',
        });
        continue;
      }

      const r = await registerUserInDevice(user.cedula, user.fullName);
      if (r.success) results.success.push({ id: doc.id, collection: collectionName, cedula: user.cedula, name: user.fullName });
      else results.errors.push({ id: doc.id, collection: collectionName, cedula: user.cedula, name: user.fullName, error: r.error });
    }
  };

  await syncCollection('barbers');
  await syncCollection('workers');

  return results;
}

// ============================
// GET RECORDS
// ============================
async function getAttendanceRecords(filters = {}) {
  const db = getDb();
  let query = db.collection('attendance').orderBy('timestamp', 'desc');

  if (filters.cedula) query = query.where('cedula', '==', filters.cedula);
  if (filters.collection) query = query.where('userCollection', '==', filters.collection);
  if (filters.eventType) query = query.where('eventType', '==', filters.eventType);
  if (filters.brandId) query = query.where('brandId', '==', filters.brandId);
  if (filters.location) query = query.where('location', '==', filters.location);
  if (filters.startDate) query = query.where('timestamp', '>=', new Date(filters.startDate));
  if (filters.endDate) query = query.where('timestamp', '<=', new Date(filters.endDate));

  const snapshot = await query.limit(parseInt(filters.limit || '100', 10)).get();

  const records = [];
  snapshot.forEach((doc) => {
    const data = doc.data();
    records.push({
      id: doc.id,
      ...data,
      timestamp: data.timestamp?.toDate ? data.timestamp.toDate() : null,
    });
  });

  return { success: true, count: records.length, records };
}

async function getTodayAttendanceForUser(userId) {
  const db = getDb();
  const now = new Date();
  const startOfDay = new Date(now); startOfDay.setHours(0, 0, 0, 0);
  const endOfDay = new Date(now); endOfDay.setHours(23, 59, 59, 999);

  const snapshot = await db
    .collection('attendance')
    .where('userId', '==', userId)
    .where('timestamp', '>=', admin.firestore.Timestamp.fromDate(startOfDay))
    .where('timestamp', '<=', admin.firestore.Timestamp.fromDate(endOfDay))
    .orderBy('timestamp', 'asc')
    .get();

  const records = [];
  snapshot.forEach(doc => {
    const data = doc.data();
    records.push({ id: doc.id, ...data, timestamp: data.timestamp?.toDate ? data.timestamp.toDate() : null });
  });

  return records;
}

module.exports = {
  checkDeviceStatus,
  registerUserInDevice,
  syncUsersToDevice,
  getAttendanceRecords,
  processAttendanceEvent,
  getTodayAttendanceForUser,
  setStreamWarmup,
};
