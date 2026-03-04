const express = require("express");
const cors = require("cors");
const cron = require("node-cron");
const https = require("https");
const path = require("path");

const app = express();
app.use(cors());
app.use(express.json());
app.use(express.static(path.join(__dirname, "public")));

const SLACK_TOKEN = process.env.SLACK_TOKEN || "";
const PORT = process.env.PORT || 3000;

const PROJECTS = [
  { id: "C0ADWK5LGT1", name: "CairoLive", emoji: "🔴", color: "#1A3A6B" },
  { id: "C0AB6NQ061X", name: "Al Nasser", emoji: "🟢", color: "#145A32" },
  { id: "C0ABM2D50LE", name: "Print Out", emoji: "🖨️", color: "#4A235A" },
  { id: "C0AC25HP64T", name: "Turbo", emoji: "⚡", color: "#7D3C0A" },
];

let cache = { lastUpdated: null, projects: [] };

function slackGet(endpoint) {
  return new Promise((resolve, reject) => {
    const options = {
      hostname: "slack.com",
      path: "/api/" + endpoint,
      headers: { Authorization: "Bearer " + SLACK_TOKEN },
    };
    https.get(options, (res) => {
      let data = "";
      res.on("data", (c) => { data += c; });
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
    const info = await slackGet("users.info?user=" + uid);
    const result = {
      name: (info.user && info.user.profile && info.user.profile.display_name) || 
            (info.user && info.user.real_name) || 
            (info.user && info.user.name) || uid,
      avatar: (info.user && info.user.profile && info.user.profile.image_48) || null,
    };
    userCache[uid] = result;
    return result;
  } catch (e) {
    return { name: uid, avatar: null };
  }
}

function parseMessages(messages) {
  const tasks = [];
  const blockers = [];
  for (let i = 0; i < messages.length; i++) {
    const msg = messages[i];
    if (!msg.text || msg.bot_id) continue;
    const text = msg.text.replace(/<[^>]+>/g, "").trim();
    if (!text || text.length < 10) continue;
    const ts = new Date(parseFloat(msg.ts) * 1000);
    const numbered = text.match(/\d+\.\s+.{8,}/g);
    if (numbered && numbered.length >= 2) {
      for (let j = 0; j < numbered.length; j++) {
        const clean = numbered[j].replace(/^\d+\.\s+/, "").trim();
        if (clean.length > 8) {
          tasks.push({ text: clean, date: ts.toISOString(), from: msg.user, status: "To Do" });
        }
      }
    }
    if (/block|stuck|bug|error|not work|issue|fail|broken|problem/i.test(text) && text.length > 25) {
      blockers.push({ text: text.substring(0, 250), date: ts.toISOString(), user: msg.user });
    }
  }
  return { tasks: tasks, blockers: blockers };
}

async function fetchAllProjects() {
  console.log("Fetching Slack data at " + new Date().toISOString());
  const results = [];
  for (let p = 0; p < PROJECTS.length; p++) {
    const proj = PROJECTS[p];
    try {
      const resp = await slackGet("conversations.history?channel=" + proj.id + "&limit=100");
      if (!resp.ok) {
        console.error(proj.name + " error: " + resp.error);
        results.push(Object.assign({}, proj, { members: [], tasks: [], blockers: [], recentActivity: [], messageCount: 0, error: resp.error }));
        continue;
      }
      const messages = resp.messages || [];
      const userIds = [];
      const seen = {};
      for (let i = 0; i < messages.length; i++) {
        const uid = messages[i].user;
        if (uid && !seen[uid]) { seen[uid] = true; userIds.push(uid); }
        if (userIds.length >= 12) break;
      }
      const members = [];
      for (let i = 0; i < userIds.length; i++) {
        const info = await getUserInfo(userIds[i]);
        members.push(Object.assign({ id: userIds[i] }, info));
      }
      const parsed = parseMessages(messages);
      const cutoff = Date.now() - 86400000;
      const recentActivity = [];
      for (let i = 0; i < messages.length && recentActivity.length < 6; i++) {
        const m = messages[i];
        if (parseFloat(m.ts) * 1000 > cutoff && m.text && !m.bot_id) {
          const uinfo = await getUserInfo(m.user);
          recentActivity.push({
            text: m.text.replace(/<[^>]+>/g, "").substring(0, 220),
            ts: new Date(parseFloat(m.ts) * 1000).toISOString(),
            user: uinfo.name,
          });
        }
      }
      results.push(Object.assign({}, proj, {
        members: members,
        tasks: parsed.tasks.slice(0, 25),
        blockers: parsed.blockers.slice(0, 8),
        recentActivity: recentActivity,
        messageCount: messages.length,
        lastMessage: messages[0] ? new Date(parseFloat(messages[0].ts) * 1000).toISOString() : null,
        error: null,
      }));
      console.log("OK " + proj.name + ": " + messages.length + " msgs, " + parsed.tasks.length + " tasks");
    } catch (err) {
      console.error("Error " + proj.name + ": " + err.message);
      results.push(Object.assign({}, proj, { members: [], tasks: [], blockers: [], recentActivity: [], messageCount: 0, error: err.message }));
    }
  }
  cache = { lastUpdated: new Date().toISOString(), projects: results };
  return cache;
}

app.get("/api/data", async function(req, res) {
  try {
    if (!cache.lastUpdated) await fetchAllProjects();
    res.json(cache);
  } catch (e) { res.status(500).json({ error: e.message }); }
});

app.post("/api/refresh", async function(req, res) {
  try {
    const data = await fetchAllProjects();
    res.json({ success: true, lastUpdated: data.lastUpdated });
  } catch (e) { res.status(500).json({ error: e.message }); }
});

app.get("/api/debug", async function(req, res) {
  const debug = {};
  for (let i = 0; i < PROJECTS.length; i++) {
    const proj = PROJECTS[i];
    try {
      const resp = await slackGet("conversations.history?channel=" + proj.id + "&limit=2");
      debug[proj.name] = { ok: resp.ok, error: resp.error || "none", msgs: (resp.messages || []).length };
    } catch(e) {
      debug[proj.name] = { ok: false, error: e.message, msgs: 0 };
    }
  }
  res.json(debug);
});

app.get("/api/health", function(req, res) {
  res.json({ status: "ok", lastUpdated: cache.lastUpdated });
});

app.get("*", function(req, res) {
  res.sendFile(path.join(__dirname, "public", "index.html"));
});

cron.schedule("0 6 * * 1-5", async function() {
  console.log("Morning auto-refresh");
  await fetchAllProjects();
}, { timezone: "UTC" });

fetchAllProjects().catch(console.error);

app.listen(PORT, function() {
  console.log("Running on port " + PORT);
});
