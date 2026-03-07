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
  return new Promise(function(resolve, reject) {
    const opts = {
      hostname: "slack.com",
      path: "/api/" + endpoint,
      headers: { Authorization: "Bearer " + SLACK_TOKEN },
    };
    https.get(opts, function(res) {
      let d = "";
      res.on("data", function(c) { d += c; });
      res.on("end", function() {
        try { resolve(JSON.parse(d)); } catch(e) { reject(e); }
      });
    }).on("error", reject);
  });
}

const uCache = {};
async function getUser(uid) {
  if (!uid) return { name: "Unknown", avatar: null };
  if (uCache[uid]) return uCache[uid];
  try {
    const r = await slackGet("users.info?user=" + uid);
    const u = r.user || {};
    const p = u.profile || {};
    const result = { name: p.display_name || u.real_name || u.name || uid, avatar: p.image_48 || null };
    uCache[uid] = result;
    return result;
  } catch(e) { return { name: uid, avatar: null }; }
}

function stripTags(s) {
  let out = "";
  let inTag = false;
  for (let i = 0; i < s.length; i++) {
    if (s[i] === "<") { inTag = true; continue; }
    if (s[i] === ">") { inTag = false; continue; }
    if (!inTag) out += s[i];
  }
  return out.trim();
}

function hasBlockerWord(t) {
  const words = ["block", "stuck", "bug", "error", "not work", "issue", "fail", "broken", "problem", "crash"];
  const low = t.toLowerCase();
  for (let i = 0; i < words.length; i++) {
    if (low.indexOf(words[i]) >= 0) return true;
  }
  return false;
}

function startsWithNumber(line) {
  let i = 0;
  while (i < line.length && line[i] >= "0" && line[i] <= "9") i++;
  return i > 0 && i < line.length && line[i] === ".";
}

function parseMessages(messages) {
  const tasks = [], blockers = [];
  for (let i = 0; i < messages.length; i++) {
    const msg = messages[i];
    if (!msg.text || msg.bot_id) continue;
    const text = stripTags(msg.text);
    if (!text || text.length < 10) continue;
    const ts = new Date(parseFloat(msg.ts) * 1000).toISOString();
    const lines = text.split("\n");
    const numbered = [];
    for (let j = 0; j < lines.length; j++) {
      const line = lines[j].trim();
      if (startsWithNumber(line) && line.length > 8) numbered.push(line);
    }
    if (numbered.length >= 2) {
      for (let k = 0; k < numbered.length; k++) {
        let clean = numbered[k];
        let dot = clean.indexOf(".");
        clean = clean.substring(dot + 1).trim();
        if (clean.length > 8) tasks.push({ text: clean, date: ts, from: msg.user, status: "To Do" });
      }
    }
    if (hasBlockerWord(text) && text.length > 25) {
      blockers.push({ text: text.substring(0, 250), date: ts, user: msg.user });
    }
  }
  return { tasks: tasks, blockers: blockers };
}

async function fetchAll() {
  console.log("Fetching " + new Date().toISOString());
  const results = [];
  for (let p = 0; p < PROJECTS.length; p++) {
    const proj = PROJECTS[p];
    try {
      const resp = await slackGet("conversations.history?channel=" + proj.id + "&limit=100");
      if (!resp.ok) {
        console.log(proj.name + " error: " + resp.error);
        results.push(Object.assign({}, proj, { members:[], tasks:[], blockers:[], recentActivity:[], messageCount:0, error:resp.error }));
        continue;
      }
      const msgs = resp.messages || [];
      const seen = {}, uids = [];
      for (let i = 0; i < msgs.length; i++) {
        const uid = msgs[i].user;
        if (uid && !seen[uid]) { seen[uid] = true; uids.push(uid); }
        if (uids.length >= 10) break;
      }
      const members = [];
      for (let i = 0; i < uids.length; i++) {
        const u = await getUser(uids[i]);
        members.push(Object.assign({ id: uids[i] }, u));
      }
      const parsed = parseMessages(msgs);
      const cutoff = Date.now() - 86400000;
      const recent = [];
      for (let i = 0; i < msgs.length && recent.length < 6; i++) {
        const m = msgs[i];
        if (parseFloat(m.ts) * 1000 > cutoff && m.text && !m.bot_id) {
          const u = await getUser(m.user);
          recent.push({ text: stripTags(m.text).substring(0, 200), ts: new Date(parseFloat(m.ts) * 1000).toISOString(), user: u.name });
        }
      }
      results.push(Object.assign({}, proj, {
        members: members,
        tasks: parsed.tasks.slice(0, 25),
        blockers: parsed.blockers.slice(0, 8),
        recentActivity: recent,
        messageCount: msgs.length,
        lastMessage: msgs[0] ? new Date(parseFloat(msgs[0].ts) * 1000).toISOString() : null,
        error: null,
      }));
      console.log("OK " + proj.name + " " + msgs.length + " msgs");
    } catch(err) {
      console.log("ERR " + proj.name + " " + err.message);
      results.push(Object.assign({}, proj, { members:[], tasks:[], blockers:[], recentActivity:[], messageCount:0, error:err.message }));
    }
  }
  cache = { lastUpdated: new Date().toISOString(), projects: results };
  return cache;
}

app.get("/api/data", async function(req, res) {
  try { if (!cache.lastUpdated) await fetchAll(); res.json(cache); }
  catch(e) { res.status(500).json({ error: e.message }); }
});

app.post("/api/refresh", async function(req, res) {
  try { const d = await fetchAll(); res.json({ success: true, lastUpdated: d.lastUpdated }); }
  catch(e) { res.status(500).json({ error: e.message }); }
});

app.get("/api/debug", async function(req, res) {
  const out = {};
  for (let i = 0; i < PROJECTS.length; i++) {
    const proj = PROJECTS[i];
    try {
      const r = await slackGet("conversations.history?channel=" + proj.id + "&limit=2");
      out[proj.name] = { ok: r.ok, error: r.error || "none", msgs: (r.messages || []).length };
    } catch(e) { out[proj.name] = { ok: false, error: e.message }; }
  }
  res.json(out);
});

app.get("/api/health", function(req, res) { res.json({ status: "ok", lastUpdated: cache.lastUpdated }); });
app.get("*", function(req, res) { res.sendFile(path.join(__dirname, "public", "index.html")); });

cron.schedule("0 6 * * 1-5", async function() { await fetchAll(); }, { timezone: "UTC" });

fetchAll().catch(console.error);
app.listen(PORT, function() { console.log("OK port " + PORT); });
