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
  { id: "C0ADWK5LGT1", name: "CairoLive", color: "#f97316" },
  { id: "C0AB6NQ061X", name: "Al Nasser", color: "#10b981" },
  { id: "C0ABM2D50LE", name: "Print Out",  color: "#8b5cf6" },
  { id: "C0AC25HP64T", name: "Turbo",      color: "#eab308" },
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

// Tags for categorizing tasks and blockers
const FRONTEND_TAGS = ["website","frontend","front end","front-end","ui","ux","web","homepage","dashboard","page","screen","display","button","form","filter","dropdown","design","layout","responsive","mobile app","app","ios","android","flutter","react","css","html","animation","slider","banner","image","icon","view","scroll","modal","popup","card","chart","widget","navigation","menu","header","footer"];
const BACKEND_TAGS  = ["backend","back end","back-end","api","endpoint","database","db","server","query","migration","model","controller","service","auth","token","route","payload","request","response","status","http","500","400","403","json","sql","seaf","seeder","schema","deploy","nginx","redis","cache","queue","cron","job","log","error","bug","fix","update","delete","insert","select","join","php","laravel","node","express","mongo","mysql","postgres"];
const MOBILE_TAGS   = ["mobile","app","ios","android","flutter","react native","apk","play store","app store","push notification","deep link","version","build","release","testflight","firebase","screen","navigation","state","widget","bloc","provider","package","dependency"];

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
  return ["block","stuck","bug","error","not work","issue","fail","broken","problem","crash","cannot","can't","500","400","failing","مشكلة","doesn't work","not showing","not loading","not appearing"].some(w => low.includes(w));
}

let cache = { lastUpdated: null, projects: [], standup: [], team: {} };
let avatars = {};

function slackGet(ep) {
  return new Promise((res,rej) => {
    const o={hostname:"slack.com",path:"/api/"+ep,headers:{Authorization:"Bearer "+SLACK_TOKEN}};
    https.get(o,r=>{let d="";r.on("data",c=>d+=c);r.on("end",()=>{try{res(JSON.parse(d));}catch(e){rej(e);}});}).on("error",rej);
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
  return{
    date:d.toLocaleDateString("en-GB",{day:"2-digit",month:"short",year:"numeric"}),
    time:d.toLocaleTimeString("en-US",{hour:"2-digit",minute:"2-digit",hour12:true}),
    iso:d.toISOString(),
    ts: ts
  };
}

// ── TASK EXTRACTION: handles nested sub-items (a. b. c.) linking to parent ──
function extractTasks(text) {
  const lines = text.split("\n");
  const tasks = [];
  let lastParentIdx = -1;

  for (const raw of lines) {
    const line = raw.trim();
    if (!line) continue;

    // Numbered: "1." "2." etc
    const num = line.match(/^(\d+)[\.\)]\s+(.+)/);
    if (num && num[2].trim().length > 4) {
      tasks.push({ text: num[2].trim(), num: parseInt(num[1]), sub: false, parentIdx: -1 });
      lastParentIdx = tasks.length - 1;
      continue;
    }
    // Sub-item: "a." "b." etc (link to last parent)
    const letter = line.match(/^([a-zA-Z])[\.\)]\s+(.+)/);
    if (letter && letter[2].trim().length > 3 && lastParentIdx >= 0) {
      tasks.push({ text: letter[2].trim(), num: null, sub: true, parentIdx: lastParentIdx });
      continue;
    }
    // Bullet - or • (only if we already started a list)
    if (tasks.length > 0) {
      const bullet = line.match(/^[-•*]\s+(.+)/);
      if (bullet && bullet[1].trim().length > 5) {
        tasks.push({ text: bullet[1].trim(), num: null, sub: true, parentIdx: lastParentIdx });
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

async function fetchAll(){
  console.log("Fetching",new Date().toISOString());
  loadAvatars().catch(()=>{});
  const results=[];

  for(const proj of PROJECTS){
    try{
      const resp=await slackGet("conversations.history?channel="+proj.id+"&limit=200");
      if(!resp.ok){results.push({...proj,members:[],tasks:[],blockers:[],recentActivity:[],messageCount:0,error:resp.error});continue;}
      const msgs=resp.messages||[];
      const allTasks=[], allBlockers=[];

      for(const m of msgs){
        if(!m.text||m.bot_id||m.subtype) continue;
        const text=clean(m.text);
        if(!text||text.length<8) continue;
        const dt=fmt(m.ts);
        const name=uname(m.user), avatar=uav(m.user);

        // Extract tasks with sub-item linking
        const items=extractTasks(text);
        if(items.length){
          // Build parent text map for linking
          const parentTexts={};
          items.forEach((it,i)=>{ if(!it.sub) parentTexts[i]=it.text; });

          items.forEach((item,i)=>{
            const parentText = item.sub && item.parentIdx>=0 ? items[item.parentIdx]?.text : null;
            const allTags = detectTags(item.text + (parentText||''));
            allTasks.push({
              text: item.text,
              num: item.num,
              sub: item.sub,
              parentTask: parentText,
              tags: allTags,
              date: dt.date, time: dt.time, iso: dt.iso, ts: dt.ts,
              from: name, avatar, uid: m.user,
              msgTs: m.ts  // for linking updates
            });
          });
        }

        // Blockers detection with tags
        if(isBlocker(text) && text.length > 20){
          allBlockers.push({
            text: text.substring(0,500),
            tags: detectTags(text),
            date: dt.date, time: dt.time, iso: dt.iso, ts: dt.ts,
            user: name, avatar, uid: m.user,
            msgTs: m.ts
          });
        }
      }

      // Recent activity — last 10 messages regardless of time (not just 48h)
      const recent=[];
      for(const m of msgs){
        if(recent.length>=6) break;
        if(m.text&&!m.bot_id&&!m.subtype){
          const txt=clean(m.text); if(txt.length<5) continue;
          const dt2=fmt(m.ts);
          recent.push({text:txt.substring(0,200),date:dt2.date,time:dt2.time,iso:dt2.iso,user:uname(m.user),avatar:uav(m.user)});
        }
      }

      const members=(PROJ_MEMBERS[proj.name]||[]).map(uid=>({id:uid,name:uname(uid),avatar:uav(uid)}));
      results.push({...proj,members,messageCount:msgs.length,
        tasks:allTasks.slice(0,80),
        blockers:allBlockers.slice(0,30),
        recentActivity:recent,
        lastMessage:msgs[0]?fmt(msgs[0].ts).iso:null,error:null});
      console.log(proj.name,msgs.length,"msgs |",allTasks.length,"tasks |",allBlockers.length,"blockers");
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
    team[uid]={id:uid,name:uname(uid),avatar:uav(uid),projects:projs,blockerCount:0};
  }
  for(const p of results) for(const b of(p.blockers||[])) if(b.uid&&team[b.uid]) team[b.uid].blockerCount++;

  cache={lastUpdated:new Date().toISOString(),projects:results,standup,team};
  console.log("Done. Standup:",standup.length,"| Team:",Object.keys(team).length);
  return cache;
}

app.get("/api/data",     async(q,s)=>{try{if(!cache.lastUpdated)await fetchAll();s.json(cache);}catch(e){s.status(500).json({error:e.message});}});
app.post("/api/refresh", async(q,s)=>{try{const d=await fetchAll();s.json({ok:true,lastUpdated:d.lastUpdated});}catch(e){s.status(500).json({error:e.message});}});
app.get("/api/health",   (q,s)=>s.json({status:"ok",lastUpdated:cache.lastUpdated}));
app.get("*",             (q,s)=>s.sendFile(path.join(__dirname,"public","index.html")));

cron.schedule("*/2 * * * *",()=>fetchAll().catch(console.error));
fetchAll().catch(console.error);
app.listen(PORT,()=>console.log("Port",PORT));
