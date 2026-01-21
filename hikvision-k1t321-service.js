// hikvision-k1t321-service.js
// Servicio completo para DS-K1T321MFWX-B con ISAPI
// Soporta: eventos en tiempo real, imágenes, huellas, entrada/salida
// ⭐ ACTUALIZADO: Validación de brandId y authorizedLocations

const axios = require('axios');
const crypto = require('crypto');
const Dicer = require('dicer');
const xml2js = require('xml2js');
const fs = require('fs');
const path = require('path');
const admin = require('firebase-admin');

// Crear carpeta para guardar evidencias (imágenes)
const EVIDENCE_DIR = path.join(__dirname, 'attendance-evidence');
if (!fs.existsSync(EVIDENCE_DIR)) {
  fs.mkdirSync(EVIDENCE_DIR, { recursive: true });
}

// ⭐ NO obtener db aquí, se obtendrá cuando se use
const getDb = () => admin.firestore();

// ============================================
// CONFIGURACIÓN DEL DISPOSITIVO
// ============================================
const DEVICE_CONFIG = {
  ip: process.env.HIKVISION_IP || '192.168.1.13',
  port: parseInt(process.env.HIKVISION_PORT) || 80,
  username: process.env.HIKVISION_USERNAME || 'admin',
  password: process.env.HIKVISION_PASSWORD || '1047338633ABC',
  brandId: process.env.HIKVISION_BRAND_ID || '8iaQueOcfYoss5zXJ3IC',
  location: process.env.HIKVISION_LOCATION || 'oRHOHl3HLppb02u4pyVK',
};

const baseURL = `http://${DEVICE_CONFIG.ip}:${DEVICE_CONFIG.port}/ISAPI`;

// ============================================
// DIGEST AUTH SIMPLE
// ============================================
async function digestRequest(method, url, options = {}) {
  try {
    // Primer intento sin auth para obtener el challenge
    const firstResponse = await axios({
      method,
      url,
      ...options,
      validateStatus: (status) => status === 401 || (status >= 200 && status < 300),
    });

    // Si no requiere auth, retornar
    if (firstResponse.status !== 401) {
      return firstResponse;
    }

    // Parsear el WWW-Authenticate header
    const authHeader = firstResponse.headers['www-authenticate'];
    if (!authHeader || !authHeader.includes('Digest')) {
      throw new Error('Digest auth no disponible');
    }

    const realm = /realm="([^"]+)"/.exec(authHeader)?.[1] || '';
    const nonce = /nonce="([^"]+)"/.exec(authHeader)?.[1] || '';
    const qop = /qop="([^"]+)"/.exec(authHeader)?.[1] || 'auth';

    // Calcular respuesta digest
    const ha1 = crypto.createHash('md5').update(`${DEVICE_CONFIG.username}:${realm}:${DEVICE_CONFIG.password}`).digest('hex');
    const ha2 = crypto.createHash('md5').update(`${method.toUpperCase()}:${new URL(url).pathname}`).digest('hex');
    const nc = '00000001';
    const cnonce = crypto.randomBytes(8).toString('hex');
    const response = crypto.createHash('md5').update(`${ha1}:${nonce}:${nc}:${cnonce}:${qop}:${ha2}`).digest('hex');

    // Segunda petición con auth
    return await axios({
      method,
      url,
      ...options,
      headers: {
        ...options.headers,
        'Authorization': `Digest username="${DEVICE_CONFIG.username}", realm="${realm}", nonce="${nonce}", uri="${new URL(url).pathname}", qop=${qop}, nc=${nc}, cnonce="${cnonce}", response="${response}"`
      },
    });
  } catch (error) {
    throw error;
  }
}
let streamConnection = null;
let reconnectAttempts = 0;
const MAX_RECONNECT_ATTEMPTS = 10;

// ============================================
// FUNCIONES DE BÚSQUEDA Y GUARDADO
// ============================================

const findUserByCedula = async (cedula) => {
  try {
    const db = getDb();
    
    // Buscar en barbers
    const barbersSnapshot = await db
      .collection('barbers')
      .where('cedula', '==', cedula)
      .limit(1)
      .get();

    if (!barbersSnapshot.empty) {
      const doc = barbersSnapshot.docs[0];
      return {
        found: true,
        collection: 'barbers',
        id: doc.id,
        data: doc.data(),
      };
    }

    // Buscar en workers
    const workersSnapshot = await db
      .collection('workers')
      .where('cedula', '==', cedula)
      .limit(1)
      .get();

    if (!workersSnapshot.empty) {
      const doc = workersSnapshot.docs[0];
      return {
        found: true,
        collection: 'workers',
        id: doc.id,
        data: doc.data(),
      };
    }

    return { found: false };
  } catch (error) {
    console.error('❌ Error buscando usuario:', error);
    throw error;
  }
};

// ⭐ NUEVA FUNCIÓN: Validar autorización de ubicación y marca
const validateUserAuthorization = (userData) => {
  const authorizedLocations = userData.authorizedLocations || [];
  const brandIds = userData.brandIds || [];

  const hasLocationAccess = authorizedLocations.includes(DEVICE_CONFIG.location);
  const hasBrandAccess = brandIds.includes(DEVICE_CONFIG.brandId);

  console.log(`   🔍 Validando autorizaciones:`);
  console.log(`      Location del dispositivo: ${DEVICE_CONFIG.location}`);
  console.log(`      Locations autorizadas: [${authorizedLocations.join(', ')}]`);
  console.log(`      ✓ Location: ${hasLocationAccess ? '✅ AUTORIZADO' : '❌ NO AUTORIZADO'}`);
  console.log(``);
  console.log(`      Brand del dispositivo: ${DEVICE_CONFIG.brandId}`);
  console.log(`      Brands autorizadas: [${brandIds.join(', ')}]`);
  console.log(`      ✓ Brand: ${hasBrandAccess ? '✅ AUTORIZADO' : '❌ NO AUTORIZADO'}`);

  return {
    isAuthorized: hasLocationAccess && hasBrandAccess,
    hasLocationAccess,
    hasBrandAccess,
    authorizedLocations,
    brandIds,
  };
};

const saveAttendanceRecord = async (data) => {
  try {
    const db = getDb();
    const attendanceRef = db.collection('attendance');
    const docRef = await attendanceRef.add({
      ...data,
      createdAt: admin.firestore.FieldValue.serverTimestamp(),
    });

    console.log('✅ Registro guardado en Firestore:', docRef.id);
    return docRef.id;
  } catch (error) {
    console.error('❌ Error guardando registro:', error);
    throw error;
  }
};

// ============================================
// STREAM DE EVENTOS EN TIEMPO REAL
// ============================================

function getBoundary(contentType) {
  if (!contentType) return null;
  const m = /boundary="?([^";]+)"?/i.exec(contentType);
  if (m && m[1]) return m[1].replace(/^--/, '');
  return null;
}

async function connectToAlertStream(io) {
  console.log('\n🔌 Conectando al stream de eventos del DS-K1T321MFWX-B...');
  console.log(`   Dispositivo: ${DEVICE_CONFIG.ip}:${DEVICE_CONFIG.port}`);
  console.log(`   📍 Location: ${DEVICE_CONFIG.location}`);
  console.log(`   🏷️  Brand: ${DEVICE_CONFIG.brandId}\n`);

  // Resetear warmup
  isStreamWarmedUp = false;
  
  // Warmup de 15 segundos para que el dispositivo envíe eventos buffereados
  setTimeout(() => {
    isStreamWarmedUp = true;
    console.log('\n' + '✅'.repeat(30));
    console.log('✅ WARMUP COMPLETADO - Procesando eventos en tiempo real');
    console.log('✅'.repeat(30) + '\n');
  }, 15000); // 15 segundos

  const url = `${baseURL}/Event/notification/alertStream`;

  try {
    const response = await digestRequest('GET', url, {
      responseType: 'stream',
      timeout: 0,
      headers: {
        'Connection': 'keep-alive',
        'Accept': 'multipart/mixed',
      },
    });

    streamConnection = response;

    const contentType = response.headers['content-type'] || '';
    const boundary = getBoundary(contentType);

    if (!boundary) {
      console.error('❌ No se pudo determinar el boundary');
      attemptReconnect(io);
      return;
    }

    console.log('✅ Conectado al stream de eventos');
    console.log('📡 Escuchando eventos en tiempo real...\n');

    reconnectAttempts = 0;

    const dicer = new Dicer({ boundary });
    let currentEventData = {};

    dicer.on('part', (part) => {
      let partType = 'bin';
      let chunks = [];

      part.on('header', (hdrs) => {
        const type = (hdrs['content-type']?.[0] || '').toLowerCase();
        if (type.includes('xml')) partType = 'xml';
        else if (type.includes('jpeg') || type.includes('jpg')) partType = 'jpg';
        else if (type.includes('png')) partType = 'png';
      });

      part.on('data', (d) => chunks.push(d));

      part.on('end', async () => {
        const buf = Buffer.concat(chunks);
        
        if (partType === 'xml') {
          const xmlStr = buf.toString('utf8');
          currentEventData = await parseEvent(xmlStr);
        } else if (partType === 'jpg' || partType === 'png') {
          // Guardar imagen de evidencia
          if (currentEventData.cedula) {
            const filename = `${currentEventData.cedula}_${Date.now()}.${partType}`;
            const filepath = path.join(EVIDENCE_DIR, filename);
            fs.writeFileSync(filepath, buf);
            currentEventData.imageUrl = filepath;
            console.log(`📸 Imagen guardada: ${filename}`);
          }
        }

        // Si tenemos todos los datos, procesar el evento
        if (currentEventData.cedula && Object.keys(currentEventData).length > 2) {
          await processAttendanceEvent(currentEventData, io);
          currentEventData = {}; // Reset para el próximo evento
        }
      });
    });

    dicer.on('error', (err) => {
      console.error('❌ Error en parser:', err.message);
      attemptReconnect(io);
    });

    response.data.on('error', (err) => {
      console.error('❌ Error en stream:', err.message);
      attemptReconnect(io);
    });

    response.data.on('end', () => {
      console.log('⚠️  Stream cerrado');
      attemptReconnect(io);
    });

    response.data.pipe(dicer);

  } catch (error) {
    console.error('❌ Error conectando al stream:', error.message);
    attemptReconnect(io);
  }
}

async function parseEvent(xmlData) {
  try {
    const parser = new xml2js.Parser({ explicitArray: false });
    const result = await parser.parseStringPromise(xmlData);

    const event = result.EventNotificationAlert;
    if (!event) return {};

    const eventType = event.eventType || 'Unknown';
    const cedula = event.employeeNoString || event.employeeNo || event.cardNo;
    const method = event.attendanceStatus || event.currentVerifyMode || 'unknown';
    const timestamp = event.dateTime || new Date().toISOString();
    
    // Detectar si es entrada o salida
    const eventTypeDetail = event.eventDescription || event.name || '';
    const isEntry = eventTypeDetail.toLowerCase().includes('in') || 
                    eventTypeDetail.toLowerCase().includes('entrada') ||
                    event.inAndOutType === '1';
    const isExit = eventTypeDetail.toLowerCase().includes('out') || 
                   eventTypeDetail.toLowerCase().includes('salida') ||
                   event.inAndOutType === '0';

    console.log('─'.repeat(60));
    console.log(`📩 Evento: ${eventType}`);
    console.log(`   👤 Cédula: ${cedula}`);
    console.log(`   🔐 Método: ${method}`);
    console.log(`   🚪 Tipo: ${isEntry ? 'ENTRADA ➡️' : isExit ? 'SALIDA ⬅️' : 'CHECK-IN'}`);
    console.log(`   🕒 Hora: ${new Date(timestamp).toLocaleString('es-CO')}`);
    console.log('─'.repeat(60));

    return {
      cedula,
      method,
      timestamp,
      eventType: isEntry ? 'entry' : isExit ? 'exit' : 'check_in',
      rawEvent: event,
    };
  } catch (error) {
    console.error('❌ Error parseando XML:', error.message);
    return {};
  }
}

async function processAttendanceEvent(eventData, io) {
  try {
    const { cedula, method, timestamp, eventType, imageUrl, rawEvent } = eventData;

    if (!cedula) {
      console.warn('⚠️  Evento sin cédula - IGNORADO');
      return;
    }

    // ⭐ VALIDAR QUE LA CÉDULA SEA VÁLIDA
    const cedulaNumber = parseInt(cedula);
    if (isNaN(cedulaNumber) || cedulaNumber < 1000) {
      console.warn(`⚠️  Identificador inválido (${cedula}) - probablemente serialNo del dispositivo - IGNORADO\n`);
      return;
    }

    // ⭐ VALIDAR QUE EL MÉTODO NO SEA "invalid"
    if (method === 'invalid' || method === 'unknown') {
      console.warn(`⚠️  Método de verificación inválido (${method}) para cédula ${cedula} - IGNORADO\n`);
      return;
    }

    console.log(`\n🔍 Buscando usuario con cédula: ${cedula}`);

    // Buscar usuario en barbers y workers
    const user = await findUserByCedula(cedula);

    if (!user.found) {
      console.warn(`⚠️  Usuario con cédula ${cedula} NO ENCONTRADO en Firebase`);
      console.warn(`   Posibles causas:`);
      console.warn(`   - Usuario no sincronizado (ejecutar: POST /api/hikvision/sync-users)`);
      console.warn(`   - Cédula incorrecta en el dispositivo`);
      console.warn(`   - Usuario eliminado de Firebase pero sigue en el dispositivo`);
      console.warn(`\n   ⏭️  EVENTO IGNORADO - No se guarda en DB\n`);
      
      // Emitir alerta a administradores
      if (io) {
        io.emit('attendance:unknown_user', {
          cedula,
          timestamp: new Date(timestamp),
          method,
          message: `Usuario con cédula ${cedula} intentó marcar pero no está en el sistema`,
        });
      }

      return;
    }

    console.log(`✅ Usuario encontrado: ${user.data.fullName} (${user.collection})`);

    // ⭐ VALIDAR AUTORIZACIÓN DE UBICACIÓN Y MARCA
    const authorization = validateUserAuthorization(user.data);

    if (!authorization.isAuthorized) {
      console.warn(`\n❌ ACCESO NO AUTORIZADO`);
      console.warn(`   Usuario: ${user.data.fullName}`);
      console.warn(`   Cédula: ${cedula}`);
      console.warn(`   Razón: ${!authorization.hasLocationAccess ? 'Location no autorizada' : 'Brand no autorizada'}`);
      console.warn(`\n   ⏭️  EVENTO IGNORADO - No se guarda en DB\n`);

      // Emitir alerta de acceso no autorizado
      if (io) {
        io.emit('attendance:unauthorized_access', {
          cedula,
          fullName: user.data.fullName,
          timestamp: new Date(timestamp),
          location: DEVICE_CONFIG.location,
          brandId: DEVICE_CONFIG.brandId,
          authorizedLocations: authorization.authorizedLocations,
          authorizedBrands: authorization.brandIds,
          reason: !authorization.hasLocationAccess ? 'location_not_authorized' : 'brand_not_authorized',
        });
      }

      return;
    }

    console.log(`✅ Autorización validada correctamente`);

    // ⭐ DETERMINAR SI ES CHECK-IN O CHECK-OUT
    const eventTimestamp = new Date(timestamp);
    const determinedEventType = await determineEventType(user.id, eventTimestamp);

    console.log(`📊 Tipo de evento determinado: ${determinedEventType}`);

    // ⭐ PREPARAR DATOS COMPLETOS DEL REGISTRO
    const attendanceData = {
      // Datos del usuario
      userId: user.id,
      userCollection: user.collection,
      cedula: user.data.cedula,
      fullName: user.data.fullName,
      email: user.data.email || '',
      phoneNumber: user.data.phoneNumber || user.data.phone || '',
      role: user.data.role || '',
      userType: user.data.userType || '',
      userTypeName: user.data.userTypeName || user.data.role || '',
      
      // Sucursal
      branch: user.data.branch || user.data.companies || '',
      branchName: user.data.branchName || '',
      
      // ⭐ AGREGAR BRAND Y LOCATION
      brandId: DEVICE_CONFIG.brandId,
      location: DEVICE_CONFIG.location,
      
      // Evento
      timestamp: admin.firestore.Timestamp.fromDate(eventTimestamp),
      eventType: determinedEventType, // "check_in" o "check_out"
      verificationMethod: method || 'fingerPrint',
      
      // Dispositivo
      deviceId: DEVICE_CONFIG.ip,
      
      // Estado
      status: 'success',
      
      // Timestamp de creación
      createdAt: admin.firestore.FieldValue.serverTimestamp(),
    };

    console.log('\n💾 Guardando registro de asistencia...');
    console.log(`   Usuario: ${attendanceData.fullName}`);
    console.log(`   Cédula: ${attendanceData.cedula}`);
    console.log(`   Tipo: ${attendanceData.eventType} ${attendanceData.eventType === 'check_in' ? '➡️ ENTRADA' : '⬅️ SALIDA'}`);
    console.log(`   Hora: ${eventTimestamp.toLocaleString('es-CO', { timeZone: 'America/Bogota' })}`);
    console.log(`   Método: ${attendanceData.verificationMethod}`);
    console.log(`   📍 Location: ${attendanceData.location}`);
    console.log(`   🏷️  Brand: ${attendanceData.brandId}`);

    // Guardar en Firestore
    const recordId = await saveAttendanceRecord(attendanceData);

    console.log(`✅ Registro guardado - ID: ${recordId}`);

    // Emitir via Socket.IO para actualización en tiempo real
    if (io) {
      io.emit('attendance:new_record', {
        id: recordId,
        ...attendanceData,
        timestamp: eventTimestamp,
      });
      
      console.log('📡 Evento emitido via Socket.IO');
    }

    console.log('─'.repeat(60) + '\n');

    return recordId;

  } catch (error) {
    console.error('❌ Error procesando evento:', error);
    // No lanzar error para no romper el flujo
  }
}


function attemptReconnect(io) {
  if (reconnectAttempts >= MAX_RECONNECT_ATTEMPTS) {
    console.error(`❌ Máximo de intentos alcanzado. Reinicia el servidor.`);
    return;
  }
  reconnectAttempts++;
  const delay = Math.min(5000 * reconnectAttempts, 30000);

  console.log(`\n⏳ Reintentando en ${delay / 1000}s... (${reconnectAttempts}/${MAX_RECONNECT_ATTEMPTS})\n`);
  setTimeout(() => connectToAlertStream(io), delay);
}

async function determineEventType(userId, eventTimestamp) {
  try {
    const db = getDb();
    
    const eventDate = new Date(eventTimestamp);
    
    const startOfDay = new Date(eventDate);
    startOfDay.setHours(0, 0, 0, 0);
    
    const endOfDay = new Date(eventDate);
    endOfDay.setHours(23, 59, 59, 999);

    console.log(`   🔍 Buscando registros del día para userId: ${userId}`);
    console.log(`   📅 Rango: ${startOfDay.toLocaleString('es-CO')} - ${endOfDay.toLocaleString('es-CO')}`);

    const lastRecordSnapshot = await db
      .collection('attendance')
      .where('userId', '==', userId)
      .where('timestamp', '>=', admin.firestore.Timestamp.fromDate(startOfDay))
      .where('timestamp', '<=', admin.firestore.Timestamp.fromDate(endOfDay))
      .orderBy('timestamp', 'desc')
      .limit(1)
      .get();

    if (lastRecordSnapshot.empty) {
      console.log('   ➡️  Primer registro del día → CHECK-IN');
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

  } catch (error) {
    console.error('❌ Error determinando tipo de evento:', error.message);
    
    if (error.message.includes('index')) {
      console.log('\n' + '⚠️ '.repeat(30));
      console.log('⚠️  ÍNDICE DE FIRESTORE REQUERIDO');
      console.log('⚠️ '.repeat(30));
      console.log('\n📝 Para crear el índice compuesto:');
      console.log('   1. Abre este link en tu navegador:');
      console.log(`   ${error.details || 'Ver en los logs el link'}`);
      console.log('\n   2. Click en "CREATE INDEX"');
      console.log('   3. Espera 2-5 minutos a que se cree');
      console.log('   4. Reinicia el servidor\n');
      console.log('⚠️ '.repeat(30) + '\n');
    }
    
    console.log('   ⚠️  Error al consultar - Usando check_in por defecto');
    return 'check_in';
  }
}


async function getTodayAttendanceForUser(userId) {
  try {
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
      records.push({
        id: doc.id,
        ...doc.data(),
        timestamp: doc.data().timestamp.toDate(),
      });
    });

    return records;

  } catch (error) {
    console.error('Error obteniendo registros del día:', error);
    return [];
  }
}

// ============================================
// VERIFICAR ESTADO DEL DISPOSITIVO
// ============================================

async function checkDeviceStatus() {
  try {
    const response = await digestRequest('GET', `${baseURL}/System/deviceInfo`, {
      timeout: 5000,
    });

    return {
      success: true,
      connected: true,
      deviceInfo: response.data,
      brandId: DEVICE_CONFIG.brandId,
      location: DEVICE_CONFIG.location,
    };
  } catch (error) {
    console.error('Error conectando:', error.message);
    
    try {
      const simpleTest = await axios.get(`http://${DEVICE_CONFIG.ip}:${DEVICE_CONFIG.port}`, {
        timeout: 3000,
        validateStatus: () => true,
      });
      
      if (simpleTest.status === 401 || simpleTest.status === 404) {
        return {
          success: true,
          connected: true,
          deviceInfo: { note: 'Dispositivo respondiendo' },
          brandId: DEVICE_CONFIG.brandId,
          location: DEVICE_CONFIG.location,
        };
      }
      
      return {
        success: true,
        connected: true,
        deviceInfo: { note: 'Dispositivo alcanzable' },
        brandId: DEVICE_CONFIG.brandId,
        location: DEVICE_CONFIG.location,
      };
    } catch (fallbackError) {
      return {
        success: false,
        connected: false,
        error: `No se puede alcanzar: ${error.message}`,
      };
    }
  }
}

// ============================================
// GESTIÓN DE USUARIOS EN EL DISPOSITIVO
// ============================================

async function registerUserInDevice(cedula, fullName) {
  try {
    const userJSON = {
      UserInfo: {
        employeeNo: cedula,
        name: fullName,
        userType: "normal",
        Valid: {
          enable: true,
          beginTime: "2025-01-01T00:00:00",
          endTime: "2035-12-31T23:59:59"
        },
        doorRight: "1"
      }
    };

    const response = await digestRequest('POST', `${baseURL}/AccessControl/UserInfo/Record?format=json`, {
      data: userJSON,
      headers: {
        'Content-Type': 'application/json',
      },
    });

    console.log(`✅ Usuario ${fullName} registrado`);
    return { success: true, data: response.data };
  } catch (error) {
    console.error(`❌ Error registrando usuario:`, error.message);
    return { success: false, error: error.message };
  }
}

async function syncUsersToDevice() {
  try {
    const db = getDb();
    console.log('\n' + '='.repeat(60));
    console.log('🔄 INICIANDO SINCRONIZACIÓN DE USUARIOS');
    console.log('='.repeat(60));
    console.log(`📍 Location del dispositivo: ${DEVICE_CONFIG.location}`);
    console.log(`🏷️  Brand del dispositivo: ${DEVICE_CONFIG.brandId}\n`);

    const results = { 
      success: [], 
      errors: [],
      skipped: [] 
    };

    // ============================================
    // SINCRONIZAR BARBERS
    // ============================================
    console.log('👨‍💼 Sincronizando BARBERS...\n');
    
    const barbersSnapshot = await db.collection('barbers')
      .where('active', '==', true)
      .get();
    
    console.log(`   📊 Total barbers activos encontrados: ${barbersSnapshot.size}`);

    for (const doc of barbersSnapshot.docs) {
      const barber = doc.data();
      const barberId = doc.id;
      
      // Validar datos requeridos
      if (!barber.cedula || !barber.fullName) {
        console.log(`   ⚠️  Barbero sin cédula o nombre: ${barberId}`);
        results.skipped.push({
          id: barberId,
          collection: 'barbers',
          name: barber.fullName || 'Sin nombre',
          reason: 'Falta cédula o nombre'
        });
        continue;
      }

      // ⭐ VALIDAR AUTORIZACIÓN
      const authorization = validateUserAuthorization(barber);
      if (!authorization.isAuthorized) {
        console.log(`   ⏭️  ${barber.fullName} - NO autorizado para este dispositivo`);
        results.skipped.push({
          id: barberId,
          cedula: barber.cedula,
          name: barber.fullName,
          collection: 'barbers',
          reason: !authorization.hasLocationAccess ? 'Location no autorizada' : 'Brand no autorizada'
        });
        continue;
      }

      console.log(`   🔄 Registrando: ${barber.fullName} (${barber.cedula})`);
      
      const result = await registerUserInDevice(barber.cedula, barber.fullName);
      
      if (result.success) {
        results.success.push({
          id: barberId,
          cedula: barber.cedula,
          name: barber.fullName,
          collection: 'barbers',
        });
        console.log(`   ✅ ${barber.fullName} registrado correctamente`);
      } else {
        results.errors.push({
          id: barberId,
          cedula: barber.cedula,
          name: barber.fullName,
          collection: 'barbers',
          error: result.error
        });
        console.log(`   ❌ Error: ${result.error}`);
      }
    }

    console.log('\n' + '-'.repeat(60) + '\n');

    // ============================================
    // SINCRONIZAR WORKERS
    // ============================================
    console.log('👷 Sincronizando WORKERS...\n');
    
    const workersSnapshot = await db.collection('workers')
      .where('active', '==', true)
      .get();
    
    console.log(`   📊 Total workers activos encontrados: ${workersSnapshot.size}`);

    for (const doc of workersSnapshot.docs) {
      const worker = doc.data();
      const workerId = doc.id;
      
      // Validar datos requeridos
      if (!worker.cedula || !worker.fullName) {
        console.log(`   ⚠️  Worker sin cédula o nombre: ${workerId}`);
        results.skipped.push({
          id: workerId,
          collection: 'workers',
          name: worker.fullName || 'Sin nombre',
          reason: 'Falta cédula o nombre'
        });
        continue;
      }

      // ⭐ VALIDAR AUTORIZACIÓN
      const authorization = validateUserAuthorization(worker);
      if (!authorization.isAuthorized) {
        console.log(`   ⏭️  ${worker.fullName} - NO autorizado para este dispositivo`);
        results.skipped.push({
          id: workerId,
          cedula: worker.cedula,
          name: worker.fullName,
          collection: 'workers',
          reason: !authorization.hasLocationAccess ? 'Location no autorizada' : 'Brand no autorizada'
        });
        continue;
      }

      console.log(`   🔄 Registrando: ${worker.fullName} (${worker.cedula})`);
      
      const result = await registerUserInDevice(worker.cedula, worker.fullName);
      
      if (result.success) {
        results.success.push({
          id: workerId,
          cedula: worker.cedula,
          name: worker.fullName,
          collection: 'workers',
        });
        console.log(`   ✅ ${worker.fullName} registrado correctamente`);
      } else {
        results.errors.push({
          id: workerId,
          cedula: worker.cedula,
          name: worker.fullName,
          collection: 'workers',
          error: result.error
        });
        console.log(`   ❌ Error: ${result.error}`);
      }
    }

    // ============================================
    // RESUMEN
    // ============================================
    console.log('\n' + '='.repeat(60));
    console.log('📊 RESUMEN DE SINCRONIZACIÓN');
    console.log('='.repeat(60));
    console.log(`✅ Éxitos:   ${results.success.length}`);
    console.log(`❌ Errores:  ${results.errors.length}`);
    console.log(`⏭️  Omitidos: ${results.skipped.length}`);
    console.log('='.repeat(60) + '\n');

    if (results.success.length > 0) {
      console.log('✅ USUARIOS SINCRONIZADOS:');
      results.success.forEach((user, index) => {
        console.log(`   ${index + 1}. ${user.name} (${user.cedula}) - ${user.collection}`);
      });
      console.log('');
    }

    if (results.errors.length > 0) {
      console.log('❌ ERRORES:');
      results.errors.forEach((user, index) => {
        console.log(`   ${index + 1}. ${user.name} (${user.cedula}): ${user.error}`);
      });
      console.log('');
    }

    if (results.skipped.length > 0) {
      console.log('⏭️  OMITIDOS:');
      results.skipped.forEach((user, index) => {
        console.log(`   ${index + 1}. ${user.name} (${user.collection}): ${user.reason}`);
      });
      console.log('');
    }

    console.log('⚠️  SIGUIENTE PASO:');
    console.log('   Registrar las huellas dactilares de cada usuario en el dispositivo');
    console.log(`   Interfaz web: http://${DEVICE_CONFIG.ip}`);
    console.log(`   Usuario: admin / Contraseña: ${DEVICE_CONFIG.password}\n`);

    return results;
  } catch (error) {
    console.error('❌ Error en sincronización:', error);
    throw error;
  }
}

// ============================================
// OBTENER REGISTROS
// ============================================

async function getAttendanceRecords(filters = {}) {
  try {
    const db = getDb();
    let query = db.collection('attendance').orderBy('timestamp', 'desc');

    if (filters.cedula) query = query.where('cedula', '==', filters.cedula);
    if (filters.collection) query = query.where('userCollection', '==', filters.collection);
    if (filters.eventType) query = query.where('eventType', '==', filters.eventType);
    if (filters.brandId) query = query.where('brandId', '==', filters.brandId);
    if (filters.location) query = query.where('location', '==', filters.location);
    if (filters.startDate) query = query.where('timestamp', '>=', new Date(filters.startDate));
    if (filters.endDate) query = query.where('timestamp', '<=', new Date(filters.endDate));

    const snapshot = await query.limit(filters.limit || 100).get();

    const records = [];
    snapshot.forEach((doc) => {
      records.push({
        id: doc.id,
        ...doc.data(),
        timestamp: doc.data().timestamp?.toDate(),
      });
    });

    return { success: true, count: records.length, records };
  } catch (error) {
    console.error('❌ Error obteniendo registros:', error);
    throw error;
  }
}

module.exports = {
  connectToAlertStream,
  checkDeviceStatus,
  registerUserInDevice,
  syncUsersToDevice,
  getAttendanceRecords,
  processAttendanceEvent,
  getTodayAttendanceForUser,
};