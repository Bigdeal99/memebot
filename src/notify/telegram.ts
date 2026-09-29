import { errorMessage } from "../log.js";
import type { Logger } from "../types.js";
import { requestJson } from "../util/http.js";

/** Sends alerts to your phone. Does nothing when TELEGRAM_BOT_TOKEN / TELEGRAM_CHAT_ID are not set. */
export class Telegram {
  constructor(
    private readonly botToken: string,
    private readonly chatId: string,
    private readonly log: Logger,
  ) {}

  get enabled(): boolean {
    return this.botToken !== "" && this.chatId !== "";
  }

  async send(text: string): Promise<void> {
    if (!this.enabled) return;
    try {
      await requestJson(`https://api.telegram.org/bot${this.botToken}/sendMessage`, {
        method: "POST",
        body: { chat_id: this.chatId, text, disable_web_page_preview: true },
        retries: 1,
      });
    } catch (err) {
      // An alert failing must never stop the bot.
      this.log.warn(`Telegram send failed: ${errorMessage(err)}`);
    }
  }
}
