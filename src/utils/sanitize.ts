/**
 * Input sanitization utilities for mama bot
 * Prevents XSS and ensures safe message handling
 */

const MAX_MESSAGE_LENGTH = 10000;
const DANGEROUS_PATTERNS = [/<script/i, /javascript:/i, /on\w+=/i];

/**
 * Sanitize user input text to prevent XSS and injection attacks
 */
export function sanitizeInput(text: string | null | undefined): string {
  if (!text) return "";

  return text
    // Remove null bytes
    .replace(/\0/g, "")
    // Trim whitespace
    .trim()
    // Limit length
    .slice(0, MAX_MESSAGE_LENGTH);
}

/**
 * Check if text contains potentially dangerous patterns
 */
export function containsDangerousPatterns(text: string): boolean {
  return DANGEROUS_PATTERNS.some((pattern) => pattern.test(text));
}

/**
 * Sanitize file names to prevent path traversal
 */
export function sanitizeFileName(fileName: string): string {
  return fileName
    .replace(/\.\./g, "_") // Prevent directory traversal
    .replace(/[/\\:*?"<>|]/g, "_") // Remove invalid characters
    .slice(0, 255) // Limit length
    .trim();
}

/**
 * Validate session key format
 * Format: platform:channelId[:threadTs]
 */
export function isValidSessionKey(key: string): boolean {
  if (!key || typeof key !== "string") return false;
  
  // Basic format check: must contain platform:channelId
  const parts = key.split(":");
  if (parts.length < 2) return false;
  
  const [platform, channelId, ...rest] = parts;
  const validPlatforms = ["slack", "discord", "telegram"];
  
  if (!validPlatforms.includes(platform.toLowerCase())) return false;
  if (!channelId || channelId.length < 1) return false;
  
  // If thread timestamp exists, validate format
  if (rest.length > 0) {
    const threadTs = rest.join(":");
    // Slack/Discord timestamps are numeric
    if (!/^\d+(\.\d+)?$/.test(threadTs)) return false;
  }
  
  return true;
}

/**
 * Escape special characters for logging
 */
export function escapeForLogging(text: string): string {
  return text
    .replace(/\\/g, "\\\\")
    .replace(/\n/g, "\\n")
    .replace(/\r/g, "\\r")
    .replace(/\t/g, "\\t");
}
