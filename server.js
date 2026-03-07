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
  { id: "C0AB6NQ061X", name: "Al Nasser", emoji: "🟢", color: "#34d399" },
  { id: "C0ABM2D50LE", name: "Print Out", emoji: "🖨️", color: "#a78bfa" },
  { id: "C0AC25HP64T", name: "Turbo",     emoji: "⚡", color: "#fbbf24" },
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

// User cache
var uCache = {};
async function getUser(uid) {
  if (!uid) return { name: "Unknown", avatar: null };
  if (uCache[uid]) return uCache[uid];
  try {
    var r = await slackGet("users.info?user=" + uid);
    var u = r.user || {}, p = u.profile || {};
    var name = p.display_name || u.real_name || u.name || uid;
    // Clean up name
    if (name === uid || name.length < 2) name = u.real_name || uid;
    var result = { name: name, avatar: p.image_48 || null };
    uCache[uid] = result;
    return result;
  } catch(e) { return { name: uid, avatar: null }; }
}

// Preload all workspace users into cache
async function preloadUsers() {
  try {
    var r = await slackGet("users.list?limit=100");
    if (r.ok && r.members) {
      r.members.forEach(function(u) {
        if (!u.is_bot && !u.deleted) {
          var p = u.profile || {};
          var name = p.display_name || u.real_name || u.name || u.id;
          uCache[u.id] = { name: name, avatar: p.image_48 || null };
        }
      });
      console.log("Preloaded " + Object.keys(uCache).length + " users");
    }
  } catch(e) { console.log("User preload error: " + e.message); }
}

// Strip Slack formatting: <@U123|name> → name, <http://...|text> → text, &amp; → &, etc.
function cleanText(raw) {
  if (!raw) return "";
  var s = raw;
  // Replace user mentions with name
  s = s.replace(/<@([A-Z0-9]+)\|([^>]+)>/g, function(m, uid, name) { return "@" + name; });
  s = s.replace(/<@([A-Z0-9]+)>/g, function(m, uid) {
    if (uCache[uid]) return "@" + uCache[uid].name;
    return "@" + uid;
  });
  // Replace links with text
  s = s.replace(/<([^|>]+)\|([^>]+)>/g, "$2");
  s = s.replace(/<(https?:[^>]+)>/g, "$1");
  // HTML entities
  s = s.replace(/&amp;/g, "&");
  s = s.replace(/&lt;/g, "<");
  s = s.replace(/&gt;/g, ">");
  s = s.replace(/&quot;/g, '"');
  // Strip remaining angle bracket tags
  s = s.replace(/<[^>]+>/g, "");
  return s.trim();
}

function hasBlockerWord(t) {
  var words = ["block", "stuck", "bug", "error", "not work", "issue", "fail", "broken", "problem", "crash", "cannot", "can't", "blzbt", "مشكلة", "500", "failing"];
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

function formatDateTime(ts) {
  var d = new Date(parseFloat(ts) * 1000);
  return {
    date: d.toLocaleDateString("en-GB", { day: "2-digit", month: "short", year: "numeric" }),
    time: d.toLocaleTimeString("en-US", { hour: "2-digit", minute: "2-digit", hour12: true }),
    iso: d.toISOString(),
    ts: d.getTime()
  };
}

// Parse standup format
function parseStandup(text, user, ts) {
  var result = { user: user, ts: ts, yesterday: null, today: null, blockers: null, raw: text };
  var lines = text.split("\n");
  var current = null, buf = [];
  for (var i = 0; i < lines.length; i++) {
    var line = lines[i].trim();
    if (!line) continue;
    var low = line.toLowerCase();
    if (low.indexOf("yesterday") >= 0 || line.indexOf("✅") >= 0) {
      if (current && buf.length) result[current] = buf.join(" ").trim();
      current = "yesterday"; buf = [line.replace(/.*yesterday[:\s]*/i, "").replace(/✅/g, "").trim()];
    } else if (low.indexOf("today") >= 0 || line.indexOf("🎯") >= 0) {
      if (current && buf.length) result[current] = buf.join(" ").trim();
      current = "today"; buf = [line.replace(/.*today[:\s]*/i, "").replace(/🎯/g, "").trim()];
    } else if (low.indexOf("blocker") >= 0 || line.indexOf("🚨") >= 0) {
      if (current && buf.length) result[current] = buf.join(" ").trim();
      current = "blockers"; buf = [line.replace(/.*blockers?[:\s]*/i, "").replace(/🚨/g, "").trim()];
    } else if (current) {
      buf.push(line);
    }
  }
  if (current && buf.length) result[current] = buf.join(" ").trim();
  return result;
}

async function fetchStandup() {
  var resp = await slackGet("conversations.history?channel=" + STANDUP_CHANNEL + "&limit=200");
  if (!resp.ok) return [];
  var msgs = resp.messages || [];
  var standups = [];
  for (var i = 0; i < msgs.length; i++) {
    var m = msgs[i];
    if (!m.text || m.bot_id || m.subtype) continue;
    var text = cleanText(m.text);
    if (text.length < 10) continue;
    var u = await getUser(m.user);
    var dt = formatDateTime(m.ts);
    var parsed = parseStandup(text, u.name, dt.iso);
    parsed.avatar = u.avatar;
    parsed.uid = m.user;
    parsed.date = dt.date;
    parsed.time = dt.time;
    standups.push(parsed);
  }
  return standups;
}

async function parseMessages(messages) {
  var tasks = [], blockers = [];
  for (var i = 0; i < messages.length; i++) {
    var msg = messages[i];
    if (!msg.text || msg.bot_id) continue;
    var raw = msg.text;
    var text = cleanText(raw);
    if (!text || text.length < 10) continue;
    var dt = formatDateTime(msg.ts);
    var user = await getUser(msg.user);

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
        if (clean.length > 8) {
          tasks.push({
            text: clean,
            date: dt.date,
            time: dt.time,
            iso: dt.iso,
            from: user.name,
            fromAvatar: user.avatar,
            status: "To Do"
          });
        }
      }
    }
    if (hasBlockerWord(text) && text.length > 25) {
      blockers.push({
        text: text.substring(0, 350),
        date: dt.date,
        time: dt.time,
        iso: dt.iso,
        user: user.name,
        avatar: user.avatar
      });
    }
  }
  return { tasks: tasks, blockers: blockers };
}

async function fetchAll() {
  console.log("Fetching " + new Date().toISOString());
  await preloadUsers();
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
        if (!teamMap[uids[i]]) teamMap[uids[i]] = Object.assign({ id: uids[i], projects: [], blockerCount: 0 }, u);
        if (teamMap[uids[i]].projects.indexOf(proj.name) < 0) teamMap[uids[i]].projects.push(proj.name);
      }
      var parsed = await parseMessages(msgs);
      var cutoff = Date.now() - 86400000;
      var recent = [];
      for (var i = 0; i < msgs.length && recent.length < 5; i++) {
        var m = msgs[i];
        if (parseFloat(m.ts) * 1000 > cutoff && m.text && !m.bot_id) {
          var u2 = await getUser(m.user);
          var dt2 = formatDateTime(m.ts);
          recent.push({
            text: cleanText(m.text).substring(0, 250),
            date: dt2.date,
            time: dt2.time,
            iso: dt2.iso,
            user: u2.name,
            avatar: u2.avatar,
            uid: m.user
          });
        }
      }
      for (var i = 0; i < parsed.blockers.length; i++) {
        var bname = parsed.blockers[i].user;
        // find in teamMap by name
        Object.keys(teamMap).forEach(function(k) {
          if (teamMap[k].name === bname) teamMap[k].blockerCount++;
        });
      }
      results.push(Object.assign({}, proj, {
        members: members,
        tasks: parsed.tasks.slice(0, 30),
        blockers: parsed.blockers.slice(0, 10),
        recentActivity: recent,
        messageCount: msgs.length,
        lastMessage: msgs[0] ? formatDateTime(msgs[0].ts).iso : null,
        error: null,
      }));
      console.log("OK " + proj.name + " " + msgs.length + " msgs, " + parsed.tasks.length + " tasks, " + parsed.blockers.length + " blockers");
    } catch(err) {
      console.log("ERR " + proj.name + ": " + err.message);
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

// Refresh every 2 minutes
cron.schedule("*/2 * * * *", async function() { await fetchAll(); }, { timezone: "UTC" });

fetchAll().catch(console.error);
app.listen(PORT, function() { console.log("OK port " + PORT); });
