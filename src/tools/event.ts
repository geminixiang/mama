import { mkdir, writeFile } from "node:fs/promises";
import { join } from "node:path";
import type { AgentTool } from "@mariozechner/pi-agent-core";
import { Type } from "@sinclair/typebox";

const eventSchema = Type.Object({
  label: Type.String({
    description: "Brief description of the event you're scheduling (shown to user)",
  }),
  type: Type.Union([Type.Literal("immediate"), Type.Literal("one-shot"), Type.Literal("periodic")]),
  text: Type.String({ description: "The reminder or event text to send when it fires" }),
  at: Type.Optional(
    Type.String({
      description: "ISO 8601 timestamp with offset, required for one-shot events",
    }),
  ),
  schedule: Type.Optional(
    Type.String({
      description: "Cron schedule, required for periodic events",
    }),
  ),
  timezone: Type.Optional(
    Type.String({
      description: "IANA timezone, required for periodic events",
    }),
  ),
  filenamePrefix: Type.Optional(
    Type.String({
      description: "Optional filename prefix for the event file",
    }),
  ),
});

interface EventToolContext {
  platform: string;
  channelId: string;
  userId: string;
}

type EventToolParams = {
  label: string;
  type: "immediate" | "one-shot" | "periodic";
  text: string;
  at?: string;
  schedule?: string;
  timezone?: string;
  filenamePrefix?: string;
};

type EventPayload =
  | {
      type: "immediate";
      platform: string;
      channelId: string;
      userId: string;
      text: string;
    }
  | {
      type: "one-shot";
      platform: string;
      channelId: string;
      userId: string;
      text: string;
      at: string;
    }
  | {
      type: "periodic";
      platform: string;
      channelId: string;
      userId: string;
      text: string;
      schedule: string;
      timezone: string;
    };

export function createEventTool(workspaceDir: string): {
  tool: AgentTool<typeof eventSchema>;
  setEventContext: (context: EventToolContext) => void;
} {
  let eventContext: EventToolContext | null = null;

  const tool: AgentTool<typeof eventSchema> = {
    name: "event",
    label: "event",
    description:
      "Schedule an immediate, one-shot, or periodic event for the current conversation. This automatically writes to the correct events directory and fills the current platform, channel, and requester userId.",
    parameters: eventSchema,
    execute: async (_toolCallId: string, params: EventToolParams, signal?: AbortSignal) => {
      if (signal?.aborted) {
        throw new Error("Operation aborted");
      }

      if (!eventContext) {
        throw new Error("Event context not configured");
      }

      const payload = buildEventPayload(params, eventContext);
      const eventsDir = join(workspaceDir, "events");
      await mkdir(eventsDir, { recursive: true });

      const prefix = sanitizeFileSegment(params.filenamePrefix || payload.type || "event");
      const filename = `${prefix}-${Date.now()}.json`;
      const filePath = join(eventsDir, filename);
      await writeFile(filePath, JSON.stringify(payload) + "\n", "utf-8");

      return {
        content: [
          {
            type: "text",
            text:
              payload.type === "periodic"
                ? `Scheduled periodic event ${filename} for ${payload.platform}/${payload.channelId} (${payload.schedule} ${payload.timezone})`
                : payload.type === "one-shot"
                  ? `Scheduled one-shot event ${filename} for ${payload.platform}/${payload.channelId} at ${payload.at}`
                  : `Queued immediate event ${filename} for ${payload.platform}/${payload.channelId}`,
          },
        ],
        details: undefined,
      };
    },
  };

  return {
    tool,
    setEventContext: (context: EventToolContext) => {
      eventContext = context;
    },
  };
}

function buildEventPayload(params: EventToolParams, context: EventToolContext): EventPayload {
  const base = {
    platform: context.platform,
    channelId: context.channelId,
    userId: context.userId,
    text: params.text,
  };

  if (params.type === "immediate") {
    return { ...base, type: "immediate" };
  }

  if (params.type === "one-shot") {
    if (!params.at) {
      throw new Error("`at` is required for one-shot events");
    }
    return { ...base, type: "one-shot", at: params.at };
  }

  if (!params.schedule) {
    throw new Error("`schedule` is required for periodic events");
  }
  if (!params.timezone) {
    throw new Error("`timezone` is required for periodic events");
  }
  return {
    ...base,
    type: "periodic",
    schedule: params.schedule,
    timezone: params.timezone,
  };
}

function sanitizeFileSegment(value: string): string {
  const sanitized = value
    .trim()
    .toLowerCase()
    .replace(/[^a-z0-9._-]+/g, "-")
    .replace(/^-+|-+$/g, "");
  return sanitized || "event";
}
