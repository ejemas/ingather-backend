const crypto = require('crypto');
const pool = require('../config/database');

const INVITE_DAYS = 14;

const normalizeEmail = (email) => String(email || '').trim().toLowerCase();

const hashInviteToken = (token) => {
  return crypto.createHash('sha256').update(String(token || '')).digest('hex');
};

const createInviteToken = () => {
  return crypto.randomBytes(32).toString('base64url');
};

const inviteExpiresAt = () => {
  return new Date(Date.now() + INVITE_DAYS * 24 * 60 * 60 * 1000);
};

const mapInviteLead = (row) => ({
  id: row.id,
  firstName: row.first_name,
  lastName: row.last_name,
  email: row.email,
  organizationName: row.organization_name,
  eventSize: row.event_size,
  status: row.status,
  inviteExpiresAt: row.invite_expires_at,
  invitedAt: row.invited_at,
  acceptedAt: row.accepted_at,
  rejectedAt: row.rejected_at
});

const findValidInvite = async (token) => {
  const tokenHash = hashInviteToken(token);

  const result = await pool.query(
    `SELECT *
     FROM waitlist_leads
     WHERE invite_token_hash = $1
       AND status = 'invited'
       AND accepted_at IS NULL
       AND rejected_at IS NULL
       AND invite_expires_at > NOW()
     LIMIT 1`,
    [tokenHash]
  );

  return result.rows[0] || null;
};

const acceptInvite = async ({ token, email, churchId }) => {
  const lead = await findValidInvite(token);
  const normalizedEmail = normalizeEmail(email);

  if (!lead) {
    return { ok: false, error: 'This invite link is invalid or has expired.' };
  }

  if (normalizeEmail(lead.email) !== normalizedEmail) {
    return { ok: false, error: 'This invite link is tied to a different email address.' };
  }

  const updateResult = await pool.query(
    `UPDATE waitlist_leads
     SET status = 'accepted',
         accepted_at = NOW(),
         accepted_church_id = $2,
         invite_token_hash = NULL
     WHERE id = $1
       AND status = 'invited'
       AND accepted_at IS NULL
       AND rejected_at IS NULL
     RETURNING *`,
    [lead.id, churchId]
  );

  if (updateResult.rows.length === 0) {
    return { ok: false, error: 'This invite has already been used.' };
  }

  return { ok: true, lead: updateResult.rows[0] };
};

module.exports = {
  INVITE_DAYS,
  acceptInvite,
  createInviteToken,
  findValidInvite,
  hashInviteToken,
  inviteExpiresAt,
  mapInviteLead,
  normalizeEmail
};
