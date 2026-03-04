const express = require("express");
const cors = require("cors");
const cron = require("node-cron");
const https = require("https");
const path = require("path");

const app = express();
app.use(cors());
app.use(express.json());
app.use(express.static(path.join(__dirname, "public")));

const SLACK_TOKEN = process.env.SLACK_TOKEN || "YOUR_SLACK_BOT_TOKEN";
const PORT = process.env.PORT || 3000;

const PROJECTS = [
  { id: "C0ADWK5LGT1", name: "CairoLive", emoji: "🔴", color: "#1A3A6B" },
  { id: "C0AB6NQ061X", name: "Al Nasser", emoji: "🟢", color: "#145A32" },
  { id: "C0ABM2D50LE", name: "Print Out", emoji: "🖨️", color: "#4A235A" },
  { id: "C0AC25HP64T", name: "Turbo",     emoji: "⚡", color: "#7D3C0A" },
];

let cache = { lastUpdated: null, projects: [] };

function slackGet(endpoint) {
  return new Promise((resolve, reject) => {
    const options = {
      hostname: "slack.com",
      path: `/api/${endpoint}`,
      headers: { Authorization: `Bearer ${SLACK_TOKEN}` },
    };
    https.get(options, (res) => {
      let data = "";
      res.on("data", (c) => (data += c));
      res.on("end", () => {
        try { resolve(JSON.parse(data)); }
        catch (e) { reject(e); }
      });
    }).on("error", reject);
  });
}

const userCache = {};
async function getUserInfo(uid) {
  if (!uid) return { name: "Unknown", avatar: null };
  if (userCache[uid]) return userCache[uid];
  try {
    const info = await slackGet(`users.info?user=${uid}`);
    const result = {
      name: info.user?.profile?.display_name || info.user?.real_name || info.user?.name || uid,
      avatar: info.user?.profile?.image_48 || null,
    };
    userCache[uid] = result;
    return result;
  } catch (_) { return { name: uid, avatar: null }; }
}

function parseMessages(messages) {
  const tasks = [], blockers = [];
  for (const msg of messages) {
    if (!msg.text || msg.bot_id) continue;
    const text = msg.text.replace(/<[^>]+>/g, "").trim();
    if (!text || text.length < 10) continue;
    const ts = new Date(parseFloat(msg.ts) * 1000);

    const numbered = text.match(/\d+\.\s+.{8,}/g);
    if (numbered && numbered.length >= 2) {
      numbered.forEach((t, i) => {
        const clean = t.replace(/^\d+\.\s+/, "").trim();
        if (clean.length > 8)
          tasks.push({ text: clean, date: ts.toISOString(), from: msg.user, status: "🆕 To Do" });
      });
    }

    if (/\b(block|stuck|bug|error|fix|not work|issue|fail|broken|problem)\b/i.test(text) && text.length > 25)
      blockers.push({ text: text.substring(0, 250), date: ts.toISOString(), user: msg.user });
  }
  return { tasks, blockers };
}

async function fetchAllProjects() {
  console.log(`[${new Date().toISOString()}] Fetching...`);
  const results = [];

  for (const proj of PROJECTS) {
    try {
      const resp = await slackGet(`conversations.history?channel=${proj.id}&limit=100`);

      if (!resp.ok) {
        console.error(`${proj.name}: ${resp.error}`);
        results.push({ ...proj, members: [], tasks: [], blockers: [], recentActivity: [], messageCount: 0, error: resp.error });
        continue;
      }

      const messages = resp.messages || [];
      const userIds = [...new Set(messages.map(m => m.user).filter(Boolean))].slice(0, 12);
      const memberInfos = await Promise.all(userIds.map(async uid => ({ id: uid, ...(await getUserInfo(uid)) })));

      const { tasks, blockers } = parseMessages(messages);

      const cutoff = Date.now() - 86400000;
      const recentActivity = await Promise.all(
        messages
          .filter(m => parseFloat(m.ts) * 1000 > cutoff && m.text && !m.bot_id)
          .slice(0, 6)
          .map(async m => ({
            text: m.text.replace(/<[^>]+>/g, "").substring(0, 220),
            ts: new Date(parseFloat(m.ts) * 1000).toISOString(),
            user: (await getUserInfo(m.user)).name,
          }))
      );

      results.push({
        ...proj,
        members: memberInfos,
        tasks: tasks.slice(0, 25),
        blockers: blockers.slice(0, 8),
        recentActivity,
        messageCount: messages.length,
        lastMessage: messages[0] ? new Date(parseFloat(messages[0].ts) * 1000).toISOString() : null,
        error: null,
      });
      console.log(`✅ ${proj.name}: ${messages.length} msgs, ${tasks.length} tasks`);
    } catch (err) {
      console.error(`Error ${proj.name}:`, err.message);
      results.push({ ...proj, members: [], tasks: [], blockers: [], recentActivity: [], messageCount: 0, error: err.message });
    }
  }

  cache = { lastUpdated: new Date().toISOString(), projects: results };
  return cache;
}

app.get("/api/data", async (req, res) => {
  try {
    if (!cache.lastUpdated) await fetchAllProjects();
    res.json(cache);
  } catch (e) { res.status(500).json({ error: e.message }); }
});

app.post("/api/refresh", async (req, res) => {
  try {
    const data = await fetchAllProjects();
    res.json({ success: true, lastUpdated: data.lastUpdated });
  } catch (e) { res.status(500).json({ error: e.message }); }
});

// Debug endpoint — visit /api/debug in browser to see what Slack returns
app.get("/api/debug", async (req, res) => {
  const debug = {};
  for (const proj of PROJECTS) {
    const resp = await slackGet(`conversations.history?channel=${proj.id}&limit=2`);
    debug[proj.name] = { ok: resp.ok, error: resp.error || "none", msgs: resp.messages?.length || 0 };
  }
  res.json(debug);
});

app.get("/api/health", (_, res) => res.json({ status: "ok", lastUpdated: cache.lastUpdated }));
app.get("*", (_, res) => res.sendFile(path.join(__dirname, "public", "index.html")));

cron.schedule("0 6 * * 1-5", async () => {
  console.log("⏰ Morning refresh");
  await fetchAllProjects();
}, { timezone: "UTC" });

fetchAllProjects().catch(console.error);
app.listen(PORT, () => console.log(`✅ Running on http://localhost:${PORT}`));
