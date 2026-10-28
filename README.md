# OPEN STORE

A 90s style web app store. Studios upload apps (as download links), visitors click INSTALL and get sent to the file. One master admin controls everything.

No `npm install` needed. The project has zero dependencies. It needs **Node.js 22.5 or newer** (it uses Node's built-in SQLite database).

## Run on your computer

```
MASTER_USER=master MASTER_PASS=pick-a-long-password npm start
```

Open http://localhost:3000 and click **Studio Login**.

On Windows (PowerShell):

```
$env:MASTER_PASS="pick-a-long-password"; npm start
```

## Deploy on pxxl.app

1. Put this folder in a GitHub repo (or upload it, whichever pxxl.app offers).
2. Create a new Node.js app. Start command: `npm start`. Make sure the Node version is **22 or newer**. If pxxl.app lets you pick Docker instead, the included `Dockerfile` works as is.
3. In the app's environment variables set:
   - `MASTER_USER` (example: `harshit`)
   - `MASTER_PASS` (a long password, at least 8 characters)
4. **Keep the database safe.** The data lives in one file (`data/openstore.db`). If pxxl.app wipes the disk on every deploy, your apps and counts disappear. Attach a persistent volume/storage in pxxl.app and set `DB_PATH` to a file inside it (example: `DB_PATH=/data/openstore.db`).
5. Open your pxxl.app URL, go to **Studio Login**, log in as the master.

If you forget `MASTER_PASS`, the first start makes a random one and prints it in the logs. To change the master login later, change `MASTER_USER` / `MASTER_PASS` and restart.

## What each role can do

**Visitors**
- Browse, search, filter by category, open an app page.
- INSTALL counts the install, then redirects to the studio's file link.

**Studio admins** (accounts made by the master)
- Add, edit and delete their own apps (name, version, icon, description, category, file link).
- See installs and users for each app, and their copyright strikes.
- Change their password.

**Master admin**
- Add studios (give them a username and password), reset their passwords, ban, unban or delete them.
- Add apps for any studio, edit any app, take down, restore or remove any app.
- See site numbers: visitors, visits, installs, per-app installs and users, per-studio installs.
- Give **copyright strikes**. A strike can take the app down or leave it live with a red "copyright notice". At **3 active strikes a studio is banned automatically** (logged out, cannot log in, apps hidden). Revoke a strike and unban if it was a mistake.

## Security notes

- Passwords are hashed (scrypt). Sessions are random tokens in HttpOnly, SameSite=Strict cookies.
- Login is rate limited (10 wrong tries per 15 minutes per IP and per username).
- Every change request needs a custom header, and the server sends strict CSP headers.
- App file links must start with `http://` or `https://`.
- Use HTTPS (pxxl.app gives you that). Cookies are marked Secure automatically behind HTTPS.
- The store links to files hosted elsewhere. It does not scan them. Only approve studios you trust.

## Files

- `server.js` - server, database tables, all API routes
- `public/index.html`, `public/style.css`, `public/app.js` - the website
- `Dockerfile` - optional, for Docker hosting
