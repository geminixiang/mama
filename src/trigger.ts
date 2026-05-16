import { completeSimple, getModel } from "@earendil-works/pi-ai";
import type { BotEvent } from "./adapter.js";
import { loadAutoReplyJudgeModel, loadConversationAutoReplyConfig } from "./config.js";
import { join } from "path";

export type TriggerIntent = "mention" | "direct" | "thread-continuation" | "auto-reply-candidate";

export type TriggerResult = { trigger: true; reason: string } | { trigger: false; reason: string };

export type AutoReplyJudge = (input: {
  event: BotEvent;
  rules: string[];
  conversationDir: string;
}) => Promise<boolean>;

/**
 * Trivially decide non-auto-reply intents synchronously. For "auto-reply-candidate"
 * callers must use {@link evaluateAutoReplyPolicy}.
 */
export function decideTrigger(
  intent: Exclude<TriggerIntent, "auto-reply-candidate">,
): TriggerResult {
  return { trigger: true, reason: intent };
}

export async function evaluateAutoReplyPolicy(input: {
  event: BotEvent;
  workingDir: string | undefined;
  judge?: AutoReplyJudge;
}): Promise<TriggerResult> {
  const { event, workingDir, judge = judgeAutoReplyWithLlm } = input;
  if (!workingDir) return { trigger: false, reason: "auto-reply-unconfigured" };

  const conversationDir = join(workingDir, event.conversationId);
  const config = loadConversationAutoReplyConfig(conversationDir);
  if (!config.enabled) return { trigger: false, reason: "auto-reply-disabled" };
  if (config.rules.length === 0) {
    return { trigger: true, reason: "auto-reply-enabled" };
  }

  const shouldReply = await judge({ event, rules: config.rules, conversationDir });
  return shouldReply
    ? { trigger: true, reason: "auto-reply-rule-match" }
    : { trigger: false, reason: "auto-reply-rule-no-match" };
}

async function judgeAutoReplyWithLlm(input: {
  event: BotEvent;
  rules: string[];
  conversationDir: string;
}): Promise<boolean> {
  const judgeConfig = loadAutoReplyJudgeModel(input.conversationDir);
  // getModel has constrained generics for known providers; judgeConfig holds plain strings.
  // eslint-disable-next-line @typescript-eslint/no-explicit-any
  const model = (getModel as any)(judgeConfig.provider, judgeConfig.model);
  const answer = await completeSimple(
    model,
    {
      systemPrompt:
        "You decide whether a bot should reply to a group/channel message. " +
        "Use only the rules provided by the user. Answer exactly YES or NO.",
      messages: [
        {
          role: "user",
          timestamp: Date.now(),
          content: [
            "Rules:",
            ...input.rules.map((rule, index) => `${index + 1}. ${rule}`),
            "",
            "Message:",
            input.event.text,
            "",
            "Should the bot reply? Answer exactly YES or NO.",
          ].join("\n"),
        },
      ],
    },
    {
      temperature: 0,
      maxTokens: 4,
      reasoning: "minimal",
    },
  );
  const text = answer.content
    .filter((part) => part.type === "text")
    .map((part) => part.text)
    .join("")
    .trim()
    .toUpperCase();
  return /^YES\b/.test(text);
}
