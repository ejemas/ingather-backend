const pool = require('../config/database');

const QR_EMAIL_DAILY_LIMIT = 500;
const QR_EMAIL_BATCH_LIMIT = 500;
const QR_EMAIL_TIMEZONE = 'Africa/Lagos';
const QR_RESERVATION_TTL_MINUTES = 15;
const QR_QUOTA_LOCK_NAMESPACE = 731409;

const shouldApplyQrEmailQuota = (registrationSource) => (
  String(registrationSource || 'legacy').trim().toLowerCase() !== 'public'
);

const buildQuotaResponse = ({ sent = 0, reserved = 0, resetsAt = null }) => {
  const used = Math.max(0, Number(sent) || 0) + Math.max(0, Number(reserved) || 0);
  return {
    limit: QR_EMAIL_DAILY_LIMIT,
    used,
    remaining: Math.max(0, QR_EMAIL_DAILY_LIMIT - used),
    timezone: QR_EMAIL_TIMEZONE,
    resetsAt: resetsAt ? new Date(resetsAt).toISOString() : null
  };
};

const readQuota = async (queryable, churchId) => {
  const result = await queryable.query(
    `WITH bounds AS (
       SELECT
         date_trunc('day', CURRENT_TIMESTAMP AT TIME ZONE $2) AT TIME ZONE $2 AS day_start,
         (date_trunc('day', CURRENT_TIMESTAMP AT TIME ZONE $2) + INTERVAL '1 day') AT TIME ZONE $2 AS resets_at
     )
     SELECT
       COUNT(*) FILTER (
         WHERE sends.status = 'sent'
           AND sends.sent_at >= bounds.day_start
           AND sends.sent_at < bounds.resets_at
       ) AS sent_count,
       COUNT(*) FILTER (
         WHERE sends.status = 'reserved'
           AND sends.reserved_at >= GREATEST(
             bounds.day_start,
             CURRENT_TIMESTAMP - ($3::text || ' minutes')::interval
           )
           AND sends.reserved_at < bounds.resets_at
       ) AS reserved_count,
       bounds.resets_at
     FROM bounds
     LEFT JOIN rsvp_qr_email_sends sends ON sends.church_id = $1
     GROUP BY bounds.resets_at`,
    [churchId, QR_EMAIL_TIMEZONE, QR_RESERVATION_TTL_MINUTES]
  );

  const row = result.rows[0] || {};
  return buildQuotaResponse({
    sent: parseInt(row.sent_count || '0', 10),
    reserved: parseInt(row.reserved_count || '0', 10),
    resetsAt: row.resets_at || null
  });
};

const getQrEmailQuota = async (churchId) => readQuota(pool, churchId);

const expireQrEmailReservations = async (queryable, churchId) => {
  await queryable.query(
    `UPDATE rsvp_qr_email_sends
     SET status = 'failed',
         failure_reason = COALESCE(failure_reason, 'Reservation expired before completion.'),
         completed_at = CURRENT_TIMESTAMP
     WHERE church_id = $1
       AND status = 'reserved'
       AND reserved_at < CURRENT_TIMESTAMP - ($2::text || ' minutes')::interval`,
    [churchId, QR_RESERVATION_TTL_MINUTES]
  );
};

const createQuotaError = (quota) => {
  const error = new Error('Daily QR email limit reached. You can send more after midnight Lagos time.');
  error.statusCode = 429;
  error.code = 'QR_EMAIL_DAILY_LIMIT_REACHED';
  error.quota = quota;
  return error;
};

const reserveQrEmailSend = async ({ churchId, preEventId, rsvpId }) => {
  const client = await pool.connect();
  let transactionStarted = false;

  try {
    await client.query('BEGIN');
    transactionStarted = true;
    await client.query('SELECT pg_advisory_xact_lock($1, $2)', [QR_QUOTA_LOCK_NAMESPACE, Number(churchId)]);
    await expireQrEmailReservations(client, churchId);

    const quota = await readQuota(client, churchId);
    if (quota.remaining <= 0) {
      await client.query('ROLLBACK');
      transactionStarted = false;
      throw createQuotaError(quota);
    }

    const reservation = await client.query(
      `INSERT INTO rsvp_qr_email_sends
       (church_id, pre_event_id, rsvp_id, status)
       VALUES ($1, $2, $3, 'reserved')
       RETURNING id`,
      [churchId, preEventId, rsvpId]
    );

    await client.query('COMMIT');
    transactionStarted = false;

    return {
      reservationId: reservation.rows[0].id,
      quota: {
        ...quota,
        used: quota.used + 1,
        remaining: Math.max(0, quota.remaining - 1)
      }
    };
  } catch (error) {
    if (transactionStarted) await client.query('ROLLBACK');
    if (error.code === '23505') {
      const conflict = new Error('A QR email is already being prepared for this attendee.');
      conflict.statusCode = 409;
      conflict.code = 'QR_EMAIL_ALREADY_SENDING';
      throw conflict;
    }
    throw error;
  } finally {
    client.release();
  }
};

const reserveImportedQrEmailBatch = async ({
  churchId,
  preEventId,
  maxCount = QR_EMAIL_BATCH_LIMIT
}) => {
  const client = await pool.connect();
  let transactionStarted = false;

  try {
    await client.query('BEGIN');
    transactionStarted = true;
    await client.query('SELECT pg_advisory_xact_lock($1, $2)', [QR_QUOTA_LOCK_NAMESPACE, Number(churchId)]);
    await expireQrEmailReservations(client, churchId);

    const quota = await readQuota(client, churchId);
    if (quota.remaining <= 0) {
      await client.query('ROLLBACK');
      transactionStarted = false;
      throw createQuotaError(quota);
    }

    const selectionLimit = Math.min(
      QR_EMAIL_BATCH_LIMIT,
      Math.max(1, Number(maxCount) || QR_EMAIL_BATCH_LIMIT),
      quota.remaining
    );
    const candidatesResult = await client.query(
      `SELECT rsvp.*
       FROM pre_event_rsvps rsvp
       WHERE rsvp.pre_event_id = $1
         AND rsvp.registration_source = 'import'
         AND rsvp.checkin_qr_sent_at IS NULL
         AND rsvp.status = 'pre_registered'
         AND NOT EXISTS (
           SELECT 1
           FROM rsvp_qr_email_sends active_send
           WHERE active_send.rsvp_id = rsvp.id
             AND active_send.status = 'reserved'
         )
       ORDER BY rsvp.created_at ASC, rsvp.id ASC
       LIMIT $2
       FOR UPDATE OF rsvp SKIP LOCKED`,
      [preEventId, selectionLimit]
    );

    if (candidatesResult.rows.length === 0) {
      await client.query('COMMIT');
      transactionStarted = false;
      return { reservations: [], quota };
    }

    const reservationsResult = await client.query(
      `INSERT INTO rsvp_qr_email_sends
       (church_id, pre_event_id, rsvp_id, status)
       SELECT $1, $2, candidate.rsvp_id, 'reserved'
       FROM UNNEST($3::bigint[]) AS candidate(rsvp_id)
       RETURNING id, rsvp_id`,
      [churchId, preEventId, candidatesResult.rows.map(row => row.id)]
    );
    const reservationByRsvp = new Map(
      reservationsResult.rows.map(row => [String(row.rsvp_id), row.id])
    );

    await client.query('COMMIT');
    transactionStarted = false;

    const reservedCount = reservationsResult.rows.length;
    return {
      reservations: candidatesResult.rows.map(row => ({
        ...row,
        reservation_id: reservationByRsvp.get(String(row.id))
      })),
      quota: {
        ...quota,
        used: quota.used + reservedCount,
        remaining: Math.max(0, quota.remaining - reservedCount)
      }
    };
  } catch (error) {
    if (transactionStarted) await client.query('ROLLBACK');
    throw error;
  } finally {
    client.release();
  }
};

const completeQrEmailSend = async ({ reservationId, rsvpId, tokenHash }) => {
  const client = await pool.connect();
  let transactionStarted = false;

  try {
    await client.query('BEGIN');
    transactionStarted = true;
    await client.query(
      `UPDATE pre_event_rsvps
       SET checkin_token_hash = $1,
           checkin_qr_last_sent_at = CURRENT_TIMESTAMP,
           checkin_qr_sent_at = COALESCE(checkin_qr_sent_at, CURRENT_TIMESTAMP),
           updated_at = CURRENT_TIMESTAMP
       WHERE id = $2`,
      [tokenHash, rsvpId]
    );
    let churchId = null;
    if (reservationId) {
      const result = await client.query(
        `UPDATE rsvp_qr_email_sends
         SET status = 'sent',
             sent_at = CURRENT_TIMESTAMP,
             completed_at = CURRENT_TIMESTAMP,
             failure_reason = NULL
         WHERE id = $1 AND status = 'reserved'
         RETURNING church_id`,
        [reservationId]
      );
      churchId = result.rows[0]?.church_id || null;
    }
    await client.query('COMMIT');
    transactionStarted = false;
    return churchId ? getQrEmailQuota(churchId) : null;
  } catch (error) {
    if (transactionStarted) await client.query('ROLLBACK');
    throw error;
  } finally {
    client.release();
  }
};

const completeQrEmailBatch = async ({ churchId, successes = [], failures = [] }) => {
  const client = await pool.connect();
  let transactionStarted = false;
  const successfulRows = successes.filter(item => item?.reservationId && item?.rsvpId && item?.tokenHash);
  const failedRows = failures.filter(item => item?.reservationId);

  try {
    await client.query('BEGIN');
    transactionStarted = true;

    if (successfulRows.length > 0) {
      await client.query(
        `UPDATE pre_event_rsvps AS rsvp
         SET checkin_token_hash = completed.token_hash,
             checkin_qr_last_sent_at = CURRENT_TIMESTAMP,
             checkin_qr_sent_at = COALESCE(rsvp.checkin_qr_sent_at, CURRENT_TIMESTAMP),
             updated_at = CURRENT_TIMESTAMP
         FROM UNNEST($1::bigint[], $2::text[]) AS completed(rsvp_id, token_hash)
         WHERE rsvp.id = completed.rsvp_id`,
        [
          successfulRows.map(item => item.rsvpId),
          successfulRows.map(item => item.tokenHash)
        ]
      );
      await client.query(
        `UPDATE rsvp_qr_email_sends
         SET status = 'sent',
             sent_at = CURRENT_TIMESTAMP,
             completed_at = CURRENT_TIMESTAMP,
             failure_reason = NULL
         WHERE id = ANY($1::bigint[])
           AND status = 'reserved'`,
        [successfulRows.map(item => item.reservationId)]
      );
    }

    if (failedRows.length > 0) {
      await client.query(
        `UPDATE rsvp_qr_email_sends AS send
         SET status = 'failed',
             failure_reason = failed.reason,
             completed_at = CURRENT_TIMESTAMP
         FROM UNNEST($1::bigint[], $2::text[]) AS failed(reservation_id, reason)
         WHERE send.id = failed.reservation_id
           AND send.status = 'reserved'`,
        [
          failedRows.map(item => item.reservationId),
          failedRows.map(item => String(item.reason || 'QR email send failed.').slice(0, 1000))
        ]
      );
    }

    await client.query('COMMIT');
    transactionStarted = false;
    return getQrEmailQuota(churchId);
  } catch (error) {
    if (transactionStarted) await client.query('ROLLBACK');
    throw error;
  } finally {
    client.release();
  }
};

const failQrEmailSend = async (reservationId, reason) => {
  if (!reservationId) return null;
  const result = await pool.query(
    `UPDATE rsvp_qr_email_sends
     SET status = 'failed',
         failure_reason = $2,
         completed_at = CURRENT_TIMESTAMP
     WHERE id = $1 AND status = 'reserved'
     RETURNING church_id`,
    [reservationId, String(reason || 'QR email send failed.').slice(0, 1000)]
  );
  return result.rows[0]?.church_id ? getQrEmailQuota(result.rows[0].church_id) : null;
};

module.exports = {
  QR_EMAIL_BATCH_LIMIT,
  QR_EMAIL_DAILY_LIMIT,
  QR_EMAIL_TIMEZONE,
  buildQuotaResponse,
  completeQrEmailBatch,
  completeQrEmailSend,
  failQrEmailSend,
  getQrEmailQuota,
  reserveImportedQrEmailBatch,
  reserveQrEmailSend,
  shouldApplyQrEmailQuota
};
