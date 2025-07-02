const express = require('express');
const http = require('http');
const socketIo = require('socket.io');
const cors = require('cors');
const admin = require('firebase-admin');
const { sendBirthdayAlerts } = require('./birthday-alerts'); // Importamos sendBirthdayAlerts

const app = express();
const server = http.createServer(app);

// Configuración de Socket.io
const io = socketIo(server, {
  cors: {
    origin: true,
    // origin: 'https://turnoyapp.netlify.app', // URL del frontend
    methods: ['GET', 'POST'],
    allowedHeaders: ['Content-Type'],
    credentials: true,
  },
  transports: ['websocket'], // Forzar el uso de WebSocket
});

app.use(express.json());
app.use(cors()); // Agregar CORS para las peticiones HTTP

// Conexión a Firebase
const serviceAccount = require('./firebase-config.json');
admin.initializeApp({
  credential: admin.credential.cert(serviceAccount),
});

// Evento cuando un cliente se conecta
io.on('connection', (socket) => {
  console.log('Cliente conectado');

  // Evento para cuando el cliente se autentica (por ejemplo, con su ID de usuario)
  socket.on('authenticate', async (userId, userType) => {
    console.log(`Autenticado: ${userId}, Tipo de usuario: ${userType}`);
    try {
      // Llamar a sendBirthdayAlerts para verificar el cumpleaños del cliente o enviar la lista al admin
      await sendBirthdayAlerts(userId, userType, socket, io);
    } catch (error) {
      console.log('Error al manejar la autenticación del usuario:', error);
    }
  });

  socket.on('disconnect', () => {
    console.log('Cliente desconectado');
  });
});

// Configura el servidor para escuchar
const PORT = process.env.PORT || 5000;
server.listen(PORT, () => {
  console.log(`Servidor corriendo en puerto ${PORT}`);
});
