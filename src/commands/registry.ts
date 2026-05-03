import type { CommandContext, CommandHandler } from "./types.js";

export class CommandRegistry {
  constructor(private readonly handlers: readonly CommandHandler[]) {}

  async handle(context: CommandContext): Promise<boolean> {
    for (const handler of this.handlers) {
      if (await handler.tryHandle(context)) {
        return true;
      }
    }
    return false;
  }
}
