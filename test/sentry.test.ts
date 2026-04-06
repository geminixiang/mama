import type { Breadcrumb, Event } from "@sentry/node";
import { describe, expect, test } from "vitest";
import {
  metricAttributes,
  sanitizeBreadcrumb,
  sanitizeEvent,
  sanitizeValue,
} from "../src/sentry.js";

describe("sanitizeValue", () => {
  test("redacts known sensitive fields", () => {
    expect(sanitizeValue("hello world", "text")).toBe("[Redacted text; length=11]");
    expect(
      sanitizeValue(
        {
          prompt: "secret",
          result: { value: "another secret" },
        },
        "payload",
      ),
    ).toEqual({
      prompt: "[Redacted prompt; length=6]",
      result: "[Redacted result; keys=1]",
    });
  });

  test("redacts local paths and tokens in plain strings", () => {
    expect(sanitizeValue("/Users/alice/project/file.ts sk-test-token-123456789012")).toBe(
      "[REDACTED_PATH] [REDACTED]",
    );
  });
});

describe("sanitizeBreadcrumb", () => {
  test("drops console breadcrumbs", () => {
    const breadcrumb: Breadcrumb = { category: "console", message: "secret" };
    expect(sanitizeBreadcrumb(breadcrumb)).toBeNull();
  });

  test("preserves safe http breadcrumbs", () => {
    const breadcrumb: Breadcrumb = {
      category: "http",
      message: "POST https://api.anthropic.com/v1/messages",
      data: { status_code: 200, url: "https://api.anthropic.com/v1/messages" },
    };

    expect(sanitizeBreadcrumb(breadcrumb)).toEqual(breadcrumb);
  });
});

describe("sanitizeEvent", () => {
  test("removes user, server name, headers, and sensitive extras", () => {
    const event: Event = {
      event_id: "123",
      user: { id: "U1", username: "alice" },
      server_name: "Alice-MacBook-Air.local",
      request: {
        headers: { authorization: "Bearer secret" },
        data: { prompt: "do not leak" },
      },
      extra: {
        systemPrompt: "hidden",
        safe: "visible",
      },
      breadcrumbs: [
        { category: "console", message: "secret" },
        { category: "http", message: "GET https://example.com" },
      ],
    };

    const sanitized = sanitizeEvent(event);
    expect(sanitized?.user).toBeUndefined();
    expect(sanitized?.server_name).toBeUndefined();
    expect(sanitized?.request?.headers).toBeUndefined();
    expect(sanitized?.request?.data).toBe("[Redacted body; keys=1]");
    expect(sanitized?.extra).toEqual({
      systemPrompt: "[Redacted systemPrompt; length=6]",
      safe: "visible",
    });
    expect(sanitized?.breadcrumbs).toEqual([
      { category: "http", message: "GET https://example.com" },
    ]);
  });
});

describe("metricAttributes", () => {
  test("drops undefined values", () => {
    expect(
      metricAttributes({
        channel_id: "C1",
        session_id: undefined,
        llm_calls: 2,
        error: false,
      }),
    ).toEqual({
      channel_id: "C1",
      llm_calls: 2,
      error: false,
    });
  });
});
