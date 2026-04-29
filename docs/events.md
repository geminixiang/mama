# Events

Events are JSON files written to the `events/` directory inside the workspace. The harness watches this directory and triggers the agent when a file appears.

## Event Types

### Immediate

Triggers as soon as the harness sees the file. Useful for signaling from external scripts or webhooks.

```json
{
  "type": "immediate",
  "platform": "slack",
  "conversationId": "C123",
  "conversationKind": "shared",
  "userId": "U123",
  "text": "New GitHub issue opened"
}
```

### One-shot

Triggers once at a specific time. Use for reminders and future callbacks.

```json
{
  "type": "one-shot",
  "platform": "slack",
  "conversationId": "C123",
  "conversationKind": "shared",
  "userId": "U123",
  "text": "Remind Mario about dentist",
  "at": "2025-12-15T09:00:00+01:00"
}
```

`at` must be an ISO 8601 timestamp with UTC offset.

### Periodic

Triggers on a cron schedule. Persists until deleted.

```json
{
  "type": "periodic",
  "platform": "slack",
  "conversationId": "C123",
  "conversationKind": "shared",
  "userId": "U123",
  "text": "Check inbox and summarize",
  "schedule": "0 9 * * 1-5",
  "timezone": "Asia/Taipei"
}
```

Cron format: `minute hour day-of-month month day-of-week`

Common schedules:

- `0 9 * * *` — daily at 09:00
- `0 9 * * 1-5` — weekdays at 09:00
- `0 0 1 * *` — first of each month at midnight

## Routing Fields

| Field              | Description                                                                                                                                                                                                                            |
| ------------------ | -------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- |
| `platform`         | Target bot platform (e.g. `slack`)                                                                                                                                                                                                     |
| `conversationId`   | Channel or DM ID to post into                                                                                                                                                                                                          |
| `conversationKind` | `"shared"` (channel) or `"direct"` (DM)                                                                                                                                                                                                |
| `userId`           | Platform user ID of whoever requested the event; used for vault/credential routing in per-user modes                                                                                                                                   |
| `sessionKey`       | Determines which AgentRunner (and its LLM context) handles the event                                                                                                                                                                   |
| `threadTs`         | Sub-conversation target; when present, the response is posted inside that thread rather than as a top-level message. Semantics are platform-specific: Slack thread timestamp, Discord thread channel ID, Telegram reply-to message ID. |

## Session Binding

`sessionKey` determines which AgentRunner (and its LLM context) handles an event when it fires. Whether it is included depends on the event type:

- **Immediate** — included. The event is an extension of the current turn, so the same session context applies.
- **One-shot** — omitted. A reminder firing hours or days later has no meaningful connection to the session it was created in; it simply delivers a message to the conversation.
- **Periodic** — included. Recurring tasks often need the context from the session where they were configured.

## Thread Targeting

`threadTs` controls whether a response is posted as a top-level message or as a reply inside a sub-conversation (Slack thread, Discord thread, Telegram reply chain). The same per-type reasoning applies:

- **Immediate** — preserved. The reply belongs in the same sub-conversation as the current exchange.
- **One-shot** — omitted. A reminder should be a prominent top-level message, not buried in a sub-conversation that may be days old.
- **Periodic** — omitted. Recurring replies into an old sub-conversation create noise and reduce visibility.

Summary:

| Type        | `sessionKey` |    `threadTs`    |
| ----------- | :----------: | :--------------: |
| `immediate` |      ✓       | ✓ (if in thread) |
| `one-shot`  |      —       |        —         |
| `periodic`  |      ✓       |        —         |

The `event` tool (available to the agent) fills all routing fields automatically and applies these rules. Use it instead of writing JSON by hand.

## Lifecycle

- **Immediate** and **one-shot** files are deleted automatically after the event fires.
- **Periodic** files persist. Delete the file to cancel.
- Maximum 5 events can be queued at once.

## Silent Response

For periodic events with nothing to report, respond with exactly `[SILENT]`. The harness deletes the status message and posts nothing to the platform, avoiding channel spam.

## Debouncing

When writing scripts that emit immediate events (email watchers, webhook handlers), always debounce. Collect events over a window and emit one summary event rather than one event per item.
