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
  { id: "C0ADWK5LGT1", name: "CairoLive", color: "#e85d4a" },
  { id: "C0AB6NQ061X", name: "Al Nasser", color: "#34d399" },
  { id: "C0ABM2D50LE", name: "Print Out",  color: "#a78bfa" },
  { id: "C0AC25HP64T", name: "Turbo",       color: "#fbbf24" },
];
const STANDUP_CHANNEL = "C0AK4KTKV2S";

// ── Hardcoded user map ────────────────────────────────────────────────────────
const USERS = {
  "U0AATPYJBFU": "Kerolos Nashat",
  "U0AAQBA8WDB": "Mok",
  "U0AAMD052JF": "Vera",
  "U0AAXCAPSR2": "Seaf Gamel",
  "U0AAMD008BD": "Ezzledeen Fathy",
  "U0AACB004SK": "Zain ul Abideen",
  "U0AACAZ7V0X": "Islam Khairy",
  "U0AD8KWQ9MG": "Abdullah Hosny",
  "U0AACB0NDHV": "Mohamed Abd Elkhalek",
  "U0AACAZKFAB": "Islam Ayman",
  "U0AAQG9F11T": "Kerolos Morkos",
  "U0AB6MYHDK3": "Mohamed Salah",
  "U0AH569FATW": "Rao Taha",
  "U0ABA01GDL1": "Gourav Kumar",
  "U0AAXCCJ89J": "Mohamed Atya",
};

// ── Static project membership ──────────────────────────────────────────────
const PROJ_MEMBERS = {
  "CairoLive": ["U0AATPYJBFU","U0AAMD052JF","U0AB6MYHDK3","U0AACAZ7V0X","U0AAQG9F11T"],
  "Al Nasser": ["U0AACB004SK","U0AAMD008BD","U0AAXCAPSR2","U0AACAZ7V0X","U0AAMD052JF"],
  "Print Out":  ["U0AACB0NDHV","U0AD8KWQ9MG","U0AAXCAPSR2","U0AACAZKFAB","U0AAQBA8WDB"],
  "Turbo":      ["U0AACAZ7V0X","U0AAMD052JF","U0AB6MYHDK3","U0AATPYJBFU","U0AAQG9F11T"],
};

let cache = { lastUpdated: null, projects: [], standup: [], team: {} };
let avatars = {};  // uid → avatar url

// ── HTTP helper ────────────────────────────────────────────────────────────
function slackGet(ep) {
  return new Promise((res, rej) => {
    const opts = { hostname:"slack.com", path:"/api/"+ep, headers:{Authorization:"Bearer "+SLACK_TOKEN} };
    https.get(opts, r => {
      let d=""; r.on("data",c=>d+=c); r.on("end",()=>{ try{res(JSON.parse(d));}catch(e){rej(e);} });
    }).on("error",rej);
  });
}

// ── Resolve name + avatar ─────────────────────────────────────────────────
function userName(uid) { return USERS[uid] || uid || "Unknown"; }
function userAvatar(uid) { return avatars[uid] || null; }

async function loadAvatars() {
  for (const uid of Object.keys(USERS)) {
    if (avatars[uid]) continue;
    try {
      const r = await slackGet("users.info?user="+uid);
      if (r.ok && r.user && r.user.profile && r.user.profile.image_48)
        avatars[uid] = r.user.profile.image_48;
    } catch(e) {}
  }
}

// ── Clean Slack text ──────────────────────────────────────────────────────
function clean(raw) {
  if (!raw) return "";
  let s = raw;
  s = s.replace(/<@([A-Z0-9]+)\|([^>]+)>/g, (_,uid,n) => "@"+(USERS[uid]||n));
  s = s.replace(/<@([A-Z0-9]+)>/g,           (_,uid)   => "@"+(USERS[uid]||uid));
  s = s.replace(/<([^|>]+)\|([^>]+)>/g, "$2");
  s = s.replace(/<https?:[^>]+>/g, "");
  s = s.replace(/&amp;/g,"&").replace(/&lt;/g,"<").replace(/&gt;/g,">").replace(/&quot;/g,'"');
  s = s.replace(/<[^>]+>/g,"");
  return s.trim();
}

// ── Format timestamp ───────────────────────────────────────────────────────
function fmt(ts) {
  const d = new Date(parseFloat(ts)*1000);
  return {
    date: d.toLocaleDateString("en-GB",{day:"2-digit",month:"short",year:"numeric"}),
    time: d.toLocaleTimeString("en-US",{hour:"2-digit",minute:"2-digit",hour12:true}),
    iso:  d.toISOString(),
  };
}

// ── Detect tasks: any message with 2+ list items (numbered OR bullet) ─────
function extractTasks(text) {
  const lines = text.split("\n");
  const items = [];
  for (const raw of lines) {
    const line = raw.trim();
    // numbered: "1." "2." etc — even if same number repeated
    const num = line.match(/^\d+[\.\)]\s+(.+)/);
    if (num && num[1].length > 5) { items.push(num[1].trim()); continue; }
    // lettered sub-items: "a." "b." etc
    const letter = line.match(/^[a-eA-E][\.\)]\s+(.+)/);
    if (letter && letter[1].length > 5) { items.push("  → "+letter[1].trim()); continue; }
    // bullet: "- " or "• "
    const bullet = line.match(/^[-•]\s+(.+)/);
    if (bullet && bullet[1].length > 5) { items.push(bullet[1].trim()); }
  }
  return items.length >= 2 ? items : [];
}

// ── Detect blockers ────────────────────────────────────────────────────────
function isBlocker(t) {
  const words = ["block","stuck","bug","error","not work","issue","fail","broken",
                 "problem","crash","cannot","can't","500","مشكلة"];
  const low = t.toLowerCase();
  return words.some(w => low.includes(w));
}

// ── Parse standup format ───────────────────────────────────────────────────
function parseStandup(text, uid, dt) {
  const base = { uid, name:userName(uid), avatar:userAvatar(uid),
                 date:dt.date, time:dt.time, ts:dt.iso,
                 yesterday:null, today:null, blockers:null, raw:text };
  const lines = text.split("\n");
  let cur=null, buf=[];
  for (const raw of lines) {
    const line = raw.trim(); if (!line) continue;
    const low = line.toLowerCase();
    if (line.includes("✅")||low.includes("yesterday")) {
      if(cur&&buf.length) base[cur]=buf.join(" ").trim();
      cur="yesterday"; buf=[line.replace(/✅/g,"").replace(/yesterday\s*[:：]?\s*/i,"").trim()];
    } else if (line.includes("🎯")||low.includes("today")) {
      if(cur&&buf.length) base[cur]=buf.join(" ").trim();
      cur="today"; buf=[line.replace(/🎯/g,"").replace(/today\s*[:：]?\s*/i,"").trim()];
    } else if (line.includes("🚨")||low.includes("blocker")) {
      if(cur&&buf.length) base[cur]=buf.join(" ").trim();
      cur="blockers"; buf=[line.replace(/🚨/g,"").replace(/blockers?\s*[:：]?\s*/i,"").trim()];
    } else if (cur) { buf.push(line); }
  }
  if(cur&&buf.length) base[cur]=buf.join(" ").trim();
  return base;
}

// ── Main fetch ─────────────────────────────────────────────────────────────
async function fetchAll() {
  console.log("Fetching", new Date().toISOString());
  loadAvatars().catch(()=>{});  // async, don't block

  const results = [];

  for (const proj of PROJECTS) {
    try {
      const resp = await slackGet("conversations.history?channel="+proj.id+"&limit=200");
      if (!resp.ok) {
        console.log("Error", proj.name, resp.error);
        results.push({...proj, members:[], tasks:[], blockers:[], recentActivity:[], messageCount:0, error:resp.error});
        continue;
      }
      const msgs = resp.messages || [];
      const allTasks=[], allBlockers=[];

      for (const m of msgs) {
        if (!m.text||m.bot_id||m.subtype) continue;
        const text = clean(m.text);
        if (!text||text.length<8) continue;
        const dt = fmt(m.ts);
        const name = userName(m.user);
        const avatar = userAvatar(m.user);

        // Tasks
        const items = extractTasks(text);
        if (items.length) {
          for (const item of items) {
            allTasks.push({ text:item, date:dt.date, time:dt.time, iso:dt.iso,
                            from:name, avatar, uid:m.user });
          }
        }

        // Blockers
        if (isBlocker(text) && text.length>25) {
          allBlockers.push({ text:text.substring(0,400), date:dt.date, time:dt.time, iso:dt.iso,
                              user:name, avatar, uid:m.user });
        }
      }

      // Recent activity last 48h
      const cutoff = Date.now()-172800000;
      const recent=[];
      for (const m of msgs) {
        if (recent.length>=5) break;
        if (parseFloat(m.ts)*1000 > cutoff && m.text && !m.bot_id && !m.subtype) {
          const dt2=fmt(m.ts);
          recent.push({ text:clean(m.text).substring(0,200), date:dt2.date, time:dt2.time, iso:dt2.iso,
                        user:userName(m.user), avatar:userAvatar(m.user) });
        }
      }

      // Members from static map
      const members = (PROJ_MEMBERS[proj.name]||[]).map(uid => ({
        id:uid, name:userName(uid), avatar:userAvatar(uid)
      }));

      results.push({...proj,
        members, messageCount:msgs.length,
        tasks:allTasks.slice(0,40),
        blockers:allBlockers.slice(0,15),
        recentActivity:recent,
        lastMessage: msgs[0] ? fmt(msgs[0].ts).iso : null,
        error:null,
      });
      console.log(proj.name, msgs.length, "msgs |", allTasks.length, "tasks |", allBlockers.length, "blockers");
    } catch(err) {
      console.log("ERR", proj.name, err.message);
      results.push({...proj, members:[], tasks:[], blockers:[], recentActivity:[], messageCount:0, error:err.message});
    }
  }

  // Standup channel
  let standup=[];
  try {
    const sr = await slackGet("conversations.history?channel="+STANDUP_CHANNEL+"&limit=200");
    if (sr.ok) {
      for (const m of sr.messages||[]) {
        if (!m.text||m.bot_id||m.subtype) continue;
        const text=clean(m.text);
        if (text.length<8) continue;
        standup.push(parseStandup(text, m.user, fmt(m.ts)));
      }
    }
  } catch(e) { console.log("Standup err", e.message); }

  // Team map from static membership
  const team={};
  for (const [projName, uids] of Object.entries(PROJ_MEMBERS)) {
    for (const uid of uids) {
      if (!team[uid]) team[uid]={ id:uid, name:userName(uid), avatar:userAvatar(uid), projects:[], blockerCount:0 };
      team[uid].projects.push(projName);
    }
  }
  // Add blocker counts
  for (const p of results) {
    for (const b of (p.blockers||[])) {
      if (b.uid && team[b.uid]) team[b.uid].blockerCount++;
    }
  }

  cache = { lastUpdated:new Date().toISOString(), projects:results, standup, team };
  console.log("Done. Standup:", standup.length, "| Team:", Object.keys(team).length);
  return cache;
}

// ── Routes ─────────────────────────────────────────────────────────────────
app.get("/api/data",    async (q,s) => { try { if(!cache.lastUpdated) await fetchAll(); s.json(cache); } catch(e){ s.status(500).json({error:e.message}); }});
app.post("/api/refresh",async (q,s) => { try { const d=await fetchAll(); s.json({ok:true,lastUpdated:d.lastUpdated}); } catch(e){ s.status(500).json({error:e.message}); }});
app.get("/api/health",  (q,s) => s.json({status:"ok",lastUpdated:cache.lastUpdated}));
app.get("*",            (q,s) => s.sendFile(path.join(__dirname,"public","index.html")));

// Refresh every 2 min
cron.schedule("*/2 * * * *", () => fetchAll().catch(console.error));

fetchAll().catch(console.error);
app.listen(PORT, () => console.log("Port", PORT));
