import { describe, it, expect } from "vitest";
import {
  sanitizeInput,
  containsDangerousPatterns,
  sanitizeFileName,
  isValidSessionKey,
  escapeForLogging,
} from "../src/utils/sanitize.js";

describe("sanitizeInput", () => {
  it("should return empty string for null input", () => {
    expect(sanitizeInput(null)).toBe("");
    expect(sanitizeInput(undefined)).toBe("");
  });

  it("should trim whitespace", () => {
    expect(sanitizeInput("  hello  ")).toBe("hello");
    expect(sanitizeInput("\n\ttest\n")).toBe("test");
  });

  it("should remove null bytes", () => {
    expect(sanitizeInput("hel\x00lo")).toBe("hello");
  });

  it("should limit message length to 10000 characters", () => {
    const longText = "a".repeat(15000);
    expect(sanitizeInput(longText).length).toBe(10000);
  });

  it("should preserve normal text", () => {
    expect(sanitizeInput("Hello, World!")).toBe("Hello, World!");
    expect(sanitizeInput("中文測試")).toBe("中文測試");
  });
});

describe("containsDangerousPatterns", () => {
  it("should detect script tags", () => {
    expect(containsDangerousPatterns("<script>alert(1)</script>")).toBe(true);
    expect(containsDangerousPatterns("<SCRIPT>alert(1)</SCRIPT>")).toBe(true);
  });

  it("should detect javascript: protocol", () => {
    expect(containsDangerousPatterns("javascript:void(0)")).toBe(true);
    expect(containsDangerousPatterns("JAVASCRIPT:alert(1)")).toBe(true);
  });

  it("should detect inline event handlers", () => {
    expect(containsDangerousPatterns('<img onerror="alert(1)">')).toBe(true);
    expect(containsDangerousPatterns("onclick=alert(1)")).toBe(true);
    expect(containsDangerousPatterns("onmouseover=alert(1)")).toBe(true);
  });

  it("should return false for safe text", () => {
    expect(containsDangerousPatterns("Hello, World!")).toBe(false);
    expect(containsDangerousPatterns("This is a normal message")).toBe(false);
    expect(containsDangerousPatterns("中文內容")).toBe(false);
  });
});

describe("sanitizeFileName", () => {
  it("should prevent directory traversal", () => {
    // Each dot in ".." is replaced, so "../" becomes "__"
    expect(sanitizeFileName("../etc/passwd")).toBe("__etc_passwd");
    expect(sanitizeFileName("..\\windows\\system32")).toBe("__windows_system32");
  });

  it("should replace invalid characters", () => {
    expect(sanitizeFileName("file:name.txt")).toBe("file_name.txt");
    // Multiple special characters each get replaced
    expect(sanitizeFileName('file*name?"|.txt')).toBe("file_name___.txt");
  });

  it("should limit filename length", () => {
    const longName = "a".repeat(300) + ".txt";
    expect(sanitizeFileName(longName).length).toBe(255);
  });

  it("should preserve valid filenames", () => {
    expect(sanitizeFileName("document.pdf")).toBe("document.pdf");
    expect(sanitizeFileName("my-image_2024.png")).toBe("my-image_2024.png");
  });
});

describe("isValidSessionKey", () => {
  it("should validate Slack session keys", () => {
    expect(isValidSessionKey("slack:C0123456789")).toBe(true);
    expect(isValidSessionKey("slack:C0123456789:1234567890.123456")).toBe(true);
  });

  it("should validate Discord session keys", () => {
    expect(isValidSessionKey("discord:123456789012345678")).toBe(true);
    expect(isValidSessionKey("discord:123456789012345678:9876543210.123")).toBe(true);
  });

  it("should validate Telegram session keys", () => {
    expect(isValidSessionKey("telegram:-1001234567890")).toBe(true);
  });

  it("should reject invalid platform", () => {
    expect(isValidSessionKey("invalid:channel")).toBe(false);
    expect(isValidSessionKey("unknown:123")).toBe(false);
  });

  it("should reject malformed keys", () => {
    expect(isValidSessionKey("slack")).toBe(false);
    expect(isValidSessionKey("slack:")).toBe(false);
    expect(isValidSessionKey("")).toBe(false);
    expect(isValidSessionKey(null as any)).toBe(false);
  });

  it("should reject invalid thread timestamp format", () => {
    expect(isValidSessionKey("slack:C0123456789:invalid")).toBe(false);
    expect(isValidSessionKey("slack:C0123456789:abc.def")).toBe(false);
  });
});

describe("escapeForLogging", () => {
  it("should escape backslashes", () => {
    expect(escapeForLogging("path\\to\\file")).toBe("path\\\\to\\\\file");
  });

  it("should escape newlines", () => {
    expect(escapeForLogging("line1\nline2")).toBe("line1\\nline2");
  });

  it("should escape carriage returns", () => {
    expect(escapeForLogging("line1\rline2")).toBe("line1\\rline2");
  });

  it("should escape tabs", () => {
    expect(escapeForLogging("col1\tcol2")).toBe("col1\\tcol2");
  });

  it("should handle empty string", () => {
    expect(escapeForLogging("")).toBe("");
  });
});
