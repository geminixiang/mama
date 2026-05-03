import { LoginCommandHandler } from "./login.js";
import { CommandRegistry } from "./registry.js";
import { SessionViewCommandHandler } from "./session-view.js";

export { CommandRegistry } from "./registry.js";
export type { CommandContext, CommandHandler, CommandServices } from "./types.js";

export function createDefaultCommandRegistry(): CommandRegistry {
  return new CommandRegistry([new LoginCommandHandler(), new SessionViewCommandHandler()]);
}
