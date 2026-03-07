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
  { id: "C0ADWK5LGT1", name: "CairoLive", emoji: "🔴", color: "#e85d4a" },
  { id: "C0AB6NQ061X", name: "Al Nasser", emoji: "🟢", color: "#3ecf8e" },
  { id: "C0ABM2D50LE", name: "Print Out", emoji: "🖨️", color: "#a78bfa" },
  { id: "C0AC25HP64T", name: "Turbo",     emoji: "⚡", color: "#f59e0b" },
];
const STANDUP_CHANNEL = "C0AK4KTKV2S";

let cache = { lastUpdated: null, projects: [], standup: [], team: {} };

function slackGet(endpoint) {
  return new Promise(function(resolve, reject) {
    var opts = {
      hostname: "slack.com",
      path: "/api/" + endpoint,
      headers: { Authorization: "Bearer " + SLACK_TOKEN },
    };
    https.get(opts, function(res) {
      var d = "";
      res.on("data", function(c) { d += c; });
      res.on("end", function() {
        try { resolve(JSON.parse(d)); } catch(e) { reject(e); }
      });
    }).on("error", reject);
  });
}

var uCache = {};
async function getUser(uid) {
  if (!uid) return { name: "Unknown", avatar: null };
  if (uCache[uid]) return uCache[uid];
  try {
    var r = await slackGet("users.info?user=" + uid);
    var u = r.user || {}, p = u.profile || {};
    var result = { name: p.display_name || u.real_name || u.name || uid, avatar: p.image_48 || null };
    uCache[uid] = result;
    return result;
  } catch(e) { return { name: uid, avatar: null }; }
}

function stripTags(s) {
  var out = "", inTag = false;
  for (var i = 0; i < s.length; i++) {
    if (s[i] === "<") { inTag = true; continue; }
    if (s[i] === ">") { inTag = false; continue; }
    if (!inTag) out += s[i];
  }
  return out.trim();
}

function hasBlockerWord(t) {
  var words = ["block", "stuck", "bug", "error", "not work", "issue", "fail", "broken", "problem", "crash", "cannot", "can't", "blzbt", "مشكلة"];
  var low = t.toLowerCase();
  for (var i = 0; i < words.length; i++) {
    if (low.indexOf(words[i]) >= 0) return true;
  }
  return false;
}

function startsWithNumber(line) {
  var i = 0;
  while (i < line.length && line[i] >= "0" && line[i] <= "9") i++;
  return i > 0 && i < line.length && line[i] === ".";
}

// Parse standup format: ✅ Yesterday / 🎯 Today / 🚨 Blockers
function parseStandup(text, user, ts) {
  var result = { user: user, ts: ts, yesterday: null, today: null, blockers: null, raw: text };
  var lines = text.split("\n");
  var current = null;
  var buf = [];

  for (var i = 0; i < lines.length; i++) {
    var line = lines[i].trim();
    if (!line) continue;
    var low = line.toLowerCase();
    if (low.indexOf("yesterday") >= 0 || line.indexOf("✅") >= 0) {
      if (current && buf.length) result[current] = buf.join(" ").trim();
      current = "yesterday"; buf = [line.replace(/.*yesterday[:\s]*/i, "").replace("✅", "").trim()];
    } else if (low.indexOf("today") >= 0 || line.indexOf("🎯") >= 0) {
      if (current && buf.length) result[current] = buf.join(" ").trim();
      current = "today"; buf = [line.replace(/.*today[:\s]*/i, "").replace("🎯", "").trim()];
    } else if (low.indexOf("blocker") >= 0 || line.indexOf("🚨") >= 0) {
      if (current && buf.length) result[current] = buf.join(" ").trim();
      current = "blockers"; buf = [line.replace(/.*blockers?[:\s]*/i, "").replace("🚨", "").trim()];
    } else if (current) {
      buf.push(line);
    }
  }
  if (current && buf.length) result[current] = buf.join(" ").trim();
  return result;
}

function parseMessages(messages) {
  var tasks = [], blockers = [];
  for (var i = 0; i < messages.length; i++) {
    var msg = messages[i];
    if (!msg.text || msg.bot_id) continue;
    var text = stripTags(msg.text);
    if (!text || text.length < 10) continue;
    var ts = new Date(parseFloat(msg.ts) * 1000).toISOString();
    var lines = text.split("\n");
    var numbered = [];
    for (var j = 0; j < lines.length; j++) {
      var line = lines[j].trim();
      if (startsWithNumber(line) && line.length > 8) numbered.push(line);
    }
    if (numbered.length >= 2) {
      for (var k = 0; k < numbered.length; k++) {
        var dot = numbered[k].indexOf(".");
        var clean = numbered[k].substring(dot + 1).trim();
        if (clean.length > 8) tasks.push({ text: clean, date: ts, from: msg.user, status: "To Do" });
      }
    }
    if (hasBlockerWord(text) && text.length > 25) {
      blockers.push({ text: text.substring(0, 300), date: ts, user: msg.user });
    }
  }
  return { tasks: tasks, blockers: blockers };
}

async function fetchStandup() {
  var resp = await slackGet("conversations.history?channel=" + STANDUP_CHANNEL + "&limit=200");
  if (!resp.ok) return [];
  var msgs = resp.messages || [];
  var standups = [];
  for (var i = 0; i < msgs.length; i++) {
    var m = msgs[i];
    if (!m.text || m.bot_id || m.subtype) continue;
    var text = stripTags(m.text);
    if (text.length < 15) continue;
    var u = await getUser(m.user);
    var parsed = parseStandup(text, u.name, new Date(parseFloat(m.ts) * 1000).toISOString());
    parsed.avatar = u.avatar;
    parsed.uid = m.user;
    standups.push(parsed);
  }
  return standups;
}

async function fetchAll() {
  console.log("Fetching " + new Date().toISOString());
  var results = [];
  var teamMap = {};

  for (var p = 0; p < PROJECTS.length; p++) {
    var proj = PROJECTS[p];
    try {
      var resp = await slackGet("conversations.history?channel=" + proj.id + "&limit=100");
      if (!resp.ok) {
        results.push(Object.assign({}, proj, { members:[], tasks:[], blockers:[], recentActivity:[], messageCount:0, error:resp.error }));
        continue;
      }
      var msgs = resp.messages || [];
      var seen = {}, uids = [];
      for (var i = 0; i < msgs.length; i++) {
        var uid = msgs[i].user;
        if (uid && !seen[uid]) { seen[uid] = true; uids.push(uid); }
        if (uids.length >= 15) break;
      }
      var members = [];
      for (var i = 0; i < uids.length; i++) {
        var u = await getUser(uids[i]);
        members.push(Object.assign({ id: uids[i] }, u));
        if (!teamMap[uids[i]]) teamMap[uids[i]] = { ...u, id: uids[i], projects: [], blockerCount: 0 };
        if (teamMap[uids[i]].projects.indexOf(proj.name) < 0) teamMap[uids[i]].projects.push(proj.name);
      }
      var parsed = parseMessages(msgs);
      var cutoff = Date.now() - 86400000;
      var recent = [];
      for (var i = 0; i < msgs.length && recent.length < 5; i++) {
        var m = msgs[i];
        if (parseFloat(m.ts) * 1000 > cutoff && m.text && !m.bot_id) {
          var u2 = await getUser(m.user);
          recent.push({ text: stripTags(m.text).substring(0, 250), ts: new Date(parseFloat(m.ts) * 1000).toISOString(), user: u2.name, avatar: u2.avatar, uid: m.user });
        }
      }
      // count blockers per team member
      for (var i = 0; i < parsed.blockers.length; i++) {
        var buid = parsed.blockers[i].user;
        if (teamMap[buid]) teamMap[buid].blockerCount++;
      }
      results.push(Object.assign({}, proj, {
        members: members,
        tasks: parsed.tasks.slice(0, 30),
        blockers: parsed.blockers.slice(0, 10),
        recentActivity: recent,
        messageCount: msgs.length,
        lastMessage: msgs[0] ? new Date(parseFloat(msgs[0].ts) * 1000).toISOString() : null,
        error: null,
      }));
      console.log("OK " + proj.name + " " + msgs.length + " msgs");
    } catch(err) {
      results.push(Object.assign({}, proj, { members:[], tasks:[], blockers:[], recentActivity:[], messageCount:0, error:err.message }));
    }
  }

  var standup = await fetchStandup();
  cache = { lastUpdated: new Date().toISOString(), projects: results, standup: standup, team: teamMap };
  return cache;
}

app.get("/api/data", async function(req, res) {
  try { if (!cache.lastUpdated) await fetchAll(); res.json(cache); }
  catch(e) { res.status(500).json({ error: e.message }); }
});

app.post("/api/refresh", async function(req, res) {
  try { var d = await fetchAll(); res.json({ success: true, lastUpdated: d.lastUpdated }); }
  catch(e) { res.status(500).json({ error: e.message }); }
});

app.get("/api/debug", async function(req, res) {
  var out = {};
  var channels = PROJECTS.concat([{ id: STANDUP_CHANNEL, name: "standup" }]);
  for (var i = 0; i < channels.length; i++) {
    try {
      var r = await slackGet("conversations.history?channel=" + channels[i].id + "&limit=2");
      out[channels[i].name] = { ok: r.ok, error: r.error || "none", msgs: (r.messages || []).length };
    } catch(e) { out[channels[i].name] = { ok: false, error: e.message }; }
  }
  res.json(out);
});

app.get("/api/health", function(req, res) { res.json({ status: "ok", lastUpdated: cache.lastUpdated }); });
app.get("*", function(req, res) { res.sendFile(path.join(__dirname, "public", "index.html")); });

// Auto-refresh every 2 minutes for near-real-time
cron.schedule("*/2 * * * *", async function() {
  await fetchAll();
}, { timezone: "UTC" });

fetchAll().catch(console.error);
app.listen(PORT, function() { console.log("OK port " + PORT); });
