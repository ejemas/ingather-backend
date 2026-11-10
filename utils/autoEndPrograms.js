// Ends events automatically 12 hours after their end time, so old check-in links stop working.
//
// Event dates and times are saved as Nigeria time (Africa/Lagos). An event whose end time is
// earlier than its start time (for example 8:00 PM to 2:00 AM) is treated as ending the next day.

const AUTO_END_HOURS = 12;
const EVENT_TIMEZONE = 'Africa/Lagos';

// The moment the event ends, as a real point in time.
const eventEndSql = (alias = 'p') => `(
  (${alias}.date + ${alias}.end_time
    + CASE WHEN ${alias}.end_time <= ${alias}.start_time THEN INTERVAL '1 day' ELSE INTERVAL '0' END
  ) AT TIME ZONE '${EVENT_TIMEZONE}'
)`;

const autoEndAtSql = (alias = 'p') => `(${eventEndSql(alias)} + INTERVAL '${AUTO_END_HOURS} hours')`;

const notifyEnded = (io, rows) => {
  if (!io) return;
  rows.forEach((row) => {
    io.emit(`program-${row.id}-update`, { isActive: false, autoEnded: true, timestamp: new Date() });
  });
};

// Ends every overdue event, or just one when programId is given. Returns the ids it ended.
const endOverduePrograms = async (db, { programId = null, io = null } = {}) => {
  const params = [];
  let onlyThis = '';
  if (programId !== null && programId !== undefined) {
    const id = Number(programId);
    if (!Number.isInteger(id) || id <= 0) return [];
    params.push(id);
    onlyThis = 'AND p.id = $1';
  }

  const result = await db.query(
    `UPDATE programs p
     SET is_active = false
     WHERE p.is_active = true
       ${onlyThis}
       AND ${autoEndAtSql('p')} <= NOW()
     RETURNING p.id`,
    params
  );

  if (result.rows.length > 0) {
    console.log(`Auto-ended ${result.rows.length} event(s) 12 hours after their end time: ${result.rows.map((row) => row.id).join(', ')}`);
    notifyEnded(io, result.rows);
  }
  return result.rows.map((row) => row.id);
};

// Express middleware. Guest check-in requests check their own event every time, so a link
// stops working on time. Organizer requests run a full sweep at most once a minute.
const SWEEP_EVERY_MS = 60 * 1000;
let lastSweepAt = 0;
let sweeping = null;

const sweepAll = (db, io) => {
  if (sweeping) return sweeping;
  if (Date.now() - lastSweepAt < SWEEP_EVERY_MS) return Promise.resolve([]);
  lastSweepAt = Date.now();
  sweeping = endOverduePrograms(db, { io }).finally(() => { sweeping = null; });
  return sweeping;
};

const autoEndMiddleware = (db) => async (req, res, next) => {
  try {
    const io = req.app?.get?.('io');
    const programId = req.params?.programId;
    if (programId !== undefined) await endOverduePrograms(db, { programId, io });
    else await sweepAll(db, io);
  } catch (error) {
    // Never block a request because of this check.
    console.error('Auto-end check failed:', error.message);
  }
  next();
};

// Background sweep, so events end even when nobody opens the app.
const startAutoEndTimer = (db, io, everyMs = 5 * 60 * 1000) => {
  const run = () => endOverduePrograms(db, { io }).catch((error) => console.error('Auto-end sweep failed:', error.message));
  run();
  const timer = setInterval(run, everyMs);
  if (timer.unref) timer.unref();
  return timer;
};

const resetSweepThrottle = () => { lastSweepAt = 0; sweeping = null; };

module.exports = {
  AUTO_END_HOURS,
  EVENT_TIMEZONE,
  eventEndSql,
  autoEndAtSql,
  endOverduePrograms,
  autoEndMiddleware,
  startAutoEndTimer,
  resetSweepThrottle
};
