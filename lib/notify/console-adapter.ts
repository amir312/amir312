import type { NotifierAdapter, OutboundMessage } from "./types";

/** Dev/pilot adapter: the message lands in the server log and nowhere else. */
export const consoleAdapter: NotifierAdapter = {
  channel: "CONSOLE",
  async deliver(message: OutboundMessage) {
    console.info(
      `[notify:console] → ${message.recipient} · ${message.template}\n  ${message.title}\n  ${message.body}${message.url ? `\n  ${message.url}` : ""}`,
    );
  },
};
