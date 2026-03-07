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
  { id: "C0AC25HP64T", name: "Turbo",     emoji: "⚡", color: "#7D3C0A" },
];

let cache = { lastUpdated: null, projects: [] };

function slackGet(endpoint) {
  return new Promise(function(resolve, reject) {
    var options = {
      hostname: "slack.com",
      path: "/api/" + endpoint,
      headers: { Authorization: "Bearer " + SLACK_TOKEN },
    };
    https.get(options, function(res) {
      var data = "";
      res.on("data", function(c) { data += c; });
      res.on("end", function() {
        try { resolve(JSON.parse(data)); }
        catch (e) { reject(e); }
      });
    }).on("error", reject);
  });
}

var userCache = {};
async function getUserInfo(uid) {
  if (!uid) return { name: "Unknown", avatar: null };
  if (userCache[uid]) return userCache[uid];
  try {
    var info = await slackGet("users.info?user=" + uid);
    var result = {
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

function cleanText(t) {
  return t.replace(/<[^>/g, "").trim();
}

function isBlocker(t) {
  var words = ["block", "stuck", "bug", "error", "not work", "issue", "fail", "broken", "problem"];
  var lower = t.toLowerCase();
  for (var i = 0; i < words.length; i++) {
    if (lower.indexOf(words[i]) !== -1) return true;
  }
  return false;
}

function parseMessages(messages) {
  var tasks = [];
  var blockers = [];
  for (var i = 0; i < messages.length; i++) {
    var msg = messages[i];
    if (!msg.text || msg.bot_id) continue;
    var text = cleanText(msg.text);
    if (!text || text.length < 10) continue;
    var ts = new Date(parseFloat(msg.ts) * 1000);
    var lines = text.split("\n");
    var numbered = [];
    for (var j = 0; j < lines.length; j++) {
      if (/^\d+\./.test(lines[j]) && lines[j].length > 8) numbered.push(lines[j]);
    }
    if (numbered.length >= 2) {
      for (var k = 0; k < numbered.length; k++) {
        var clean = numbered[k].replace(/^\d+\.\s*/, "").trim();
        if (clean.length > 8) tasks.push({ text: clean, date: ts.toISOString(), from: msg.user, status: "To Do" });
      }
    }
    if (isBlocker(text) && text.length > 25) blockers.push({ text: text.substring(0, 250), date: ts.toISOString(), user: msg.user });
  }
  return { tasks: tasks, blockers: blockers };
}

async function fetchAllProjects() {
  console.log("Fetching at " + new Date().toISOString());
  var results = [];
  for (var p = 0; p < PROJECTS.length; p++) {
    var proj = PROJECTS[p];
    try {
      var resp = await slackGet("conversations.history?channel=" + proj.id + "&limit=100");
      if (!resp.ok) {
        results.push(Object.assign({}, proj, { members: [], tasks: [], blockers: [], recentActivity: [], messageCount: 0, error: resp.error }));
        continue;
      }
      var messages = resp.messages || [];
      var userIds = []; var seen = {};
      for (var i = 0; i < messages.length; i++) {
        var uid = messages[i].user;
        if (uid && !seen[uid]) { seen[uid] = true; userIds.push(uid); }
        if (userIds.length >= 10) break;
      }
      var members = [];
      for (var i = 0; i < userIds.length; i++) {
        var uinfo = await getUserInfo(userIds[i]);
        members.push(Object.assign({ id: userIds[i] }, uinfo));
      }
      var parsed = parseMessages(messages);
      var cutoff = Date.now() - 86400000;
      var recentActivity = [];
      for (var i = 0; i < messages.length && recentActivity.length < 6; i++) {
        var m = messages[i];
        if (parseFloat(m.ts) * 1000 > cutoff && m.text && !m.bot_id) {
          var u = await getUserInfo(m.user);
          recentActivity.push({ text: cleanText(m.text).substring(0, 200), ts: new Date(parseFloat(m.ts) * 1000).toISOString(), user: u.name });
        }
      }
      results.push(Object.assign({}, proj, {
        members: members, tasks: parsed.tasks.slice(0, 25), blockers: parsed.blockers.slice(0, 8),
        recentActivity: recentActivity, messageCount: messages.length,
        lastMessage: messages[0] ? new Date(parseFloat(messages[0].ts) * 1000).toISOString() : null, error: null,
      }));
      console.log("OK " + proj.name + ": " + messages.length + " msgs");
    } catch (err) {
      results.push(Object.assign({}, proj, { members: [], tasks: [], blockers: [], recentActivity: [], messageCount: 0, error: err.message }));
    }
  }
  cache = { lastUpdated: new Date().toISOString(), projects: results };
  return cache;
}

app.get("/api/data", async function(req, res) {
  try { if (!cache.lastUpdated) await fetchAllProjects(); res.json(cache); }
  catch (e) { res.status(500).json({ error: e.message }); }
});

app.post("/api/refresh", async function(req, res) {
  try { var data = await fetchAllProjects(); res.json({ success: true, lastUpdated: data.lastUpdated }); }
  catch (e) { res.status(500).json({ error: e.message }); }
});

app.get("/api/debug", async function(req, res) {
  var debug = {};
  for (var i = 0; i < PROJECTS.length; i++) {
    var proj = PROJECTS[i];
    try {
      var r = await slackGet("conversations.history?channel=" + proj.id + "&limit=2");
      debug[proj.name] = { ok: r.ok, error: r.error || "none", msgs: (r.messages || []).length };
    } catch(e) { debug[proj.name] = { ok: false, error: e.message, msgs: 0 }; }
  }
  res.json(debug);
});

app.get("/api/health", function(req, res) { res.json({ status: "ok", lastUpdated: cache.lastUpdated }); });
app.get("*", function(req, res) { res.sendFile(path.join(__dirname, "public", "index.html")); });

cron.schedule("0 6 * * 1-5", async function() { await fetchAllProjects(); }, { timezone: "UTC" });

fetchAllProjects().catch(console.error);
app.listen(PORT, function() { console.log("Running on port " + PORT); });
