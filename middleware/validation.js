const { validationResult } = require('express-validator');

const validate = (req, res, next) => {
  const errors = validationResult(req);
  if (!errors.isEmpty()) {
    const list = errors.array();
    return res.status(400).json({ error: list[0]?.msg || 'Please check the details and try again.', errors: list });
  }
  next();
};

module.exports = validate;