# The Mok Company — Daily Standup Dashboard

A live dashboard that reads your Slack channels automatically and updates every morning at 8:00 AM Cairo time.

---

## 🚀 Deploy in 5 Minutes (Free on Railway)

### Step 1 — Get your Slack Bot Token

1. Go to https://api.slack.com/apps → **Create New App** → "From scratch"
2. Name it `Standup Bot`, select your Mok workspace
3. Go to **OAuth & Permissions** → add these scopes:
   - `channels:history`
   - `channels:read`
   - `groups:history`
   - `users:read`
4. Click **Install to Workspace**
5. Copy the **Bot OAuth Token** (starts with `xoxb-...`)
6. **Invite the bot to each project channel**: In each channel type `/invite @Standup Bot`

### Step 2 — Deploy to Railway (Free)

1. Go to https://railway.app → Sign up free with GitHub
2. Click **New Project** → **Deploy from GitHub repo**
3. Upload this folder to a GitHub repo first, then connect it
4. In Railway project settings → **Variables** → add:
   ```
   SLACK_TOKEN = xoxb-your-token-here
   PORT = 3000
   ```
5. Railway will auto-deploy. You'll get a URL like `https://your-app.railway.app`

### Step 3 — Done! ✅

Your dashboard is live. It will:
- **Auto-refresh every weekday at 8:00 AM Cairo time** (cron job built-in)
- **Refresh on-demand** via the "Refresh Now" button
- **Auto-refresh in browser** every 5 minutes

---

## 🔄 Alternative: Deploy to Render (Also Free)

1. Go to https://render.com → New → Web Service
2. Connect your GitHub repo
3. Set **Start Command**: `node server.js`
4. Add environment variable: `SLACK_TOKEN = xoxb-...`
5. Deploy!

---

## 📁 Project Structure

```
standup-dashboard/
├── server.js          ← Express backend + Slack API + cron scheduler
├── public/
│   └── index.html     ← Full dashboard frontend (no build step needed)
├── package.json
├── .env.example
└── README.md
```

## 🛠 Local Development

```bash
npm install
SLACK_TOKEN=xoxb-your-token node server.js
# Open http://localhost:3000
```
