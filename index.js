import { Client, GatewayIntentBits } from "discord.js";
import Groq from "groq-sdk";
import express from "express";
import "dotenv/config";

/* ===================== BASIC CONFIG ===================== */

const client = new Client({
  intents: [
    GatewayIntentBits.Guilds,
    GatewayIntentBits.GuildMessages,
    GatewayIntentBits.MessageContent
  ]
});

const PORT = Number(process.env.PORT || 3000);
const REMOTE_PASSWORD = process.env.REMOTE_PASSWORD || "";

const TICKET_CATEGORY_ID = process.env.TICKET_CATEGORY_ID || "";
const CASHAPP_LINK = process.env.CASHAPP_LINK || "";
const PAYPAL_LINK = process.env.PAYPAL_LINK || "";

/* ===================== SAFE GROQ INIT ===================== */

let groq = null;
try {
  if (process.env.GROQ_API_KEY) {
    groq = new Groq({ apiKey: process.env.GROQ_API_KEY });
    console.log("Groq initialized");
  } else {
    console.log("GROQ_API_KEY missing — AI disabled");
  }
} catch (e) {
  console.error("Groq failed to initialize — AI disabled");
  groq = null;
}

/* ===================== PRICING ===================== */

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

/* ===================== HELPERS ===================== */

function isTicketChannel(obj) {
  const ch = obj?.channel ?? obj;
  if (!ch || !ch.parentId) return false;
  return ch.parentId === TICKET_CATEGORY_ID;
}

function parseAmount(text) {
  const s = text.toLowerCase();
  if (s.includes("max")) return MAX_MONEY;

  const m = s.replace(/,/g, "").match(/(\d+(\.\d+)?)(k|m)?/);
  if (!m) return null;

  let n = Number(m[1]);
  if (m[3] === "k") n *= 1000;
  if (m[3] === "m") n *= 1000000;

  return Math.round(n);
}

function closestRobux(gameMoney) {
  const exact = (gameMoney / 100000) * ROBUX_PER_100K;
  const rounded = Math.round(exact / 50) * 50;
  return rounded;
}

function buildGamepasses(total) {
  let remaining = total;
  const sorted = [...gamepasses].sort((a, b) => b.robux - a.robux);
  const lines = [];

  for (const gp of sorted) {
    while (remaining >= gp.robux) {
      lines.push(`• ${gp.robux} Robux – ${gp.url}`);
      remaining -= gp.robux;
    }
  }
  return lines;
}

/* ===================== TICKET STATE ===================== */

const tickets = new Map();

function resetTicket(channelId, userId) {
  tickets.set(channelId, {
    userId,
    step: "ASK_AMOUNT",
    amount: null,
    method: null,
    memory: []
  });
}

/* ===================== DISCORD LOGIC ===================== */

client.once("ready", () => {
  console.log(`Logged in as ${client.user.tag}`);
});

client.on("messageCreate", async (message) => {
  try {
    if (message.author.bot) return;
    if (!isTicketChannel(message)) return;

    const channelId = message.channel.id;
    let t = tickets.get(channelId);

    if (!t) {
      resetTicket(channelId, message.author.id);
      return message.channel.send("How much game money do you want to buy?");
    }

    if (message.author.id !== t.userId) return;

    const txt = message.content.trim().toLowerCase();

    if (txt === "restart") {
      resetTicket(channelId, message.author.id);
      return message.channel.send("How much game money do you want to buy?");
    }

    if (t.step === "ASK_AMOUNT") {
      const amt = parseAmount(txt);
      if (!amt) return message.channel.send("Say an amount like `700k`, `1m`, or `max money`.");

      t.amount = Math.min(amt, MAX_MONEY);
      t.step = "ASK_METHOD";
      return message.channel.send("Paying with **real money** or **robux**?");
    }

    if (t.step === "ASK_METHOD") {
      if (txt.includes("robux")) {
        const robux = closestRobux(t.amount);
        const lines = buildGamepasses(robux);

        t.step = "DONE";
        t.method = "ROBUX";

        return message.channel.send(
          `Total: **${robux} Robux**\n\n` + lines.join("\n")
        );
      }

      if (txt.includes("real") || txt.includes("cash")) {
        const usd = ((t.amount / 100000) * USD_PER_100K).toFixed(2);
        t.step = "DONE";
        t.method = "USD";

        return message.channel.send(
          `Total: **$${usd}**\nCash App: ${CASHAPP_LINK}\nPayPal: ${PAYPAL_LINK}`
        );
      }

      return message.channel.send("Say **real money** or **robux**.");
    }

    /* ===== NORMAL AI CHAT AFTER CHECKOUT ===== */

    if (!groq) {
      return message.channel.send("AI temporarily unavailable.");
    }

    t.memory.push({ role: "user", content: message.content });
    if (t.memory.length > 10) t.memory.shift();

    const res = await groq.chat.completions.create({
      model: "llama-3.1-8b-instant",
      messages: t.memory
    });

    const reply = res.choices[0].message.content;
    t.memory.push({ role: "assistant", content: reply });

    message.channel.send(reply);

  } catch (err) {
    console.error("Message crash prevented:", err);
  }
});

client.login(process.env.DISCORD_TOKEN);

/* ===================== REMOTE CONTROL SERVER ===================== */

const app = express();
app.use(express.json());

app.get("/", (req, res) => {
  res.send("Remote control running");
});

app.get("/panel", (req, res) => {
  res.send(`
    <form onsubmit="send();return false;">
      <input id=p placeholder=password><br>
      <input id=c placeholder=channelId><br>
      <textarea id=m></textarea><br>
      <button>Send</button>
      <pre id=o></pre>
    </form>
    <script>
      async function send(){
        const r=await fetch('/send',{method:'POST',headers:{'Content-Type':'application/json'},body:JSON.stringify({
          password:p.value,channelId:c.value,message:m.value
        })});
        o.textContent=await r.text();
      }
    </script>
  `);
});

app.post("/send", async (req, res) => {
  try {
    if (req.body.password !== REMOTE_PASSWORD) return res.send("unauthorized");
    const ch = await client.channels.fetch(req.body.channelId).catch(() => null);
    if (!ch || !isTicketChannel(ch)) return res.send("bad channel");
    await ch.send(req.body.message);
    res.send("ok");
  } catch {
    res.send("error");
  }
});

app.listen(PORT, () => {
  console.log(`Remote panel on port ${PORT}`);
});
