const buckets = new Map();

const defaultKeyGenerator = (req) => `${req.ip || req.socket?.remoteAddress || 'unknown'}:${req.baseUrl}:${req.path}`;

const createRateLimiter = ({
  windowMs = 15 * 60 * 1000,
  max = 100,
  keyGenerator = defaultKeyGenerator,
  message = 'Too many requests. Please try again later.'
} = {}) => {
  return (req, res, next) => {
    const now = Date.now();
    const key = keyGenerator(req);
    const existing = buckets.get(key);

    if (!existing || existing.resetAt <= now) {
      buckets.set(key, { count: 1, resetAt: now + windowMs });
      return next();
    }

    existing.count += 1;
    const retryAfter = Math.ceil((existing.resetAt - now) / 1000);

    res.set('Retry-After', String(retryAfter));

    if (existing.count > max) {
      return res.status(429).json({ error: message });
    }

    return next();
  };
};

setInterval(() => {
  const now = Date.now();
  for (const [key, value] of buckets.entries()) {
    if (value.resetAt <= now) {
      buckets.delete(key);
    }
  }
}, 10 * 60 * 1000).unref();

module.exports = createRateLimiter;
