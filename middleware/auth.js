const jwt = require('jsonwebtoken');
const { isTokenStillValid } = require('../utils/sessionGuard');

const auth = async (req, res, next) => {
  let decoded;
  try {
    // Get token from header
    const token = req.header('Authorization')?.replace('Bearer ', '');

    if (!token) {
      return res.status(401).json({ error: 'No authentication token, access denied' });
    }

    // Verify token
    decoded = jwt.verify(token, process.env.JWT_SECRET);
  } catch (error) {
    return res.status(401).json({ error: 'Token is not valid' });
  }

  // Signed in before the password was last changed: this device has been signed out.
  if (!(await isTokenStillValid(decoded))) {
    return res.status(401).json({ error: 'Your password was changed, so you were signed out. Please log in again.', code: 'SESSION_ENDED' });
  }

  req.churchId = decoded.churchId;
  req.email = decoded.email;
  req.tokenExp = decoded.exp;
  return next();
};

module.exports = auth;
