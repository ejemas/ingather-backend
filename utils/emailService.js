const { Resend } = require('resend');
const crypto = require('crypto');

let resend = null;

if (process.env.RESEND_API_KEY) {
  resend = new Resend(process.env.RESEND_API_KEY);
  console.log('✅ Email service ready (Resend HTTP API)');
} else {
  console.warn('⚠️ RESEND_API_KEY not set — email sending will fail. Add it to your environment variables.');
}

const generateOTP = () => {
  return crypto.randomInt(100000, 1000000).toString();
};

/**
 * Send OTP email for account verification
 */
const sendOTPEmail = async (email, otp) => {
  const { error } = await resend.emails.send({
    from: `Ingather <${process.env.EMAIL_FROM || 'no-reply@ingather.app'}>`,
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
  });

  if (error) {
    console.error('Email send error:', error);
    throw new Error(error.message || 'Failed to send email');
  }
};

/**
 * Send OTP email for password reset
 */
const sendPasswordResetEmail = async (email, otp) => {
  const { error } = await resend.emails.send({
    from: `Ingather <${process.env.EMAIL_FROM || 'no-reply@ingather.app'}>`,
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
  });

  if (error) {
    console.error('Email send error:', error);
    throw new Error(error.message || 'Failed to send email');
  }
};

const sendWaitlistInviteEmail = async ({ email, firstName, inviteLink }) => {
  if (!resend) {
    return { sent: false, reason: 'RESEND_API_KEY is not configured' };
  }

  const { error } = await resend.emails.send({
    from: `Ingather <${process.env.EMAIL_FROM || 'no-reply@ingather.app'}>`,
    to: email,
    subject: 'Your Ingather invite is ready',
    html: `
      <div style="font-family: 'Segoe UI', Tahoma, Geneva, Verdana, sans-serif; max-width: 560px; margin: 0 auto; background-color: #090809; border-radius: 18px; overflow: hidden;">
        <div style="background: linear-gradient(135deg, #F96D10 0%, #e05d00 100%); padding: 32px;">
          <h1 style="color: #ffffff; margin: 0; font-size: 28px;">Ingather</h1>
        </div>
        <div style="padding: 32px;">
          <p style="color: #F96D10; font-weight: 800; text-transform: uppercase; font-size: 12px; letter-spacing: .08em; margin: 0 0 12px;">Invite approved</p>
          <h2 style="color: #ffffff; margin: 0 0 12px; font-size: 24px;">${firstName || 'Your'} Ingather access is ready.</h2>
          <p style="color: rgba(255,255,255,.72); line-height: 1.6; margin: 0 0 26px;">
            Create your workspace and start building smarter event check-ins, RSVP flows, sponsor touchpoints, and post-event reports.
          </p>
          <a href="${inviteLink}" style="display:inline-block; background:#F96D10; color:#ffffff; text-decoration:none; font-weight:800; padding:14px 22px; border-radius:12px;">Create your workspace</a>
          <p style="color: rgba(255,255,255,.48); font-size: 13px; line-height: 1.5; margin: 24px 0 0;">
            This invite link expires in 14 days and can only be used once.
          </p>
        </div>
      </div>
    `
  });

  if (error) {
    console.error('Waitlist invite email error:', error);
    return { sent: false, reason: error.message || 'Failed to send invite email' };
  }

  return { sent: true };
};

module.exports = { generateOTP, sendOTPEmail, sendPasswordResetEmail, sendWaitlistInviteEmail };
