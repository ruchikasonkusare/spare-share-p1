const { createError } = require("../utils/errors");

// Fixed-window in-memory limiter. State is per process: when the API runs
// on several instances each instance keeps its own counters.
const createRateLimiter = ({ windowMs, max, keyGenerator, code = "RATE_LIMITED" }) => {
  const buckets = new Map();

  const sweep = setInterval(() => {
    const now = Date.now();
    for (const [key, bucket] of buckets) {
      if (bucket.resetAt <= now) buckets.delete(key);
    }
  }, Math.max(windowMs, 10000));
  sweep.unref();

  const consume = (key) => {
    const now = Date.now();
    let bucket = buckets.get(key);
    if (!bucket || bucket.resetAt <= now) {
      bucket = { count: 0, resetAt: now + windowMs };
      buckets.set(key, bucket);
    }
    bucket.count += 1;
    return {
      allowed: bucket.count <= max,
      remaining: Math.max(0, max - bucket.count),
      retryAfterSeconds: Math.max(1, Math.ceil((bucket.resetAt - now) / 1000)),
    };
  };

  const middleware = (req, res, next) => {
    const key = keyGenerator ? keyGenerator(req) : req.ip;
    const result = consume(String(key));
    res.setHeader("X-RateLimit-Limit", String(max));
    res.setHeader("X-RateLimit-Remaining", String(result.remaining));
    if (!result.allowed) {
      res.setHeader("Retry-After", String(result.retryAfterSeconds));
      return next(createError("Too many requests. Please try again later.", 429, code));
    }
    return next();
  };

  middleware.consume = consume;
  return middleware;
};

module.exports = { createRateLimiter };
