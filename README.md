# Voxel Combat 3 – Online setup (beginner guide)

Your game stays on **Netlify**. The new `server.js` runs on **Render** (free) and keeps accounts
(username + password) in **Upstash** (free). You do this once.

You have 3 files to work with:
- `voxel-combat-3-online.html`  – the game (goes on Netlify)
- `server.js` and `package.json` – the server (go on Render)

---
## Step 1 – Free database (Upstash)  ~3 min
1. Go to https://upstash.com and sign up.
2. Click **Create Database** → choose **Redis** → pick any name → pick the region closest to your players → Create.
3. On the database page, scroll to **REST API**. Copy two things and keep them in a notepad:
   - `UPSTASH_REDIS_REST_URL`
   - `UPSTASH_REDIS_REST_TOKEN`

## Step 2 – Put the server files on GitHub  ~5 min
Render reads your server from GitHub.
1. Sign up at https://github.com → click **New repository** → name it `voxel-server` → Create.
2. Click **uploading an existing file**, drag in `server.js` and `package.json`, then **Commit changes**.

## Step 3 – Start the server (Render)  ~5 min
1. Go to https://render.com, sign up (you can use your GitHub login).
2. **New +** → **Web Service** → connect your `voxel-server` repository.
3. Fill in:
   - Runtime / Language: **Node**
   - Build Command: `npm install`
   - Start Command: `npm start`
   - Instance Type: **Free**
4. Open **Environment Variables** and add:
   - `UPSTASH_REDIS_REST_URL`   = (the URL from Step 1)
   - `UPSTASH_REDIS_REST_TOKEN` = (the token from Step 1)
   - `ALLOWED_ORIGIN` = your Netlify address, e.g. `https://yourgame.netlify.app`
     (no slash at the end. If you have a custom domain, put both, separated by a comma.
     Leave this empty only while you are testing from a file on your computer.)
5. Click **Create Web Service**. When it says **Live**, copy its address at the top,
   e.g. `https://voxel-server-abcd.onrender.com`.

## Step 4 – Tell the game where the server is  ~2 min
1. Open `voxel-combat-3-online.html` in a text editor (Notepad is fine).
2. Search for `YOUR-SERVER`. You will find this line:
   `const SERVER='wss://YOUR-SERVER.onrender.com';`
3. Replace the address with yours but keep **wss://** at the start (not https://):
   `const SERVER='wss://voxel-server-abcd.onrender.com';`
4. Save the file. Rename it to `index.html`.

## Step 5 – Upload to Netlify
Drag `index.html` onto your Netlify site's **Deploys** page. Done!

---
## Good to know
- **Free Render sleeps** when nobody has played for ~15 minutes. The first person to log in
  then waits about 30 seconds while it wakes up. Paid plans don't sleep.
- Accounts, coins, weapons, avatar and stats are saved to your account, so players can log in on any device.
- Passwords are never stored as plain text (they are salted and scrypt-hashed).
- Players are limited to 16 per lobby. Logging in on a second device logs the first one out.
- If login says "Not connected", wait a few seconds and try again (the server may be waking up).
- To test on your own computer: `npm install`, then `npm start`, and set `SERVER` to `ws://localhost:8080`.
