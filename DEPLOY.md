# How to deploy Birke on Render

## What you need
- GitHub account ✅
- Render account ✅
- Your Anthropic API key (get it from console.anthropic.com → API Keys)

---

## Step 1 — Create the GitHub repo

1. Go to github.com → click the **+** → **New repository**
2. Name it `birke`
3. Set it to **Public** (or Private, both work)
4. Click **Create repository**

---

## Step 2 — Upload the files

You should have this folder structure:
```
birke/
  server.js
  package.json
  .gitignore
  public/
    index.html
```

**Easiest way (no terminal):**
1. On your new GitHub repo page, click **uploading an existing file**
2. Drag and drop `server.js`, `package.json`, `.gitignore` into the upload area
3. Commit them
4. Then create the `public` folder: click **Add file → Create new file**, type `public/index.html` as the filename, paste the contents of `index.html`, and commit

---

## Step 3 — Create the PostgreSQL database on Render

1. Go to render.com → click **New +** → **PostgreSQL**
2. Name it `birke-db`
3. Region: pick closest to you (US East or similar)
4. Plan: **Free**
5. Click **Create Database**
6. Wait ~1 minute, then copy the **Internal Database URL** (you'll need it in Step 4)

---

## Step 4 — Create the Web Service on Render

1. Click **New +** → **Web Service**
2. Connect your GitHub account if not already connected
3. Select your `birke` repository
4. Fill in the settings:
   - **Name:** birke
   - **Region:** same as your database
   - **Branch:** main
   - **Runtime:** Node
   - **Build Command:** `npm install`
   - **Start Command:** `npm start`
   - **Plan:** Free
5. Scroll down to **Environment Variables** — add these two:
   - Key: `ANTHROPIC_API_KEY` → Value: your Anthropic API key
   - Key: `DATABASE_URL` → Value: the Internal Database URL from Step 3
6. Click **Create Web Service**

---

## Step 5 — You're live!

Render will build and deploy Birke (takes ~2 minutes).
Your URL will be: `https://birke.onrender.com` (or similar)

Open it from any phone, tablet, or computer — Birke remembers everything across all devices.

---

## Notes

- **Free tier sleeps after 15 min of inactivity** — first load may take 30 seconds to wake up. Paid tier ($7/mo) stays always-on.
- **Memories are permanent** — stored in PostgreSQL, survive restarts and redeployments.
- Every time you push changes to GitHub, Render auto-redeploys.
