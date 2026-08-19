const crypto = require('crypto');

const MAILERSEND_EMAIL_ENDPOINT = 'https://api.mailersend.com/v1/email';
const MAILERSEND_BULK_EMAIL_ENDPOINT = 'https://api.mailersend.com/v1/bulk-email';
const MAILERSEND_REQUEST_TIMEOUT_MS = 15_000;
const MAILERSEND_BULK_TIMEOUT_MS = 30_000;
const RSVP_QR_BATCH_CONCURRENCY = 5;

const getMailerSendToken = () => process.env.MAILERSEND_API_TOKEN;

if (getMailerSendToken()) {
  console.log('Email service ready (MailerSend HTTP API)');
} else {
  console.warn('MAILERSEND_API_TOKEN not set - email sending will fail. Add it to your backend environment variables.');
}

const getEmailSender = () => ({
  email: process.env.EMAIL_FROM || 'no-reply@ingather.app',
  name: 'Ingather'
});

const getProviderErrorMessage = (body, fallback) => {
  if (body && typeof body === 'object') {
    if (typeof body.message === 'string' && body.message.trim()) return body.message;
    if (body.errors && typeof body.errors === 'object') {
      const firstError = Object.values(body.errors).flat().find(Boolean);
      if (typeof firstError === 'string') return firstError;
    }
  }

  return fallback;
};

const parseResponseBody = async (response) => {
  const text = await response.text();
  if (!text) return null;

  try {
    return JSON.parse(text);
  } catch {
    return text;
  }
};

const sendMailerSendEmail = async ({ to, subject, html }) => {
  const token = getMailerSendToken();
  if (!token) {
    return { sent: false, reason: 'MAILERSEND_API_TOKEN is not configured' };
  }

  if (typeof fetch !== 'function') {
    return { sent: false, reason: 'This server runtime does not support the MailerSend HTTP client.' };
  }

  const controller = new AbortController();
  const timeout = setTimeout(() => controller.abort(), MAILERSEND_REQUEST_TIMEOUT_MS);

  try {
    const response = await fetch(MAILERSEND_EMAIL_ENDPOINT, {
      method: 'POST',
      headers: {
        Authorization: `Bearer ${token}`,
        'Content-Type': 'application/json'
      },
      body: JSON.stringify({
        from: getEmailSender(),
        to: [{ email: to }],
        subject,
        html
      }),
      signal: controller.signal
    });
    const body = await parseResponseBody(response);
    const messageId = response.headers.get('x-message-id');
    const sendPaused = response.headers.get('x-send-paused') === 'true';
    const warnings = Array.isArray(body?.warnings) ? body.warnings : [];

    if (response.status !== 202) {
      return {
        sent: false,
        reason: getProviderErrorMessage(body, `MailerSend rejected the email request (${response.status}).`)
      };
    }

    if (sendPaused) {
      return { sent: false, reason: 'MailerSend accepted the request but email sending is paused.' };
    }

    if (warnings.length > 0 || !messageId) {
      return {
        sent: false,
        reason: getProviderErrorMessage(body, 'MailerSend did not accept this recipient for delivery.')
      };
    }

    return { sent: true, id: messageId };
  } catch (error) {
    const reason = error?.name === 'AbortError'
      ? 'MailerSend email request timed out.'
      : error?.message || 'MailerSend email request failed.';
    return { sent: false, reason };
  } finally {
    clearTimeout(timeout);
  }
};

const sendMailerSendBulkEmails = async (emailPayloads) => {
  const token = getMailerSendToken();
  if (!token) {
    return { sent: false, reason: 'MAILERSEND_API_TOKEN is not configured' };
  }

  if (typeof fetch !== 'function') {
    return { sent: false, reason: 'This server runtime does not support the MailerSend HTTP client.' };
  }

  const controller = new AbortController();
  const timeout = setTimeout(() => controller.abort(), MAILERSEND_BULK_TIMEOUT_MS);

  try {
    const response = await fetch(MAILERSEND_BULK_EMAIL_ENDPOINT, {
      method: 'POST',
      headers: {
        Authorization: `Bearer ${token}`,
        'Content-Type': 'application/json'
      },
      body: JSON.stringify(
        emailPayloads.map(payload => ({
          from: getEmailSender(),
          to: [{ email: payload.to }],
          subject: payload.subject,
          html: payload.html
        }))
      ),
      signal: controller.signal
    });
    const body = await parseResponseBody(response);

    if (response.status !== 202) {
      return {
        sent: false,
        reason: getProviderErrorMessage(body, `MailerSend rejected the bulk email request (${response.status}).`)
      };
    }

    return { sent: true, body };
  } catch (error) {
    const reason = error?.name === 'AbortError'
      ? 'MailerSend bulk email request timed out.'
      : error?.message || 'MailerSend bulk email request failed.';
    return { sent: false, reason };
  } finally {
    clearTimeout(timeout);
  }
};

const mapWithConcurrency = async (items, concurrency, mapper) => {
  const results = new Array(items.length);
  let nextIndex = 0;

  const worker = async () => {
    while (nextIndex < items.length) {
      const currentIndex = nextIndex;
      nextIndex += 1;
      results[currentIndex] = await mapper(items[currentIndex], currentIndex);
    }
  };

  await Promise.all(Array.from({ length: Math.min(concurrency, items.length) }, worker));
  return results;
};

const generateOTP = () => {
  return crypto.randomInt(100000, 1000000).toString();
};

/**
 * Send OTP email for account verification
 */
const sendOTPEmail = async (email, otp) => {
  const result = await sendMailerSendEmail({
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

  if (!result.sent) {
    console.error('Email send error:', result.reason);
    throw new Error(result.reason || 'Failed to send email');
  }

  return result;
};

/**
 * Send OTP email for password reset
 */
const sendPasswordResetEmail = async (email, otp) => {
  const result = await sendMailerSendEmail({
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

  if (!result.sent) {
    console.error('Email send error:', result.reason);
    throw new Error(result.reason || 'Failed to send email');
  }

  return result;
};

const sendWaitlistInviteEmail = async ({ email, firstName, inviteLink }) => {
  const result = await sendMailerSendEmail({
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

  if (!result.sent) {
    console.error('Waitlist invite email error:', result.reason);
    return { sent: false, reason: result.reason || 'Failed to send invite email' };
  }

  return result;
};

const buildRsvpQrEmailPayload = ({ email, attendeeName, eventTitle, eventDate, organizerName, venueName, city, qrImageUrl, checkinLink, checkinToken }) => {
  const safeName = attendeeName || 'there';
  const safeOrganizer = organizerName || 'your event organizer';
  const eventDateLabel = eventDate
    ? new Date(eventDate).toLocaleString('en-US', {
        weekday: 'short',
        month: 'short',
        day: 'numeric',
        year: 'numeric',
        hour: 'numeric',
        minute: '2-digit'
      })
    : 'Event date';

  return {
    to: email,
    subject: `Your check-in QR for ${eventTitle}`,
    html: `
      <div style="font-family: 'Segoe UI', Tahoma, Geneva, Verdana, sans-serif; max-width: 600px; margin: 0 auto; background-color: #090809; border-radius: 20px; overflow: hidden;">
        <div style="background: linear-gradient(135deg, #F96D10 0%, #e05d00 100%); padding: 32px;">
          <h1 style="color: #ffffff; margin: 0; font-size: 28px;">Ingather</h1>
        </div>
        <div style="padding: 32px; color: #ffffff;">
          <p style="color: #F96D10; font-weight: 800; text-transform: uppercase; font-size: 12px; letter-spacing: .08em; margin: 0 0 12px;">Pre-event access confirmed</p>
          <h2 style="margin: 0 0 12px; font-size: 25px;">Hi ${safeName}, your check-in QR is ready.</h2>
          <p style="color: rgba(255,255,255,.74); line-height: 1.65; margin: 0 0 22px;">
            Bring this QR code to <strong style="color:#fff;">${eventTitle}</strong>. ${safeOrganizer} will scan it at the entrance to check you in quickly. If scanning fails, give the RSVP token below to the usher.
          </p>
          ${qrImageUrl ? `
            <div style="background:#ffffff; border-radius: 18px; padding: 20px; text-align:center; margin: 24px auto; max-width: 280px;">
              <img src="${qrImageUrl}" alt="Personal check-in QR code" width="220" height="220" style="display:block; margin:0 auto;" />
            </div>
          ` : `
            <div style="background: rgba(255,255,255,.06); border: 1px solid rgba(255,255,255,.12); border-radius: 16px; padding: 18px; text-align:center; margin: 24px 0;">
              <p style="margin:0; color:rgba(255,255,255,.72);">Your QR image could not be attached, but your secure fallback link and RSVP token below will still work at check-in.</p>
            </div>
          `}
          <div style="background: rgba(249,109,16,.13); border: 1px solid rgba(249,109,16,.38); border-radius: 16px; padding: 18px; text-align:center; margin: 0 0 22px;">
            <p style="margin:0 0 8px; color:#F96D10; font-size:12px; font-weight:800; text-transform:uppercase; letter-spacing:.08em;">RSVP Token</p>
            <strong style="display:block; color:#ffffff; font-size:30px; letter-spacing:.18em; font-family: 'Segoe UI', Tahoma, Geneva, Verdana, sans-serif;">${checkinToken || ''}</strong>
            <p style="margin:10px 0 0; color:rgba(255,255,255,.64); font-size:13px;">Use this token only if the QR scanner is unavailable.</p>
          </div>
          <div style="background: rgba(255,255,255,.06); border: 1px solid rgba(255,255,255,.12); border-radius: 14px; padding: 16px; margin-bottom: 22px;">
            <p style="margin:0; color:rgba(255,255,255,.62); font-size:13px;">Event</p>
            <strong style="display:block; margin-top:4px;">${eventTitle}</strong>
            <p style="margin:10px 0 0; color:rgba(255,255,255,.82);">${eventDateLabel}</p>
            ${venueName ? `<p style="margin:8px 0 0; color:rgba(255,255,255,.72); font-size:13px;">📍 ${venueName}${city ? `, ${city}` : ''}</p>` : ''}
          </div>
          <p style="color: rgba(255,255,255,.56); font-size: 13px; line-height: 1.55; margin: 0;">
            If the QR image does not display, show this secure fallback link at check-in:<br />
            <a href="${checkinLink}" style="color:#F96D10; word-break:break-all;">${checkinLink}</a>
          </p>
        </div>
      </div>
    `
  };
};

const sendRsvpQrEmail = async (email) => {
  const result = await sendMailerSendEmail(buildRsvpQrEmailPayload(email));
  if (!result.sent) {
    console.error('RSVP QR email error:', result.reason);
    return { sent: false, reason: result.reason || 'Failed to send RSVP QR email' };
  }

  return result;
};

const sendRsvpQrEmailBatch = async ({ emails }) => {
  if (!Array.isArray(emails) || emails.length === 0) {
    return { sent: true, accepted: [], errors: [] };
  }

  const accepted = [];
  const errors = [];

  // MailerSend allows up to 500 emails per bulk request for paid accounts
  const BATCH_SIZE = 500;
  
  for (let i = 0; i < emails.length; i += BATCH_SIZE) {
    const chunk = emails.slice(i, i + BATCH_SIZE);
    const payloads = chunk.map(email => buildRsvpQrEmailPayload(email));
    
    const result = await sendMailerSendBulkEmails(payloads);
    
    if (result.sent) {
      // In bulk sending, we don't get individual message IDs synchronously,
      // it returns a bulk_email_id. We'll just mark them all as accepted.
      chunk.forEach(() => accepted.push({ id: result.body?.bulk_email_id || 'bulk-accepted' }));
    } else {
      chunk.forEach((_, idx) => errors.push({ index: i + idx, message: result.reason || 'Failed to send RSVP QR email.' }));
    }
  }

  if (accepted.length === 0) {
    console.error('RSVP QR batch email error:', errors[0]?.message || 'MailerSend rejected the QR email batch.');
    return {
      sent: false,
      reason: errors[0]?.message || 'Failed to send RSVP QR email batch',
      accepted: [],
      errors
    };
  }

  return {
    sent: true,
    accepted,
    errors
  };
};

module.exports = {
  buildRsvpQrEmailPayload,
  generateOTP,
  sendMailerSendEmail,
  sendOTPEmail,
  sendPasswordResetEmail,
  sendRsvpQrEmail,
  sendRsvpQrEmailBatch,
  sendWaitlistInviteEmail
};
