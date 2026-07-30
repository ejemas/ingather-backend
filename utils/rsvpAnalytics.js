const RSVP_ANALYTICS_TIMEZONE = 'Africa/Lagos';
const RSVP_VELOCITY_DAYS = 14;

const getDateKeyInTimeZone = (value, timeZone = RSVP_ANALYTICS_TIMEZONE) => {
  const date = value instanceof Date ? value : new Date(value);
  if (Number.isNaN(date.getTime())) return '';

  const parts = new Intl.DateTimeFormat('en-US', {
    timeZone,
    year: 'numeric',
    month: '2-digit',
    day: '2-digit'
  }).formatToParts(date);
  const lookup = Object.fromEntries(parts.map(part => [part.type, part.value]));
  return `${lookup.year}-${lookup.month}-${lookup.day}`;
};

const buildVelocityDateKeys = (todayKey) => {
  const [year, month, day] = String(todayKey).split('-').map(Number);
  if (![year, month, day].every(Number.isInteger)) return [];

  const todayAtNoonUtc = new Date(Date.UTC(year, month - 1, day, 12));
  return Array.from({ length: RSVP_VELOCITY_DAYS }, (_, index) => {
    const date = new Date(todayAtNoonUtc);
    date.setUTCDate(date.getUTCDate() - (RSVP_VELOCITY_DAYS - 1 - index));
    return {
      date: date.toISOString().slice(0, 10),
      label: date.toLocaleDateString('en-US', {
        timeZone: 'UTC',
        month: 'short',
        day: 'numeric'
      })
    };
  });
};

const buildRsvpAnalytics = (rows, now = new Date()) => {
  const rsvps = Array.isArray(rows) ? rows : [];
  const todayKey = getDateKeyInTimeZone(now);
  const countsByDate = rsvps.reduce((counts, row) => {
    const dateKey = String(row.registration_date_key || row.registrationDateKey || '');
    if (/^\d{4}-\d{2}-\d{2}$/.test(dateKey)) {
      counts[dateKey] = (counts[dateKey] || 0) + 1;
    }
    return counts;
  }, {});

  return {
    totalRsvps: rsvps.length,
    todayRsvps: countsByDate[todayKey] || 0,
    velocity: buildVelocityDateKeys(todayKey).map(day => ({
      ...day,
      registrations: countsByDate[day.date] || 0
    }))
  };
};

module.exports = {
  RSVP_ANALYTICS_TIMEZONE,
  RSVP_VELOCITY_DAYS,
  buildRsvpAnalytics,
  getDateKeyInTimeZone
};
