const pool = require('../config/database');
const { sendWaitlistInviteEmail } = require('../utils/emailService');
const {
  createInviteToken,
  findValidInvite,
  hashInviteToken,
  inviteExpiresAt,
  mapInviteLead,
  normalizeEmail
} = require('../utils/waitlistInviteService');

const EVENT_SIZE_OPTIONS = new Set(['1-50', '50-200', '200-500', '500+']);
const STATUS_PENDING = 'pending';

const normalizeText = (value) => String(value || '').trim();

const isValidEmail = (email) => {
  return /^[^\s@]+@[^\s@]+\.[^\s@]+$/.test(email) && email.length <= 255;
};

const getCanonicalBaseUrl = () => {
  return (process.env.FRONTEND_URL || 'https://ingather.app').replace(/\/+$/, '');
};

const requireAdmin = (req, res) => {
  const adminKey = req.header('X-Admin-Key');
  if (!adminKey || adminKey !== process.env.ADMIN_API_KEY) {
    res.status(403).json({ error: 'Unauthorized: invalid admin key' });
    return false;
  }
  return true;
};

const mapLead = (row) => ({
  id: row.id,
  firstName: row.first_name,
  lastName: row.last_name,
  email: row.email,
  organizationName: row.organization_name,
  eventSize: row.event_size,
  status: row.status,
  createdAt: row.created_at,
  invitedAt: row.invited_at,
  inviteExpiresAt: row.invite_expires_at,
  acceptedAt: row.accepted_at,
  rejectedAt: row.rejected_at,
  acceptedChurchId: row.accepted_church_id
});

exports.joinWaitlist = async (req, res) => {
  try {
    const {
      firstName,
      lastName,
      email,
      organizationName,
      eventSize,
      website
    } = req.body || {};

    if (normalizeText(website)) {
      return res.status(204).send();
    }

    const normalizedFirstName = normalizeText(firstName);
    const normalizedLastName = normalizeText(lastName);
    const normalizedEmail = normalizeEmail(email);
    const normalizedOrganizationName = normalizeText(organizationName);
    const normalizedEventSize = normalizeText(eventSize);

    if (!normalizedFirstName || normalizedFirstName.length > 80) {
      return res.status(400).json({ error: 'First name is required.' });
    }

    if (!normalizedLastName || normalizedLastName.length > 80) {
      return res.status(400).json({ error: 'Last name is required.' });
    }

    if (!isValidEmail(normalizedEmail)) {
      return res.status(400).json({ error: 'Enter a valid email address.' });
    }

    if (normalizedOrganizationName.length > 180) {
      return res.status(400).json({ error: 'Organization name is too long.' });
    }

    if (!EVENT_SIZE_OPTIONS.has(normalizedEventSize)) {
      return res.status(400).json({ error: 'Choose a valid event size.' });
    }

    const result = await pool.query(
      `INSERT INTO waitlist_leads (
        first_name,
        last_name,
        email,
        organization_name,
        event_size,
        status
      )
      VALUES ($1, $2, $3, $4, $5, $6)
      RETURNING id, email, status, created_at`,
      [
        normalizedFirstName,
        normalizedLastName,
        normalizedEmail,
        normalizedOrganizationName || null,
        normalizedEventSize,
        STATUS_PENDING
      ]
    );

    return res.status(201).json({
      message: 'You are on the waitlist.',
      lead: {
        id: result.rows[0].id,
        email: result.rows[0].email,
        status: result.rows[0].status,
        createdAt: result.rows[0].created_at
      }
    });
  } catch (error) {
    if (error.code === '23505') {
      return res.status(409).json({
        error: 'This email is already on the Ingather waitlist.'
      });
    }

    console.error('Waitlist join error:', error);
    return res.status(500).json({ error: 'Server error joining waitlist.' });
  }
};

exports.getAdminLeads = async (req, res) => {
  if (!requireAdmin(req, res)) return;

  try {
    const result = await pool.query(
      `SELECT *
       FROM waitlist_leads
       ORDER BY created_at DESC`
    );

    return res.json({ leads: result.rows.map(mapLead) });
  } catch (error) {
    console.error('Get waitlist leads error:', error);
    return res.status(500).json({ error: 'Server error fetching waitlist leads.' });
  }
};

exports.inviteLead = async (req, res) => {
  if (!requireAdmin(req, res)) return;

  try {
    const { id } = req.params;
    const token = createInviteToken();
    const tokenHash = hashInviteToken(token);
    const expiresAt = inviteExpiresAt();

    const result = await pool.query(
      `UPDATE waitlist_leads
       SET status = 'invited',
           invite_token_hash = $2,
           invite_expires_at = $3,
           invited_at = NOW(),
           rejected_at = NULL
       WHERE id = $1
         AND status IN ('pending', 'invited', 'rejected')
       RETURNING *`,
      [id, tokenHash, expiresAt]
    );

    if (result.rows.length === 0) {
      return res.status(404).json({ error: 'Lead not found or already accepted.' });
    }

    const lead = result.rows[0];
    const inviteLink = `${getCanonicalBaseUrl()}/register?invite=${encodeURIComponent(token)}`;
    const emailResult = await sendWaitlistInviteEmail({
      email: lead.email,
      firstName: lead.first_name,
      inviteLink
    });

    return res.json({
      message: 'Invite generated.',
      lead: mapLead(lead),
      inviteLink,
      emailSent: Boolean(emailResult.sent),
      emailWarning: emailResult.sent ? null : emailResult.reason
    });
  } catch (error) {
    console.error('Invite waitlist lead error:', error);
    return res.status(500).json({ error: 'Server error generating invite.' });
  }
};

exports.rejectLead = async (req, res) => {
  if (!requireAdmin(req, res)) return;

  try {
    const result = await pool.query(
      `UPDATE waitlist_leads
       SET status = 'rejected',
           rejected_at = NOW(),
           invite_token_hash = NULL,
           invite_expires_at = NULL
       WHERE id = $1
         AND status <> 'accepted'
       RETURNING *`,
      [req.params.id]
    );

    if (result.rows.length === 0) {
      return res.status(404).json({ error: 'Lead not found or already accepted.' });
    }

    return res.json({ message: 'Lead rejected.', lead: mapLead(result.rows[0]) });
  } catch (error) {
    console.error('Reject waitlist lead error:', error);
    return res.status(500).json({ error: 'Server error rejecting lead.' });
  }
};

exports.revokeLead = async (req, res) => {
  if (!requireAdmin(req, res)) return;

  try {
    const result = await pool.query(
      `UPDATE waitlist_leads
       SET status = 'pending',
           invite_token_hash = NULL,
           invite_expires_at = NULL,
           invited_at = NULL,
           rejected_at = NULL
       WHERE id = $1
         AND status = 'invited'
       RETURNING *`,
      [req.params.id]
    );

    if (result.rows.length === 0) {
      return res.status(404).json({ error: 'Invited lead not found.' });
    }

    return res.json({ message: 'Invite revoked.', lead: mapLead(result.rows[0]) });
  } catch (error) {
    console.error('Revoke waitlist lead error:', error);
    return res.status(500).json({ error: 'Server error revoking invite.' });
  }
};

exports.validateInvite = async (req, res) => {
  try {
    const lead = await findValidInvite(req.params.token);

    if (!lead) {
      return res.status(404).json({ error: 'This invite link is invalid or has expired.' });
    }

    return res.json({
      invite: {
        valid: true,
        lead: mapInviteLead(lead)
      }
    });
  } catch (error) {
    console.error('Validate invite error:', error);
    return res.status(500).json({ error: 'Server error validating invite.' });
  }
};
