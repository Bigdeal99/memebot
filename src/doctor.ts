import { GrokAnalyst } from "./ai/grok.js";
import { config } from "./config.js";
import { consoleLogger as log, errorMessage } from "./log.js";
import { Telegram } from "./notify/telegram.js";
import { evaluateSafety } from "./safety.js";
import { computeSignals } from "./signals.js";
import { discoverSolanaTokens, getBestPairs } from "./sources/dexscreener.js";
import { discoverTrending } from "./sources/geckoterminal.js";
import { getRugReport } from "./sources/rugcheck.js";

/** Well-known token used to sanity-check the APIs (BONK). */
const TEST_MINT = "DezXAZ8z7PnrnRJjz3wXBoRgixCa6xjnB7YaB1pPB263";

async function check(name: string, fn: () => Promise<string>): Promise<boolean> {
  const started = Date.now();
  try {
    const detail = await fn();
    console.log(`✅ ${name} (${Date.now() - started} ms): ${detail}`);
    return true;
  } catch (err) {
    console.log(`❌ ${name}: ${errorMessage(err)}`);
    return false;
  }
}

async function pumpPortalCheck(): Promise<string> {
  return new Promise((resolve, reject) => {
    const ws = new WebSocket("wss://pumpportal.fun/api/data");
    const timer = setTimeout(() => {
      ws.close();
      reject(new Error("no answer within 10s"));
    }, 10_000);
    ws.addEventListener("open", () => ws.send(JSON.stringify({ method: "subscribeMigration" })));
    ws.addEventListener("message", (e) => {
      clearTimeout(timer);
      ws.close();
      resolve(`connected, first message: ${String(e.data).slice(0, 80)}`);
    });
    ws.addEventListener("error", () => {
      clearTimeout(timer);
      reject(new Error("websocket error"));
    });
  });
}

async function main(): Promise<void> {
  console.log("memebot doctor: checking every external service from this machine\n");
  const results: boolean[] = [];

  results.push(
    await check("DexScreener discovery", async () => {
      const found = await discoverSolanaTokens();
      return `${found.length} Solana tokens in latest profiles/boosts`;
    }),
  );

  results.push(
    await check("GeckoTerminal trending", async () => {
      const found = await discoverTrending();
      if (found.length === 0) throw new Error("no trending Solana pools parsed");
      return `${found.length} trending Solana tokens, e.g. ${found[0]?.mint}`;
    }),
  );

  results.push(
    await check("DexScreener pairs", async () => {
      const pair = (await getBestPairs([TEST_MINT])).get(TEST_MINT);
      if (!pair) throw new Error("no pair returned for BONK");
      const s = computeSignals(pair);
      return `BONK $${s.priceUsd} liq $${Math.round(s.liquidityUsd)} 1h txns ${s.txnsH1}`;
    }),
  );

  results.push(
    await check("RugCheck report", async () => {
      const report = await getRugReport(TEST_MINT);
      if (!report) throw new Error("no report for BONK");
      const safety = evaluateSafety(report, config.safety);
      const fields = {
        score_normalised: report.score_normalised,
        mintAuthority: report.mintAuthority,
        freezeAuthority: report.freezeAuthority,
        topHolders: report.topHolders?.length,
        markets: report.markets?.length,
      };
      return `fields ${JSON.stringify(fields)} | metrics ${JSON.stringify(safety.metrics)}`;
    }),
  );

  if (config.usePumpPortal) results.push(await check("PumpPortal websocket", pumpPortalCheck));

  if (config.ai.apiKey) {
    results.push(
      await check(`Grok ${config.ai.model} + X search`, async () => {
        const pair = (await getBestPairs([TEST_MINT])).get(TEST_MINT);
        if (!pair) throw new Error("need BONK pair data first");
        const grok = new GrokAnalyst({ ...config.ai, maxCallsPerDay: 1 }, log);
        const v = await grok.assess({ mint: TEST_MINT, symbol: "BONK", name: "Bonk" }, computeSignals(pair));
        if (!v) throw new Error("no usable verdict");
        return `${v.verdict} hype=${v.hype} organic=${v.organic} | ${v.reason}`;
      }),
    );
  } else {
    console.log("⚪ Grok skipped (no XAI_API_KEY). Only the non-AI strategies will trade.");
  }

  const telegram = new Telegram(config.telegram.botToken, config.telegram.chatId, log);
  if (telegram.enabled) {
    results.push(
      await check("Telegram", async () => {
        await telegram.send("memebot doctor: Telegram alerts work ✅");
        return "test message sent, check your phone";
      }),
    );
  } else {
    console.log("⚪ Telegram skipped (no TELEGRAM_BOT_TOKEN / TELEGRAM_CHAT_ID)");
  }

  const ok = results.every(Boolean);
  console.log(ok ? "\nAll checks passed. Start the bot with: npm start" : "\nSome checks failed, see above.");
  process.exit(ok ? 0 : 1);
}

void main();
