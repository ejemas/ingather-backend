const nodemailer = require('nodemailer');

// Configure Gmail SMTP transporter (port 587 + STARTTLS for Render compatibility)
const transporter = nodemailer.createTransport({
  host: 'smtp.gmail.com',
  port: 587,
  secure: false,
  auth: {
    user: process.env.EMAIL_USER,
    pass: process.env.EMAIL_PASS
  },
  tls: {
    rejectUnauthorized: false
  }
});

// Verify transporter connection on startup
transporter.verify()
  .then(() => console.log('✅ Email service ready'))
  .catch((err) => console.error('❌ Email service error:', err.message));

/**
 * Generate a random 4-digit OTP
 */
const generateOTP = () => {
  return Math.floor(1000 + Math.random() * 9000).toString();
};

/**
 * Send OTP email for account verification
 */
const sendOTPEmail = async (email, otp) => {
  const mailOptions = {
    from: `"Ingather" <${process.env.EMAIL_USER}>`,
    to: email,
    subject: 'Verify Your Ingather Account',
    html: `
      <div style="font-family: 'Segoe UI', Tahoma, Geneva, Verdana, sans-serif; max-width: 500px; margin: 0 auto; background-color: #090809; border-radius: 16px; overflow: hidden;">
        <div style="background: linear-gradient(135deg, #F96D10 0%, #e05d00 100%); padding: 32px; text-align: center;">
          <h1 style="color: #EBEBD3; margin: 0; font-size: 28px;">Ingather</h1>
        </div>
        <div style="padding: 32px; text-align: center;">
          <h2 style="color: #EBEBD3; margin-bottom: 8px; font-size: 22px;">Verify Your Email</h2>
          <p style="color: #EBEBD3; opacity: 0.7; margin-bottom: 24px; font-size: 14px;">
            Enter this code to complete your registration
          </p>
          <div style="background-color: #1a1a1a; border-radius: 12px; padding: 24px; margin-bottom: 24px;">
            <span style="font-size: 36px; font-weight: 700; letter-spacing: 12px; color: #F96D10;">${otp}</span>
          </div>
          <p style="color: #EBEBD3; opacity: 0.5; font-size: 13px;">
            This code expires in <strong>10 minutes</strong>.
          </p>
          <p style="color: #EBEBD3; opacity: 0.5; font-size: 13px;">
            If you didn't create an account, please ignore this email.
          </p>
        </div>
      </div>
    `
  };

  await transporter.sendMail(mailOptions);
};

/**
 * Send OTP email for password reset
 */
const sendPasswordResetEmail = async (email, otp) => {
  const mailOptions = {
    from: `"Ingather" <${process.env.EMAIL_USER}>`,
    to: email,
    subject: 'Reset Your Ingather Password',
    html: `
      <div style="font-family: 'Segoe UI', Tahoma, Geneva, Verdana, sans-serif; max-width: 500px; margin: 0 auto; background-color: #090809; border-radius: 16px; overflow: hidden;">
        <div style="background: linear-gradient(135deg, #F96D10 0%, #e05d00 100%); padding: 32px; text-align: center;">
          <h1 style="color: #EBEBD3; margin: 0; font-size: 28px;">Ingather</h1>
        </div>
        <div style="padding: 32px; text-align: center;">
          <h2 style="color: #EBEBD3; margin-bottom: 8px; font-size: 22px;">Password Reset</h2>
          <p style="color: #EBEBD3; opacity: 0.7; margin-bottom: 24px; font-size: 14px;">
            Enter this code to reset your password
          </p>
          <div style="background-color: #1a1a1a; border-radius: 12px; padding: 24px; margin-bottom: 24px;">
            <span style="font-size: 36px; font-weight: 700; letter-spacing: 12px; color: #F96D10;">${otp}</span>
          </div>
          <p style="color: #EBEBD3; opacity: 0.5; font-size: 13px;">
            This code expires in <strong>10 minutes</strong>.
          </p>
          <p style="color: #EBEBD3; opacity: 0.5; font-size: 13px;">
            If you didn't request a password reset, please ignore this email.
          </p>
        </div>
      </div>
    `
  };

  await transporter.sendMail(mailOptions);
};

module.exports = { generateOTP, sendOTPEmail, sendPasswordResetEmail };
