const express = require('express');
const http = require('http');
const socketIo = require('socket.io');
const { sendBirthdayAlerts } = require('./birthday-alerts'); // Importa la función

const app = express();
const server = http.createServer(app);
const io = socketIo(server);

app.use(express.json());

// Conexión a Firebase
const admin = require('firebase-admin');
const serviceAccount = require('./firebase-config.json');

// Inicializa Firebase Admin SDK
admin.initializeApp({
  credential: admin.credential.cert(serviceAccount),
  // No es necesario databaseURL para Firestore
});

// Prueba de ruta
app.get('/', (req, res) => {
  res.send('Servidor funcionando');
});

// Rutas adicionales para operaciones
app.post('/send-email', async (req, res) => {
  try {
    const { to, subject, text } = req.body;
    await sendEmail(to, subject, text);
    res.status(200).send('Correo enviado exitosamente');
  } catch (error) {
    res.status(500).send('Error al enviar correo');
  }
});

// Conexión Socket.io
io.on('connection', (socket) => {
  console.log('Cliente conectado');

  socket.on('disconnect', () => {
    console.log('Cliente desconectado');
  });
  
  // Enviar alertas de cumpleaños y otras alertas
  socket.on('send_discount_alert', (discountDetails) => {
    sendDiscountAlert(io, discountDetails);
  });

  socket.on('send_birthday_alert', (birthdayDetails) => {
    sendBirthdayAlert(io, birthdayDetails);
  });

  socket.on('send_barber_alert', (barberDetails) => {
    sendBarberAlert(io, barberDetails);
  });
});

// Llamamos a la función de alertas de cumpleaños pasando `io`
sendBirthdayAlerts(io);

const PORT = process.env.PORT || 5000;
server.listen(PORT, () => {
  console.log(`Servidor corriendo en puerto ${PORT}`);
});
