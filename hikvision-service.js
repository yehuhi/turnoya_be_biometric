// hikvision-service.js
const axios = require('axios');
const admin = require('firebase-admin');
const xml2js = require('xml2js');

// ⭐ NO obtener db aquí, se obtendrá cuando se use
// const db = admin.firestore(); ❌

// Función helper para obtener db
const getDb = () => {
  return admin.firestore();
};

// ============================================
// CONFIGURACIÓN DEL DISPOSITIVO HIKVISION
// ============================================
const DEVICE_CONFIG = {
  ip: '192.168.1.64',
  port: 80,  // ⬅️ CAMBIADO A 80 (puerto HTTP estándar)
  username: 'admin',
  password: 'A1047338633', // ⬅️ CAMBIA ESTO
};

const baseURL = `http://${DEVICE_CONFIG.ip}:${DEVICE_CONFIG.port}/ISAPI`;
const auth = {
  username: DEVICE_CONFIG.username,
  password: DEVICE_CONFIG.password,
};

// ============================================
// FUNCIONES AUXILIARES
// ============================================

/**
 * Buscar usuario en Firestore por cédula
 * Busca primero en 'barbers', luego en 'workers'
 */
const findUserByCedula = async (cedula) => {
  try {
    const db = getDb(); // ⭐ Obtener db aquí
    
    // Buscar en colección BARBERS
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

    // Buscar en colección WORKERS
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
    console.error('❌ Error buscando usuario por cédula:', error);
    throw error;
  }
};

/**
 * Guardar registro de asistencia en Firestore
 */
const saveAttendanceRecord = async (data) => {
  try {
    const db = getDb(); // ⭐ Obtener db aquí
    const attendanceRef = db.collection('attendance');
    const docRef = await attendanceRef.add({
      ...data,
      createdAt: admin.firestore.FieldValue.serverTimestamp(),
    });

    console.log('✅ Registro de asistencia guardado en Firestore:', docRef.id);
    return docRef.id;
  } catch (error) {
    console.error('❌ Error guardando registro de asistencia:', error);
    throw error;
  }
};

// ============================================
// FUNCIONES PRINCIPALES
// ============================================

/**
 * Verificar conexión con el dispositivo Hikvision
 */
const checkDeviceStatus = async () => {
  try {
    // Intentar con diferentes endpoints y configuraciones
    const response = await axios({
      method: 'GET',
      url: `${baseURL}/System/deviceInfo`,
      auth,
      timeout: 10000,
      headers: {
        'User-Agent': 'axios',
        'Accept': '*/*',
      },
      // Desactivar validación estricta de HTTP
      httpAgent: new (require('http').Agent)({ keepAlive: true }),
      validateStatus: (status) => status < 500, // Aceptar cualquier status < 500
    });

    return {
      success: true,
      connected: true,
      deviceInfo: response.data,
    };
  } catch (error) {
    console.error('❌ Error conectando con Hikvision:', error.message);
    
    // Intentar método alternativo - solo verificar si el puerto responde
    try {
      const simpleTest = await axios.get(`http://${DEVICE_CONFIG.ip}:${DEVICE_CONFIG.port}`, {
        timeout: 3000,
        validateStatus: () => true,
      });
      
      // Si responde algo (incluso error), el dispositivo está vivo
      return {
        success: true,
        connected: true,
        deviceInfo: { note: 'Dispositivo respondiendo, API puede requerir configuración adicional' },
      };
    } catch (fallbackError) {
      return {
        success: false,
        connected: false,
        error: error.message,
      };
    }
  }
};

/**
 * Obtener registros de eventos del dispositivo (polling)
 * Esta función se puede llamar periódicamente si no usas webhook
 */
const getFingerprintData = async (startTime) => {
  try {
    const searchTime = startTime || new Date().toISOString().split('.')[0];

    const searchXML = `<?xml version="1.0" encoding="UTF-8"?>
      <AfterTime>
        <picEnable>false</picEnable>
        <afterTime>${searchTime}</afterTime>
      </AfterTime>`;

    const response = await axios.post(
      `${baseURL}/AccessControl/AcsEvent?format=json`,
      searchXML,
      {
        auth,
        headers: {
          'Content-Type': 'application/xml',
        },
        timeout: 10000,
      }
    );

    return {
      success: true,
      data: response.data,
    };
  } catch (error) {
    console.error('❌ Error obteniendo datos de Hikvision:', error.message);
    return {
      success: false,
      error: error.message,
    };
  }
};

/**
 * Procesar evento de huella del dispositivo
 * Esta función se llama desde el webhook o desde polling
 */
const processAttendanceEvent = async (eventData, io) => {
  try {
    console.log('📩 Procesando evento de asistencia...');

    const cedula = eventData.employeeNoString || eventData.employeeNo;
    const timestamp = eventData.dateTime || eventData.time;
    const verificationMethod = eventData.attendanceStatus || 'fingerPrint';

    console.log(`👤 Huella detectada - Cédula: ${cedula}`);

    // Buscar usuario en Firestore
    const user = await findUserByCedula(cedula);

    if (!user.found) {
      console.warn(`⚠️  Usuario con cédula ${cedula} no encontrado en Firestore`);

      // Guardar evento sin usuario asociado
      await saveAttendanceRecord({
        cedula,
        timestamp: new Date(timestamp),
        verificationMethod,
        status: 'user_not_found',
        deviceId: DEVICE_CONFIG.ip,
        rawEvent: eventData,
      });

      // Emitir alerta a administradores
      if (io) {
        io.emit('attendance:unknown_user', {
          cedula,
          timestamp: new Date(timestamp),
          message: `Usuario con cédula ${cedula} no registrado`,
        });
      }

      return {
        success: false,
        error: 'Usuario no encontrado',
        cedula,
      };
    }

    console.log(`✅ Usuario encontrado: ${user.data.fullName} (${user.collection})`);

    // Preparar datos para guardar
    const attendanceData = {
      // Datos del usuario
      userId: user.id,
      userCollection: user.collection,
      cedula: user.data.cedula,
      fullName: user.data.fullName,
      email: user.data.email || '',
      phoneNumber: user.data.phoneNumber || user.data.phone || '',
      role: user.data.role,
      userType: user.data.userType,
      userTypeName: user.data.userTypeName,

      // Datos de la sucursal
      branchName: user.data.branchName || '',
      branch: user.data.branch || user.data.companies || '',

      // Datos del evento
      timestamp: new Date(timestamp),
      verificationMethod, // fingerPrint, face, card
      deviceId: DEVICE_CONFIG.ip,
      eventType: 'check_in',

      // Metadata
      status: 'success',
    };

    // Guardar en Firestore
    const recordId = await saveAttendanceRecord(attendanceData);

    // Emitir evento via Socket.IO a los administradores
    if (io) {
      io.emit('attendance:new_record', {
        id: recordId,
        ...attendanceData,
      });

      console.log('📡 Evento emitido via Socket.IO');
    }

    console.log(`💾 Registro procesado exitosamente - ID: ${recordId}`);

    return {
      success: true,
      recordId,
      user: {
        fullName: user.data.fullName,
        role: user.data.role,
        branch: user.data.branchName,
      },
    };
  } catch (error) {
    console.error('❌ Error procesando evento de asistencia:', error);
    throw error;
  }
};

/**
 * Registrar usuario en el dispositivo Hikvision
 */
const registerUserInDevice = async (cedula, fullName) => {
  try {
    const userXML = `<?xml version="1.0" encoding="UTF-8"?>
      <UserInfo>
        <employeeNo>${cedula}</employeeNo>
        <name>${fullName}</name>
        <userType>normal</userType>
        <Valid>
          <enable>true</enable>
          <beginTime>2025-01-01T00:00:00</beginTime>
          <endTime>2035-12-31T23:59:59</endTime>
        </Valid>
        <doorRight>1</doorRight>
        <RightPlan>
          <doorNo>1</doorNo>
          <planTemplateNo>1</planTemplateNo>
        </RightPlan>
      </UserInfo>`;

    const response = await axios.post(
      `${baseURL}/AccessControl/UserInfo/Record?format=json`,
      userXML,
      {
        auth,
        headers: {
          'Content-Type': 'application/xml',
        },
        timeout: 10000,
      }
    );

    console.log(`✅ Usuario ${fullName} registrado en dispositivo Hikvision`);

    return {
      success: true,
      data: response.data,
    };
  } catch (error) {
    console.error('❌ Error registrando usuario en dispositivo:', error.message);
    return {
      success: false,
      error: error.message,
    };
  }
};

/**
 * Sincronizar todos los usuarios de Firestore al dispositivo
 */
const syncUsersToDevice = async () => {
  try {
    const db = getDb(); // ⭐ Obtener db aquí
    console.log('🔄 Iniciando sincronización de usuarios...');

    const results = {
      success: [],
      errors: [],
    };

    // Sincronizar BARBERS
    const barbersSnapshot = await db.collection('barbers').get();

    for (const doc of barbersSnapshot.docs) {
      const barber = doc.data();

      try {
        await registerUserInDevice(barber.cedula, barber.fullName);
        results.success.push({
          cedula: barber.cedula,
          name: barber.fullName,
          collection: 'barbers',
        });
      } catch (error) {
        results.errors.push({
          cedula: barber.cedula,
          name: barber.fullName,
          error: error.message,
        });
      }
    }

    // Sincronizar WORKERS
    const workersSnapshot = await db.collection('workers').get();

    for (const doc of workersSnapshot.docs) {
      const worker = doc.data();

      try {
        await registerUserInDevice(worker.cedula, worker.fullName);
        results.success.push({
          cedula: worker.cedula,
          name: worker.fullName,
          collection: 'workers',
        });
      } catch (error) {
        results.errors.push({
          cedula: worker.cedula,
          name: worker.fullName,
          error: error.message,
        });
      }
    }

    console.log(`✅ Sincronización completada: ${results.success.length} éxitos, ${results.errors.length} errores`);

    return results;
  } catch (error) {
    console.error('❌ Error en sincronización:', error);
    throw error;
  }
};

/**
 * Obtener registros de asistencia desde Firestore
 */
const getAttendanceRecords = async (filters = {}) => {
  try {
    const db = getDb(); // ⭐ Obtener db aquí
    let query = db.collection('attendance').orderBy('timestamp', 'desc');

    // Aplicar filtros
    if (filters.cedula) {
      query = query.where('cedula', '==', filters.cedula);
    }

    if (filters.collection) {
      query = query.where('userCollection', '==', filters.collection);
    }

    if (filters.startDate) {
      query = query.where('timestamp', '>=', new Date(filters.startDate));
    }

    if (filters.endDate) {
      query = query.where('timestamp', '<=', new Date(filters.endDate));
    }

    const snapshot = await query.limit(filters.limit || 100).get();

    const records = [];
    snapshot.forEach((doc) => {
      records.push({
        id: doc.id,
        ...doc.data(),
        timestamp: doc.data().timestamp?.toDate(),
      });
    });

    return {
      success: true,
      count: records.length,
      records,
    };
  } catch (error) {
    console.error('❌ Error obteniendo registros:', error);
    throw error;
  }
};

module.exports = {
  checkDeviceStatus,
  getFingerprintData,
  processAttendanceEvent,
  registerUserInDevice,
  syncUsersToDevice,
  getAttendanceRecords,
  findUserByCedula,
};