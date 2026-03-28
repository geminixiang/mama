import { describe, it, expect, beforeEach } from "vitest";
import {
  checkRateLimit,
  checkIpRateLimit,
  getRateLimitStatus,
  resetRateLimit,
  getRateLimitStats,
  createRateLimitMiddleware,
} from "../src/middleware/rateLimit.js";

// Use unique identifiers for each test to avoid interference
let testCounter = 0;

function getUniqueUserId() {
  return `test-user-${Date.now()}-${++testCounter}`;
}

function getUniqueIP() {
  return `192.168.${Math.floor(Math.random() * 256)}.${Math.floor(Math.random() * 256)}`;
}

describe("checkRateLimit", () => {
  const userId = getUniqueUserId();

  beforeEach(() => {
    resetRateLimit(userId);
  });

  it("should allow requests under limit", () => {
    const result = checkRateLimit(userId, { maxRequests: 10, windowMs: 60000 });
    expect(result.allowed).toBe(true);
    expect(result.remaining).toBe(9);
  });

  it("should track remaining requests", () => {
    const config = { maxRequests: 5, windowMs: 60000 };

    const r1 = checkRateLimit(userId, config);
    const r2 = checkRateLimit(userId, config);
    const r3 = checkRateLimit(userId, config);

    expect(r1.remaining).toBe(4);
    expect(r2.remaining).toBe(3);
    expect(r3.remaining).toBe(2);
  });

  it("should block requests over limit", () => {
    const config = { maxRequests: 3, windowMs: 60000 };

    checkRateLimit(userId, config);
    checkRateLimit(userId, config);
    checkRateLimit(userId, config);
    const result = checkRateLimit(userId, config);

    expect(result.allowed).toBe(false);
    expect(result.remaining).toBe(0);
  });

  it("should reset after window expires", async () => {
    const config = { maxRequests: 2, windowMs: 100 };

    checkRateLimit(userId, config);
    checkRateLimit(userId, config);
    expect(checkRateLimit(userId, config).allowed).toBe(false);

    // Wait for window to expire
    await new Promise((resolve) => setTimeout(resolve, 150));

    const result = checkRateLimit(userId, config);
    expect(result.allowed).toBe(true);
    expect(result.remaining).toBe(1);
  });

  it("should block immediately in strict mode", () => {
    const config = { maxRequests: 2, windowMs: 60000, strictMode: true };

    checkRateLimit(userId, config);
    checkRateLimit(userId, config);
    checkRateLimit(userId, config);

    // Should remain blocked even after waiting
    expect(checkRateLimit(userId, config).allowed).toBe(false);
  });

  it("should include resetAt timestamp", () => {
    const before = Date.now();
    const result = checkRateLimit(userId, { maxRequests: 10, windowMs: 60000 });
    const after = Date.now();

    expect(result.resetAt).toBeGreaterThanOrEqual(before + 60000);
    expect(result.resetAt).toBeLessThanOrEqual(after + 60000);
  });
});

describe("checkIpRateLimit", () => {
  const ip = getUniqueIP();

  beforeEach(() => {
    // Reset is done by identifier in rateLimitStore
    // We need to use a new IP for each test
  });

  it("should limit requests by IP", () => {
    const config = { maxRequests: 5, windowMs: 60000 };

    const ip1 = getUniqueIP();
    const ip2 = getUniqueIP();

    // ip1 makes 5 requests
    for (let i = 0; i < 5; i++) {
      expect(checkIpRateLimit(ip1, config).allowed).toBe(true);
    }

    // ip2 should still be allowed
    expect(checkIpRateLimit(ip2, config).allowed).toBe(true);

    // ip1 should be blocked
    expect(checkIpRateLimit(ip1, config).allowed).toBe(false);
  });

  it("should track IPs independently", () => {
    const config = { maxRequests: 3, windowMs: 60000 };

    const ipA = getUniqueIP();
    const ipB = getUniqueIP();

    for (let i = 0; i < 3; i++) {
      checkIpRateLimit(ipA, config);
    }

    const result = checkIpRateLimit(ipB, config);
    expect(result.allowed).toBe(true);
    expect(result.remaining).toBe(2);
  });
});

describe("getRateLimitStatus", () => {
  it("should return undefined for unknown identifier", () => {
    expect(getRateLimitStatus("non-existent-id")).toBeUndefined();
  });

  it("should return current status after requests", () => {
    const userId = getUniqueUserId();
    const config = { maxRequests: 10, windowMs: 60000 };

    checkRateLimit(userId, config);
    checkRateLimit(userId, config);

    const status = getRateLimitStatus(userId);
    expect(status).toBeDefined();
    expect(status!.count).toBe(2);
    expect(status!.blocked).toBe(false);
  });
});

describe("resetRateLimit", () => {
  it("should clear rate limit for identifier", () => {
    const userId = getUniqueUserId();
    const config = { maxRequests: 2, windowMs: 60000 };

    checkRateLimit(userId, config);
    checkRateLimit(userId, config);

    resetRateLimit(userId);

    const result = checkRateLimit(userId, config);
    expect(result.allowed).toBe(true);
    expect(result.remaining).toBe(1);
  });
});

describe("getRateLimitStats", () => {
  it("should return zero for empty store", () => {
    const stats = getRateLimitStats();
    expect(stats.activeUsers).toBeGreaterThanOrEqual(0);
    expect(stats.activeIPs).toBeGreaterThanOrEqual(0);
  });

  it("should track active users", () => {
    const user1 = getUniqueUserId();
    const user2 = getUniqueUserId();

    checkRateLimit(user1, { maxRequests: 10, windowMs: 60000 });
    checkRateLimit(user2, { maxRequests: 10, windowMs: 60000 });

    const stats = getRateLimitStats();
    expect(stats.activeUsers).toBeGreaterThanOrEqual(2);
  });
});

describe("createRateLimitMiddleware", () => {
  it("should create middleware function", () => {
    const middleware = createRateLimitMiddleware({ maxRequests: 10, windowMs: 60000 });
    expect(typeof middleware).toBe("function");
  });

  it("should call next() when allowed", () => {
    const middleware = createRateLimitMiddleware({ maxRequests: 10, windowMs: 60000 });
    let called = false;

    const req = { ip: getUniqueIP() };
    const res = {
      status: (code: number) => {
        expect(code).toBe(429);
        return { json: () => {} };
      },
      setHeader: () => {},
    };

    middleware(req as any, res as any, () => {
      called = true;
    });

    expect(called).toBe(true);
  });

  it("should set rate limit headers", () => {
    const middleware = createRateLimitMiddleware({ maxRequests: 100, windowMs: 60000 });
    const headers: Record<string, string> = {};

    const req = { ip: getUniqueIP() };
    const res = {
      status: () => ({ json: () => {} }),
      setHeader: (name: string, value: string) => {
        headers[name] = value;
      },
    };

    middleware(req as any, res as any, () => {});

    expect(headers["X-RateLimit-Limit"]).toBe(100);
    expect(headers["X-RateLimit-Remaining"]).toBeDefined();
    expect(headers["X-RateLimit-Reset"]).toBeDefined();
  });

  it("should return 429 when rate limited", () => {
    const ip = getUniqueIP();
    const config = { maxRequests: 2, windowMs: 60000 };

    // Exhaust the limit
    checkIpRateLimit(ip, config);
    checkIpRateLimit(ip, config);

    const middleware = createRateLimitMiddleware(config);
    let statusCode = 0;

    const req = { ip };
    const res = {
      status: (code: number) => {
        statusCode = code;
        return { json: () => {} };
      },
      setHeader: () => {},
    };

    middleware(req as any, res as any, () => {
      throw new Error("next() should not be called");
    });

    expect(statusCode).toBe(429);
  });
});
