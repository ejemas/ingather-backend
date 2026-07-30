const MAX_RSVP_IMPORT_ROWS = 5000;
const RSVP_IMPORT_CHUNK_SIZE = 500;

const normalizeImportEmail = (value) => String(value || '').trim().toLowerCase();
const normalizeImportName = (value) => String(value || '').trim();

const isValidImportEmail = (value) => {
  const email = normalizeImportEmail(value);
  return email.length > 0
    && email.length <= 255
    && /^[^\s@]+@[^\s@]+\.[^\s@]+$/.test(email)
    && email.indexOf('@') === email.lastIndexOf('@');
};

const validateRsvpImportRows = (rows) => {
  if (!Array.isArray(rows)) {
    return {
      received: 0,
      validRows: [],
      errors: [{ sourceRow: null, emailAddress: '', type: 'invalid', reason: 'Rows must be an array.' }],
      invalidCount: 1,
      duplicateCount: 0
    };
  }

  const seenEmails = new Set();
  const validRows = [];
  const errors = [];
  let invalidCount = 0;
  let duplicateCount = 0;

  rows.forEach((row, index) => {
    const sourceRow = Number.isInteger(Number(row?.sourceRow)) && Number(row.sourceRow) > 0
      ? Number(row.sourceRow)
      : index + 2;
    const fullName = normalizeImportName(row?.fullName);
    const emailAddress = normalizeImportEmail(row?.emailAddress);

    let reason = '';
    if (!fullName) reason = 'Full Name is required.';
    else if (fullName.length > 255) reason = 'Full Name must be 255 characters or fewer.';
    else if (!emailAddress) reason = 'Email Address is required.';
    else if (!isValidImportEmail(emailAddress)) reason = 'Enter a valid email address.';

    if (reason) {
      invalidCount += 1;
      errors.push({ sourceRow, emailAddress, type: 'invalid', reason });
      return;
    }

    if (seenEmails.has(emailAddress)) {
      duplicateCount += 1;
      errors.push({
        sourceRow,
        emailAddress,
        type: 'duplicate',
        reason: 'This email appears more than once in the import.'
      });
      return;
    }

    seenEmails.add(emailAddress);
    validRows.push({ sourceRow, fullName, emailAddress });
  });

  return {
    received: rows.length,
    validRows,
    errors,
    invalidCount,
    duplicateCount
  };
};

module.exports = {
  MAX_RSVP_IMPORT_ROWS,
  RSVP_IMPORT_CHUNK_SIZE,
  isValidImportEmail,
  normalizeImportEmail,
  normalizeImportName,
  validateRsvpImportRows
};
