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
  { id: "C0ADWK5LGT1", name: "CairoLive",  color: "#e85d4a" },
  { id: "C0AB6NQ061X", name: "Al Nasser",  color: "#34d399" },
  { id: "C0ABM2D50LE", name: "Print Out",  color: "#a78bfa" },
  { id: "C0AC25HP64T", name: "Turbo",       color: "#fbbf24" },
];
const STANDUP_CHANNEL = "C0AK4KTKV2S";

// HARDCODED user map — never fails, always returns real names
const KNOWN_USERS = {
  "U0AATPYJBFU": { name: "Kerolos Nashat",       avatar: null },
  "U0AAQBA8WDB": { name: "Mok",                   avatar: null },
  "U0AAMD052JF": { name: "Vera",                  avatar: null },
  "U0AAXCAPSR2": { name: "Seaf Gamel",            avatar: null },
  "U0AAMD008BD": { name: "Ezzledeen Fathy",       avatar: null },
  "U0AACB004SK": { name: "Zain ul Abideen",       avatar: null },
  "U0AACAZ7V0X": { name: "Islam Khairy",          avatar: null },
  "U0AD8KWQ9MG": { name: "Abdullah Hosny",        avatar: null },
  "U0AACB0NDHV": { name: "Mohamed Abd Elkhalek",  avatar: null },
  "U0AACAZKFAB": { name: "Islam Ayman",           avatar: null },
  "U0AAQG9F11T": { name: "Kerolos Morkos",        avatar: null },
  "U0AB6MYHDK3": { name: "Mohamed Salah",         avatar: null },
  "U0AH569FATW": { name: "Rao Taha",              avatar: null },
  "U0ABA01GDL1": { name: "Gourav Kumar",          avatar: null },
  "U0AAXCCJ89J": { name: "Mohamed Atya",          avatar: null },
};

// Project membership for team tab
const PROJECT_MEMBERS = {
  "CairoLive": ["U0AATPYJBFU","U0AAMD052JF","U0AB6MYHDK3","U0AACAZ7V0X","U0AAQG9F11T"],
  "Al Nasser": ["U0AACB004SK","U0AAMD008BD","U0AAXCAPSR2","U0AACAZ7V0X","U0AAMD052JF"],
  "Print Out": ["U0AACB0NDHV","U0AD8KWQ9MG","U0AAXCAPSR2","U0AACAZKFAB"],
  "Turbo":     ["U0AACAZ7V0X","U0AAMD052JF","U0AB6MYHDK3","U0AATPYJBFU","U0AAQG9F11T"],
};

let cache = { lastUpdated: null, projects: [], standup: [], team: {} };

// Dynamic avatar cache (fetched from Slack API when possible)
var avatarCache = {};

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

// Resolve user — hardcoded first, then API fallback
async function getUser(uid) {
  if (!uid) return { name: "Unknown", avatar: null };

  // Use hardcoded name, try cached avatar
  var known = KNOWN_USERS[uid];
  var avatar = avatarCache[uid] || null;

  if (known) return { name: known.name, avatar: avatar };

  // Unknown user — try API
  try {
    var r = await slackGet("users.info?user=" + uid);
    if (r.ok && r.user) {
      var p = r.user.profile || {};
      var name = p.display_name || r.user.real_name || r.user.name || uid;
      if (p.image_48) avatarCache[uid] = p.image_48;
      return { name: name, avatar: p.image_48 || null };
    }
  } catch(e) {}
  return { name: uid, avatar: null };
}

// Try to load avatars for known users (best-effort)
async function loadAvatars() {
  var uids = Object.keys(KNOWN_USERS);
  for (var i = 0; i < uids.length; i++) {
    if (avatarCache[uids[i]]) continue;
    try {
      var r = await slackGet("users.info?user=" + uids[i]);
      if (r.ok && r.user && r.user.profile && r.user.profile.image_48) {
        avatarCache[uids[i]] = r.user.profile.image_48;
      }
    } catch(e) {}
  }
  console.log("Avatars loaded: " + Object.keys(avatarCache).length);
}

// Clean Slack text: remove tags, fix entities, resolve mentions
function cleanText(raw) {
  if (!raw) return "";
  var s = raw;
  // user mentions with display name
  s = s.replace(/<@([A-Z0-9]+)\|([^>]+)>/g, function(m, uid, name) {
    var u = KNOWN_USERS[uid];
    return "@" + (u ? u.name : name);
  });
  // user mentions without display name
  s = s.replace(/<@([A-Z0-9]+)>/g, function(m, uid) {
    var u = KNOWN_USERS[uid];
    return "@" + (u ? u.name : uid);
  });
  // links with text
  s = s.replace(/<([^|>]+)\|([^>]+)>/g, "$2");
  s = s.replace(/<(https?:[^>]+)>/g, "$1");
  // HTML entities
  s = s.replace(/&amp;/g, "&");
  s = s.replace(/&lt;/g, "<");
  s = s.replace(/&gt;/g, ">");
  s = s.replace(/&quot;/g, '"');
  s = s.replace(/&#39;/g, "'");
  // Remove leftover angle-bracket tags
  s = s.replace(/<[^>]+>/g, "");
  return s.trim();
}

function hasBlockerWord(t) {
  var words = ["block", "stuck", "bug", "error", "not work", "issue", "fail", "broken",
               "problem", "crash", "cannot", "can't", "500", "failing", "مشكلة"];
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

function fmtTs(ts) {
  var d = new Date(parseFloat(ts) * 1000);
  return {
    date: d.toLocaleDateString("en-GB", { day: "2-digit", month: "short", year: "numeric" }),
    time: d.toLocaleTimeString("en-US", { hour: "2-digit", minute: "2-digit", hour12: true }),
    iso: d.toISOString()
  };
}

// Parse standup format ✅ Yesterday / 🎯 Today / 🚨 Blockers
function parseStandup(text, user, dt) {
  var result = { user: user.name, avatar: user.avatar || avatarCache[user.id] || null,
                 date: dt.date, time: dt.time, ts: dt.iso,
                 yesterday: null, today: null, blockers: null, raw: text };
  var lines = text.split("\n");
  var current = null, buf = [];
  for (var i = 0; i < lines.length; i++) {
    var line = lines[i].trim();
    if (!line) continue;
    var low = line.toLowerCase();
    if (line.indexOf("✅") >= 0 || low.indexOf("yesterday") >= 0) {
      if (current && buf.length) result[current] = buf.join(" ").trim();
      current = "yesterday";
      buf = [line.replace(/✅/g,"").replace(/yesterday\s*[:：]?\s*/i,"").trim()];
    } else if (line.indexOf("🎯") >= 0 || low.indexOf("today") >= 0) {
      if (current && buf.length) result[current] = buf.join(" ").trim();
      current = "today";
      buf = [line.replace(/🎯/g,"").replace(/today\s*[:：]?\s*/i,"").trim()];
    } else if (line.indexOf("🚨") >= 0 || low.indexOf("blocker") >= 0) {
      if (current && buf.length) result[current] = buf.join(" ").trim();
      current = "blockers";
      buf = [line.replace(/🚨/g,"").replace(/blockers?\s*[:：]?\s*/i,"").trim()];
    } else if (current) {
      buf.push(line);
    }
  }
  if (current && buf.length) result[current] = buf.join(" ").trim();
  return result;
}

async function fetchStandup() {
  var resp = await slackGet("conversations.history?channel=" + STANDUP_CHANNEL + "&limit=200");
  if (!resp.ok) { console.log("Standup error:", resp.error); return []; }
  var msgs = resp.messages || [];
  var standups = [];
  for (var i = 0; i < msgs.length; i++) {
    var m = msgs[i];
    if (!m.text || m.bot_id || m.subtype) continue;
    var text = cleanText(m.text);
    if (text.length < 8) continue;
    var u = await getUser(m.user);
    u.id = m.user;
    var dt = fmtTs(m.ts);
    standups.push(parseStandup(text, u, dt));
  }
  return standups;
}

async function parseMessages(messages) {
  var tasks = [], blockers = [];
  for (var i = 0; i < messages.length; i++) {
    var msg = messages[i];
    if (!msg.text || msg.bot_id || msg.subtype) continue;
    var text = cleanText(msg.text);
    if (!text || text.length < 10) continue;
    var dt = fmtTs(msg.ts);
    var user = await getUser(msg.user);

    // TASKS: numbered lists (2+ items)
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
        if (clean.length > 5) {
          tasks.push({ text: clean, date: dt.date, time: dt.time, iso: dt.iso,
                       from: user.name, fromAvatar: user.avatar || avatarCache[msg.user] || null, uid: msg.user });
        }
      }
    }

    // BLOCKERS
    if (hasBlockerWord(text) && text.length > 25) {
      blockers.push({ text: text.substring(0, 400), date: dt.date, time: dt.time, iso: dt.iso,
                      user: user.name, avatar: user.avatar || avatarCache[msg.user] || null, uid: msg.user });
    }
  }
  return { tasks: tasks, blockers: blockers };
}

async function fetchAll() {
  console.log("Fetching", new Date().toISOString());

  // Load avatars (async, non-blocking for data)
  loadAvatars().catch(function() {});

  var results = [];

  for (var p = 0; p < PROJECTS.length; p++) {
    var proj = PROJECTS[p];
    try {
      var resp = await slackGet("conversations.history?channel=" + proj.id + "&limit=100");
      if (!resp.ok) {
        console.log("Channel error", proj.name, resp.error);
        results.push(Object.assign({}, proj, { members:[], tasks:[], blockers:[], recentActivity:[], messageCount:0, error: resp.error }));
        continue;
      }
      var msgs = resp.messages || [];

      // Members from project membership map
      var memberIds = PROJECT_MEMBERS[proj.name] || [];
      var members = memberIds.map(function(uid) {
        return { id: uid, name: (KNOWN_USERS[uid]||{name:uid}).name, avatar: avatarCache[uid]||null };
      });

      var parsed = await parseMessages(msgs);

      // Recent activity (last 24h)
      var cutoff = Date.now() - 86400000;
      var recent = [];
      for (var i = 0; i < msgs.length && recent.length < 4; i++) {
        var m = msgs[i];
        if (parseFloat(m.ts) * 1000 > cutoff && m.text && !m.bot_id && !m.subtype) {
          var u2 = await getUser(m.user);
          var dt2 = fmtTs(m.ts);
          recent.push({ text: cleanText(m.text).substring(0, 200),
                        date: dt2.date, time: dt2.time, iso: dt2.iso,
                        user: u2.name, avatar: avatarCache[m.user]||null });
        }
      }

      results.push(Object.assign({}, proj, {
        members: members,
        tasks: parsed.tasks.slice(0, 30),
        blockers: parsed.blockers.slice(0, 15),
        recentActivity: recent,
        messageCount: msgs.length,
        lastMessage: msgs[0] ? fmtTs(msgs[0].ts).iso : null,
        error: null,
      }));
      console.log("OK", proj.name, msgs.length, "msgs,", parsed.tasks.length, "tasks,", parsed.blockers.length, "blockers");
    } catch(err) {
      console.log("ERR", proj.name, err.message);
      results.push(Object.assign({}, proj, { members:[], tasks:[], blockers:[], recentActivity:[], messageCount:0, error: err.message }));
    }
  }

  // Build team map from hardcoded project membership
  var teamMap = {};
  Object.keys(PROJECT_MEMBERS).forEach(function(projName) {
    var uids = PROJECT_MEMBERS[projName];
    uids.forEach(function(uid) {
      if (!teamMap[uid]) {
        teamMap[uid] = {
          id: uid,
          name: (KNOWN_USERS[uid]||{name:uid}).name,
          avatar: avatarCache[uid]||null,
          projects: [],
          blockerCount: 0
        };
      }
      teamMap[uid].projects.push(projName);
    });
  });
  // Count blockers
  results.forEach(function(proj) {
    (proj.blockers||[]).forEach(function(b) {
      if (b.uid && teamMap[b.uid]) teamMap[b.uid].blockerCount++;
    });
  });

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

app.get("/api/health", function(req, res) { res.json({ status: "ok", lastUpdated: cache.lastUpdated }); });
app.get("*", function(req, res) { res.sendFile(path.join(__dirname, "public", "index.html")); });

// Refresh every 2 minutes
cron.schedule("*/2 * * * *", function() { fetchAll().catch(console.error); });

fetchAll().catch(console.error);
app.listen(PORT, function() { console.log("Running on port", PORT); });
