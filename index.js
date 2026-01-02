import { Client, GatewayIntentBits } from "discord.js";
import Groq from "groq-sdk";
import express from "express";
import "dotenv/config";

const TICKET_CATEGORY_ID = process.env.TICKET_CATEGORY_ID;
const CASHAPP_LINK = process.env.CASHAPP_LINK;
const PAYPAL_LINK = process.env.PAYPAL_LINK;

const PORT = Number(process.env.PORT || 3000);
const REMOTE_PASSWORD = process.env.REMOTE_PASSWORD;

const USD_PER_100K = 1.5;
const ROBUX_PER_100K = 150;
const MAX_MONEY = 1750000;

const gamepasses = [
  { robux: 50, url: "https://www.roblox.com/game-pass/678549030/" },
  { robux: 100, url: "https://www.roblox.com/game-pass/678099847/" },
  { robux: 150, url: "https://www.roblox.com/game-pass/1647150838/150" },
  { robux: 200, url: "https://www.roblox.com/game-pass/1535869478/" },
  { robux: 300, url: "https://www.roblox.com/game-pass/1536936054/" },
  { robux: 400, url: "https://www.roblox.com/game-pass/1537173869/" },
  { robux: 500, url: "https://www.roblox.com/game-pass/678482231/" },
  { robux: 600, url: "https://www.roblox.com/game-pass/1536758039/" },
  { robux: 700, url: "https://www.roblox.com/game-pass/1535869486/" },
  { robux: 800, url: "https://www.roblox.com/game-pass/1535265655/" },
  { robux: 900, url: "https://www.roblox.com/game-pass/1537281898/" },
  { robux: 1000, url: "https://www.roblox.com/game-pass/678189829/" }
];

const client = new Client({
  intents: [GatewayIntentBits.Guilds, GatewayIntentBits.GuildMessages, GatewayIntentBits.MessageContent]
});

const groq = new Groq({ apiKey: process.env.GROQ_API_KEY });

const ticketState = new Map();

function isTicketChannel(messageOrChannel) {
  const parentId = messageOrChannel?.channel
    ? messageOrChannel.channel?.parentId
    : messageOrChannel?.parentId;

  if (!TICKET_CATEGORY_ID) return false;
  if (!parentId) return false;
  return parentId === TICKET_CATEGORY_ID;
}

function formatNumber(n) {
  return n.toLocaleString("en-US");
}

function detectPaymentMethod(input) {
  const s = input.toLowerCase();
  if (s.includes("robux") || s.includes("rbx") || s.includes("r$")) return "ROBUX";
  if (s.includes("real") || s.includes("cash") || s.includes("usd") || s.includes("$") || s.includes("paypal") || s.includes("cashapp")) return "USD";
  return null;
}

function usdTotal(gameMoney) {
  return (gameMoney / 100000) * USD_PER_100K;
}

function exactRobuxFromGameMoney(gameMoney) {
  return (gameMoney / 100000) * ROBUX_PER_100K;
}

function gameMoneyFromRobux(robux) {
  return (robux / ROBUX_PER_100K) * 100000;
}

function roundToMultiple(n, step) {
  return Math.round(n / step) * step;
}

function clamp(n, lo, hi) {
  return Math.min(hi, Math.max(lo, n));
}

function closestRobuxPlan(desiredGameMoney) {
  const gpStep = 50;

  const desiredRobuxExact = exactRobuxFromGameMoney(desiredGameMoney);
  const base = desiredRobuxExact / gpStep;

  const candA = Math.floor(base) * gpStep;
  const candB = Math.ceil(base) * gpStep;

  const candidates = [];
  for (const robuxCand of [candA, candB]) {
    if (!Number.isFinite(robuxCand) || robuxCand <= 0) continue;

    let gm = Math.round(gameMoneyFromRobux(robuxCand));
    gm = clamp(gm, 1, MAX_MONEY);

    const robuxFinal = roundToMultiple(exactRobuxFromGameMoney(gm), gpStep);
    let gmFinal = Math.round(gameMoneyFromRobux(robuxFinal));
    gmFinal = clamp(gmFinal, 1, MAX_MONEY);

    candidates.push({ adjustedGameMoney: gmFinal, totalRobux: robuxFinal });
  }

  if (!candidates.length) {
    const robuxFallback = gpStep;
    return { adjustedGameMoney: Math.round(gameMoneyFromRobux(robuxFallback)), totalRobux: robuxFallback };
  }

  candidates.sort((a, b) => Math.abs(a.adjustedGameMoney - desiredGameMoney) - Math.abs(b.adjustedGameMoney - desiredGameMoney));
  return candidates[0];
}

function buildGamepassLines(totalRobux) {
  const sorted = [...gamepasses].sort((a, b) => b.robux - a.robux);
  let remaining = totalRobux;
  const picks = [];

  for (const gp of sorted) {
    while (remaining >= gp.robux) {
      picks.push(gp);
      remaining -= gp.robux;
    }
  }

  const lines = [];
  lines.push("Buy these gamepasses:");
  for (const gp of picks) lines.push(`• ${gp.robux} Robux – ${gp.url}`);

  if (remaining !== 0) {
    lines.push(`(Note: missing ${remaining} Robux with current passes.)`);
  }
  return lines;
}

function parseGameMoney(input) {
  if (!input) return null;
  let s = input.toLowerCase().trim();

  if (s.includes("max")) return MAX_MONEY;
  if (s.includes("maximum")) return MAX_MONEY;
  if (s.includes("all in")) return MAX_MONEY;

  s = s.replace(/,/g, "");
  s = s.replace(/\$/g, "");
  s = s.replace(/\b(money|game|cash|coins|dollars|usd|robux|rbx|r\$|buy|want|need|get|give|me|for)\b/g, " ");
  s = s.replace(/\bmillion\b/g, "m");
  s = s.replace(/\bmil\b/g, "m");
  s = s.replace(/\s+/g, " ").trim();

  const parts = s.match(/(\d+(\.\d+)?\s*[km]?)/gi);
  if (!parts) return null;

  let total = 0;
  for (const p of parts) {
    const m = p.trim().match(/^(\d+(\.\d+)?)(\s*)([km])?$/i);
    if (!m) continue;
    const num = Number(m[1]);
    if (!Number.isFinite(num)) continue;

    const suffix = (m[4] || "").toLowerCase();
    let value = num;
    if (suffix === "k") value = num * 1000;
    if (suffix === "m") value = num * 1000000;

    total += value;
  }

  total = Math.round(total);
  if (!Number.isFinite(total) || total <= 0) return null;
  return total;
}

async function aiExtractAmount(text) {
  try {
    const resp = await groq.chat.completions.create({
      model: "llama-3.1-8b-instant",
      temperature: 0,
      messages: [
        {
          role: "system",
          content:
            `Extract ONLY the game money amount as an integer.
If user means "max money"/"max", return ${MAX_MONEY}.
Understand: 700k, 1m, 1.75m, 1,750,000, "1 mil 750k".
If no clear amount, return null.
Output strict JSON only: {"amount": number|null}`
        },
        { role: "user", content: text }
      ]
    });

    const raw = resp.choices?.[0]?.message?.content?.trim() || "";
    const start = raw.indexOf("{");
    const end = raw.lastIndexOf("}");
    if (start === -1 || end === -1) return null;

    const obj = JSON.parse(raw.slice(start, end + 1));
    const amt = obj?.amount;

    if (amt === null) return null;
    if (!Number.isFinite(amt) || amt <= 0) return null;

    return Math.round(amt);
  } catch {
    return null;
  }
}

function resetTicket(channelId, userId) {
  ticketState.set(channelId, {
    step: "ASK_AMOUNT",
    customerId: userId,
    amount: null,
    lastMethod: null,
    lastTotalRobux: null,
    chat: []
  });
}

function pushChat(state, role, content) {
  if (!state.chat) state.chat = [];
  state.chat.push({ role, content });
  if (state.chat.length > 20) state.chat = state.chat.slice(-20);
}

function checkoutSummary(state) {
  const units = state.amount / 100000;

  if (state.lastMethod === "USD") {
    const total = usdTotal(state.amount);
    return (
      `Game money: ${formatNumber(state.amount)}\n` +
      `Total: ${units} × $${USD_PER_100K} = $${total.toFixed(2)}\n` +
      `Cash App: ${CASHAPP_LINK}\n` +
      `PayPal: ${PAYPAL_LINK}`
    );
  }

  if (state.lastMethod === "ROBUX") {
    const totalRobux = state.lastTotalRobux ?? roundToMultiple(exactRobuxFromGameMoney(state.amount), 50);
    const lines = buildGamepassLines(totalRobux);
    return (
      `Game money: ${formatNumber(state.amount)}\n` +
      `Total: ${units} × ${ROBUX_PER_100K} = ${totalRobux} Robux\n` +
      lines.join("\n")
    );
  }

  return "";
}

client.once("ready", () => {
  console.log(`Logged in as ${client.user.tag}`);
});

client.on("messageCreate", async (message) => {
  try {
    if (message.author.bot) return;
    if (!message.guild) return;
    if (!isTicketChannel(message)) return;

    const channelId = message.channel.id;
    let state = ticketState.get(channelId);

    if (!state) {
      resetTicket(channelId, message.author.id);
      state = ticketState.get(channelId);
      return message.channel.send("How much game money do you want to buy? (ex: 700k, 1.75m, max money)");
    }

    if (message.author.id !== state.customerId) return;

    const text = message.content.trim();
    const lower = text.toLowerCase();

    if (lower === "restart" || lower === "reset" || lower === "new" || lower === "new order") {
      resetTicket(channelId, message.author.id);
      return message.channel.send("How much game money do you want to buy?");
    }

    if (state.step === "ASK_AMOUNT") {
      let amt = parseGameMoney(text);
      if (!amt) amt = await aiExtractAmount(text);

      if (!amt) return message.channel.send("I didn’t understand the amount. Try 700k, 1m, 1,750,000, or max money.");

      state.amount = amt;
      state.step = "ASK_PAYMENT";
      ticketState.set(channelId, state);

      pushChat(state, "assistant", `Amount selected: ${amt}`);
      return message.channel.send(`Got it: ${formatNumber(amt)} game money. Are you paying with real money or Robux?`);
    }

    if (state.step === "ASK_PAYMENT") {
      const method = detectPaymentMethod(text);
      if (!method) return message.channel.send("Reply with real money or Robux.");

      if (method === "USD") {
        state.lastMethod = "USD";
        state.step = "DONE";
        ticketState.set(channelId, state);

        const summary = checkoutSummary(state);
        pushChat(state, "assistant", summary);
        return message.channel.send(summary);
      }

      if (method === "ROBUX") {
        const desired = state.amount;
        const plan = closestRobuxPlan(desired);

        state.amount = plan.adjustedGameMoney;
        state.lastTotalRobux = plan.totalRobux;
        state.lastMethod = "ROBUX";
        state.step = "DONE";
        ticketState.set(channelId, state);

        const summary = checkoutSummary(state);

        if (plan.adjustedGameMoney !== desired) {
          const note =
            `Closest to ${formatNumber(desired)} for Robux is **${formatNumber(plan.adjustedGameMoney)}** game money for **${plan.totalRobux} Robux**.\n\n`;
          pushChat(state, "assistant", note + summary);
          return message.channel.send(note + summary);
        }

        pushChat(state, "assistant", summary);
        return message.channel.send(summary);
      }
    }

    if (state.step === "DONE") {
      const maybeAmt = parseGameMoney(text) || (await aiExtractAmount(text));
      if (maybeAmt) {
        state.amount = maybeAmt;
        state.step = "ASK_PAYMENT";
        ticketState.set(channelId, state);
        pushChat(state, "user", text);
        return message.channel.send(`Got it: ${formatNumber(maybeAmt)} game money. Are you paying with real money or Robux?`);
      }

      if (lower.includes("where") || lower.includes("pay") || lower.includes("cashapp") || lower.includes("paypal") || lower.includes("link")) {
        const summary = checkoutSummary(state);
        pushChat(state, "user", text);
        pushChat(state, "assistant", summary);
        return message.channel.send(summary);
      }

      pushChat(state, "user", text);

      const system = {
        role: "system",
        content:
          `You are a Discord ticket assistant for selling game money.
Rules:
- Prices are fixed: $1.50 per 100k OR 150 Robux per 100k.
- Never change rates, never invent discounts.
- Real money payment: Cash App ${CASHAPP_LINK} and PayPal ${PAYPAL_LINK}.
- Robux payment: use the provided gamepass links. If exact total isn't possible, the order is adjusted to the closest possible.
- Keep replies short and helpful.`
      };

      const ctx = checkoutSummary(state);
      const contextMsg = ctx ? { role: "system", content: `Current order context:\n${ctx}` } : null;

      const messages = [system];
      if (contextMsg) messages.push(contextMsg);
      for (const m of state.chat || []) messages.push(m);
      messages.push({ role: "user", content: text });

      const response = await groq.chat.completions.create({
        model: "llama-3.1-8b-instant",
        temperature: 0.4,
        messages
      });

      const out = response.choices?.[0]?.message?.content?.trim() || "Okay.";
      pushChat(state, "assistant", out);
      ticketState.set(channelId, state);

      return message.channel.send(out);
    }
  } catch (err) {
    console.error(err);
    try { await message.channel.send("Error. Try again."); } catch {}
  }
});

client.login(process.env.DISCORD_TOKEN);

// ------------------- REMOTE CONTROL SERVER -------------------

const app = express();
app.use(express.json({ limit: "256kb" }));

function bad(res, code, msg) {
  return res.status(code).json({ ok: false, error: msg });
}

app.get("/", (req, res) => {
  res.type("text").send("Remote control is running. Open /panel");
});

app.get("/panel", (req, res) => {
  res.type("html").send(`<!doctype html>
<html>
<head>
  <meta charset="utf-8" />
  <meta name="viewport" content="width=device-width, initial-scale=1" />
  <title>Bot Remote Panel</title>
  <style>
    body { font-family: Arial, sans-serif; max-width: 700px; margin: 20px auto; padding: 0 12px; }
    input, textarea, button { width: 100%; padding: 10px; margin: 6px 0; font-size: 16px; }
    textarea { height: 120px; }
    button { cursor: pointer; }
    .row { display:flex; gap:10px; }
    .row > * { flex:1; }
    pre { background:#f3f3f3; padding:10px; white-space:pre-wrap; word-break:break-word; }
  </style>
</head>
<body>
  <h2>Send a message as the bot</h2>
  <p>Fill password + ticket channel ID + message, then Send.</p>

  <input id="password" placeholder="Remote password" />
  <input id="channelId" placeholder="Ticket Channel ID (right click channel → Copy ID)" />
  <textarea id="message" placeholder="Message to send as the bot"></textarea>

  <div class="row">
    <button onclick="sendMsg()">Send</button>
    <button onclick="quick('Paid received ✅')">Paid</button>
    <button onclick="quick('Delivering now…')">Delivering</button>
  </div>

  <pre id="status"></pre>

  <script>
    async function sendMsg() {
      const body = {
        password: document.getElementById('password').value,
        channelId: document.getElementById('channelId').value,
        message: document.getElementById('message').value
      };
      const res = await fetch('/send', {
        method: 'POST',
        headers: {'Content-Type':'application/json'},
        body: JSON.stringify(body)
      });
      const txt = await res.text();
      document.getElementById('status').textContent = txt;
    }
    function quick(t){
      document.getElementById('message').value = t;
      sendMsg();
    }
  </script>
</body>
</html>`);
});

app.post("/send", async (req, res) => {
  try {
    const { password, channelId, message } = req.body || {};

    if (!REMOTE_PASSWORD) return bad(res, 500, "REMOTE_PASSWORD is not set in .env");
    if (password !== REMOTE_PASSWORD) return bad(res, 401, "Unauthorized");
    if (!channelId || !message) return bad(res, 400, "Missing channelId or message");

    const ch = await client.channels.fetch(channelId).catch(() => null);
    if (!ch || !ch.isTextBased()) return bad(res, 404, "Channel not found or not text");

    // Safety: only allow sending into channels that are inside your Tickets category
    if (!isTicketChannel(ch)) return bad(res, 403, "That channel is not in the Tickets category");

    await ch.send(String(message).slice(0, 1800));
    return res.json({ ok: true });
  } catch (e) {
    console.error("Remote /send error:", e);
    return bad(res, 500, "Server error");
  }
});

app.listen(PORT, () => {
  console.log(`Remote control listening on http://localhost:${PORT} (open /panel)`);
});
