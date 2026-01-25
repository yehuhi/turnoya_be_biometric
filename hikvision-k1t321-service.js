// hikvision-k1t321-service.js
const axios = require('axios');
const crypto = require('crypto');
const Dicer = require('dicer');
const xml2js = require('xml2js');
const fs = require('fs');
const path = require('path');
const admin = require('firebase-admin');
const { DateTime } = require('luxon');

// Carpeta evidencias
const EVIDENCE_DIR = path.join(__dirname, 'attendance-evidence');
if (!fs.existsSync(EVIDENCE_DIR)) fs.mkdirSync(EVIDENCE_DIR, { recursive: true });

const getDb = () => admin.firestore();

// ============================
// CONFIG
// ============================
const DEVICE_CONFIG = {
  ip: process.env.HIKVISION_IP || '192.168.1.25',
  port: parseInt(process.env.HIKVISION_PORT, 10) || 80,
  username: process.env.HIKVISION_USERNAME || 'admin',
  password: process.env.HIKVISION_PASSWORD || 'Negro2025',
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

  // ⭐ Convertir el timestamp a timezone Colombia
  const eventInColombia = DateTime.fromJSDate(eventTimestamp).setZone('America/Bogota');
  
  // ⭐ Obtener inicio y fin del DÍA en Colombia
  const startOfDay = eventInColombia.startOf('day').toJSDate();
  const endOfDay = eventInColombia.endOf('day').toJSDate();

  console.log(`   🔍 Determinando tipo de evento`);
  console.log(`   📅 Fecha: ${eventInColombia.toFormat('yyyy-MM-dd')}`);
  console.log(`   🕐 Hora: ${eventInColombia.toFormat('HH:mm:ss')} COT`);
  console.log(`   📅 Buscando del día: ${startOfDay.toISOString()} a ${endOfDay.toISOString()}`);

  const lastRecordSnapshot = await db
    .collection('attendance')
    .where('userId', '==', userId)
    .where('timestamp', '>=', admin.firestore.Timestamp.fromDate(startOfDay))
    .where('timestamp', '<=', admin.firestore.Timestamp.fromDate(endOfDay))
    .orderBy('timestamp', 'desc')
    .limit(1)
    .get();

  if (lastRecordSnapshot.empty) {
    console.log('   ➡️  Primer registro del día (Colombia) → CHECK-IN');
    return 'check_in';
  }

  const lastRecord = lastRecordSnapshot.docs[0].data();
  const lastEventType = lastRecord.eventType;

  console.log(`   📝 Último evento del día: ${lastEventType}`);

  if (lastEventType === 'check_in') {
    console.log('   ⬅️  Último fue entrada → CHECK-OUT');
    return 'check_out';
  } else {
    console.log('   ➡️  Último fue salida → CHECK-IN');
    return 'check_in';
  }
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

async function autoConvertPendingCheckIns() {
  try {
    const db = getDb();
    
    // Obtener ayer en timezone Colombia
    const nowColombia = DateTime.now().setZone('America/Bogota');
    const yesterday = nowColombia.minus({ days: 1 });
    
    const startOfYesterday = yesterday.startOf('day').toJSDate();
    const endOfYesterday = yesterday.endOf('day').toJSDate();
    
    console.log('\n' + '='.repeat(60));
    console.log('🕛 AUTO-CONVERSIÓN INTELIGENTE DE CHECK-INS');
    console.log('='.repeat(60));
    console.log(`📅 Revisando día: ${yesterday.toFormat('yyyy-MM-dd')}`);
    console.log(`🕐 Rango: ${startOfYesterday.toISOString()} - ${endOfYesterday.toISOString()}`);
    
    // Obtener TODOS los registros de ayer
    const yesterdayRecords = await db
      .collection('attendance')
      .where('timestamp', '>=', admin.firestore.Timestamp.fromDate(startOfYesterday))
      .where('timestamp', '<=', admin.firestore.Timestamp.fromDate(endOfYesterday))
      .orderBy('timestamp', 'asc')
      .get();
    
    console.log(`📊 Total registros de ayer: ${yesterdayRecords.size}`);
    
    // Agrupar por usuario
    const userRecords = {};
    
    yesterdayRecords.forEach(doc => {
      const data = doc.data();
      const userId = data.userId;
      
      if (!userRecords[userId]) {
        userRecords[userId] = [];
      }
      
      userRecords[userId].push({
        docId: doc.id,
        ...data,
        timestamp: data.timestamp?.toDate(),
      });
    });
    
    console.log(`👥 Usuarios con actividad ayer: ${Object.keys(userRecords).length}`);
    
    // Analizar cada usuario
    const recordsToConvert = [];
    const skippedSingleEvent = [];
    
    for (const [userId, records] of Object.entries(userRecords)) {
      // Ordenar por timestamp
      records.sort((a, b) => a.timestamp - b.timestamp);
      
      const totalEvents = records.length;
      const lastRecord = records[records.length - 1];
      
      console.log(`\n👤 Usuario: ${lastRecord.fullName} (${lastRecord.cedula})`);
      console.log(`   Total eventos: ${totalEvents}`);
      console.log(`   Último evento: ${lastRecord.eventType} a las ${lastRecord.timestamp.toLocaleTimeString('es-CO')}`);
      
      // ⭐ LÓGICA INTELIGENTE
      if (totalEvents === 1 && lastRecord.eventType === 'check_in') {
        // Usuario con UN SOLO check_in → NO modificar
        console.log(`   ℹ️  Solo tiene 1 evento (check_in) → NO modificar`);
        skippedSingleEvent.push({
          userId,
          userName: lastRecord.fullName,
          cedula: lastRecord.cedula,
          timestamp: lastRecord.timestamp,
        });
      } else if (totalEvents > 1 && lastRecord.eventType === 'check_in') {
        // Usuario con MÚLTIPLES eventos Y último es check_in → Modificar
        console.log(`   ✅ Tiene ${totalEvents} eventos y terminó con check_in → Modificar a check_out`);
        recordsToConvert.push({
          docId: lastRecord.docId,
          userId,
          userName: lastRecord.fullName,
          cedula: lastRecord.cedula,
          timestamp: lastRecord.timestamp,
          totalEvents,
        });
      } else {
        // Último evento es check_out → OK
        console.log(`   ✅ Terminó correctamente con check_out → OK`);
      }
    }
    
    console.log('\n' + '─'.repeat(60));
    console.log(`⚠️  Registros a convertir: ${recordsToConvert.length}`);
    console.log(`ℹ️  Omitidos (1 solo evento): ${skippedSingleEvent.length}`);
    console.log('─'.repeat(60));
    
    if (recordsToConvert.length === 0) {
      console.log('\n✅ No hay check-ins pendientes de conversión');
      
      if (skippedSingleEvent.length > 0) {
        console.log('\nℹ️  Usuarios con 1 solo evento (no modificados):');
        skippedSingleEvent.forEach(user => {
          console.log(`   • ${user.userName} (${user.cedula}) - ${user.timestamp.toLocaleTimeString('es-CO')}`);
        });
      }
      
      console.log('\n' + '='.repeat(60) + '\n');
      return { 
        success: true, 
        converted: 0, 
        skipped: skippedSingleEvent.length,
        users: [] 
      };
    }
    
    // ⭐ MODIFICAR los registros seleccionados
    const results = [];
    const batch = db.batch();
    
    console.log('\n🔄 Convirtiendo registros...');
    
    for (const record of recordsToConvert) {
      try {
        console.log(`\n   → ${record.userName} (${record.cedula})`);
        console.log(`     Total eventos del día: ${record.totalEvents}`);
        console.log(`     Timestamp: ${record.timestamp.toLocaleString('es-CO')}`);
        console.log(`     Doc ID: ${record.docId}`);
        
        const docRef = db.collection('attendance').doc(record.docId);
        
        // ⭐ MODIFICAR el documento
        batch.update(docRef, {
          eventType: 'check_out', // ⭐ Cambiar de check_in a check_out
          autoConverted: true,
          autoConvertedAt: admin.firestore.FieldValue.serverTimestamp(),
          originalEventType: 'check_in',
          conversionNote: 'Convertido automáticamente - Usuario registró múltiples eventos pero no marcó salida final',
          totalDayEvents: record.totalEvents, // Cuántos eventos tuvo ese día
        });
        
        console.log(`     ✅ Marcado para conversión`);
        
        results.push({
          docId: record.docId,
          userId: record.userId,
          userName: record.userName,
          cedula: record.cedula,
          totalEvents: record.totalEvents,
          success: true,
        });
        
      } catch (error) {
        console.error(`     ❌ Error:`, error.message);
        
        results.push({
          docId: record.docId,
          userId: record.userId,
          userName: record.userName,
          cedula: record.cedula,
          success: false,
          error: error.message,
        });
      }
    }
    
    // ⭐ EJECUTAR BATCH UPDATE
    console.log(`\n💾 Ejecutando batch update de ${recordsToConvert.length} documentos...`);
    await batch.commit();
    console.log(`✅ Batch completado exitosamente`);
    
    const successCount = results.filter(r => r.success).length;
    const errorCount = results.filter(r => !r.success).length;
    
    console.log('\n' + '='.repeat(60));
    console.log('📊 RESUMEN DE AUTO-CONVERSIÓN');
    console.log('='.repeat(60));
    console.log(`✅ Check-ins convertidos a check-out: ${successCount}`);
    console.log(`❌ Errores: ${errorCount}`);
    console.log(`ℹ️  Omitidos (1 solo evento): ${skippedSingleEvent.length}`);
    
    if (successCount > 0) {
      console.log('\n👥 Usuarios convertidos:');
      results.filter(r => r.success).forEach(r => {
        console.log(`   • ${r.userName} (${r.cedula}) - ${r.totalEvents} eventos`);
      });
    }
    
    if (skippedSingleEvent.length > 0) {
      console.log('\nℹ️  Usuarios con 1 solo evento (no modificados):');
      skippedSingleEvent.forEach(user => {
        console.log(`   • ${user.userName} (${user.cedula})`);
      });
    }
    
    console.log('='.repeat(60) + '\n');
    
    return {
      success: true,
      converted: successCount,
      errors: errorCount,
      skipped: skippedSingleEvent.length,
      users: results,
      skippedUsers: skippedSingleEvent,
    };
    
  } catch (error) {
    console.error('❌ Error en auto-conversión:', error);
    return {
      success: false,
      error: error.message,
    };
  }
}

/**
 * Programa la auto-conversión para ejecutarse a medianoche (00:00:30)
 */
function scheduleAutoConvert() {
  const { DateTime } = require('luxon');
  
  function scheduleNext() {
    const nowColombia = DateTime.now().setZone('America/Bogota');
    
    // Próxima medianoche + 30 segundos
    let nextRun = nowColombia.plus({ days: 1 }).startOf('day').plus({ seconds: 30 });
    
    // Si estamos muy cerca de medianoche, ejecutar en la próxima
    if (nextRun.diff(nowColombia, 'seconds').seconds < 60) {
      nextRun = nextRun.plus({ days: 1 });
    }
    
    const msUntilRun = nextRun.diff(nowColombia).milliseconds;
    
    console.log('\n⏰ Auto-conversión inteligente programada para:', nextRun.toFormat('yyyy-MM-dd HH:mm:ss COT'));
    console.log(`   (en ${(msUntilRun / 1000 / 60 / 60).toFixed(1)} horas)`);
    console.log('   Lógica: Solo convierte si hay >1 evento y último es check_in\n');
    
    setTimeout(async () => {
      console.log('\n🕛 Ejecutando auto-conversión programada...');
      await autoConvertPendingCheckIns();
      
      // Programar la próxima ejecución
      scheduleNext();
    }, msUntilRun);
  }
  
  scheduleNext();
}

module.exports = {
  checkDeviceStatus,
  registerUserInDevice,
  syncUsersToDevice,
  getAttendanceRecords,
  processAttendanceEvent,
  getTodayAttendanceForUser,
  setStreamWarmup,
  autoConvertPendingCheckIns,  // ⭐ NUEVO
  scheduleAutoConvert,          // ⭐ NUEVO
};
