import { Client, GatewayIntentBits } from "discord.js";
import express from "express";
import Groq from "groq-sdk";
import "dotenv/config";

/* ===================== CONFIG ===================== */

const PORT = Number(process.env.PORT || 3000);
const REMOTE_PASSWORD = process.env.REMOTE_PASSWORD || "";

const TICKET_CATEGORY_ID = process.env.TICKET_CATEGORY_ID || "";
const WEBSITE_LINK = process.env.WEBSITE_LINK || "https://your-website-link-here.com";

// Credits pricing rule (as you specified)
const ROBUX_PER_CREDIT_DOLLAR = 100; // because 150 Robux = $1.50 -> 100 Robux per $1

/* ===================== GAMEPASSES (Robux) ===================== */

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

/* ===================== OPTIONAL GROQ (not required) ===================== */

let groq = null;
try {
  if (process.env.GROQ_API_KEY) {
    groq = new Groq({ apiKey: process.env.GROQ_API_KEY });
    console.log("Groq initialized (optional)");
  } else {
    console.log("GROQ_API_KEY missing — AI disabled (not needed for this flow)");
  }
} catch {
  console.log("Groq init failed — AI disabled (not needed for this flow)");
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

function detectPayMethod(text) {
  const s = (text || "").toLowerCase();
  if (s.includes("robux") || s.includes("rbx") || s.includes("r$")) return "ROBUX";
  if (s.includes("real") || s.includes("money") || s.includes("cash") || s.includes("usd") || s.includes("$")) return "REAL";
  return null;
}

function isYes(text) {
  const s = (text || "").trim().toLowerCase();
  return s === "yes" || s === "y" || s === "yeah" || s === "yea" || s === "yep";
}

function isNo(text) {
  const s = (text || "").trim().toLowerCase();
  return s === "no" || s === "n" || s === "nope" || s === "nah";
}

// Parse $ amount for credits. Must be a dollar amount like: 1.50, $5, 10, 12.75
function parseDollarAmount(textRaw) {
  if (!textRaw) return null;

  let s = textRaw.trim().toLowerCase();
  s = s.replace(/,/g, "");
  s = s.replace(/\s+/g, " ");

  // Find something that looks like $12.50 or 12.50
  const m = s.match(/\$?\s*(\d+(\.\d{1,2})?)/);
  if (!m) return null;

  const val = Number(m[1]);
  if (!Number.isFinite(val) || val <= 0) return null;

  // Round to cents
  return Math.round(val * 100) / 100;
}

function robuxNeededFromCreditsDollars(creditDollars) {
  // 150 robux = $1.50 credits -> 100 robux = $1 credits
  const exact = creditDollars * ROBUX_PER_CREDIT_DOLLAR;
  // round to nearest 50 to match pass sizes better
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
    step: "ASK_METHOD",
    method: null,
    wantsContinue: null,
    creditDollars: null
  });
}

/* ===================== MAIN TICKET FLOW ===================== */

client.on("messageCreate", async (message) => {
  try {
    if (message.author.bot) return;
    if (!message.guild) return;
    if (!isTicketChannel(message)) return;

    const channelId = message.channel.id;
    let t = tickets.get(channelId);

    // First message in a fresh ticket: start flow + ignore what they typed
    if (!t) {
      resetTicket(channelId, message.author.id);
      return message.channel.send("Are you paying with **real money** or **robux**?");
    }

    // Only original user controls the flow
    if (message.author.id !== t.userId) return;

    const raw = message.content || "";
    const txt = raw.trim().toLowerCase();

    // Restart works anytime
    if (txt === "restart" || txt === "reset" || txt === "new order" || txt === "new") {
      resetTicket(channelId, message.author.id);
      return message.channel.send("Are you paying with **real money** or **robux**?");
    }

    // If stopped, ignore everything
    if (t.step === "STOPPED") return;

    // Step 1: Ask method
    if (t.step === "ASK_METHOD") {
      const method = detectPayMethod(raw);
      if (!method) return message.channel.send("Reply with **real money** or **robux**.");

      t.method = method;

      if (method === "REAL") {
        t.step = "STOPPED";

        // EXACT sentence you required
        await message.channel.send("Check The Website To See If The Amount You're Wanting Is Available.");
        await message.channel.send(`Website: ${WEBSITE_LINK}`);

        return; // stop responding
      }

      if (method === "ROBUX") {
        t.step = "ROBEXPLAIN";

        // EXACT sentence you required (must match exactly)
        await message.channel.send(
          "You're Gonna Be Buying Store Credits, Store Credits Are Like A Card With A Balance On It, You Can Use These Credits To Buy Accounts On The Website"
        );
        return message.channel.send("Do you wish to continue with the order? Reply **yes** or **no**.");
      }
    }

    // Step 2 (Robux): Confirm continue
    if (t.step === "ROBEXPLAIN") {
      if (isNo(raw)) {
        t.step = "STOPPED";
        return; // stop responding
      }
      if (!isYes(raw)) {
        return message.channel.send("Reply **yes** or **no**.");
      }

      t.step = "ASK_CREDITS";

      await message.channel.send(
        "How many **Credits** do you want to buy?\n" +
          "You MUST send a **$ amount** when saying how many credits you want. (Example: `$1.50`, `$5`, `10.00`)\n" +
          "Your Robux payment will be calculated into credits.\n" +
          "**150 Robux = $1.50 Credits.**"
      );
      return;
    }

    // Step 3 (Robux): Ask credits amount in dollars
    if (t.step === "ASK_CREDITS") {
      const dollars = parseDollarAmount(raw);
      if (!dollars) {
        return message.channel.send(
          "I didn’t understand that. Please send a **$ amount** like: `$1.50`, `$5`, `10.00`."
        );
      }

      t.creditDollars = dollars;

      const totalRobux = robuxNeededFromCreditsDollars(dollars);
      const passList = buildGamepassList(totalRobux);

      t.step = "STOPPED";

      await message.channel.send(
        `Credits Amount: **$${dollars.toFixed(2)}**\n` +
          `Robux Needed (calculated): **${totalRobux} Robux**\n\n` +
          `Buy these gamepasses:\n${passList}\n\n` +
          `Please send a **screenshot proof** of buying after you're done.`
      );

      return; // stop responding after this
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
