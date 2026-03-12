const express = require("express");
const cors = require("cors");
const cron = require("node-cron");
const https = require("https");
const path = require("path");
const crypto = require("crypto");

// ── AUTH ─────────────────────────────────────────────────────────────────────
const SALT = "mokcosalt2026";
const USERS_AUTH = {
  "KerolosNashat": "07401eba22fc3a00941394bb77172162e90b2d138847063cf90eb52a27cbc25c"
};
const SESSIONS = new Set();
function hashPass(p){ return crypto.createHmac("sha256", SALT).update(p).digest("hex"); }
function makeToken(){ return crypto.randomBytes(32).toString("hex"); }
function requireAuth(req, res, next){
  const token = req.headers["x-auth-token"] || req.query.token;
  if(token && SESSIONS.has(token)) return next();
  res.status(401).json({error:"Unauthorized"});
}

const app = express();
app.use(cors());
app.use(express.json());
app.use(express.static(path.join(__dirname, "public")));

const SLACK_TOKEN = process.env.SLACK_TOKEN || "";
const PORT = process.env.PORT || 3000;

const PROJECTS = [
  { id: "C0ADWK5LGT1", name: "CairoLive", color: "#f97316" },
  { id: "C0AB6NQ061X", name: "Al Nasser", color: "#2dd4a0" },
  { id: "C0ABM2D50LE", name: "Print Out",  color: "#9b6dff" },
  { id: "C0AC25HP64T", name: "Turbo",      color: "#f5a623" },
];
const STANDUP_CHANNEL = "C0AK4KTKV2S";

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

const PROJ_MEMBERS = {
  "CairoLive": ["U0AATPYJBFU","U0AAMD052JF","U0AB6MYHDK3","U0AACAZ7V0X","U0AAQG9F11T","U0AAQBA8WDB"],
  "Al Nasser": ["U0AAMD008BD","U0ABA01GDL1","U0AACAZ7V0X","U0AATPYJBFU","U0AACB0NDHV","U0AAXCCJ89J","U0AB6MYHDK3","U0AAQBA8WDB","U0AAXCAPSR2","U0AAMD052JF","U0AACB004SK"],
  "Print Out":  ["U0AD8KWQ9MG","U0AACAZ7V0X","U0AATPYJBFU","U0AACB0NDHV","U0AB6MYHDK3","U0AAQBA8WDB","U0AAXCAPSR2","U0AAMD052JF"],
  "Turbo":      ["U0AATPYJBFU","U0AAMD052JF","U0AB6MYHDK3","U0AACAZ7V0X","U0AAQG9F11T","U0AAQBA8WDB"],
};

const ALL_MEMBERS = Object.keys(USERS);

// Sprint state (persisted in memory, reset on redeploy — acceptable for now)
let sprintState = {
  name: "Sprint 1",
  startDate: null,
  endDate: null,
  goals: []
};

const FRONTEND_TAGS = ["website","frontend","front end","front-end","ui","ux","web","homepage","dashboard","page","screen","display","button","form","filter","dropdown","design","layout","slider","banner","image","icon","view","scroll","modal","card","navigation","menu","header","footer","css","html","react","animation","responsive"];
const BACKEND_TAGS  = ["backend","back end","back-end","api","endpoint","database","db","server","query","migration","model","controller","service","auth","token","route","payload","request","response","500","400","403","json","sql","seeder","schema","deploy","nginx","redis","cache","php","laravel","node","express","mongo","mysql","postgres"];
const MOBILE_TAGS   = ["mobile","ios","android","flutter","react native","apk","play store","app store","push notification","deep link","testflight","firebase","bloc","provider"];

function detectTags(text) {
  const low = text.toLowerCase();
  const tags = new Set();
  if (FRONTEND_TAGS.some(t => low.includes(t))) tags.add("Frontend");
  if (BACKEND_TAGS.some(t => low.includes(t)))  tags.add("Backend");
  if (MOBILE_TAGS.some(t => low.includes(t)))   tags.add("Mobile");
  return [...tags];
}

function isBlocker(text) {
  const low = text.toLowerCase();
  return ["block","stuck","bug","error","not work","issue","fail","broken","problem","crash","cannot","can't","500","400","failing","doesn't work","not showing","not loading","not appearing","مشكلة"].some(w => low.includes(w));
}

function detectTaskUpdate(text) {
  const low = text.toLowerCase().trim();
  const pfx = "(update|done|progress|fixed|completed|finish|finished|deployed|merged|tested|resolved)";
  const m = low.match(new RegExp(`^${pfx}[d]?\\s+task\\s+(\\d+)\\s*[:\\-]?\\s*(.*)`, "s"));
  if (m) return { type: m[1], taskNum: parseInt(m[2]), detail: m[3].trim()||text };
  const m2 = low.match(new RegExp(`^task\\s+(\\d+)\\s+${pfx}[d]?\\s*[:\\-]?\\s*(.*)`, "s"));
  if (m2) return { type: m2[2], taskNum: parseInt(m2[1]), detail: m2[3].trim()||text };
  return null;
}

let cache = { lastUpdated: null, projects: [], standup: [], team: {} };
let avatars = {};

function slackGet(ep) {
  return new Promise((res,rej) => {
    const o={hostname:"slack.com",path:"/api/"+ep,headers:{Authorization:"Bearer "+SLACK_TOKEN}};
    https.get(o,r=>{let d="";r.on("data",c=>d+=c);r.on("end",()=>{try{res(JSON.parse(d));}catch(e){rej(e);}});}).on("error",rej);
  });
}

async function slackPost(ep, body) {
  return new Promise((res,rej) => {
    const data = JSON.stringify(body);
    const o = {
      hostname:"slack.com", path:"/api/"+ep, method:"POST",
      headers:{"Authorization":"Bearer "+SLACK_TOKEN,"Content-Type":"application/json","Content-Length":Buffer.byteLength(data)}
    };
    const req = https.request(o, r=>{let d="";r.on("data",c=>d+=c);r.on("end",()=>{try{res(JSON.parse(d));}catch(e){rej(e);}});});
    req.on("error",rej); req.write(data); req.end();
  });
}

function uname(uid){ return USERS[uid]||uid||"Unknown"; }
function uav(uid){ return avatars[uid]||null; }

async function loadAvatars(){
  for(const uid of ALL_MEMBERS){
    if(avatars[uid]) continue;
    try{ const r=await slackGet("users.info?user="+uid); if(r.ok&&r.user?.profile?.image_48) avatars[uid]=r.user.profile.image_48; }catch(e){}
  }
}

function clean(raw){
  if(!raw) return "";
  let s=raw;
  s=s.replace(/<@([A-Z0-9]+)\|([^>]+)>/g,(_,uid,n)=>"@"+(USERS[uid]||n));
  s=s.replace(/<@([A-Z0-9]+)>/g,(_,uid)=>"@"+(USERS[uid]||uid));
  s=s.replace(/<([^|>]+)\|([^>]+)>/g,"$2");
  s=s.replace(/<https?:[^>]+>/g,"");
  s=s.replace(/&amp;/g,"&").replace(/&lt;/g,"<").replace(/&gt;/g,">").replace(/&quot;/g,'"');
  s=s.replace(/<[^>]+>/g,"");
  return s.trim();
}

function fmt(ts){
  const d=new Date(parseFloat(ts)*1000);
  return{date:d.toLocaleDateString("en-GB",{day:"2-digit",month:"short",year:"numeric"}),time:d.toLocaleTimeString("en-US",{hour:"2-digit",minute:"2-digit",hour12:true}),iso:d.toISOString(),ts};
}

function extractTasks(text) {
  const lines = text.split("\n");
  const tasks = [];
  let lastParentIdx = -1;
  let foundList = false;
  for (const raw of lines) {
    const line = raw.trim();
    if (!line) continue;
    const num = line.match(/^(\d+)[\.\)]\s+(.+)/);
    if (num && num[2].trim().length > 4) {
      tasks.push({ text: num[2].trim(), num: parseInt(num[1]), sub: false, parentIdx: -1 });
      lastParentIdx = tasks.length - 1;
      foundList = true;
      continue;
    }
    if (foundList) {
      const letter = line.match(/^[a-zA-Z][\.\)]\s+(.+)/);
      if (letter && letter[1].trim().length > 3) {
        tasks.push({ text: letter[1].trim(), num: null, sub: true, parentIdx: lastParentIdx });
        continue;
      }
    }
  }
  return tasks.length >= 2 ? tasks : [];
}

function parseStandup(text,uid,dt){
  const o={uid,name:uname(uid),avatar:uav(uid),date:dt.date,time:dt.time,ts:dt.iso,yesterday:null,today:null,blockers:null,raw:text};
  const lines=text.split("\n"); let cur=null,buf=[];
  for(const raw of lines){
    const line=raw.trim(); if(!line) continue; const low=line.toLowerCase();
    if(line.includes("✅")||low.includes("yesterday")){if(cur&&buf.length)o[cur]=buf.join("\n").trim();cur="yesterday";buf=[line.replace(/✅/g,"").replace(/yesterday\s*[:：]?\s*/i,"").trim()];}
    else if(line.includes("🎯")||low.includes("today")){if(cur&&buf.length)o[cur]=buf.join("\n").trim();cur="today";buf=[line.replace(/🎯/g,"").replace(/today[:\s]*/i,"").trim()];}
    else if(line.includes("🚨")||low.includes("blocker")){if(cur&&buf.length)o[cur]=buf.join("\n").trim();cur="blockers";buf=[line.replace(/🚨/g,"").replace(/blockers?[:\s]*/i,"").trim()];}
    else if(cur){buf.push(line);}
  }
  if(cur&&buf.length)o[cur]=buf.join("\n").trim();
  return o;
}

// Build and send daily digest to Slack
async function sendDailyDigest() {
  try {
    if(!cache.lastUpdated) return;
    const ps = cache.projects || [];
    const today = new Date().toLocaleDateString("en-GB",{day:"2-digit",month:"short",year:"numeric"});

    const totalTasks = ps.reduce((s,p)=>s+(p.tasks||[]).length,0);
    const totalDone  = ps.reduce((s,p)=>s+(p.tasks||[]).filter(t=>t.updates&&t.updates.some(u=>["done","fixed","deployed","merged","resolved","finished","completed"].includes(u.type))).length,0);
    const totalBlk   = ps.reduce((s,p)=>s+(p.blockers||[]).length,0);
    const todaySU    = (cache.standup||[]).filter(s=>s.date===today);

    let msg = `*🌅 Good morning, Mok Company!* — Daily Digest for *${today}*\n\n`;
    msg += `📊 *Overview:*  ${totalTasks} tasks across all projects  |  ✅ ${totalDone} marked done  |  🚨 ${totalBlk} active blockers\n\n`;

    msg += `*📋 Project Snapshot:*\n`;
    ps.forEach(p => {
      const done = (p.tasks||[]).filter(t=>t.updates&&t.updates.some(u=>["done","fixed","deployed","merged","resolved","finished","completed"].includes(u.type))).length;
      const blk  = (p.blockers||[]).length;
      const status = blk > 0 ? `⚠️ ${blk} blocker${blk>1?'s':''}` : "✅ clear";
      msg += `• *${p.name}* — ${(p.tasks||[]).length} tasks, ${done} done — ${status}\n`;
    });

    if(todaySU.length > 0) {
      msg += `\n*📝 Standup Posted Today (${todaySU.length}/${Object.keys(USERS).length}):*\n`;
      todaySU.forEach(s => { msg += `• ${s.name}`; if(s.blockers && !["none","no","n/a","—","-"].includes(s.blockers.toLowerCase().trim())) msg += ` 🚨`; msg += "\n"; });
      const missing = Object.values(USERS).filter(n => !todaySU.find(s=>s.name===n));
      if(missing.length <= 8) msg += `_Not yet posted: ${missing.join(", ")}_\n`;
    } else {
      msg += `\n_⏰ No standup posts yet today — reminder: post in #standup!_\n`;
    }

    if(totalBlk > 0) {
      msg += `\n*🚨 Open Blockers:*\n`;
      ps.forEach(p => (p.blockers||[]).slice(0,2).forEach(b => {
        msg += `• [${p.name}] *${b.user}*: ${b.text.substring(0,100)}${b.text.length>100?"…":""}\n`;
      }));
    }

    msg += `\n_Dashboard → https://mok-standup-production-c282.up.railway.app/_`;

    await slackPost("chat.postMessage", { channel: STANDUP_CHANNEL, text: msg });
    console.log("Daily digest sent at", new Date().toISOString());
  } catch(e) {
    console.error("Digest error:", e.message);
  }
}

async function fetchAll(){
  console.log("Fetching",new Date().toISOString());
  loadAvatars().catch(()=>{});
  const results=[];

  for(const proj of PROJECTS){
    try{
      const resp=await slackGet("conversations.history?channel="+proj.id+"&limit=200");
      if(!resp.ok){results.push({...proj,members:[],tasks:[],blockers:[],recentActivity:[],messageCount:0,error:resp.error});continue;}
      const msgs=resp.messages||[];
      const allTasks=[], allBlockers=[], rawUpdates=[];

      for(const m of msgs){
        if(!m.text||m.bot_id||m.subtype) continue;
        const text=clean(m.text);
        if(!text||text.length<4) continue;
        const dt=fmt(m.ts);
        const name=uname(m.user), avatar=uav(m.user);

        const upd=detectTaskUpdate(text);
        if(upd){
          rawUpdates.push({...upd, from:name, avatar, date:dt.date, time:dt.time, iso:dt.iso, msgTs:m.ts});
          continue;
        }

        const items=extractTasks(text);
        if(items.length){
          items.forEach(item=>{
            const parentText = item.sub&&item.parentIdx>=0 ? items[item.parentIdx]?.text : null;
            allTasks.push({
              text:item.text, num:item.num, sub:item.sub, parentTask:parentText,
              tags:detectTags(item.text+(parentText||'')),
              updates:[],
              date:dt.date, time:dt.time, iso:dt.iso, ts:dt.ts,
              from:name, avatar, uid:m.user, msgTs:m.ts
            });
          });
        }

        if(isBlocker(text)&&text.length>20){
          allBlockers.push({
            text:text.substring(0,500),
            tags:detectTags(text),
            date:dt.date, time:dt.time, iso:dt.iso, ts:dt.ts,
            user:name, avatar, uid:m.user, msgTs:m.ts, projId:proj.id
          });
        }
      }

      for(const upd of rawUpdates){
        const matchedTask = allTasks.find(t=>!t.sub && t.num===upd.taskNum);
        if(matchedTask) matchedTask.updates.push(upd);
      }

      const recent=[];
      for(const m of msgs){
        if(recent.length>=6) break;
        if(m.text&&!m.bot_id&&!m.subtype){
          const txt=clean(m.text); if(txt.length<5) continue;
          const dt2=fmt(m.ts);
          recent.push({text:txt.substring(0,200),date:dt2.date,time:dt2.time,iso:dt2.iso,user:uname(m.user),avatar:uav(m.user),msgTs:m.ts});
        }
      }

      const members=(PROJ_MEMBERS[proj.name]||[]).map(uid=>({id:uid,name:uname(uid),avatar:uav(uid)}));
      results.push({
        ...proj, members, messageCount:msgs.length,
        tasks:allTasks.slice(0,80),
        blockers:allBlockers.slice(0,30),
        recentActivity:recent,
        lastMessage:msgs[0]?fmt(msgs[0].ts).iso:null, error:null
      });
    }catch(err){
      results.push({...proj,members:[],tasks:[],blockers:[],recentActivity:[],messageCount:0,error:err.message});
    }
  }

  let standup=[];
  try{
    const sr=await slackGet("conversations.history?channel="+STANDUP_CHANNEL+"&limit=200");
    if(sr.ok) for(const m of sr.messages||[]){if(!m.text||m.bot_id||m.subtype)continue;const text=clean(m.text);if(text.length<8)continue;standup.push(parseStandup(text,m.user,fmt(m.ts)));}
  }catch(e){}

  const team={};
  for(const uid of ALL_MEMBERS){
    const projs=Object.entries(PROJ_MEMBERS).filter(([,ms])=>ms.includes(uid)).map(([n])=>n);
    team[uid]={id:uid,name:uname(uid),avatar:uav(uid),projects:projs,blockerCount:0,taskCount:0};
  }
  for(const p of results){
    for(const b of(p.blockers||[])) if(b.uid&&team[b.uid]) team[b.uid].blockerCount++;
    for(const t of(p.tasks||[])) if(t.uid&&team[t.uid]) team[t.uid].taskCount++;
  }

  cache={lastUpdated:new Date().toISOString(),projects:results,standup,team,sprint:sprintState};
  return cache;
}

// ── ROUTES ──────────────────────────────────────────────────────────────────
// Login — public
app.post("/api/login", (req, res) => {
  const { username, password } = req.body;
  const expected = USERS_AUTH[username];
  if(!expected || hashPass(password) !== expected)
    return res.status(401).json({error:"Invalid username or password"});
  const token = makeToken();
  SESSIONS.add(token);
  res.json({ok:true, token});
});

// Logout
app.post("/api/logout", (req, res) => {
  const token = req.headers["x-auth-token"];
  if(token) SESSIONS.delete(token);
  res.json({ok:true});
});

// Verify token (used by frontend on load)
app.get("/api/auth/check", (req, res) => {
  const token = req.headers["x-auth-token"];
  res.json({ok: !!(token && SESSIONS.has(token))});
});

app.get("/api/data",     requireAuth, async(q,s)=>{try{if(!cache.lastUpdated)await fetchAll();s.json(cache);}catch(e){s.status(500).json({error:e.message});}});
app.post("/api/refresh", requireAuth, async(q,s)=>{try{const d=await fetchAll();s.json({ok:true,lastUpdated:d.lastUpdated});}catch(e){s.status(500).json({error:e.message});}});
app.get("/api/health",   (q,s)=>s.json({status:"ok",lastUpdated:cache.lastUpdated}));

// Sprint API
app.get("/api/sprint",  requireAuth,   (q,s)=>s.json(sprintState));
app.post("/api/sprint", requireAuth,  (q,s)=>{
  const {name,startDate,endDate,goals}=q.body;
  if(name) sprintState.name=name;
  if(startDate) sprintState.startDate=startDate;
  if(endDate) sprintState.endDate=endDate;
  if(goals) sprintState.goals=goals;
  cache.sprint=sprintState;
  s.json({ok:true,sprint:sprintState});
});


// Manual digest trigger
app.post("/api/digest", requireAuth, async(q,s)=>{try{await sendDailyDigest();s.json({ok:true});}catch(e){s.status(500).json({error:e.message});}});

// Notifications — all messages newer than ?since= across every channel
app.get("/api/notifications", requireAuth, async(req,res)=>{
  try{
    const since=parseFloat(req.query.since||"0");
    const notifs=[];
    const allCh=[
      ...PROJECTS.map(p=>({id:p.id,name:p.name,color:p.color,type:"project"})),
      {id:STANDUP_CHANNEL,name:"standup",color:"#4f90f7",type:"standup"}
    ];
    for(const ch of allCh){
      try{
        const ep="conversations.history?channel="+ch.id+"&limit=50"+(since?"&oldest="+since:"");
        const resp=await slackGet(ep);
        if(!resp.ok) continue;
        for(const m of(resp.messages||[])){
          if(!m.text||m.bot_id||m.subtype) continue;
          const ts=parseFloat(m.ts);
          if(since&&ts<=since) continue;
          const text=clean(m.text);
          if(!text||text.length<4) continue;
          const dt=fmt(m.ts);
          const low=text.toLowerCase();
          let type="message";
          if(/^(update|done|progress|fixed|completed|deployed|merged)\s+task/i.test(text)) type="update";
          else if(text.split("\n").filter(l=>/^\d+[.)]\s/.test(l.trim())).length>=2) type="tasks";
          else if(["block","stuck","bug","error","not work","issue","fail","broken","500","400","crash"].some(w=>low.includes(w))&&text.length>20) type="blocker";
          else if(text.includes("\u2705")||text.includes("\uD83C\uDFAF")||low.includes("yesterday")) type="standup";
          notifs.push({id:m.ts,ts:m.ts,channel:ch.name,channelId:ch.id,color:ch.color,channelType:ch.type,user:uname(m.user),avatar:uav(m.user)||null,uid:m.user,text:text.substring(0,300),date:dt.date,time:dt.time,iso:dt.iso,type});
        }
      }catch(e){}
    }
    notifs.sort((a,b)=>parseFloat(b.ts)-parseFloat(a.ts));
    res.json({ok:true,notifications:notifs,count:notifs.length});
  }catch(e){res.status(500).json({error:e.message});}
});

// ── MEETINGS ─────────────────────────────────────────────────────────────────
const DEEPGRAM_KEY = process.env.DEEPGRAM_KEY || "21f78bfd8a6bf65f0377cdc78c89f4686cefa62e";
let meetingsStore = []; // in-memory store (persists until redeploy)

// Transcribe audio via Deepgram Nova-3 (Arabic + English)
function deepgramTranscribe(audioBuffer, mimetype) {
  return new Promise((resolve, reject) => {
    const params = "model=nova-3&language=multi&punctuate=true&diarize=true&smart_format=true&utterances=true&filler_words=false";
    const opts = {
      hostname: "api.deepgram.com",
      path: "/v1/listen?" + params,
      method: "POST",
      headers: {
        "Authorization": "Token " + DEEPGRAM_KEY,
        "Content-Type": mimetype || "audio/webm",
        "Content-Length": audioBuffer.length
      }
    };
    const req = https.request(opts, r => {
      let d = "";
      r.on("data", c => d += c);
      r.on("end", () => {
        try { resolve(JSON.parse(d)); } catch(e) { reject(e); }
      });
    });
    req.on("error", reject);
    req.write(audioBuffer);
    req.end();
  });
}

// Analyze transcript with Claude API (via Anthropic)
function analyzeTranscript(transcript, title) {
  return new Promise((resolve, reject) => {
    const prompt = `You are an expert meeting analyst. Analyze this meeting transcript and extract structured information.

Meeting Title: ${title || "Team Meeting"}
Transcript:
${transcript}

Respond ONLY with a valid JSON object (no markdown, no backticks) in this exact format:
{
  "summary": "2-3 sentence overview of the meeting",
  "attendees_mentioned": ["name1", "name2"],
  "tasks": [
    {"text": "task description", "assignee": "person name or null", "priority": "high|medium|low"}
  ],
  "blockers": [
    {"text": "blocker description", "owner": "person name or null"}
  ],
  "decisions": ["decision 1", "decision 2"],
  "action_items": ["action item 1", "action item 2"],
  "topics": ["topic1", "topic2"],
  "sentiment": "positive|neutral|concerned"
}`;

    const body = JSON.stringify({
      model: "claude-haiku-4-5-20251001",
      max_tokens: 1500,
      messages: [{ role: "user", content: prompt }]
    });

    const opts = {
      hostname: "api.anthropic.com",
      path: "/v1/messages",
      method: "POST",
      headers: {
        "x-api-key": process.env.ANTHROPIC_API_KEY || "",
        "anthropic-version": "2023-06-01",
        "content-type": "application/json",
        "content-length": Buffer.byteLength(body)
      }
    };

    const req = https.request(opts, r => {
      let d = "";
      r.on("data", c => d += c);
      r.on("end", () => {
        try {
          const resp = JSON.parse(d);
          const text = resp.content?.[0]?.text || "{}";
          const clean = text.replace(/```json|```/g, "").trim();
          resolve(JSON.parse(clean));
        } catch(e) { resolve(null); }
      });
    });
    req.on("error", () => resolve(null));
    req.write(body);
    req.end();
  });
}

// Upload audio → transcribe → analyze
app.post("/api/meetings/transcribe", requireAuth, express.raw({ type: "*/*", limit: "50mb" }), async(req, res) => {
  try {
    const mimetype = req.headers["content-type"] || "audio/webm";
    const title = req.headers["x-meeting-title"] || "Team Meeting";
    const audioBuffer = req.body;

    if (!audioBuffer || audioBuffer.length < 100)
      return res.status(400).json({ error: "No audio data received" });

    // 1. Transcribe with Deepgram
    const dgResult = await deepgramTranscribe(audioBuffer, mimetype);
    if (!dgResult?.results) return res.status(500).json({ error: "Deepgram transcription failed", details: dgResult });

    const transcript = dgResult.results?.channels?.[0]?.alternatives?.[0]?.transcript || "";
    const words = dgResult.results?.channels?.[0]?.alternatives?.[0]?.words || [];
    const utterances = dgResult.results?.utterances || [];
    const duration = dgResult.metadata?.duration || 0;

    if (!transcript.trim()) return res.status(422).json({ error: "No speech detected in audio" });

    // Build speaker-labeled transcript from utterances
    const speakerLines = utterances.map(u => ({
      speaker: "Speaker " + (u.speaker + 1),
      text: u.transcript,
      start: u.start,
      end: u.end
    }));

    // 2. Analyze with AI
    const analysis = await analyzeTranscript(transcript, title);

    // 3. Store meeting
    const meeting = {
      id: Date.now().toString(),
      title,
      date: new Date().toLocaleDateString("en-GB", { day: "2-digit", month: "short", year: "numeric" }),
      time: new Date().toLocaleTimeString("en-US", { hour: "2-digit", minute: "2-digit", hour12: true }),
      iso: new Date().toISOString(),
      duration: Math.round(duration),
      transcript,
      speakerLines,
      wordCount: words.length,
      analysis: analysis || {},
      audioSize: audioBuffer.length
    };

    meetingsStore.unshift(meeting);
    if (meetingsStore.length > 50) meetingsStore = meetingsStore.slice(0, 50);

    res.json({ ok: true, meeting });
  } catch(e) {
    console.error("Transcribe error:", e.message);
    res.status(500).json({ error: e.message });
  }
});

// Get all meetings
app.get("/api/meetings", requireAuth, (req, res) => {
  res.json({ ok: true, meetings: meetingsStore });
});

// Get single meeting
app.get("/api/meetings/:id", requireAuth, (req, res) => {
  const m = meetingsStore.find(x => x.id === req.params.id);
  if (!m) return res.status(404).json({ error: "Not found" });
  res.json({ ok: true, meeting: m });
});

// Delete meeting
app.delete("/api/meetings/:id", requireAuth, (req, res) => {
  meetingsStore = meetingsStore.filter(x => x.id !== req.params.id);
  res.json({ ok: true });
});

// Post meeting summary to Slack
app.post("/api/meetings/:id/post-slack", requireAuth, async(req, res) => {
  try {
    const m = meetingsStore.find(x => x.id === req.params.id);
    if (!m) return res.status(404).json({ error: "Not found" });
    const a = m.analysis || {};
    const dur = m.duration >= 60 ? Math.floor(m.duration/60)+"m "+( m.duration%60)+"s" : m.duration+"s";

    let msg = `*🎙 Meeting Summary — ${m.title}*\n`;
    msg += `📅 ${m.date} · ${m.time} · Duration: ${dur}\n\n`;
    if (a.summary) msg += `*Summary:*\n${a.summary}\n\n`;
    if (a.tasks?.length) {
      msg += `*✅ Tasks (${a.tasks.length}):*\n`;
      a.tasks.forEach((t,i) => msg += `${i+1}. ${t.text}${t.assignee?" → *"+t.assignee+"*":""}\n`);
      msg += "\n";
    }
    if (a.blockers?.length) {
      msg += `*🚨 Blockers (${a.blockers.length}):*\n`;
      a.blockers.forEach(b => msg += `• ${b.text}${b.owner?" ("+b.owner+")":""}\n`);
      msg += "\n";
    }
    if (a.decisions?.length) {
      msg += `*📌 Decisions:*\n`;
      a.decisions.forEach(d => msg += `• ${d}\n`);
      msg += "\n";
    }
    if (a.attendees_mentioned?.length) msg += `*👥 Mentioned:* ${a.attendees_mentioned.join(", ")}\n\n`;
    msg += `_Posted from Mok Command Center_`;

    await slackPost("chat.postMessage", { channel: STANDUP_CHANNEL, text: msg });
    res.json({ ok: true });
  } catch(e) { res.status(500).json({ error: e.message }); }
});

app.get("*", (q,s)=>s.sendFile(path.join(__dirname,"public","index.html")));

// Cron: refresh every 2 min, digest at 9am Cairo time (UTC+2 = 7am UTC)
cron.schedule("*/2 * * * *",  ()=>fetchAll().catch(console.error));
cron.schedule("0 7 * * *",    ()=>sendDailyDigest().catch(console.error));

fetchAll().catch(console.error);
app.listen(PORT,()=>console.log("Port",PORT));
