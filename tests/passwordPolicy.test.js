const test = require('node:test');
const assert = require('node:assert/strict');
const { getPasswordProblem, isCommonPassword } = require('../utils/passwordPolicy');

test('accepts passwords with 8+ characters, letters and numbers', () => {
  assert.equal(getPasswordProblem('Builders26'), '');
  assert.equal(getPasswordProblem('kano2026x'), '');
  assert.equal(getPasswordProblem('Builders#Lagos26'), '');
});

test('rejects short, letter-only, number-only and very long passwords', () => {
  assert.equal(getPasswordProblem('abc1234'), 'Use at least 8 characters');
  assert.equal(getPasswordProblem('abcdefghij'), 'Use both letters and numbers');
  assert.equal(getPasswordProblem('83749201'), 'Use both letters and numbers');
  assert.equal(getPasswordProblem(`a1${'x'.repeat(70)}`), 'Use 64 characters or fewer');
  assert.equal(getPasswordProblem(''), 'Password is required');
  assert.equal(getPasswordProblem(undefined), 'Password is required');
});

test('rejects common passwords, including with numbers or symbols added', () => {
  for (const value of ['password', 'Password2026!', 'qwerty123', 'lagos2026', 'Jesus1234', '12345678', 'aaaaaaaa', 'Ingather2026']) {
    assert.equal(isCommonPassword(value), true, value);
  }
  assert.equal(isCommonPassword('Builders26'), false);
});
