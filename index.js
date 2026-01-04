import { Client, GatewayIntentBits } from "discord.js";
import Groq from "groq-sdk";
import express from "express";
import "dotenv/config";

/* ===================== CONFIG ===================== */

const PORT = Number(process.env.PORT || 3000);
const REMOTE_PASSWORD = process.env.REMOTE_PASSWORD || "";

const TICKET_CATEGORY_ID = process.env.TICKET_CATEGORY_ID || "";
const CASHAPP_LINK = process.env.CASHAPP_LINK || "https://cash.app/$RimarrX";
const PAYPAL_LINK = process.env.PAYPAL_LINK || "https://www.paypal.com/paypalme/lmLandon";

const USD_PER_100K = 1.5;
const ROBUX_PER_100K = 150;
const MAX_MONEY = 1750000;

/* ===================== GAMEPASSES ===================== */

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

/* ===================== SAFE GROQ INIT (won't crash bot) ===================== */

let groq = null;
try {
  if (process.env.GROQ_API_KEY) {
    groq = new Groq({ apiKey: process.env.GROQ_API_KEY });
    console.log("Groq initialized");
  } else {
    console.log("GROQ_API_KEY missing — AI disabled (checkout still works)");
  }
} catch (e) {
  console.error("Groq failed to initialize — AI disabled (checkout still works)");
  groq = null;
}

/* ===================== DISCORD CLIENT ===================== */

const client = new Client({
  intents: [GatewayIntentBits.Guilds, GatewayIntentBits.GuildMessages, GatewayIntentBits.MessageContent]
});

client.once("ready", () => {
  console.log(`Logged in as ${client.user.tag}`);
});

/* ===================== HELPERS ===================== */

function isTicketChannel(obj) {
  const ch = obj?.channel ?? obj;
  if (!ch) return false;
  if (!TICKET_CATEGORY_ID) return false;
  return ch.parentId === TICKET_CATEGORY_ID;
}

function formatNumber(n) {
  return Number(n).toLocaleString("en-US");
}

function parseAmount(textRaw) {
  if (!textRaw) return null;
  const text = textRaw.toLowerCase().trim();

  // "max money" keywords
  if (text.includes("max")) return MAX_MONEY;
  if (text.includes("maximum")) return MAX_MONEY;

  // remove commas/spaces
  const cleaned = text.replace(/,/g, "").replace(/\s+/g, " ");

  // match first number + optional suffix
  const m = cleaned.match(/(\d+(\.\d+)?)(\s*)(k|m)?/i);
  if (!m) return null;

  let n = Number(m[1]);
  if (!Number.isFinite(n) || n <= 0) return null;

  const suffix = (m[4] || "").toLowerCase();
  if (suffix === "k") n *= 1000;
  if (suffix === "m") n *= 1000000;

  n = Math.round(n);
  if (n <= 0) return null;

  return Math.min(n, MAX_MONEY);
}

function detectMethod(textRaw) {
  const t = (textRaw || "").toLowerCase();
  if (t.includes("robux") || t.includes("rbx") || t.includes("r$")) return "ROBUX";
  if (t.includes("real") || t.includes("cash") || t.includes("usd") || t.includes("$") || t.includes("paypal") || t.includes("cashapp"))
    return "USD";
  return null;
}

function usdTotal(gameMoney) {
  return (gameMoney / 100000) * USD_PER_100K;
}

function robuxTotal(gameMoney) {
  // round to nearest 50 so it matches your gamepass step sizes better
  const exact = (gameMoney / 100000) * ROBUX_PER_100K;
  return Math.round(exact / 50) * 50;
}

function buildGamepassList(totalRobux) {
  const sorted = [...gamepasses].sort((a, b) => b.robux - a.robux);
  let remaining = totalRobux;
  const lines = [];

  for (const gp of sorted) {
    while (remaining >= gp.robux) {
      lines.push(`• ${gp.robux} Robux – ${gp.url}`);
      remaining -= gp.robux;
    }
  }

  if (lines.length === 0) {
    lines.push(`• (No passes matched. Total needed: ${totalRobux} Robux)`);
  } else if (remaining !== 0) {
    lines.push(`(Note: missing ${remaining} Robux with the current pass set.)`);
  }

  return lines.join("\n");
}

/* ===================== TICKET STATE ===================== */

const tickets = new Map();

function resetTicket(channelId, userId) {
  tickets.set(channelId, {
    userId,
    step: "ASK_AMOUNT",
    amount: null,
    method: null
  });
}

/* ===================== MAIN BOT LOGIC ===================== */

client.on("messageCreate", async (message) => {
  try {
    if (message.author.bot) return;
    if (!message.guild) return;
    if (!isTicketChannel(message)) return;

    const channelId = message.channel.id;
    let t = tickets.get(channelId);

    // If first time in this ticket, start the flow and ignore their first message content
    if (!t) {
      resetTicket(channelId, message.author.id);
      return message.channel.send("How much game money do you want to buy? (ex: 700k, 1m, 1,750,000, max money)");
    }

    // Only the person who started the ticket flow can answer it
    if (message.author.id !== t.userId) return;

    const raw = message.content || "";
    const txt = raw.trim().toLowerCase();

    // Restart command works any time
    if (txt === "restart" || txt === "reset" || txt === "new order" || txt === "new") {
      resetTicket(channelId, message.author.id);
      return message.channel.send("How much game money do you want to buy? (ex: 700k, 1m, max money)");
    }

    // After checkout is done: STOP responding (optional final message is already sent at checkout)
    if (t.step === "DONE") {
      return; // ignore everything else
    }

    // Ask amount
    if (t.step === "ASK_AMOUNT") {
      let amt = parseAmount(raw);

      // If they typed weird phrasing and you still want AI help parsing, you can enable this
      // but you asked to stop chatting after checkout; this only helps amount parsing.
      if (!amt && groq) {
        try {
          const res = await groq.chat.completions.create({
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
              { role: "user", content: raw }
            ]
          });

          const out = res.choices?.[0]?.message?.content?.trim() || "";
          const s = out.indexOf("{");
          const e = out.lastIndexOf("}");
          if (s !== -1 && e !== -1) {
            const obj = JSON.parse(out.slice(s, e + 1));
            if (typeof obj.amount === "number" && Number.isFinite(obj.amount) && obj.amount > 0) {
              amt = Math.min(Math.round(obj.amount), MAX_MONEY);
            }
          }
        } catch {
          // ignore AI parse failures
        }
      }

      if (!amt) {
        return message.channel.send("I didn’t understand the amount. Try: `700k`, `1m`, `1,750,000`, or `max money`.");
      }

      t.amount = amt;
      t.step = "ASK_METHOD";
      return message.channel.send(`Got it: **${formatNumber(amt)}** game money. Are you paying with **real money** or **robux**?`);
    }

    // Ask payment method + send checkout links + STOP responding afterward
    if (t.step === "ASK_METHOD") {
      const method = detectMethod(raw);
      if (!method) return message.channel.send("Reply with **real money** or **robux**.");

      t.method = method;

      if (method === "USD") {
        const total = usdTotal(t.amount);
        t.step = "DONE";

        await message.channel.send(
          `Total: **$${total.toFixed(2)}**\nCash App: ${CASHAPP_LINK}\nPayPal: ${PAYPAL_LINK}`
        );

        // OPTIONAL FINAL MESSAGE (you asked for this)
        return message.channel.send("Send payment using the links above. Type `restart` to start a new order.");
      }

      if (method === "ROBUX") {
        const total = robuxTotal(t.amount);
        t.step = "DONE";

        await message.channel.send(`Total: **${total} Robux**\n\n${buildGamepassList(total)}`);

        // OPTIONAL FINAL MESSAGE (you asked for this)
        return message.channel.send("Buy the passes above. Type `restart` to start a new order.");
      }
    }
  } catch (err) {
    console.error("Message handler crash prevented:", err);
  }
});

client.login(process.env.DISCORD_TOKEN);

/* ===================== REMOTE CONTROL SERVER ===================== */

const app = express();
app.use(express.json({ limit: "256kb" }));

app.get("/", (req, res) => {
  res.type("text").send("Remote control running. Open /panel");
});

app.get("/panel", (req, res) => {
  res.type("html").send(`<!doctype html>
<html>
<head>
  <meta charset="utf-8" />
  <meta name="viewport" content="width=device-width, initial-scale=1" />
  <title>Bot Remote Panel</title>
  <style>
    body{font-family:Arial,sans-serif;max-width:700px;margin:20px auto;padding:0 12px}
    input,textarea,button{width:100%;padding:10px;margin:6px 0;font-size:16px}
    textarea{height:120px}
    button{cursor:pointer}
    pre{background:#f3f3f3;padding:10px;white-space:pre-wrap;word-break:break-word}
    .row{display:flex;gap:10px}
    .row>*{flex:1}
  </style>
</head>
<body>
  <h2>Send a message as the bot (tickets only)</h2>
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
      document.getElementById('status').textContent = await res.text();
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

    if (!REMOTE_PASSWORD) return res.status(500).send("REMOTE_PASSWORD not set");
    if (password !== REMOTE_PASSWORD) return res.status(401).send("unauthorized");
    if (!channelId || !message) return res.status(400).send("missing channelId or message");

    const ch = await client.channels.fetch(channelId).catch(() => null);
    if (!ch || !ch.isTextBased()) return res.status(404).send("channel not found");
    if (!isTicketChannel(ch)) return res.status(403).send("not a ticket channel");

    await ch.send(String(message).slice(0, 1800));
    return res.send("ok");
  } catch (e) {
    console.error("Remote /send error:", e);
    return res.status(500).send("error");
  }
});

app.listen(PORT, () => {
  console.log(`Remote panel listening on port ${PORT}`);
});
