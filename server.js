const express = require("express");
const cors = require("cors");
const cron = require("node-cron");
const https = require("https");
const path = require("path");
const fs = require("fs");

const app = express();
app.use(cors());
app.use(express.json());
app.use(express.static(path.join(__dirname, "public")));

// ── Config ────────────────────────────────────────────────────────────────────
const SLACK_TOKEN = process.env.SLACK_TOKEN || "YOUR_SLACK_BOT_TOKEN";
const PORT = process.env.PORT || 3000;

const PROJECTS = [
  { id: "C0ADWK5LGT1", name: "CairoLive",  emoji: "🔴", color: "#1A3A6B" },
  { id: "C0AB6NQ061X", name: "Al Nasser",  emoji: "🟢", color: "#145A32" },
  { id: "C0ABM2D50LE", name: "Print Out",  emoji: "🖨️", color: "#4A235A" },
  { id: "C0AC25HP64T", name: "Turbo",      emoji: "⚡", color: "#7D3C0A" },
];

// ── In-memory cache ───────────────────────────────────────────────────────────
let cache = {
  lastUpdated: null,
  projects: [],
};

// ── Slack API helper ──────────────────────────────────────────────────────────
function slackGet(endpoint) {
  return new Promise((resolve, reject) => {
    const options = {
      hostname: "slack.com",
      path: `/api/${endpoint}`,
      headers: { Authorization: `Bearer ${SLACK_TOKEN}` },
    };
    https.get(options, (res) => {
      let data = "";
      res.on("data", (chunk) => (data += chunk));
      res.on("end", () => {
        try { resolve(JSON.parse(data)); }
        catch (e) { reject(e); }
      });
    }).on("error", reject);
  });
}

// ── Parse messages into standup entries & tasks ───────────────────────────────
function parseMessages(messages, channelName) {
  const userMap = {};
  const tasks = [];
  const standups = [];
  const blockers = [];

  for (const msg of messages) {
    if (!msg.text || msg.subtype) continue;
    const text = msg.text;
    const ts = new Date(parseFloat(msg.ts) * 1000);
    const user = msg.username || msg.user || "Unknown";

    // Detect task lists (numbered items from Mok)
    const taskMatches = text.match(/\d+\.\s+.+/g);
    if (taskMatches && taskMatches.length >= 2) {
      taskMatches.forEach((t, i) => {
        const clean = t.replace(/^\d+\.\s+/, "").replace(/<[^>]+>/g, "").trim();
        if (clean.length > 10) {
          tasks.push({
            id: `${channelName.substring(0,2).toUpperCase()}-${Date.now()}-${i}`,
            text: clean,
            date: ts.toISOString(),
            from: user,
            status: "🆕 To Do",
          });
        }
      });
    }

    // Detect blockers
    if (/block|stuck|issue|bug|fix|error|not work/i.test(text) && text.length > 30) {
      blockers.push({
        text: text.replace(/<[^>]+>/g, "").substring(0, 200),
        date: ts.toISOString(),
        user,
      });
    }

    // Detect standup updates (yesterday/today patterns)
    if (/yesterday|today|done|completed|working on|will/i.test(text) && text.length > 20) {
      standups.push({
        text: text.replace(/<[^>]+>/g, "").substring(0, 300),
        date: ts.toISOString(),
        user,
      });
    }
  }

  return { tasks, standups, blockers };
}

// ── Fetch all project data from Slack ─────────────────────────────────────────
async function fetchAllProjects() {
  console.log(`[${new Date().toISOString()}] Fetching Slack data...`);
  const results = [];

  for (const proj of PROJECTS) {
    try {
      const resp = await slackGet(
        `conversations.history?channel=${proj.id}&limit=100`
      );
      const messages = resp.messages || [];

      // Get unique users from messages
      const userIds = [...new Set(messages.map((m) => m.user).filter(Boolean))];
      const members = [];
      for (const uid of userIds.slice(0, 10)) {
        try {
          const info = await slackGet(`users.info?user=${uid}`);
          if (info.user) {
            members.push({
              id: uid,
              name: info.user.real_name || info.user.name,
              avatar: info.user.profile?.image_48,
            });
          }
        } catch (_) {}
      }

      const { tasks, standups, blockers } = parseMessages(messages, proj.name);

      // Recent activity (last 24h)
      const yesterday = Date.now() - 86400000;
      const recentMsgs = messages
        .filter((m) => parseFloat(m.ts) * 1000 > yesterday)
        .slice(0, 5)
        .map((m) => ({
          text: (m.text || "").replace(/<[^>]+>/g, "").substring(0, 200),
          ts: new Date(parseFloat(m.ts) * 1000).toISOString(),
          user: members.find((u) => u.id === m.user)?.name || m.user || "Unknown",
        }));

      results.push({
        ...proj,
        members,
        tasks: tasks.slice(0, 20),
        standups: standups.slice(0, 5),
        blockers: blockers.slice(0, 5),
        recentActivity: recentMsgs,
        messageCount: messages.length,
        lastMessage: messages[0]
          ? new Date(parseFloat(messages[0].ts) * 1000).toISOString()
          : null,
      });
    } catch (err) {
      console.error(`Error fetching ${proj.name}:`, err.message);
      results.push({ ...proj, members: [], tasks: [], standups: [], blockers: [], recentActivity: [], error: err.message });
    }
  }

  cache = { lastUpdated: new Date().toISOString(), projects: results };
  console.log(`[${new Date().toISOString()}] Cache updated.`);
  return cache;
}

// ── API routes ────────────────────────────────────────────────────────────────
app.get("/api/data", async (req, res) => {
  try {
    if (!cache.lastUpdated) await fetchAllProjects();
    res.json(cache);
  } catch (e) {
    res.status(500).json({ error: e.message });
  }
});

app.post("/api/refresh", async (req, res) => {
  try {
    const data = await fetchAllProjects();
    res.json({ success: true, lastUpdated: data.lastUpdated });
  } catch (e) {
    res.status(500).json({ error: e.message });
  }
});

app.get("/api/health", (_, res) =>
  res.json({ status: "ok", lastUpdated: cache.lastUpdated })
);

// Serve dashboard for all other routes
app.get("*", (_, res) =>
  res.sendFile(path.join(__dirname, "public", "index.html"))
);

// ── Cron: every weekday at 8:00 AM (Cairo time = UTC+2, so 6:00 UTC) ─────────
cron.schedule("0 6 * * 1-5", async () => {
  console.log("⏰ Morning auto-refresh triggered");
  await fetchAllProjects();
}, { timezone: "UTC" });

// Initial fetch on startup
fetchAllProjects().catch(console.error);

app.listen(PORT, () =>
  console.log(`✅ Standup Dashboard running on http://localhost:${PORT}`)
);
