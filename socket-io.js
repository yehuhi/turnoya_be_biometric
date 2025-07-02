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

// Función para emitir alerta de cumpleaños
const sendBirthdayListToAdmin = (io, usersWithBirthdayToday) => {
  if (usersWithBirthdayToday.length > 0) {
    io.emit('admin_birthday_list', { message: 'Clientes con cumpleaños hoy:', data: usersWithBirthdayToday });
    console.log(`Lista de cumpleaños enviada al admin con ${usersWithBirthdayToday.length} usuarios.`);
  } else {
    console.log('No hay usuarios con cumpleaños hoy.');
  }
};

module.exports = { sendDiscountAlert, sendBirthdayAlert, sendBarberAlert, sendBirthdayListToAdmin };
