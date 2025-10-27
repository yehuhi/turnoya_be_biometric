// ehome-v5-server.js - VERSIÓN FINAL PARA V5.0
const net = require('net');
const crypto = require('crypto');
const axios = require('axios');

const EHOME_PORT = 7660;
const YOUR_BACKEND_URL = 'http://localhost:5000/hikvision/events';
const EHOME_KEY = 'A1047338633!';

console.log('='.repeat(60));
console.log('🚀 SERVIDOR EHOME V5.0 - VERSIÓN CORREGIDA');
console.log(`🔑 EHome Key: ${EHOME_KEY}`);
console.log('='.repeat(60));

class EHomeV5Server {
    constructor(port) {
        this.port = port;
        this.devices = new Map();
        this.connectionCount = 0;
    }

    start() {
        const server = net.createServer((socket) => {
            this.connectionCount++;
            const connId = this.connectionCount;
            
            console.log('\n' + '='.repeat(60));
            console.log(`[${new Date().toISOString()}] 🔌 CONEXIÓN #${connId}`);
            console.log(`  IP: ${socket.remoteAddress}:${socket.remotePort}`);
            console.log('='.repeat(60));
            
            let buffer = Buffer.alloc(0);
            
            socket.on('data', (data) => {
                console.log(`\n[CONN #${connId}] 📥 ${data.length} bytes`);
                console.log(`[CONN #${connId}] HEX: ${data.slice(0, 60).toString('hex')}...`);
                
                buffer = Buffer.concat([buffer, data]);
                
                while (buffer.length > 0) {
                    const processed = this.processMessage(socket, buffer, connId);
                    if (processed <= 0) break;
                    buffer = buffer.slice(processed);
                }
            });

            socket.on('error', (err) => {
                console.error(`[CONN #${connId}] ❌`, err.message);
            });

            socket.on('close', () => {
                console.log(`[CONN #${connId}] 🔌 Cerrada\n`);
                this.devices.delete(connId);
            });

            socket.setKeepAlive(true, 30000);
            socket.setTimeout(300000);
        });

        server.listen(this.port, '0.0.0.0', () => {
            console.log(`\n✅ Escuchando en puerto ${this.port}`);
            console.log(`📡 Esperando dispositivo DS-K1T8003MF...\n`);
        });
    }

    processMessage(socket, buffer, connId) {
        if (buffer.length < 1) return 0;

        const msgType = buffer[0];
        console.log(`[CONN #${connId}] 📋 Tipo: 0x${msgType.toString(16).padStart(2, '0')}`);

        switch(msgType) {
            case 0x10: return this.handleLogin(socket, buffer, connId);
            case 0x11: return this.handleHeartbeat(socket, buffer, connId);
            case 0x12: return this.handleEvent(socket, buffer, connId);
            case 0x13: return this.handleLogout(socket, buffer, connId);
            default:
                console.log(`[CONN #${connId}] ⚠️  Desconocido: 0x${msgType.toString(16)}`);
                this.sendGenericAck(socket, buffer[0], connId);
                return buffer.length;
        }
    }

    handleLogin(socket, buffer, connId) {
        console.log(`[CONN #${connId}] 🔐 LOGIN V5.0`);
        
        if (buffer.length < 69) {
            console.log(`[CONN #${connId}] ⏳ Esperando más datos (tengo ${buffer.length}, necesito 69)`);
            return 0;
        }

        try {
            // Parsear mensaje
            let pos = 5;
            
            const serialLen = buffer[pos++];
            const serial = buffer.slice(pos, pos + serialLen).toString('ascii');
            pos += serialLen;
            
            const modelLen = buffer[pos++];
            const model = buffer.slice(pos, pos + modelLen).toString('ascii');
            pos += modelLen;
            
            const fw = buffer[pos++] || 0;
            const ch = buffer[pos++] || 0;
            
            let user = 'N/A';
            if (pos < buffer.length - 32) {
                const userLen = buffer[pos++];
                if (pos + userLen <= buffer.length - 32) {
                    user = buffer.slice(pos, pos + userLen).toString('ascii');
                }
            }
            
            console.log(`[CONN #${connId}] 📱 Dispositivo:`);
            console.log(`[CONN #${connId}]    ${model} (${serial})`);
            console.log(`[CONN #${connId}]    Usuario: ${user}`);

            this.devices.set(connId, {
                serial, model, user,
                connectedAt: new Date(),
                lastHeartbeat: new Date()
            });

            // RESPUESTA: Espejo del mensaje de login pero con tipo 0x20
            const response = Buffer.alloc(69);
            
            // Copiar los primeros bytes del request
            buffer.copy(response, 0, 0, 37);
            
            // Cambiar el tipo a Response
            response[0] = 0x20; // 0x10 → 0x20
            
            // Status success
            response[4] = 0x01;
            
            // Los últimos 32 bytes: calcular hash de respuesta
            // Para V5.0, simplemente usamos un hash derivado de EHOME_KEY
            const authData = Buffer.concat([
                response.slice(0, 37),
                Buffer.from(serial),
                Buffer.from(EHOME_KEY)
            ]);
            
            const hash = crypto.createHash('md5').update(authData).digest();
            
            // Llenar los 32 bytes finales con el hash (repetido si es necesario)
            hash.copy(response, 37);
            hash.copy(response, 37 + 16); // Repetir para llenar 32 bytes
            
            socket.write(response);
            console.log(`[CONN #${connId}] ✅ Login Response enviado`);
            console.log(`[CONN #${connId}] 📤 Response: ${response.slice(0, 40).toString('hex')}...`);
            console.log(`[CONN #${connId}] 💚 Esperando más mensajes...\n`);
            
            // Marcar como conectado
            setTimeout(() => {
                if (this.devices.has(connId)) {
                    console.log(`[CONN #${connId}] ✨ Conexión estable - Dispositivo listo\n`);
                }
            }, 2000);
            
            return 69;

        } catch (err) {
            console.error(`[CONN #${connId}] ❌ Error:`, err.message);
            return 69;
        }
    }

    handleHeartbeat(socket, buffer, connId) {
        console.log(`[CONN #${connId}] 💓 Heartbeat`);
        
        if (buffer.length < 8) return 0;

        const device = this.devices.get(connId);
        if (device) {
            device.lastHeartbeat = new Date();
            console.log(`[CONN #${connId}] ✅ Heartbeat actualizado\n`);
        }

        const response = Buffer.alloc(8);
        response[0] = 0x21;
        response[1] = 0x43;
        response.writeUInt32BE(Math.floor(Date.now() / 1000), 4);
        
        socket.write(response);
        
        return buffer.length >= 16 ? 16 : 8;
    }

    handleEvent(socket, buffer, connId) {
        console.log(`[CONN #${connId}] 🎉🎉🎉 ¡¡¡EVENTO DE ACCESO!!!`);
        
        if (buffer.length < 10) return 0;

        try {
            const device = this.devices.get(connId);
            
            const event = {
                timestamp: new Date().toISOString(),
                deviceSerial: device?.serial || 'unknown',
                deviceModel: device?.model || 'unknown',
                eventType: buffer[1],
                rawDataHex: buffer.slice(0, Math.min(200, buffer.length)).toString('hex'),
                rawDataLength: buffer.length
            };

            // Intentar parsear datos ASCII
            const ascii = buffer.toString('ascii', 2).replace(/[^\x20-\x7E]/g, '');
            if (ascii.length > 5) {
                console.log(`[CONN #${connId}] 📄 Datos: ${ascii.substring(0, 80)}`);
                event.parsedData = ascii;
            }

            console.log(`[CONN #${connId}] 📊 Evento completo:`);
            console.log(JSON.stringify(event, null, 2));

            // ACK
            const response = Buffer.alloc(16);
            response[0] = 0x22;
            response[1] = 0x43;
            response.writeUInt32BE(0x00000001, 4);
            
            socket.write(response);
            console.log(`[CONN #${connId}] ✅ Evento ACK enviado\n`);

            // Reenviar a backend
            this.forwardToBackend(event, connId);
            
            return buffer.length;

        } catch (err) {
            console.error(`[CONN #${connId}] ❌ Error:`, err.message);
            return buffer.length;
        }
    }

    handleLogout(socket, buffer, connId) {
        console.log(`[CONN #${connId}] 👋 Logout`);
        const response = Buffer.from([0x23, 0x43]);
        socket.write(response);
        setTimeout(() => socket.end(), 100);
        return buffer.length;
    }

    sendGenericAck(socket, msgType, connId) {
        const response = Buffer.from([msgType + 0x10, 0x43]);
        socket.write(response);
        console.log(`[CONN #${connId}] ✅ ACK genérico enviado\n`);
    }

    async forwardToBackend(event, connId) {
        try {
            console.log(`[CONN #${connId}] 📤 Reenviando a backend...`);
            const response = await axios.post(YOUR_BACKEND_URL, event, {
                timeout: 5000,
                headers: { 'Content-Type': 'application/json' }
            });
            console.log(`[CONN #${connId}] ✅ Enviado: HTTP ${response.status}\n`);
        } catch (err) {
            if (err.code === 'ECONNREFUSED') {
                console.log(`[CONN #${connId}] ⚠️  Backend no disponible\n`);
            } else {
                console.error(`[CONN #${connId}] ❌ Error:`, err.message, '\n');
            }
        }
    }
}

const server = new EHomeV5Server(EHOME_PORT);
server.start();

process.on('SIGINT', () => {
    console.log('\n🛑 Cerrando...');
    process.exit(0);
});