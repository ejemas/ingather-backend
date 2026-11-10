const crypto = require('crypto');

const ZEPTOMAIL_EMAIL_ENDPOINT = 'https://cpaas.zoho.com/v1.1/email';
const ZEPTOMAIL_REQUEST_TIMEOUT_MS = 15_000;
const ZEPTOMAIL_BATCH_CONCURRENCY = 5;

const getZeptoMailToken = () => (
  process.env.ZEPTOMAIL_API_TOKEN ||
  process.env.ZOHO_CPAAS_API_TOKEN ||
  process.env.ZOHO_API_KEY
);

const getAuthHeaderValue = (token) => {
  if (!token) return '';
  const trimmed = token.trim();
  return trimmed.startsWith('Zoho-enczapikey') ? trimmed : `Zoho-enczapikey ${trimmed}`;
};

if (getZeptoMailToken()) {
  console.log('Email service ready (ZeptoMail / Zoho CPaaS HTTP API)');
} else {
  console.warn('ZEPTOMAIL_API_TOKEN not set - email sending will fail. Add it to your backend environment variables.');
}

const getEmailSender = () => ({
  address: process.env.EMAIL_FROM || 'no-reply@ingather.app',
  name: 'Ingather'
});

const getProviderErrorMessage = (body, fallback) => {
  if (body && typeof body === 'object') {
    if (typeof body.message === 'string' && body.message.trim()) return body.message;
    if (typeof body.error === 'string' && body.error.trim()) return body.error;
    if (body.error && typeof body.error.message === 'string') return body.error.message;
    if (Array.isArray(body.data) && body.data[0]?.message) return body.data[0].message;
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

const sendZeptoMailEmail = async ({ to, recipientName, subject, html, replyTo }) => {
  const token = getZeptoMailToken();
  if (!token) {
    return { sent: false, reason: 'ZEPTOMAIL_API_TOKEN is not configured' };
  }

  if (typeof fetch !== 'function') {
    return { sent: false, reason: 'This server runtime does not support the ZeptoMail HTTP client.' };
  }

  const controller = new AbortController();
  const timeout = setTimeout(() => controller.abort(), ZEPTOMAIL_REQUEST_TIMEOUT_MS);

  try {
    const response = await fetch(ZEPTOMAIL_EMAIL_ENDPOINT, {
      method: 'POST',
      headers: {
        Authorization: getAuthHeaderValue(token),
        Accept: 'application/json',
        'Content-Type': 'application/json'
      },
      body: JSON.stringify({
        from: getEmailSender(),
        to: [
          {
            email_address: {
              address: to,
              name: recipientName || to.split('@')[0]
            }
          }
        ],
        subject,
        htmlbody: html,
        ...(replyTo?.address ? { reply_to: [{ address: replyTo.address, name: replyTo.name || replyTo.address }] } : {})
      }),
      signal: controller.signal
    });

    const body = await parseResponseBody(response);
    const messageId = body?.data?.[0]?.request_id || response.headers.get('x-request-id');

    if (response.status < 200 || response.status >= 300) {
      return {
        sent: false,
        reason: getProviderErrorMessage(body, `ZeptoMail rejected the email request (${response.status}).`)
      };
    }

    return { sent: true, id: messageId || 'zeptomail-ok' };
  } catch (error) {
    const reason = error?.name === 'AbortError'
      ? 'ZeptoMail email request timed out.'
      : error?.message || 'ZeptoMail email request failed.';
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

/* ------------------------------------------------------------------
 * Email templates (redesign, Nov 2026)
 * Email-safe HTML: tables and inline styles only, no SVG, no flexbox,
 * no external fonts. Every value that came from a person is escaped.
 * ------------------------------------------------------------------ */

const EMAIL_ASSET_BASE_URL = (process.env.EMAIL_ASSET_BASE_URL || 'https://ingather.app').replace(/\/+$/, '');
const EMAIL_LOGO_URL = `${EMAIL_ASSET_BASE_URL}/ingather-logo.png`;
const EMAIL_FONT = "Inter, 'Segoe UI', Helvetica, Arial, sans-serif";

const escapeHtml = (value) => String(value ?? '')
  .replace(/&/g, '&amp;')
  .replace(/</g, '&lt;')
  .replace(/>/g, '&gt;')
  .replace(/"/g, '&quot;')
  .replace(/'/g, '&#39;');

const renderEmailButton = (href, label, { color = '#C84B07' } = {}) => `
  <table role="presentation" cellpadding="0" cellspacing="0" border="0" style="border-collapse: separate;">
    <tr>
      <td align="center" bgcolor="${color}" style="border-radius: 999px; background: ${color};">
        <a href="${escapeHtml(href)}" target="_blank" style="display: inline-block; padding: 14px 26px; font-family: ${EMAIL_FONT}; font-size: 15px; font-weight: 600; line-height: 20px; color: #FFFFFF; text-decoration: none; border-radius: 999px;">${escapeHtml(label)}</a>
      </td>
    </tr>
  </table>`;

const renderEmailLayout = ({ title, preheader, tag, body, footer }) => `<!doctype html>
<html lang="en">
<head>
<meta charset="utf-8">
<meta name="viewport" content="width=device-width, initial-scale=1">
<meta name="x-apple-disable-message-reformatting">
<title>${escapeHtml(title)}</title>
<style>
  /* Phones: the email fills the screen. No grey frame or rounded card, 16px side spacing,
     and the QR pass uses nearly the full width. Computer email apps keep the framed card. */
  @media only screen and (max-width: 620px) {
    .ig-outer { padding: 0 !important; }
    .ig-card { border: 0 !important; border-radius: 0 !important; }
    .ig-px { padding-left: 16px !important; padding-right: 16px !important; }
    .ig-pass-wrap { padding-left: 8px !important; padding-right: 8px !important; }
    .ig-pass-px { padding-left: 16px !important; padding-right: 16px !important; }
    .ig-full { padding-left: 0 !important; padding-right: 0 !important; }
    .ig-full-img { border-radius: 0 !important; max-width: 100% !important; }
  }
</style>
</head>
<body style="margin: 0; padding: 0; background: #F4F4F3; -webkit-text-size-adjust: 100%;">
  <div style="display: none; max-height: 0; overflow: hidden; opacity: 0; color: #F4F4F3; font-size: 1px; line-height: 1px;">${escapeHtml(preheader)}&#8199;&#65279;&#847;&#8199;&#65279;&#847;&#8199;&#65279;&#847;</div>
  <table role="presentation" width="100%" cellpadding="0" cellspacing="0" border="0" bgcolor="#F4F4F3" style="background: #F4F4F3;">
    <tr>
      <td align="center" class="ig-outer" style="padding: 24px 12px 32px;">
        <table role="presentation" width="100%" cellpadding="0" cellspacing="0" border="0" class="ig-card" style="max-width: 600px; background: #FFFFFF; border: 1px solid #ECECEA; border-radius: 20px; border-collapse: separate; overflow: hidden;">
          <tr>
            <td class="ig-px" style="padding: 24px 28px 0;">
              <table role="presentation" width="100%" cellpadding="0" cellspacing="0" border="0">
                <tr>
                  <td align="left" valign="middle">
                    <img src="${EMAIL_LOGO_URL}" width="89" height="22" alt="Ingather" style="display: block; border: 0; height: 22px; width: 89px;">
                  </td>
                  <td align="right" valign="middle">
                    <span style="display: inline-block; padding: 4px 10px; background: #FFF1E7; border: 1px solid #FAD4BB; border-radius: 999px; font-family: ${EMAIL_FONT}; font-size: 12px; font-weight: 600; line-height: 16px; color: #C84B07; white-space: nowrap;">${escapeHtml(tag)}</span>
                  </td>
                </tr>
              </table>
            </td>
          </tr>
          ${body}
          <tr>
            <td class="ig-px" style="padding: 18px 28px 22px; background: #FAFAF9; border-top: 1px solid #F0F0EE; font-family: ${EMAIL_FONT}; font-size: 12px; line-height: 18px; color: #6B6B6B;">
              ${escapeHtml(footer)}<br>
              Ingather &middot; Made in Nigeria
            </td>
          </tr>
        </table>
      </td>
    </tr>
  </table>
</body>
</html>`;

const textBlock = (html, { padding = '0 28px 16px', size = 15, color = '#3F3F3F' } = {}) => `
  <tr>
    <td class="ig-px" style="padding: ${padding}; font-family: ${EMAIL_FONT}; font-size: ${size}px; line-height: 1.6; color: ${color};">${html}</td>
  </tr>`;

const headingBlock = (html, padding = '22px 28px 12px') => `
  <tr>
    <td class="ig-px" style="padding: ${padding}; font-family: ${EMAIL_FONT}; font-size: 26px; font-weight: 600; line-height: 1.2; letter-spacing: -0.03em; color: #111111;">${html}</td>
  </tr>`;

const renderCodeEmail = ({ title, lead, code, note, tag, preheader, footer, extra = '' }) => {
  const digits = String(code || '').split('').map((digit) => `
      <td align="center" valign="middle" width="48" height="60" style="width: 48px; height: 60px; background: #FFF8F3; border: 1px solid #FAD4BB; border-radius: 12px; font-family: ${EMAIL_FONT}; font-size: 28px; font-weight: 600; color: #111111;">${escapeHtml(digit)}</td>
      <td width="8" style="width: 8px; font-size: 0; line-height: 0;">&nbsp;</td>`).join('');

  const body = `
    ${headingBlock(escapeHtml(title))}
    ${textBlock(escapeHtml(lead))}
    <tr>
      <td class="ig-px" style="padding: 4px 28px 18px;">
        <table role="presentation" cellpadding="0" cellspacing="0" border="0" style="border-collapse: separate;" aria-label="Your code is ${escapeHtml(String(code || '').split('').join(' '))}">
          <tr>${digits}</tr>
        </table>
      </td>
    </tr>
    ${extra}
    ${textBlock('This code expires in <strong style="color: #111111;">10 minutes</strong>.', { size: 14 })}
    <tr>
      <td class="ig-px" style="padding: 0 28px 28px;">
        <table role="presentation" width="100%" cellpadding="0" cellspacing="0" border="0" style="border-collapse: separate;">
          <tr>
            <td style="padding: 14px 16px; background: #FAFAF9; border: 1px solid #F0F0EE; border-radius: 14px; font-family: ${EMAIL_FONT}; font-size: 13px; line-height: 1.55; color: #5A5A5A;">${escapeHtml(note)}</td>
          </tr>
        </table>
      </td>
    </tr>`;

  return renderEmailLayout({ title, preheader, tag, body, footer });
};

const buildVerificationEmailHtml = (otp) => renderCodeEmail({
  title: 'Verify your email',
  lead: 'Enter this code to finish creating your Ingather workspace.',
  code: otp,
  note: "Didn't create an Ingather account? You can ignore this email. No account is activated without this code.",
  tag: 'Verify email',
  preheader: 'Your verification code is inside. It expires in 10 minutes.',
  footer: 'You received this because this email was used to create an Ingather account.'
});

const buildPasswordResetEmailHtml = (otp) => renderCodeEmail({
  title: 'Reset your password',
  lead: 'Enter this code on the reset page, then choose a new password.',
  code: otp,
  note: "Didn't ask to reset your password? Ignore this email and your password stays the same. Never share this code with anyone.",
  tag: 'Password reset',
  preheader: 'Your password reset code is inside. It expires in 10 minutes.',
  footer: 'You received this because a password reset was requested for your Ingather account.'
});

const buildWaitlistInviteEmailHtml = ({ email, firstName, inviteLink }) => {
  const name = String(firstName || '').trim();
  const greeting = name ? `${escapeHtml(name)}, your` : 'Your';
  const step = (number, text) => `
    <tr>
      <td valign="top" width="30" style="width: 30px; padding: 4px 0;">
        <span style="display: inline-block; width: 22px; height: 22px; line-height: 22px; text-align: center; border-radius: 999px; background: #111111; color: #FFFFFF; font-family: ${EMAIL_FONT}; font-size: 12px; font-weight: 600;">${number}</span>
      </td>
      <td valign="top" style="padding: 4px 0; font-family: ${EMAIL_FONT}; font-size: 14px; line-height: 22px; color: #3F3F3F;">${text}</td>
    </tr>`;

  const body = `
    <tr>
      <td class="ig-full" style="padding: 20px 28px 0; font-size: 0; line-height: 0;">
        <img src="${EMAIL_ASSET_BASE_URL}/email/invite.jpg" width="544" alt="" class="ig-full-img" style="display: block; width: 100%; max-width: 544px; height: auto; border: 0; border-radius: 18px; background: #2B2420;">
      </td>
    </tr>
    ${headingBlock(`${greeting} Ingather access is <span style="display: inline-block; padding: 0 6px 2px; background: #FFF1E7; border: 1px solid #FAD4BB; border-radius: 8px; color: #E8590C;">ready</span>`)}
    ${textBlock('Thanks for joining the waitlist. Your invite is approved, so you can set up your workspace and run your next event on Ingather.')}
    <tr>
      <td class="ig-px" style="padding: 4px 28px 14px;">${renderEmailButton(inviteLink, 'Create your workspace')}</td>
    </tr>
    ${textBlock(`This invite link expires in 14 days and can only be used once. It's tied to <strong style="color: #111111;">${escapeHtml(email)}</strong>.`, { size: 13, color: '#6B6B6B', padding: '0 28px 18px' })}
    <tr>
      <td class="ig-px" style="padding: 0 28px 28px;">
        <table role="presentation" width="100%" cellpadding="0" cellspacing="0" border="0" style="border-collapse: separate;">
          <tr>
            <td style="padding: 16px; background: #FAFAF9; border: 1px solid #F0F0EE; border-radius: 16px;">
              <div style="font-family: ${EMAIL_FONT}; font-size: 14px; font-weight: 600; color: #111111; padding-bottom: 6px;">Set up in three steps</div>
              <table role="presentation" width="100%" cellpadding="0" cellspacing="0" border="0">
                ${step(1, 'Create your workspace and verify your email.')}
                ${step(2, 'Create your first event or RSVP page.')}
                ${step(3, 'Print your QR code and share your link.')}
              </table>
            </td>
          </tr>
        </table>
      </td>
    </tr>
    ${textBlock(`Button not working? Copy this link into your browser:<br><a href="${escapeHtml(inviteLink)}" style="color: #C84B07; word-break: break-all;">${escapeHtml(inviteLink)}</a>`, { size: 12, color: '#6B6B6B', padding: '0 28px 24px' })}`;

  return renderEmailLayout({
    title: 'Your Ingather invite is ready',
    preheader: 'Create your workspace. This link expires in 14 days.',
    tag: 'Invite approved',
    body,
    footer: 'You received this because you joined the Ingather waitlist.'
  });
};

const renderDeviceDetails = (rows) => `
    <tr>
      <td class="ig-px" style="padding: 0 28px 16px;">
        <table role="presentation" width="100%" cellpadding="0" cellspacing="0" border="0" style="border-collapse: separate;">
          <tr>
            <td style="padding: 6px 16px; border: 1px solid #ECECEA; border-radius: 14px;">
              <table role="presentation" width="100%" cellpadding="0" cellspacing="0" border="0">
                ${rows.map(([label, value]) => `
                <tr>
                  <td style="padding: 8px 0; font-family: ${EMAIL_FONT}; font-size: 14px; color: #6B6B6B;">${escapeHtml(label)}</td>
                  <td align="right" style="padding: 8px 0; font-family: ${EMAIL_FONT}; font-size: 14px; font-weight: 600; color: #111111;">${escapeHtml(value)}</td>
                </tr>`).join('')}
              </table>
            </td>
          </tr>
        </table>
      </td>
    </tr>`;

const buildDeviceCodeEmailHtml = ({ code, deviceLabel, time }) => renderCodeEmail({
  title: "Confirm it's you",
  lead: "Enter this code on the device you're signing in from. We ask once per new device.",
  code,
  note: "Not trying to sign in? Don't share this code with anyone. Someone may know your password, so change it from Settings.",
  tag: 'New device',
  preheader: 'Someone is signing in on a new device. Your code expires in 10 minutes.',
  footer: 'You received this because someone signed in to your Ingather workspace from a new device.',
  extra: renderDeviceDetails([['Device', deviceLabel || 'Unknown device'], ['Time', time || '']])
});

const buildSigninAlertEmailHtml = ({ workspaceName, deviceLabel, time, resetLink }) => {
  const workspace = String(workspaceName || '').trim() || 'Your workspace';
  const body = `
    ${headingBlock('New sign-in to your workspace')}
    ${textBlock(`${escapeHtml(workspace)} was just opened on a new device. If this was you, there's nothing to do.`)}
    ${renderDeviceDetails([['Device', deviceLabel || 'Unknown device'], ['Time', time || '']])}
    <tr>
      <td class="ig-px" style="padding: 0 28px 28px;">
        <table role="presentation" width="100%" cellpadding="0" cellspacing="0" border="0" style="border-collapse: separate;">
          <tr>
            <td style="padding: 16px; background: #FEF3F2; border: 1px solid #FECDCA; border-radius: 16px;">
              <div style="font-family: ${EMAIL_FONT}; font-size: 15px; font-weight: 600; color: #7A1A12;">Not you?</div>
              <div style="padding: 4px 0 12px; font-family: ${EMAIL_FONT}; font-size: 14px; line-height: 1.5; color: #7A1A12;">Reset your password straight away so it can't be used to log in again.</div>
              ${renderEmailButton(resetLink, "This wasn't me", { color: '#B42318' })}
            </td>
          </tr>
        </table>
      </td>
    </tr>`;

  return renderEmailLayout({
    title: 'New sign-in to Ingather',
    preheader: `${deviceLabel || 'A new device'}. If this was you, there's nothing to do.`,
    tag: 'Security',
    body,
    footer: 'We send this every time your workspace is opened on a new device.'
  });
};

const formatEmailEventDate = (eventDate) => {
  if (!eventDate) return { date: 'Date to be announced', time: '' };
  const value = new Date(eventDate);
  if (Number.isNaN(value.getTime())) return { date: 'Date to be announced', time: '' };
  return {
    date: value.toLocaleDateString('en-US', { weekday: 'short', month: 'short', day: 'numeric', year: 'numeric' }),
    time: value.toLocaleTimeString('en-US', { hour: 'numeric', minute: '2-digit' })
  };
};

const buildRsvpQrEmailHtml = ({ attendeeName, eventTitle, eventDate, organizerName, venueName, city, qrImageUrl, checkinLink, checkinToken, bannerUrl }) => {
  const guest = String(attendeeName || '').trim();
  const firstName = guest.split(/\s+/)[0] || 'there';
  const organizer = String(organizerName || '').trim() || 'Your event organizer';
  const title = String(eventTitle || '').trim() || 'your event';
  const { date, time } = formatEmailEventDate(eventDate);
  const venue = [venueName, city].filter(Boolean).join(', ');

  const detail = (label, value) => `
    <td valign="top" width="50%" style="width: 50%; padding: 0 6px 14px 0;">
      <div style="font-family: ${EMAIL_FONT}; font-size: 12px; line-height: 16px; color: #6B6B6B;">${label}</div>
      <div style="font-family: ${EMAIL_FONT}; font-size: 15px; line-height: 21px; font-weight: 600; color: #111111;">${escapeHtml(value)}</div>
    </td>`;

  // The banner is a cropped background so tall flyers are never squashed: Gmail ignores
  // object-fit on <img>. Clients without background images (old Outlook) show the dark band.
  const safeBannerUrl = /^https?:\/\//i.test(String(bannerUrl || ''))
    ? String(bannerUrl).replace(/["'()\\\s<>]/g, (ch) => `%${ch.charCodeAt(0).toString(16).toUpperCase().padStart(2, '0')}`)
    : '';
  const banner = safeBannerUrl ? `
            <tr>
              <td height="180" bgcolor="#2B2420" role="img" aria-label="${escapeHtml(title)} event banner" style="height: 180px; padding: 0; background-color: #2B2420; background-image: url('${safeBannerUrl}'); background-size: cover; background-position: center center; background-repeat: no-repeat; border-radius: 24px 24px 0 0; font-size: 0; line-height: 0;">&nbsp;</td>
            </tr>` : '';

  const qr = qrImageUrl ? `
                <table role="presentation" cellpadding="0" cellspacing="0" border="0" align="center" style="border-collapse: separate;">
                  <tr>
                    <td style="padding: 12px; background: #FFFFFF; border: 1px solid #ECECEA; border-radius: 18px;">
                      <img src="${escapeHtml(qrImageUrl)}" width="210" height="210" alt="Your personal check-in QR code" style="display: block; width: 210px; height: 210px; border: 0;">
                    </td>
                  </tr>
                </table>` : `
                <div style="padding: 14px 16px; background: #FAFAF9; border: 1px solid #F0F0EE; border-radius: 14px; font-family: ${EMAIL_FONT}; font-size: 13px; line-height: 1.55; color: #5A5A5A;">Your QR image could not be attached, but the button below and your backup code still work at check-in.</div>`;

  const body = `
    ${headingBlock(`Hi ${escapeHtml(firstName)}, your check-in QR is ready.`)}
    ${textBlock(`Bring this QR code to <strong style="color: #111111;">${escapeHtml(title)}</strong>. ${escapeHtml(organizer)} will scan it at the entrance to check you in quickly.`)}
    <tr>
      <td align="center" class="ig-pass-wrap" style="padding: 6px 20px 18px;">
        <table role="presentation" width="100%" cellpadding="0" cellspacing="0" border="0" style="max-width: 420px; border: 2px solid #E8590C; border-radius: 26px; border-collapse: separate; background: #FFFFFF;">
          ${banner}
          <tr>
            <td bgcolor="#2B2420" class="ig-pass-px" style="padding: 16px 18px; background: #2B2420; border-radius: ${safeBannerUrl ? '0' : '24px 24px 0 0'};">
              <div style="font-family: ${EMAIL_FONT}; font-size: 12px; line-height: 16px; color: #F1E6DD;">${escapeHtml(organizer)}</div>
              <div style="font-family: ${EMAIL_FONT}; font-size: 21px; line-height: 26px; font-weight: 600; letter-spacing: -0.02em; color: #FFFFFF;">${escapeHtml(title)}</div>
            </td>
          </tr>
          <tr>
            <td class="ig-pass-px" style="padding: 18px 18px 4px;">
              <table role="presentation" width="100%" cellpadding="0" cellspacing="0" border="0">
                <tr>${detail('Guest', guest || 'Guest')}${detail('Date', date)}</tr>
                <tr>${detail('Time', time || 'See event details')}${detail('Venue', venue || 'See event details')}</tr>
              </table>
            </td>
          </tr>
          <tr>
            <td class="ig-pass-px" style="padding: 0 18px;">
              <div style="height: 0; border-top: 2px dashed #E8590C; font-size: 0; line-height: 0;">&nbsp;</div>
            </td>
          </tr>
          <tr>
            <td align="center" class="ig-pass-px" style="padding: 20px 18px 22px;">
              ${qr}
              <div style="padding-top: 12px; font-family: ${EMAIL_FONT}; font-size: 16px; font-weight: 600; color: #111111;">Show this at the entrance</div>
              <div style="padding-top: 4px; font-family: ${EMAIL_FONT}; font-size: 13px; line-height: 1.5; color: #6B6B6B;">An usher scans it to check you in. It works once, so don't share it.</div>
              ${checkinToken ? `
              <div style="padding-top: 14px; font-family: ${EMAIL_FONT}; font-size: 12px; color: #6B6B6B;">Backup code if scanning fails</div>
              <div style="padding-top: 4px;">
                <span style="display: inline-block; padding: 6px 14px; background: #FFF8F3; border: 1px dashed #E8590C; border-radius: 10px; font-family: ${EMAIL_FONT}; font-size: 20px; font-weight: 700; letter-spacing: 0.16em; color: #111111;">${escapeHtml(checkinToken)}</span>
              </div>` : ''}
            </td>
          </tr>
        </table>
      </td>
    </tr>
    ${checkinLink ? `
    <tr>
      <td align="center" class="ig-px" style="padding: 0 28px 12px;">${renderEmailButton(checkinLink, 'Open my pass')}</td>
    </tr>` : ''}
    ${textBlock("Each pass works once. Don't forward this email.", { size: 13, color: '#6B6B6B', padding: '0 28px 24px' })}`;

  return renderEmailLayout({
    title: `Your check-in QR for ${title}`,
    preheader: `Show this QR code at the entrance${date && date !== 'Date to be announced' ? ` on ${date}` : ''}.`,
    tag: 'RSVP confirmed',
    body,
    footer: `You received this because you RSVP'd to an event hosted by ${organizer} on Ingather.`
  });
};

/**
 * Send OTP email for account verification
 */
const sendOTPEmail = async (email, otp) => {
  const result = await sendZeptoMailEmail({
    to: email,
    subject: 'Verify your Ingather account',
    html: buildVerificationEmailHtml(otp)
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
  const result = await sendZeptoMailEmail({
    to: email,
    subject: 'Reset your Ingather password',
    html: buildPasswordResetEmailHtml(otp)
  });

  if (!result.sent) {
    console.error('Email send error:', result.reason);
    throw new Error(result.reason || 'Failed to send email');
  }

  return result;
};

const sendWaitlistInviteEmail = async ({ email, firstName, inviteLink }) => {
  const result = await sendZeptoMailEmail({
    to: email,
    recipientName: firstName,
    subject: 'Your Ingather invite is ready',
    html: buildWaitlistInviteEmailHtml({ email, firstName, inviteLink })
  });

  if (!result.sent) {
    console.error('Waitlist invite email error:', result.reason);
    return { sent: false, reason: result.reason || 'Failed to send invite email' };
  }

  return result;
};

const sendDeviceCodeEmail = async ({ email, code, deviceLabel, time }) => {
  const result = await sendZeptoMailEmail({
    to: email,
    subject: 'Your Ingather sign-in code',
    html: buildDeviceCodeEmailHtml({ code, deviceLabel, time })
  });

  if (!result.sent) {
    console.error('Device code email error:', result.reason);
  }

  return result;
};

const sendSigninAlertEmail = async ({ email, workspaceName, deviceLabel, time, resetLink }) => {
  const result = await sendZeptoMailEmail({
    to: email,
    subject: 'New sign-in to Ingather',
    html: buildSigninAlertEmailHtml({ workspaceName, deviceLabel, time, resetLink })
  });

  if (!result.sent) {
    console.error('Sign-in alert email error:', result.reason);
  }

  return result;
};

const buildRsvpQrEmailPayload = (details) => ({
  to: details.email,
  recipientName: details.attendeeName,
  subject: `Your check-in QR for ${details.eventTitle}`,
  html: buildRsvpQrEmailHtml(details)
});

const sendRsvpQrEmail = async (email) => {
  const result = await sendZeptoMailEmail(buildRsvpQrEmailPayload(email));
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

  const results = await mapWithConcurrency(
    emails,
    ZEPTOMAIL_BATCH_CONCURRENCY,
    email => sendZeptoMailEmail(buildRsvpQrEmailPayload(email))
  );

  const accepted = [];
  const errors = [];

  results.forEach((result, index) => {
    if (result.sent) {
      accepted.push({ id: result.id || `accepted-${index}` });
      return;
    }

    errors.push({ index, message: result.reason || 'Failed to send RSVP QR email.' });
  });

  if (accepted.length === 0) {
    console.error('RSVP QR batch email error:', errors[0]?.message || 'ZeptoMail rejected the QR email batch.');
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

// ---------- Help centre ----------
const HELP_APP_ORIGIN = 'https://ingather.app';

const renderHelpFacts = (rows) => `
    <tr>
      <td class="ig-px" style="padding: 0 28px 16px;">
        <table role="presentation" width="100%" cellpadding="0" cellspacing="0" border="0" style="border-collapse: separate; border: 1px solid #ECECEA; border-radius: 14px;">
          ${rows.filter(([, value]) => value).map(([label, value], index) => `
          <tr>
            <td style="padding: 10px 14px; ${index ? 'border-top: 1px solid #F0F0EE;' : ''} font-family: ${EMAIL_FONT}; font-size: 13px; color: #6B6B6B;">${escapeHtml(label)}</td>
            <td align="right" style="padding: 10px 14px; ${index ? 'border-top: 1px solid #F0F0EE;' : ''} font-family: ${EMAIL_FONT}; font-size: 13px; font-weight: 600; color: #111111;">${escapeHtml(value)}</td>
          </tr>`).join('')}
        </table>
      </td>
    </tr>`;

const renderHelpMessage = (message, { tinted = false } = {}) => `
    <tr>
      <td class="ig-px" style="padding: 0 28px 18px;">
        <table role="presentation" width="100%" cellpadding="0" cellspacing="0" border="0" style="border-collapse: separate;">
          <tr>
            <td style="padding: 14px 16px; background: ${tinted ? '#FFF8F3' : '#FAFAF9'}; border: 1px solid ${tinted ? '#FAD4BB' : '#F0F0EE'}; border-radius: 14px; font-family: ${EMAIL_FONT}; font-size: 14px; line-height: 1.6; color: #2A2A2A; white-space: pre-wrap;">${escapeHtml(message)}</td>
          </tr>
        </table>
      </td>
    </tr>`;

const helpButtonRow = (href, label) => `
    <tr>
      <td class="ig-px" style="padding: 4px 28px 24px;">${renderEmailButton(href, label)}</td>
    </tr>`;

// To the Ingather team when an organizer sends a ticket or writes back.
const buildHelpTeamEmailHtml = ({ ticketNumber, subject, organizerName, organizerEmail, topicLabel, eventTitle, message, urgent, followUp, hasScreenshot }) => {
  const title = followUp ? `New reply on ticket #${ticketNumber}` : `New ticket #${ticketNumber}`;
  const body = `
    ${headingBlock(escapeHtml(subject))}
    ${textBlock(`${urgent ? '<strong style="color: #B42318;">Their event is happening now.</strong> ' : ''}${escapeHtml(organizerName)} ${followUp ? 'wrote back on' : 'sent'} ticket <strong style="color: #111111;">#${escapeHtml(ticketNumber)}</strong>.`)}
    ${renderHelpFacts([['Organization', organizerName], ['Email', organizerEmail], ['Topic', topicLabel], ['Event', eventTitle], ['Screenshot', hasScreenshot ? 'Attached in Ingather' : '']])}
    ${renderHelpMessage(message)}
    ${helpButtonRow(`${HELP_APP_ORIGIN}/admin/help/${ticketNumber}`, 'Open in the admin dashboard')}
    ${textBlock('Reply from the admin dashboard so the answer shows in their Help page. Replying to this email reaches them by email only.', { size: 13, color: '#6B6B6B', padding: '0 28px 24px' })}`;
  return renderEmailLayout({
    title,
    preheader: `${organizerName}: ${subject}`,
    tag: urgent ? 'Urgent ticket' : 'Help ticket',
    body,
    footer: 'You get this because you are on the Ingather support team.'
  });
};

// To the organizer, confirming their ticket arrived.
const buildHelpReceiptEmailHtml = ({ ticketNumber, subject, message, urgent }) => {
  const body = `
    ${headingBlock(`We got your ticket #${escapeHtml(ticketNumber)}`)}
    ${textBlock(urgent
      ? 'You told us your event is happening now, so it is at the top of our list. We will reply in Ingather and by email.'
      : 'Thanks for writing. We will reply in your Help page in Ingather and by email.')}
    ${renderHelpFacts([['Ticket', `#${ticketNumber}`], ['Subject', subject]])}
    ${renderHelpMessage(message)}
    ${helpButtonRow(`${HELP_APP_ORIGIN}/help/${ticketNumber}`, 'View your ticket')}`;
  return renderEmailLayout({
    title: `We got your ticket #${ticketNumber}`,
    preheader: `Ticket #${ticketNumber}: ${subject}`,
    tag: 'Help',
    body,
    footer: 'You get this because you sent a ticket from your Ingather workspace.'
  });
};

// To the organizer when someone on the Ingather team replies (used by the admin dashboard).
const buildHelpReplyEmailHtml = ({ ticketNumber, subject, adminName, reply }) => {
  const body = `
    ${headingBlock(`Ingather replied to ticket #${escapeHtml(ticketNumber)}`)}
    ${textBlock(`<strong style="color: #111111;">${escapeHtml(adminName || 'The Ingather team')}</strong> answered "${escapeHtml(subject)}".`)}
    ${renderHelpMessage(reply, { tinted: true })}
    ${helpButtonRow(`${HELP_APP_ORIGIN}/help/${ticketNumber}`, 'Reply in Ingather')}`;
  return renderEmailLayout({
    title: `Ingather replied to ticket #${ticketNumber}`,
    preheader: String(reply || '').slice(0, 120),
    tag: 'Help',
    body,
    footer: 'You get this because you sent a ticket from your Ingather workspace.'
  });
};

const getHelpInbox = () => process.env.HELP_INBOX_EMAIL || 'ingatherr@gmail.com';

const sendHelpTeamEmail = async (details) => {
  const result = await sendZeptoMailEmail({
    to: getHelpInbox(),
    recipientName: 'Ingather support',
    subject: `${details.urgent ? 'URGENT ' : ''}${details.followUp ? 'Reply' : 'Ticket'} #${details.ticketNumber}: ${details.subject}`,
    html: buildHelpTeamEmailHtml(details),
    replyTo: details.organizerEmail ? { address: details.organizerEmail, name: details.organizerName } : undefined
  });
  if (!result.sent) console.error('Help team email error:', result.reason);
  return result;
};

const sendHelpReceiptEmail = async ({ email, organizerName, ...details }) => {
  const result = await sendZeptoMailEmail({
    to: email,
    recipientName: organizerName,
    subject: `We got your ticket #${details.ticketNumber}`,
    html: buildHelpReceiptEmailHtml(details)
  });
  if (!result.sent) console.error('Help receipt email error:', result.reason);
  return result;
};

const sendHelpReplyEmail = async ({ email, organizerName, ...details }) => {
  const result = await sendZeptoMailEmail({
    to: email,
    recipientName: organizerName,
    subject: `Ingather replied to ticket #${details.ticketNumber}`,
    html: buildHelpReplyEmailHtml(details)
  });
  if (!result.sent) console.error('Help reply email error:', result.reason);
  return result;
};

module.exports = {
  buildDeviceCodeEmailHtml,
  buildSigninAlertEmailHtml,
  sendDeviceCodeEmail,
  sendSigninAlertEmail,
  buildPasswordResetEmailHtml,
  buildRsvpQrEmailHtml,
  buildRsvpQrEmailPayload,
  buildVerificationEmailHtml,
  buildWaitlistInviteEmailHtml,
  generateOTP,
  sendZeptoMailEmail,
  sendOTPEmail,
  sendPasswordResetEmail,
  sendRsvpQrEmail,
  sendRsvpQrEmailBatch,
  sendWaitlistInviteEmail,
  buildHelpTeamEmailHtml,
  buildHelpReceiptEmailHtml,
  buildHelpReplyEmailHtml,
  sendHelpTeamEmail,
  sendHelpReceiptEmail,
  sendHelpReplyEmail
};
