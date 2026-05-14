import { BrowserCommandHandler } from "./browser.js";
import { LoginCommandHandler } from "./login.js";
import { ModelCommandHandler } from "./model.js";
import { NewCommandHandler } from "./new.js";
import { CommandRegistry } from "./registry.js";
import { SandboxCommandHandler } from "./sandbox.js";
import { SessionViewCommandHandler } from "./session-view.js";

export { CommandRegistry } from "./registry.js";
export type { CommandContext, CommandHandler, CommandServices } from "./types.js";

export function createDefaultCommandRegistry(): CommandRegistry {
  return new CommandRegistry([
    new BrowserCommandHandler(),
    new LoginCommandHandler(),
    new SessionViewCommandHandler(),
    new ModelCommandHandler(),
    new SandboxCommandHandler(),
    new NewCommandHandler(),
  ]);
}
