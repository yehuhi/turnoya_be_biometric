#!/usr/bin/env node

// ============================================
// CAMBIAR ZONA HORARIA DEL DISPOSITIVO HIKVISION
// De GMT+8 (China) a GMT-5 (Colombia)
// ============================================

const axios = require('axios');
const crypto = require('crypto');
const xml2js = require('xml2js');

const CONFIG = {
  deviceIp: '192.168.1.10',
  devicePort: 80,
  username: 'admin',
  password: '1047338633ABC',
};

const baseURL = `http://${CONFIG.deviceIp}:${CONFIG.devicePort}/ISAPI`;

// ============================================
// DIGEST AUTH
// ============================================

async function digestAuth(method, url, data = null, contentType = 'application/xml') {
  try {
    const firstResponse = await axios({
      method,
      url,
      data,
      headers: contentType ? { 'Content-Type': contentType } : {},
      validateStatus: (status) => status === 401 || (status >= 200 && status < 300),
    });

    if (firstResponse.status !== 401) {
      return firstResponse;
    }

    const authHeader = firstResponse.headers['www-authenticate'];
    const realm = /realm="([^"]+)"/.exec(authHeader)?.[1] || '';
    const nonce = /nonce="([^"]+)"/.exec(authHeader)?.[1] || '';
    const qop = /qop="([^"]+)"/.exec(authHeader)?.[1] || 'auth';

    const ha1 = crypto.createHash('md5')
      .update(`${CONFIG.username}:${realm}:${CONFIG.password}`)
      .digest('hex');
    
    const ha2 = crypto.createHash('md5')
      .update(`${method.toUpperCase()}:${new URL(url).pathname}`)
      .digest('hex');
    
    const nc = '00000001';
    const cnonce = crypto.randomBytes(8).toString('hex');
    const response = crypto.createHash('md5')
      .update(`${ha1}:${nonce}:${nc}:${cnonce}:${qop}:${ha2}`)
      .digest('hex');

    return await axios({
      method,
      url,
      data,
      headers: {
        'Content-Type': contentType,
        'Authorization': `Digest username="${CONFIG.username}", realm="${realm}", nonce="${nonce}", uri="${new URL(url).pathname}", qop=${qop}, nc=${nc}, cnonce="${cnonce}", response="${response}"`
      },
    });
  } catch (error) {
    throw error;
  }
}

// ============================================
// FUNCIONES
// ============================================

async function getCurrentTime() {
  console.log('\n📅 Obteniendo configuración de tiempo actual...\n');
  
  try {
    const response = await digestAuth('GET', `${baseURL}/System/time`);
    
    const parser = new xml2js.Parser({ explicitArray: false });
    const result = await parser.parseStringPromise(response.data);
    
    console.log('⏰ Configuración actual:');
    console.log(JSON.stringify(result, null, 2));
    
    return result;
  } catch (error) {
    console.error('❌ Error:', error.message);
    if (error.response) {
      console.error('Respuesta:', error.response.data);
    }
  }
}

async function setTimeZoneColombia() {
  console.log('\n🔧 Cambiando zona horaria a Colombia (GMT-5)...\n');
  
  // XML para configurar la zona horaria de Colombia
  const timeXML = `<?xml version="1.0" encoding="UTF-8"?>
<Time version="2.0" xmlns="http://www.hikvision.com/ver20/XMLSchema">
  <timeMode>NTP</timeMode>
  <localTime>2025-10-30T12:00:00</localTime>
  <timeZone>CST+5:00:00</timeZone>
</Time>`;

  try {
    const response = await digestAuth('PUT', `${baseURL}/System/time`, timeXML, 'application/xml');
    
    console.log('✅ Zona horaria actualizada correctamente');
    console.log('📋 Respuesta:', response.data);
    
    return true;
  } catch (error) {
    console.error('❌ Error:', error.message);
    if (error.response) {
      console.error('Respuesta:', error.response.data);
    }
    return false;
  }
}

async function setNTPServer() {
  console.log('\n🌐 Configurando servidor NTP...\n');
  
  // Usar servidor NTP de Colombia
  const ntpXML = `<?xml version="1.0" encoding="UTF-8"?>
<NTPServer version="2.0" xmlns="http://www.hikvision.com/ver20/XMLSchema">
  <id>1</id>
  <addressingFormatType>ipaddress</addressingFormatType>
  <ipAddress>time.nist.gov</ipAddress>
  <portNo>123</portNo>
  <synchronizeInterval>60</synchronizeInterval>
</NTPServer>`;

  try {
    const response = await digestAuth('PUT', `${baseURL}/System/time/ntpServers/1`, ntpXML, 'application/xml');
    
    console.log('✅ Servidor NTP configurado');
    console.log('📋 Respuesta:', response.data);
    
    return true;
  } catch (error) {
    console.error('❌ Error:', error.message);
    if (error.response) {
      console.error('Respuesta:', error.response.data);
    }
    return false;
  }
}

async function syncTimeNow() {
  console.log('\n⏰ Sincronizando tiempo con NTP...\n');
  
  try {
    const response = await digestAuth('PUT', `${baseURL}/System/time/ntpServers/1/sync`, '', 'application/xml');
    
    console.log('✅ Tiempo sincronizado');
    return true;
  } catch (error) {
    console.error('❌ Error:', error.message);
    return false;
  }
}

// ============================================
// MENÚ
// ============================================

async function showMenu() {
  console.log('\n' + '='.repeat(60));
  console.log('🌍 CONFIGURACIÓN DE ZONA HORARIA - HIKVISION');
  console.log('='.repeat(60));
  console.log('\n1. Ver configuración de tiempo actual');
  console.log('2. Cambiar zona horaria a Colombia (GMT-5)');
  console.log('3. Configurar servidor NTP');
  console.log('4. Sincronizar con NTP ahora');
  console.log('5. Hacer todo (Recomendado)');
  console.log('0. Salir\n');
}

async function doAll() {
  console.log('\n🚀 Ejecutando configuración completa...\n');
  
  await getCurrentTime();
  await new Promise(r => setTimeout(r, 2000));
  
  await setTimeZoneColombia();
  await new Promise(r => setTimeout(r, 2000));
  
  await setNTPServer();
  await new Promise(r => setTimeout(r, 2000));
  
  await syncTimeNow();
  await new Promise(r => setTimeout(r, 2000));
  
  console.log('\n' + '='.repeat(60));
  console.log('✅ CONFIGURACIÓN COMPLETADA');
  console.log('='.repeat(60));
  console.log('\n📝 Resumen:');
  console.log('   - Zona horaria: Colombia (GMT-5)');
  console.log('   - Servidor NTP: time.nist.gov');
  console.log('   - Sincronización: Cada 60 minutos');
  console.log('\n⚠️  Reinicia el stream de eventos en tu servidor');
  console.log('   para que tome la nueva zona horaria\n');
}

async function main() {
  const readline = require('readline').createInterface({
    input: process.stdin,
    output: process.stdout
  });

  const askQuestion = (query) => new Promise(resolve => readline.question(query, resolve));

  while (true) {
    await showMenu();
    const choice = await askQuestion('Opción: ');

    switch (choice.trim()) {
      case '1':
        await getCurrentTime();
        break;
      case '2':
        await setTimeZoneColombia();
        break;
      case '3':
        await setNTPServer();
        break;
      case '4':
        await syncTimeNow();
        break;
      case '5':
        await doAll();
        break;
      case '0':
        console.log('\n👋 ¡Hasta luego!');
        readline.close();
        process.exit(0);
      default:
        console.log('❌ Opción inválida');
    }

    await askQuestion('\nPresiona Enter para continuar...');
  }
}

// ============================================
// EJECUTAR
// ============================================

if (require.main === module) {
  main().catch(console.error);
}

module.exports = {
  getCurrentTime,
  setTimeZoneColombia,
  setNTPServer,
  syncTimeNow,
};