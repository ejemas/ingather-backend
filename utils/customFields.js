const crypto = require('crypto');

const CUSTOM_FIELD_TYPES = new Set(['text', 'radio', 'checkbox']);
const MAX_CUSTOM_FIELDS = 15;
const MAX_OPTIONS = 12;
const MAX_LABEL_LENGTH = 120;
const MAX_OPTION_LENGTH = 80;
const MAX_TEXT_RESPONSE_LENGTH = 500;

const cleanText = (value, maxLength = 255) => (
  typeof value === 'string' ? value.trim().slice(0, maxLength) : ''
);

const createCustomFieldId = () => `cf_${crypto.randomBytes(8).toString('hex')}`;

const normalizeCustomFieldId = (value) => {
  const cleaned = cleanText(value, 80).toLowerCase().replace(/[^a-z0-9_-]/g, '');
  return cleaned && cleaned.startsWith('cf_') ? cleaned : createCustomFieldId();
};

const normalizeOptions = (options = []) => {
  if (!Array.isArray(options)) return [];

  const seen = new Set();
  const normalized = [];

  options.forEach((option) => {
    const cleaned = cleanText(option, MAX_OPTION_LENGTH);
    const key = cleaned.toLowerCase();
    if (cleaned && !seen.has(key)) {
      seen.add(key);
      normalized.push(cleaned);
    }
  });

  return normalized.slice(0, MAX_OPTIONS);
};

const normalizeCustomFieldSchema = (schema = []) => {
  if (!Array.isArray(schema)) return [];

  return schema
    .filter(field => field && typeof field === 'object')
    .slice(0, MAX_CUSTOM_FIELDS)
    .map((field) => {
      const type = CUSTOM_FIELD_TYPES.has(field.type) ? field.type : 'text';
      const normalized = {
        id: normalizeCustomFieldId(field.id),
        label: cleanText(field.label, MAX_LABEL_LENGTH),
        type,
        required: Boolean(field.required),
        options: []
      };

      if (type === 'radio' || type === 'checkbox') {
        normalized.options = normalizeOptions(field.options);
      }

      return normalized;
    })
    .filter((field) => {
      if (!field.label) return false;
      if ((field.type === 'radio' || field.type === 'checkbox') && field.options.length < 2) return false;
      return true;
    });
};

const validateCustomResponses = (schema = [], responses = {}) => {
  const normalizedSchema = normalizeCustomFieldSchema(schema);
  const source = responses && typeof responses === 'object' ? responses : {};
  const values = {};
  const errors = {};

  normalizedSchema.forEach((field) => {
    const rawValue = source[field.id];

    if (field.type === 'checkbox') {
      const selected = Array.isArray(rawValue)
        ? rawValue.map(value => cleanText(String(value), MAX_OPTION_LENGTH)).filter(Boolean)
        : [];
      const validSelected = selected.filter(value => field.options.includes(value));

      if (field.required && validSelected.length === 0) {
        errors[field.id] = `${field.label} is required`;
      } else if (selected.length !== validSelected.length) {
        errors[field.id] = `${field.label} contains an invalid option`;
      }

      if (validSelected.length > 0) values[field.id] = [...new Set(validSelected)];
      return;
    }

    const value = cleanText(String(rawValue || ''), field.type === 'text' ? MAX_TEXT_RESPONSE_LENGTH : MAX_OPTION_LENGTH);

    if (field.required && !value) {
      errors[field.id] = `${field.label} is required`;
      return;
    }

    if (field.type === 'radio' && value && !field.options.includes(value)) {
      errors[field.id] = `${field.label} contains an invalid option`;
      return;
    }

    if (value) values[field.id] = value;
  });

  return { values, errors };
};

module.exports = {
  normalizeCustomFieldSchema,
  validateCustomResponses
};
