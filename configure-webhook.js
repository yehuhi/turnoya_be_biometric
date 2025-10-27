// configure-webhook.js
// Script para configurar automáticamente el webhook en el dispositivo Hikvision

const axios = require('axios');
const readline = require('readline');

const rl = readline.createInterface({
  input: process.stdin,
  output: process.stdout,
});

// Colores para consola
const colors = {
  reset: '\x1b[0m',
  green: '\x1b[32m',
  red: '\x1b[31m',
  yellow: '\x1b[33m',
  blue: '\x1b[34m',
  cyan: '\x1b[36m',
};

function log(msg, color = 'reset') {
  console.log(`${colors[color]}${msg}${colors.reset}`);
}

function question(prompt) {
  return new Promise((resolve) => {
    rl.question(prompt, resolve);
  });
}

async function configureWebhook() {
  console.log('\n' + '='.repeat(60));
  log('🔧 CONFIGURACIÓN DE WEBHOOK HIKVISION', 'cyan');
  console.log('='.repeat(60) + '\n');

  // Datos del dispositivo (ya los conocemos)
  const deviceIp = '192.168.1.64';
  const devicePort = '80';
  const username = 'admin';
  
  log('📋 Configuración del dispositivo:', 'blue');
  console.log(`   IP: ${deviceIp}`);
  console.log(`   Puerto: ${devicePort}`);
  console.log(`   Usuario: ${username}\n`);
  
  const password = await question('Ingresa la contraseña del dispositivo: ');
  
  if (!password) {
    log('❌ La contraseña es requerida', 'red');
    rl.close();
    return;
  }
  
  console.log('');
  log('📌 ¿Dónde está corriendo tu servidor Node.js?', 'yellow');
  console.log('');
  log('   1. En ESTA computadora (localhost/127.0.0.1)', 'yellow');
  log('   2. En otra computadora en la misma red', 'yellow');
  log('   3. En un servidor en la nube (con dominio público)', 'yellow');
  
  const option = await question('\nSelecciona una opción [1/2/3]: ') || '1';
  
  let webhookUrl;
  
  if (option === '1') {
    // Obtener IP local de la computadora
    const os = require('os');
    const interfaces = os.networkInterfaces();
    let localIp = '192.168.1.12'; // Default fallback
    
    // Buscar IP de WiFi o Ethernet
    for (const name of Object.keys(interfaces)) {
      for (const iface of interfaces[name]) {
        if (iface.family === 'IPv4' && !iface.internal) {
          localIp = iface.address;
          break;
        }
      }
    }
    
    console.log('');
    log(`💡 Tu IP local detectada: ${localIp}`, 'cyan');
    const customIp = await question(`   ¿Es correcta? Si no, ingresa la IP correcta [${localIp}]: `);
    const serverIp = customIp || localIp;
    
    const serverPort = await question('   Puerto del servidor [5000]: ') || '5000';
    webhookUrl = `http://${serverIp}:${serverPort}/api/hikvision/webhook`;
    
  } else if (option === '2') {
    const serverIp = await question('Ingresa la IP de la computadora donde corre el servidor: ');
    const serverPort = await question('Puerto del servidor [5000]: ') || '5000';
    webhookUrl = `http://${serverIp}:${serverPort}/api/hikvision/webhook`;
    
  } else {
    webhookUrl = await question('Ingresa la URL completa del webhook (ej: https://midominio.com/api/hikvision/webhook): ');
  }
  
  console.log('\n' + '-'.repeat(60));
  log('📋 RESUMEN DE CONFIGURACIÓN:', 'blue');
  console.log(`   Dispositivo: ${deviceIp}:${devicePort}`);
  console.log(`   Usuario: ${username}`);
  console.log(`   Webhook URL: ${webhookUrl}`);
  console.log('-'.repeat(60) + '\n');
  
  const confirm = await question('¿Proceder con la configuración? [S/n]: ') || 's';
  
  if (confirm.toLowerCase() !== 's') {
    log('❌ Configuración cancelada', 'yellow');
    rl.close();
    return;
  }
  
  // Configurar webhook
  log('\n🔄 Configurando webhook en el dispositivo...', 'cyan');
  
  try {
    // Paso 1: Verificar conexión
    log('   1/4 Verificando conexión con el dispositivo...', 'yellow');
    
    const testResponse = await axios.get(
      `http://${deviceIp}:${devicePort}/ISAPI/System/deviceInfo`,
      {
        auth: { username, password },
        timeout: 5000,
      }
    );
    
    log('   ✅ Dispositivo alcanzable', 'green');
    
    // Paso 2: Configurar el host HTTP
    log('   2/4 Configurando HTTP host para notificaciones...', 'yellow');
    
    const webhookXML = `<?xml version="1.0" encoding="UTF-8"?>
<HttpHostNotification>
  <id>1</id>
  <url>${webhookUrl}</url>
  <protocolType>HTTP</protocolType>
  <parameterFormatType>XML</parameterFormatType>
  <addressingFormatType>ipaddress</addressingFormatType>
  <httpAuthenticationMethod>none</httpAuthenticationMethod>
</HttpHostNotification>`;
    
    await axios.put(
      `http://${deviceIp}:${devicePort}/ISAPI/Event/notification/httpHosts/1`,
      webhookXML,
      {
        auth: { username, password },
        headers: {
          'Content-Type': 'application/xml',
        },
        timeout: 10000,
      }
    );
    
    log('   ✅ HTTP host configurado', 'green');
    
    // Paso 3: Habilitar notificaciones HTTP
    log('   3/4 Habilitando notificaciones HTTP...', 'yellow');
    
    const notificationXML = `<?xml version="1.0" encoding="UTF-8"?>
<HttpHostNotificationList>
  <HttpHostNotification>
    <id>1</id>
    <url>${webhookUrl}</url>
    <protocolType>HTTP</protocolType>
    <parameterFormatType>XML</parameterFormatType>
    <addressingFormatType>ipaddress</addressingFormatType>
    <httpAuthenticationMethod>none</httpAuthenticationMethod>
  </HttpHostNotification>
</HttpHostNotificationList>`;
    
    try {
      await axios.put(
        `http://${deviceIp}:${devicePort}/ISAPI/Event/notification/httpHosts`,
        notificationXML,
        {
          auth: { username, password },
          headers: {
            'Content-Type': 'application/xml',
          },
          timeout: 10000,
        }
      );
      log('   ✅ Notificaciones HTTP habilitadas', 'green');
    } catch (err) {
      log('   ⚠️  Configuración alternativa (puede que ya esté configurado)', 'yellow');
    }
    
    // Paso 4: Configurar triggers de eventos
    log('   4/4 Configurando triggers de eventos de control de acceso...', 'yellow');
    
    const triggerXML = `<?xml version="1.0" encoding="UTF-8"?>
<EventTrigger>
  <eventType>AccessControllerEvent</eventType>
  <eventDescription>Access Controller Event</eventDescription>
  <notificationMethod>HTTP</notificationMethod>
</EventTrigger>`;
    
    try {
      await axios.put(
        `http://${deviceIp}:${devicePort}/ISAPI/Event/triggers/AccessControllerEvent`,
        triggerXML,
        {
          auth: { username, password },
          headers: {
            'Content-Type': 'application/xml',
          },
          timeout: 10000,
        }
      );
      log('   ✅ Triggers configurados', 'green');
    } catch (err) {
      log('   ⚠️  Triggers pueden estar ya configurados', 'yellow');
    }
    
    // Éxito
    console.log('\n' + '='.repeat(60));
    log('✅ ¡CONFIGURACIÓN COMPLETADA EXITOSAMENTE!', 'green');
    console.log('='.repeat(60));
    
    console.log('\n📝 Próximos pasos:\n');
    console.log('   1. Asegúrate de que tu servidor Node.js esté corriendo:');
    console.log(`      ${colors.cyan}npm start${colors.reset}\n`);
    console.log('   2. El dispositivo ahora enviará eventos automáticamente a:');
    console.log(`      ${colors.cyan}${webhookUrl}${colors.reset}\n`);
    console.log('   3. Prueba colocando una huella en el dispositivo');
    console.log('   4. Verifica los logs de tu servidor para ver los eventos\n');
    
    log('💡 TIP: Los eventos aparecerán en tiempo real en los logs del servidor', 'blue');
    console.log('');
    
  } catch (error) {
    console.log('\n' + '='.repeat(60));
    log('❌ ERROR EN LA CONFIGURACIÓN', 'red');
    console.log('='.repeat(60) + '\n');
    
    if (error.code === 'ECONNREFUSED') {
      log('No se pudo conectar al dispositivo. Verifica:', 'red');
      console.log('   • La IP del dispositivo es correcta');
      console.log('   • El dispositivo está encendido y en la red');
      console.log('   • No hay firewall bloqueando la conexión');
    } else if (error.response?.status === 401) {
      log('Credenciales incorrectas. Verifica:', 'red');
      console.log('   • Usuario y contraseña correctos');
      console.log('   • La cuenta no está bloqueada');
    } else {
      log(`Error: ${error.message}`, 'red');
      if (error.response?.data) {
        console.log('\nRespuesta del dispositivo:');
        console.log(error.response.data);
      }
    }
    
    console.log('\n📘 Para configuración manual:');
    console.log(`   1. Accede a http://${deviceIp}:${devicePort}`);
    console.log('   2. Ve a Configuration → Event → Notifications');
    console.log(`   3. Configura HTTP Notification con URL: ${webhookUrl}\n`);
  }
  
  rl.close();
}

// Ejecutar
configureWebhook().catch((error) => {
  console.error('\n❌ Error fatal:', error.message);
  rl.close();
  process.exit(1);
});