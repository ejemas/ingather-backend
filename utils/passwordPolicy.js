// Password rules for new passwords (sign-up, reset, change).
// Existing passwords are not affected: login never checks these rules.
// Keep this list in step with src/components/AccountLayout.js in the frontend.

const PASSWORD_MIN_LENGTH = 8;
const PASSWORD_MAX_LENGTH = 64;

const COMMON_PASSWORDS = new Set([
  'password', 'passw0rd', 'password1', 'qwerty', 'qwertyuiop', 'qwerty123', 'asdfghjkl', 'zxcvbnm',
  '1q2w3e4r', '1q2w3e4r5t', 'zaq12wsx', 'iloveyou', 'admin', 'administrator', 'welcome', 'letmein',
  'abc123', 'abcd1234', 'football', 'baseball', 'monkey', 'dragon', 'sunshine', 'princess', 'master',
  'hello', 'freedom', 'whatever', 'trustno1', 'starwars', 'login', 'changeme', 'secret', 'superman',
  'batman', 'michael', 'shadow', 'nigeria', 'naija', 'lagos', 'abuja', 'jesus', 'jesuschrist',
  'godisgood', 'blessed', 'blessing', 'favour', 'favor', 'grace', 'ingather', 'church', 'event',
  'events', 'summer', 'winter', 'computer', 'internet', 'samsung', 'iphone', 'google'
]);

const NUMERIC_RUNS = ['0123456789', '1234567890', '9876543210', '0987654321'];

const isCommonPassword = (password) => {
  const lower = String(password || '').toLowerCase();
  if (!lower) return false;
  if (/^(.)\1+$/.test(lower)) return true;
  if (/^\d+$/.test(lower) && NUMERIC_RUNS.some((run) => run.includes(lower) || lower.includes(run.slice(0, 6)))) return true;
  if (COMMON_PASSWORDS.has(lower)) return true;
  const stripped = lower.replace(/[^a-z]+$/g, '').replace(/^[^a-z]+/g, '');
  return Boolean(stripped) && COMMON_PASSWORDS.has(stripped);
};

// Returns '' when the password is acceptable, otherwise a message for the person.
const getPasswordProblem = (password) => {
  if (typeof password !== 'string' || password.length === 0) return 'Password is required';
  if (isCommonPassword(password)) return 'This password is too common. Pick another.';
  if (password.length < PASSWORD_MIN_LENGTH) return `Use at least ${PASSWORD_MIN_LENGTH} characters`;
  if (password.length > PASSWORD_MAX_LENGTH) return `Use ${PASSWORD_MAX_LENGTH} characters or fewer`;
  if (!/[A-Za-z]/.test(password) || !/\d/.test(password)) return 'Use both letters and numbers';
  return '';
};

// For express-validator: body('password').custom(passwordValidator)
const passwordValidator = (value) => {
  const problem = getPasswordProblem(value);
  if (problem) throw new Error(problem);
  return true;
};

module.exports = {
  PASSWORD_MIN_LENGTH,
  PASSWORD_MAX_LENGTH,
  getPasswordProblem,
  isCommonPassword,
  passwordValidator
};
