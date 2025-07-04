const sendDiscountAlert = (io, discountDetails) => {
  io.emit('discount_alert', discountDetails);
};

const sendBirthdayAlert = (io, birthdayDetails) => {
  io.emit('birthday_alert', birthdayDetails);
};

const sendBarberAlert = (io, barberDetails) => {
  io.emit('barber_alert', barberDetails);
};

// Función para emitir alerta a un grupo de clientes
const sendAlertToClientGroup = (io, clientId, message) => {
  console.log(`Enviando alerta al cliente con ID: ${clientId}, mensaje: ${message.phone}`);
  console.log(` Contenido del Mensaje: ${message.message}`);
  io.to(clientId).emit('alert', { message }); // Emitir la alerta a un cliente específico
};


module.exports = { sendDiscountAlert, sendBirthdayAlert, sendBarberAlert, sendAlertToClientGroup };
