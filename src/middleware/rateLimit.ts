/**
 * Rate limiting middleware for mama bot
 * Prevents API abuse and ensures fair usage
 */

interface RateLimitRecord {
  count: number;
  resetAt: number;
  blocked: boolean;
}

interface RateLimitConfig {
  /** Maximum requests per window */
  maxRequests: number;
  /** Window size in milliseconds */
  windowMs: number;
  /** Whether to block immediately or just flag */
  strictMode: boolean;
}

/** Default configuration */
const DEFAULT_CONFIG: RateLimitConfig = {
  maxRequests: 100,
  windowMs: 60000, // 1 minute
  strictMode: false,
};

/** Store for rate limit records by user ID */
const rateLimitStore = new Map<string, RateLimitRecord>();

/** Store for rate limit records by IP (for OAuth server) */
const ipRateLimitStore = new Map<string, RateLimitRecord>();

/**
 * Check if a user has exceeded their rate limit
 */
export function checkRateLimit(
  identifier: string,
  config: Partial<RateLimitConfig> = {}
): { allowed: boolean; remaining: number; resetAt: number } {
  const { maxRequests, windowMs, strictMode } = { ...DEFAULT_CONFIG, ...config };
  const now = Date.now();

  // Clean up old records periodically
  if (Math.random() < 0.01) {
    cleanupExpiredRecords();
  }

  let record = rateLimitStore.get(identifier);

  // Initialize or reset if window expired
  if (!record || now > record.resetAt) {
    record = {
      count: 0,
      resetAt: now + windowMs,
      blocked: false,
    };
    rateLimitStore.set(identifier, record);
  }

  // Check if blocked in strict mode
  if (strictMode && record.blocked) {
    return {
      allowed: false,
      remaining: 0,
      resetAt: record.resetAt,
    };
  }

  // Increment counter
  record.count++;

  // Check if limit exceeded
  if (record.count > maxRequests) {
    if (strictMode) {
      record.blocked = true;
    }
    return {
      allowed: false,
      remaining: 0,
      resetAt: record.resetAt,
    };
  }

  return {
    allowed: true,
    remaining: Math.max(0, maxRequests - record.count),
    resetAt: record.resetAt,
  };
}

/**
 * Check rate limit for IP addresses (OAuth server)
 */
export function checkIpRateLimit(
  ip: string,
  config: Partial<RateLimitConfig> = {}
): { allowed: boolean; remaining: number; resetAt: number } {
  const { maxRequests, windowMs } = { ...DEFAULT_CONFIG, ...config };
  const now = Date.now();

  let record = ipRateLimitStore.get(ip);

  if (!record || now > record.resetAt) {
    record = {
      count: 0,
      resetAt: now + windowMs,
      blocked: false,
    };
    ipRateLimitStore.set(ip, record);
  }

  record.count++;

  if (record.count > maxRequests) {
    return {
      allowed: false,
      remaining: 0,
      resetAt: record.resetAt,
    };
  }

  return {
    allowed: true,
    remaining: Math.max(0, maxRequests - record.count),
    resetAt: record.resetAt,
  };
}

/**
 * Get current rate limit status for an identifier
 */
export function getRateLimitStatus(identifier: string): RateLimitRecord | undefined {
  return rateLimitStore.get(identifier);
}

/**
 * Reset rate limit for a specific identifier
 */
export function resetRateLimit(identifier: string): void {
  rateLimitStore.delete(identifier);
}

/**
 * Clean up expired records to prevent memory leaks
 */
function cleanupExpiredRecords(): void {
  const now = Date.now();

  for (const [key, record] of rateLimitStore.entries()) {
    if (now > record.resetAt) {
      rateLimitStore.delete(key);
    }
  }

  for (const [key, record] of ipRateLimitStore.entries()) {
    if (now > record.resetAt) {
      ipRateLimitStore.delete(key);
    }
  }
}

/**
 * Express middleware style helper for OAuth server
 */
interface MockResponse {
  status: (code: number) => MockResponse;
  json: (body: object) => MockResponse;
  setHeader: (name: string, value: string | number) => MockResponse;
}

export function createRateLimitMiddleware(
  config: Partial<RateLimitConfig> = {}
) {
  return (req: { ip?: string }, res: MockResponse, next: () => void) => {
    const ip = req.ip || "unknown";
    const result = checkIpRateLimit(ip, config);

    // Add rate limit headers
    res.setHeader("X-RateLimit-Limit", config.maxRequests || DEFAULT_CONFIG.maxRequests);
    res.setHeader("X-RateLimit-Remaining", result.remaining);
    res.setHeader("X-RateLimit-Reset", Math.ceil(result.resetAt / 1000));

    if (!result.allowed) {
      res.status(429).json({
        error: "Too Many Requests",
        retryAfter: Math.ceil((result.resetAt - Date.now()) / 1000),
      });
      return;
    }

    next();
  };
}

/**
 * Get statistics for monitoring
 */
export function getRateLimitStats(): {
  activeUsers: number;
  activeIPs: number;
} {
  const now = Date.now();
  
  let activeUsers = 0;
  for (const record of rateLimitStore.values()) {
    if (now <= record.resetAt) activeUsers++;
  }

  let activeIPs = 0;
  for (const record of ipRateLimitStore.values()) {
    if (now <= record.resetAt) activeIPs++;
  }

  return { activeUsers, activeIPs };
}
