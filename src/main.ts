import { Bot } from "./bot.js";
import { config } from "./config.js";
import { consoleLogger as log } from "./log.js";
import { Store } from "./store.js";
import { defaultStrategies } from "./strategies.js";

if (config.mode !== "paper") {
  // Live trading comes in step 2, only after the paper results prove the strategy works.
  log.error(`MODE=${config.mode} is not supported yet. Only MODE=paper exists in this version.`);
  process.exit(1);
}

const bot = new Bot(config, defaultStrategies(config.paper.positionUsd), new Store(config.dataDir), log);
bot.start();

for (const signal of ["SIGINT", "SIGTERM"] as const) {
  process.on(signal, () => {
    bot.stop();
    process.exit(0);
  });
}
