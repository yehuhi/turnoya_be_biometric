// Funciones para emitir alertas a los clientes conectados
const sendDiscountAlert = (io, discountDetails) => {
  io.emit('discount_alert', discountDetails);
};

const sendBirthdayAlert = (io, birthdayDetails) => {
  io.emit('birthday_alert', birthdayDetails);
};

const sendBarberAlert = (io, barberDetails) => {
  io.emit('barber_alert', barberDetails);
};


module.exports = { sendDiscountAlert, sendBirthdayAlert, sendBarberAlert };
