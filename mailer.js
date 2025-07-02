const nodemailer = require('nodemailer');

// Configura el transporte para enviar correos
const transporter = nodemailer.createTransport({
  service: 'gmail',
  auth: {
    user: 'your-email@gmail.com',
    pass: 'your-email-password'
  }
});

// Función para enviar correos electrónicos
const sendEmail = async (to, subject, text) => {
  const mailOptions = {
    from: 'your-email@gmail.com',
    to,
    subject,
    text
  };

  try {
    const info = await transporter.sendMail(mailOptions);
    console.log('Correo enviado: ' + info.response);
  } catch (error) {
    console.error('Error al enviar correo', error);
  }
};

module.exports = { sendEmail };
