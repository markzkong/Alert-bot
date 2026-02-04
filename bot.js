import http from "http";
import fs from "fs/promises";

const TELEGRAM_BOT_TOKEN = String(process.env.TELEGRAM_BOT_TOKEN || "").trim();
const TELEGRAM_CHAT_ID = String(process.env.TELEGRAM_CHAT_ID || "").trim();

if (!TELEGRAM_BOT_TOKEN) throw new Error("Missing env var: TELEGRAM_BOT_TOKEN");
if (!TELEGRAM_CHAT_ID) throw new Error("Missing env var: TELEGRAM_CHAT_ID");

const SLUG_PREFIX = String(
  process.env.SLUG_PREFIX || "1-free-app-in-the-us-apple-app-store-on-"
).trim();

const FORCE_EVENT_SLUG = String(process.env.FORCE_EVENT_SLUG || "").trim();

// NEW: which outcome to track when this is a multi-outcome market
const OUTCOME_NAME = String(process.env.OUTCOME_NAME || "ChatGPT").trim();

const POLL_SECONDS = Number(process.env.POLL_SECONDS || 60);
const THRESHOLD_WARN = Number(process.env.THRESHOLD_WARN || 0.9);
const THRESHOLD_CRIT = Number(process.env.THRESHOLD_CRIT || 0.5);
const PORT = Number(process.env.PORT || 10000);

const GAMMA_BASE = "https://gamma-api.polymarket.com";
const CLOB_BASE = "https://clob.polymarket.com";

const STATE_PATH = "./state.json";

function nowIso() {
  return new Date().toISOString();
}

async function sleep(ms) {
  await new Promise((r) => setTimeout(r, ms));
}

async function fetchJson(url, opts = {}) {
  const res = await fetch(url, {
    ...opts,
    headers: {
      accept: "application/json",
      ...(opts.headers || {}),
    },
  });

  if (!res.ok) {
    const text = await res.text().catch(() => "");
    throw new Error(
      `HTTP ${res.status} ${res.statusText} for ${url} :: ${text.slice(0, 300)}`
    );
  }
  return await res.json();
}

async function loadState() {
  try {
    const raw = await fs.readFile(STATE_PATH, "utf8");
    const st = JSON.parse(raw);
    return {
      trackedSlug: st.trackedSlug || null,
      lastProb: typeof st.lastProb === "number" ? st.lastProb : null,
      warnTriggered: Boolean(st.warnTriggered),
      critTriggered: Boolean(st.critTriggered),
      updatedAt: st.updatedAt || null,
    };
  } catch {
    return {
      trackedSlug: null,
      lastProb: null,
      warnTriggered: false,
      critTriggered: false,
      updatedAt: null,
    };
  }
}

async function saveState(state) {
  const out = { ...state, updatedAt: nowIso() };
  await fs.writeFile(STATE_PATH, JSON.stringify(out, null, 2), "utf8");
}

async function sendTelegram(text) {
  const url = `https://api.telegram.org/bot${encodeURIComponent(
    TELEGRAM_BOT_TOKEN
  )}/sendMessage`;

  const payload = {
    chat_id: TELEGRAM_CHAT_ID,
    text,
    disable_web_page_preview: true,
  };

  const res = await fetch(url, {
    method: "POST",
    headers: { "content-type": "application/json" },
    body: JSON.stringify(payload),
  });

  if (!res.ok) {
    const body = await res.text().catch(() => "");
    throw new Error(
      `Telegram sendMessage failed: HTTP ${res.status} :: ${body.slice(0, 300)}`
    );
  }
}

async function findCurrentWeeklyEventSlug() {
  if (FORCE_EVENT_SLUG) return FORCE_EVENT_SLUG;

  const url = `${GAMMA_BASE}/events?limit=200&offset=0`;
  const events = await fetchJson(url);

  const matches = (Array.isArray(events) ? events : []).filter(
    (e) => e && typeof e.slug === "string" && e.slug.startsWith(SLUG_PREFIX)
  );

  if (matches.length === 0) return null;

  const now = Date.now();

  function parseTimeMs(x) {
    if (!x) return null;
    const ms = Date.parse(x);
    return Number.isFinite(ms) ? ms : null;
  }

  const scored = matches.map((e) => {
    const endCandidates = [
      e.endDate,
      e.end_date,
      e.endTime,
      e.end_time,
      e.closeTime,
      e.close_time,
      e.resolutionTime,
      e.resolution_time,
    ];
    const endMs = endCandidates.map(parseTimeMs).find((v) => v !== null) ?? null;

    let score = 9e18;
    if (endMs !== null) {
      if (endMs >= now) score = endMs;
      else score = endMs + 1e15;
    }
    return { slug: e.slug, score };
  });

  scored.sort((a, b) => a.score - b.score);
  return scored[0].slug;
}

async function getEventBySlug(slug) {
  const url = `${GAMMA_BASE}/events/slug/${encodeURIComponent(slug)}`;
  return await fetchJson(url);
}

/**
 * Choose the best market to read from the event.
 * If there are multiple markets, prefer one that looks like the weekly question.
 * Otherwise use the first market.
 */
function pickMarket(eventObj) {
  const markets = eventObj?.markets;
  if (!Array.isArray(markets) || markets.length === 0) {
    throw new Error("No markets found in event response.");
  }

  // Heuristic: prefer market whose question mentions the outcome name, if available.
  const preferred = markets.find((m) => {
    const q = String(m?.question || "").toLowerCase();
    return q.includes(OUTCOME_NAME.toLowerCase());
  });

  return preferred || markets[0];
}

/**
 * Extract token id for:
 * - YES if market is binary ("Yes"/"No"), else
 * - OUTCOME_NAME (default "ChatGPT") for multi-outcome markets
 */
function extractTrackedTokenIdFromMarket(marketObj) {
  let outcomes = marketObj.outcomes;
  let tokenIds = marketObj.clobTokenIds;

  if (typeof outcomes === "string") outcomes = JSON.parse(outcomes);
  if (typeof tokenIds === "string") tokenIds = JSON.parse(tokenIds);

  if (!Array.isArray(outcomes) || !Array.isArray(tokenIds) || outcomes.length !== tokenIds.length) {
    throw new Error("Market outcomes/clobTokenIds missing or malformed.");
  }

  // Case 1: binary market
  const yesIndex = outcomes.findIndex((o) => String(o).toLowerCase() === "yes");
  if (yesIndex >= 0) {
    const yesTokenId = tokenIds[yesIndex];
    if (!yesTokenId) throw new Error("YES token id was empty.");
    return { tokenId: String(yesTokenId), label: "Yes" };
  }

  // Case 2: multi-outcome market (track ChatGPT outcome)
  const targetIndex = outcomes.findIndex(
    (o) => String(o).trim().toLowerCase() === OUTCOME_NAME.toLowerCase()
  );

  if (targetIndex < 0) {
    throw new Error(
      `Could not find outcome "${OUTCOME_NAME}" in outcomes: ${outcomes.slice(0, 15).join(", ")}`
    );
  }

  const tokenId = tokenIds[targetIndex];
  if (!tokenId) throw new Error(`Token id for outcome "${OUTCOME_NAME}" was empty.`);
  return { tokenId: String(tokenId), label: OUTCOME_NAME };
}

async function getProbabilityFromTokenId(tokenId) {
  try {
    const midUrl = `${CLOB_BASE}/midpoint?token_id=${encodeURIComponent(tokenId)}`;
    const mid = await fetchJson(midUrl);
    const p = Number(mid?.midpoint);
    if (Number.isFinite(p)) return p;
  } catch {
    // fallback
  }

  const buyUrl = `${CLOB_BASE}/price?token_id=${encodeURIComponent(tokenId)}&side=BUY`;
  const sellUrl = `${CLOB_BASE}/price?token_id=${encodeURIComponent(tokenId)}&side=SELL`;

  const [buy, sell] = await Promise.all([fetchJson(buyUrl), fetchJson(sellUrl)]);
  const pb = Number(buy?.price);
  const ps = Number(sell?.price);

  if (!Number.isFinite(pb) || !Number.isFinite(ps)) {
    throw new Error("Could not read buy/sell price as numbers.");
  }
  return (pb + ps) / 2;
}

function fmtPct(x) {
  return `${(x * 100).toFixed(1)}%`;
}

function makeEventUrl(slug) {
  return `https://polymarket.com/event/${slug}`;
}

function updateTriggers(state, prob) {
  if (prob >= THRESHOLD_WARN) state.warnTriggered = false;
  if (prob >= THRESHOLD_CRIT) state.critTriggered = false;

  const shouldWarn = !state.warnTriggered && prob < THRESHOLD_WARN;
  const shouldCrit = !state.critTriggered && prob < THRESHOLD_CRIT;

  if (shouldWarn) state.warnTriggered = true;
  if (shouldCrit) state.critTriggered = true;

  return { shouldWarn, shouldCrit };
}

async function mainLoop() {
  let state = await loadState();

  console.log(
    `[${nowIso()}] Starting monitor. SLUG_PREFIX=${SLUG_PREFIX} FORCE_EVENT_SLUG=${FORCE_EVENT_SLUG || "(none)"} OUTCOME_NAME=${OUTCOME_NAME}`
  );

  while (true) {
    try {
      const currentSlug = await findCurrentWeeklyEventSlug();

      if (!currentSlug) {
        console.log(`[${nowIso()}] No matching event found. Will retry.`);
        await sleep(POLL_SECONDS * 1000);
        continue;
      }

      if (state.trackedSlug !== currentSlug) {
        state.trackedSlug = currentSlug;
        state.lastProb = null;
        state.warnTriggered = false;
        state.critTriggered = false;
        await saveState(state);

        await sendTelegram(
          `Tracking weekly event:\n${makeEventUrl(currentSlug)}\nTracking outcome: ${OUTCOME_NAME}`
        );
      }

      const ev = await getEventBySlug(state.trackedSlug);
      const market = pickMarket(ev);
      const { tokenId, label } = extractTrackedTokenIdFromMarket(market);
      const prob = await getProbabilityFromTokenId(tokenId);

      state.lastProb = prob;

      const { shouldWarn, shouldCrit } = updateTriggers(state, prob);
      await saveState(state);

      console.log(`[${nowIso()}] ${label} prob=${fmtPct(prob)}`);

      if (shouldWarn) {
        await sendTelegram(
          `⚠️ ${label} dropped below ${fmtPct(THRESHOLD_WARN)}: now ${fmtPct(prob)}\n${makeEventUrl(state.trackedSlug)}`
        );
      }
      if (shouldCrit) {
        await sendTelegram(
          `🚨 ${label} dropped below ${fmtPct(THRESHOLD_CRIT)}: now ${fmtPct(prob)}\n${makeEventUrl(state.trackedSlug)}`
        );
      }
    } catch (err) {
      console.error(`[${nowIso()}] Error:`, err?.message || err);
    }

    await sleep(POLL_SECONDS * 1000);
  }
}

http
  .createServer((req, res) => {
    if (req.url === "/healthz") {
      res.writeHead(200, { "content-type": "text/plain" });
      res.end("ok");
      return;
    }
    res.writeHead(200, { "content-type": "text/plain" });
    res.end("running");
  })
  .listen(PORT, () => console.log(`[${nowIso()}] HTTP server listening on :${PORT}`));

mainLoop().catch((e) => {
  console.error(`[${nowIso()}] Fatal:`, e);
  process.exit(1);
});
