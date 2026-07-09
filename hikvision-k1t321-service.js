// hikvision-k1t321-service.js - VERSIÓN MULTI-DISPOSITIVO CORREGIDA
const axios = require('axios');
const crypto = require('crypto');
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
// CONFIGURACIÓN MULTI-DISPOSITIVO
// ============================
const DEVICES = [
  {
    id: 'NEGRO_MALLPLAZA',
    ip: '192.168.1.25',
    port: 80,
    username: 'admin',
    password: 'Negro2025',
    brandId: '8iaQueOcfYoss5zXJ3IC',
    location: 'oRHOHl3HLppb02u4pyVK',
    name: 'CC MALL PLAZA BARRANQUILLA',
  },
  {
    id: 'NEGRO_VIVA',
    ip: '192.168.1.18',
    port: 80,
    username: 'admin',
    password: 'NEGROVIVA!',
    brandId: '8iaQueOcfYoss5zXJ3IC',
    location: 'sfO6ev2fFyVDMHykB2MW',
    name: 'CC VIVA BARRANQUILLA',
  },
  // Agregar más dispositivos aquí según necesites:
];

// Anti doble huella (30s por defecto)
const COOLDOWN_SECONDS = parseInt(process.env.ATTENDANCE_COOLDOWN_SECONDS || '30', 10);

// Warmup control
let isStreamWarmedUp = true;
function setStreamWarmup(value) {
  isStreamWarmedUp = !!value;
}

// ============================
// FUNCIÓN PARA OBTENER CONFIG POR ID O IP
// ============================
// Se prioriza el match por `id` (confiable, viene de la URL del webhook)
// sobre el match por IP (no confiable detrás de NAT/cloud, se mantiene
// solo por compatibilidad con el webhook legacy sin deviceId en la ruta).
function getDeviceConfig(identifier) {
  const device = DEVICES.find(d => d.id === identifier) || DEVICES.find(d => d.ip === identifier);
  if (!device) {
    console.warn(`⚠️ Dispositivo ${identifier} no configurado - usando primer dispositivo por defecto`);
    return DEVICES[0] || {
      id: 'unknown',
      ip: identifier,
      port: 80,
      username: 'admin',
      password: '12345',
      brandId: 'unknown',
      location: 'unknown',
      name: 'Dispositivo Desconocido',
    };
  }
  return device;
}

// ============================
// DIGEST AUTH POR DISPOSITIVO
// ============================
async function digestRequestForDevice(method, url, deviceConfig, options = {}) {
  const firstResponse = await axios({
    method,
    url,
    ...options,
    validateStatus: (status) => status === 401 || (status >= 200 && status < 300),
  });

  if (firstResponse.status !== 401) return firstResponse;

  const authHeader = firstResponse.headers['www-authenticate'];
  if (!authHeader || !authHeader.includes('Digest')) {
    throw new Error('Digest auth no disponible');
  }

  const realm = /realm="([^"]+)"/.exec(authHeader)?.[1] || '';
  const nonce = /nonce="([^"]+)"/.exec(authHeader)?.[1] || '';
  const qop = /qop="([^"]+)"/.exec(authHeader)?.[1] || 'auth';

  const ha1 = crypto
    .createHash('md5')
    .update(`${deviceConfig.username}:${realm}:${deviceConfig.password}`)
    .digest('hex');

  const ha2 = crypto
    .createHash('md5')
    .update(`${method.toUpperCase()}:${new URL(url).pathname}`)
    .digest('hex');

  const nc = '00000001';
  const cnonce = crypto.randomBytes(8).toString('hex');
  const response = crypto
    .createHash('md5')
    .update(`${ha1}:${nonce}:${nc}:${cnonce}:${qop}:${ha2}`)
    .digest('hex');

  return axios({
    method,
    url,
    ...options,
    headers: {
      ...options.headers,
      Authorization: `Digest username="${deviceConfig.username}", realm="${realm}", nonce="${nonce}", uri="${new URL(url).pathname}", qop=${qop}, nc=${nc}, cnonce="${cnonce}", response="${response}"`,
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
const validateUserAuthorization = (userData, deviceConfig) => {
  const authorizedLocations = userData.authorizedLocations || [];
  const brandIds = userData.brandIds || [];

  const hasLocationAccess = authorizedLocations.includes(deviceConfig.location);
  const hasBrandAccess = brandIds.includes(deviceConfig.brandId);

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

  const eventInColombia = DateTime.fromJSDate(eventTimestamp).setZone('America/Bogota');
  const startOfDay = eventInColombia.startOf('day').toJSDate();
  const endOfDay = eventInColombia.endOf('day').toJSDate();

  console.log(`   🔍 Determinando tipo de evento`);
  console.log(`   📅 Fecha: ${eventInColombia.toFormat('yyyy-MM-dd')}`);
  console.log(`   🕐 Hora: ${eventInColombia.toFormat('HH:mm:ss')} COT`);

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
    // Identificar dispositivo: se prioriza deviceId (viene de la ruta del
    // webhook, ej. /api/hikvision/webhook/NEGRO_VIVA) sobre deviceIP (no
    // confiable detrás de NAT cuando el server corre en la nube).
    const deviceIdentifier = eventData.deviceId || eventData.deviceIP || DEVICES[0].id;

    // Obtener configuración del dispositivo
    const deviceConfig = getDeviceConfig(deviceIdentifier);
    
    console.log(`\n📍 Dispositivo: ${deviceConfig.name} (${deviceConfig.ip})`);
    console.log(`   Location: ${deviceConfig.location}`);
    console.log(`   BrandId: ${deviceConfig.brandId}`);
    
    // Normalización
    const cedula = eventData.cedula || eventData.employeeNoString || eventData.employeeNo || eventData.cardNo;
    const method = eventData.method || eventData.attendanceStatus || eventData.currentVerifyMode || 'fingerPrint';
    const tsStr = eventData.timestamp || eventData.dateTime || new Date().toISOString();
    const eventTimestamp = parseHikvisionDate(tsStr);

    if (!cedula) {
      console.warn('⚠️ Evento sin cédula - IGNORADO');
      return;
    }

    const cedulaNumber = parseInt(cedula, 10);
    if (isNaN(cedulaNumber) || cedulaNumber < 1000) {
      console.warn(`⚠️ Identificador inválido (${cedula}) - IGNORADO`);
      return;
    }

    if (method === 'invalid' || method === 'unknown') {
      console.warn(`⚠️ Método inválido (${method}) - IGNORADO`);
      return;
    }

    console.log(`🔍 Buscando usuario con cédula: ${cedula}`);
    const user = await findUserByCedula(String(cedula));

    if (!user.found) {
      console.warn(`⚠️ Usuario con cédula ${cedula} NO ENCONTRADO`);
      if (io) {
        io.emit('attendance:unknown_user', {
          cedula,
          timestamp: eventTimestamp,
          method,
          deviceIP: deviceConfig.ip,
          deviceName: deviceConfig.name,
          message: `Usuario con cédula ${cedula} intentó marcar en ${deviceConfig.name}`,
        });
      }
      return;
    }

    // Validar autorización
    const authorization = validateUserAuthorization(user.data, deviceConfig);
    
    console.log(`   authorizedLocations: ${JSON.stringify(user.data.authorizedLocations)}`);
    console.log(`   brandIds: ${JSON.stringify(user.data.brandIds)}`);
    console.log(`   Requiere location: ${deviceConfig.location}`);
    console.log(`   Requiere brandId: ${deviceConfig.brandId}`);
    console.log(`   hasLocationAccess: ${authorization.hasLocationAccess}`);
    console.log(`   hasBrandAccess: ${authorization.hasBrandAccess}`);
    
    if (!authorization.isAuthorized) {
      console.warn(`❌ ACCESO NO AUTORIZADO: ${user.data.fullName} (${cedula})`);
      console.warn(`   Usuario no tiene acceso a ${deviceConfig.name}`);
      if (io) {
        io.emit('attendance:unauthorized_access', {
          cedula,
          fullName: user.data.fullName,
          timestamp: eventTimestamp,
          location: deviceConfig.location,
          brandId: deviceConfig.brandId,
          deviceName: deviceConfig.name,
          reason: !authorization.hasLocationAccess ? 'location_not_authorized' : 'brand_not_authorized',
        });
      }
      return;
    }

    console.log(`✅ ACCESO AUTORIZADO para ${deviceConfig.name}`);

    // Cooldown
    const cooldown = await isWithinCooldown(user.id, eventTimestamp);
    if (cooldown.blocked) {
      console.warn(`⏱️ COOLDOWN: Ignorando marca duplicada`);
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
      
      // Configuración del dispositivo
      brandId: deviceConfig.brandId,
      location: deviceConfig.location,
      deviceId: deviceConfig.ip,
      deviceName: deviceConfig.name,
      
      timestamp: admin.firestore.Timestamp.fromDate(eventTimestamp),
      eventType: determinedEventType,
      verificationMethod: method || 'fingerPrint',
      status: 'success',
    };

    console.log(`💾 Guardando asistencia: ${attendanceData.fullName} (${attendanceData.eventType}) en ${deviceConfig.name}`);
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

// Hikvision date parsing
function parseHikvisionDate(dateStr) {
  const s = String(dateStr || '').trim();
  if (!s) return new Date();
  const hasTZ = /([zZ]|[+-]\d\d:\d\d)$/.test(s);
  return new Date(hasTZ ? s : `${s}-05:00`);
}

// ============================
// DEVICE STATUS
// ============================
async function checkDeviceStatus(deviceId) {
  const device = deviceId 
    ? DEVICES.find(d => d.id === deviceId) 
    : DEVICES[0];
    
  if (!device) {
    return { success: false, error: 'Dispositivo no encontrado' };
  }
  
  try {
    const deviceURL = `http://${device.ip}:${device.port}/ISAPI`;
    const response = await digestRequestForDevice(
      'GET', 
      `${deviceURL}/System/deviceInfo`, 
      device,
      { timeout: 5000 }
    );
    
    return { 
      success: true, 
      connected: true, 
      deviceInfo: response.data, 
      brandId: device.brandId, 
      location: device.location,
      deviceName: device.name,
      deviceId: device.id,
    };
  } catch (error) {
    return { 
      success: false, 
      connected: false, 
      error: error.message,
      deviceName: device.name,
      deviceId: device.id,
    };
  }
}

async function checkAllDevicesStatus() {
  const results = [];
  
  for (const device of DEVICES) {
    try {
      const deviceURL = `http://${device.ip}:${device.port}/ISAPI`;
      const response = await digestRequestForDevice(
        'GET', 
        `${deviceURL}/System/deviceInfo`, 
        device,
        { timeout: 5000 }
      );
      
      results.push({
        deviceId: device.id,
        deviceName: device.name,
        ip: device.ip,
        success: true,
        connected: true,
        deviceInfo: response.data,
        brandId: device.brandId,
        location: device.location,
      });
    } catch (error) {
      results.push({
        deviceId: device.id,
        deviceName: device.name,
        ip: device.ip,
        success: false,
        connected: false,
        error: error.message,
      });
    }
  }
  
  return {
    success: true,
    totalDevices: DEVICES.length,
    connectedDevices: results.filter(r => r.connected).length,
    devices: results,
  };
}

// ============================
// REGISTER / SYNC USERS
// ============================
async function registerUserInDevice(cedula, fullName, deviceConfig = DEVICES[0]) {
  try {
    const deviceURL = `http://${deviceConfig.ip}:${deviceConfig.port}/ISAPI`;
    
    const userJSON = {
      UserInfo: {
        employeeNo: cedula,
        name: fullName,
        userType: 'normal',
        Valid: { 
          enable: true, 
          beginTime: '2025-01-01T00:00:00', 
          endTime: '2035-12-31T23:59:59' 
        },
        doorRight: '1',
      },
    };

    const response = await digestRequestForDevice(
      'POST', 
      `${deviceURL}/AccessControl/UserInfo/Record?format=json`, 
      deviceConfig,
      {
        data: userJSON,
        headers: { 'Content-Type': 'application/json' },
      }
    );

    return { success: true, data: response.data };
  } catch (error) {
    return { success: false, error: error.message };
  }
}

async function syncUsersToDevice(deviceId = 'device_1') {
  const db = getDb();
  const results = { success: [], errors: [], skipped: [] };

  // Obtener configuración del dispositivo
  const deviceConfig = DEVICES.find(d => d.id === deviceId) || DEVICES[0];
  
  console.log(`\n🔄 Sincronizando usuarios al dispositivo: ${deviceConfig.name}`);
  console.log(`   IP: ${deviceConfig.ip}`);
  console.log(`   Location: ${deviceConfig.location}`);
  console.log(`   BrandId: ${deviceConfig.brandId}\n`);

  const syncCollection = async (collectionName) => {
    const snapshot = await db.collection(collectionName).where('active', '==', true).get();

    for (const doc of snapshot.docs) {
      const user = doc.data();
      if (!user.cedula || !user.fullName) {
        results.skipped.push({ 
          id: doc.id, 
          collection: collectionName, 
          name: user.fullName || 'Sin nombre', 
          reason: 'Falta cédula o nombre' 
        });
        continue;
      }

      // Validar autorización con el dispositivo específico
      const auth = validateUserAuthorization(user, deviceConfig);
      if (!auth.isAuthorized) {
        results.skipped.push({
          id: doc.id,
          collection: collectionName,
          cedula: user.cedula,
          name: user.fullName,
          reason: !auth.hasLocationAccess 
            ? `Location no autorizada (requiere ${deviceConfig.location})` 
            : `Brand no autorizado (requiere ${deviceConfig.brandId})`,
        });
        continue;
      }

      const r = await registerUserInDevice(user.cedula, user.fullName, deviceConfig);
      if (r.success) {
        results.success.push({ 
          id: doc.id, 
          collection: collectionName, 
          cedula: user.cedula, 
          name: user.fullName 
        });
      } else {
        results.errors.push({ 
          id: doc.id, 
          collection: collectionName, 
          cedula: user.cedula, 
          name: user.fullName, 
          error: r.error 
        });
      }
    }
  };

  await syncCollection('barbers');
  await syncCollection('workers');

  console.log(`\n📊 Sincronización completada:`);
  console.log(`   ✅ Exitosos: ${results.success.length}`);
  console.log(`   ❌ Errores: ${results.errors.length}`);
  console.log(`   ⏭️  Omitidos: ${results.skipped.length}\n`);

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
  if (filters.deviceId) query = query.where('deviceId', '==', filters.deviceId);
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
  const startOfDay = new Date(now); 
  startOfDay.setHours(0, 0, 0, 0);
  const endOfDay = new Date(now); 
  endOfDay.setHours(23, 59, 59, 999);

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
    records.push({ 
      id: doc.id, 
      ...data, 
      timestamp: data.timestamp?.toDate ? data.timestamp.toDate() : null 
    });
  });

  return records;
}

// ============================
// AUTO-CONVERSIÓN INTELIGENTE
// ============================
async function autoConvertPendingCheckIns() {
  try {
    const db = getDb();
    
    const nowColombia = DateTime.now().setZone('America/Bogota');
    const yesterday = nowColombia.minus({ days: 1 });
    
    const startOfYesterday = yesterday.startOf('day').toJSDate();
    const endOfYesterday = yesterday.endOf('day').toJSDate();
    
    console.log('\n' + '='.repeat(60));
    console.log('🕛 AUTO-CONVERSIÓN INTELIGENTE DE CHECK-INS');
    console.log('='.repeat(60));
    console.log(`📅 Revisando día: ${yesterday.toFormat('yyyy-MM-dd')}`);
    console.log(`🕐 Rango: ${startOfYesterday.toISOString()} - ${endOfYesterday.toISOString()}`);
    
    const yesterdayRecords = await db
      .collection('attendance')
      .where('timestamp', '>=', admin.firestore.Timestamp.fromDate(startOfYesterday))
      .where('timestamp', '<=', admin.firestore.Timestamp.fromDate(endOfYesterday))
      .orderBy('timestamp', 'asc')
      .get();
    
    console.log(`📊 Total registros de ayer: ${yesterdayRecords.size}`);
    
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
    
    const recordsToConvert = [];
    const skippedSingleEvent = [];
    
    for (const [userId, records] of Object.entries(userRecords)) {
      records.sort((a, b) => a.timestamp - b.timestamp);
      
      const totalEvents = records.length;
      const lastRecord = records[records.length - 1];
      
      console.log(`\n👤 Usuario: ${lastRecord.fullName} (${lastRecord.cedula})`);
      console.log(`   Total eventos: ${totalEvents}`);
      console.log(`   Último evento: ${lastRecord.eventType} a las ${lastRecord.timestamp.toLocaleTimeString('es-CO')}`);
      
      if (totalEvents === 1 && lastRecord.eventType === 'check_in') {
        console.log(`   ℹ️  Solo tiene 1 evento (check_in) → NO modificar`);
        skippedSingleEvent.push({
          userId,
          userName: lastRecord.fullName,
          cedula: lastRecord.cedula,
          timestamp: lastRecord.timestamp,
        });
      } else if (totalEvents > 1 && lastRecord.eventType === 'check_in') {
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
        
        batch.update(docRef, {
          eventType: 'check_out',
          autoConverted: true,
          autoConvertedAt: admin.firestore.FieldValue.serverTimestamp(),
          originalEventType: 'check_in',
          conversionNote: 'Convertido automáticamente - Usuario registró múltiples eventos pero no marcó salida final',
          totalDayEvents: record.totalEvents,
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

function scheduleAutoConvert() {
  function scheduleNext() {
    const nowColombia = DateTime.now().setZone('America/Bogota');
    
    let nextRun = nowColombia.plus({ days: 1 }).startOf('day').plus({ seconds: 30 });
    
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
      
      scheduleNext();
    }, msUntilRun);
  }
  
  scheduleNext();
}

// ============================
// EXPORTS
// ============================
module.exports = {
  DEVICES,
  getDeviceConfig,
  digestRequestForDevice,
  checkDeviceStatus,
  checkAllDevicesStatus,
  registerUserInDevice,
  syncUsersToDevice,
  getAttendanceRecords,
  processAttendanceEvent,
  getTodayAttendanceForUser,
  setStreamWarmup,
  autoConvertPendingCheckIns,
  scheduleAutoConvert,
};