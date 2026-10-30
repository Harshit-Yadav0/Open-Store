'use strict';
/*
 * OPEN STORE server
 * Needs Node.js 22.5 or newer.
 *
 * Database:
 *   - If TURSO_DATABASE_URL is set, data lives in your Turso database (safe across redeploys).
 *     This needs the @libsql/client package (npm install).
 *   - Otherwise data lives in a local SQLite file (fine for testing on your own computer,
 *     but it is wiped on hosts with a temporary disk, like Render's free plan).
 *
 * Env vars:
 *   PORT                 port to listen on (hosts usually set this for you)
 *   MASTER_USER          master admin username   (default: master)
 *   MASTER_PASS          master admin password   (set this! min 8 chars)
 *   TURSO_DATABASE_URL   libsql://your-db.turso.io
 *   TURSO_AUTH_TOKEN     token from Turso
 *   DB_PATH              local sqlite file (default: ./data/openstore.db), used when Turso is not set
 */
const http = require('http');
const fs = require('fs');
const path = require('path');
const crypto = require('crypto');

const PORT = Number(process.env.PORT) || 3000;
const TURSO_URL = (process.env.TURSO_DATABASE_URL || process.env.TURSO_URL || '').trim();
const TURSO_TOKEN = (process.env.TURSO_AUTH_TOKEN || process.env.TURSO_TOKEN || '').trim();
const DB_PATH = process.env.DB_PATH || path.join(__dirname, 'data', 'openstore.db');
const PUBLIC_DIR = path.join(__dirname, 'public');
const CATEGORIES = ['Games', 'Tools', 'Social', 'Music', 'Photo', 'Education', 'Productivity', 'Other'];
const MAX_STRIKES = 3;
const SESSION_MS = 7 * 24 * 60 * 60 * 1000;

/* ---------------------------------------------------------------- database
 * One small interface over two backends, so the rest of the file does not care which one is in use:
 *   all(sql, args)    -> array of plain row objects
 *   get(sql, args)    -> first row or undefined
 *   run(sql, args)    -> { changes, lastId }
 *   batch([[sql, args], ...]) -> runs all statements as one all-or-nothing transaction
 *   exec(script)      -> runs several statements (used for the schema)
 */
const norm = (v) => (typeof v === 'bigint' ? Number(v) : v);

function openLocal(file) {
  const { DatabaseSync } = require('node:sqlite');
  fs.mkdirSync(path.dirname(file), { recursive: true });
  const d = new DatabaseSync(file);
  d.exec('PRAGMA journal_mode = WAL; PRAGMA foreign_keys = ON;');
  const plain = (r) => { const o = {}; for (const k of Object.keys(r)) o[k] = norm(r[k]); return o; };
  return {
    kind: 'local',
    async all(sql, args = []) { return d.prepare(sql).all(...args).map(plain); },
    async get(sql, args = []) { const r = d.prepare(sql).get(...args); return r ? plain(r) : undefined; },
    async run(sql, args = []) {
      const r = d.prepare(sql).run(...args);
      return { changes: Number(r.changes), lastId: Number(r.lastInsertRowid) };
    },
    async batch(stmts) { // no await inside, so nothing else can interleave
      d.exec('BEGIN');
      try {
        for (const [sql, args = []] of stmts) d.prepare(sql).run(...args);
        d.exec('COMMIT');
      } catch (e) { d.exec('ROLLBACK'); throw e; }
    },
    async exec(script) { d.exec(script); },
  };
}

async function loadLibsql() {
  const names = ['@libsql/client', '@tursodatabase/serverless/compat'];
  let lastErr;
  for (const name of names) {
    try {
      let m;
      try { m = require(name); } catch (e) { m = await import(name); }
      const createClient = m.createClient || (m.default && m.default.createClient);
      if (createClient) return createClient;
    } catch (e) { lastErr = e; }
  }
  throw new Error('Turso is configured but its library is missing. Run "npm install" (package @libsql/client). ' + (lastErr ? lastErr.message : ''));
}

async function openTurso(url, authToken) {
  const createClient = await loadLibsql();
  const c = createClient(authToken ? { url, authToken } : { url });
  const rowsOf = (r) => r.rows.map((row) => {
    const o = {};
    r.columns.forEach((col, i) => { o[col] = norm(row[i]); });
    return o;
  });
  return {
    kind: 'turso',
    async all(sql, args = []) { return rowsOf(await c.execute({ sql, args })); },
    async get(sql, args = []) { return rowsOf(await c.execute({ sql, args }))[0]; },
    async run(sql, args = []) {
      const r = await c.execute({ sql, args });
      return { changes: Number(r.rowsAffected), lastId: r.lastInsertRowid == null ? 0 : Number(r.lastInsertRowid) };
    },
    async batch(stmts) { await c.batch(stmts.map(([sql, args = []]) => ({ sql, args })), 'write'); },
    async exec(script) { await c.executeMultiple(script); },
  };
}

const SCHEMA = `
  CREATE TABLE IF NOT EXISTS admins (
    id INTEGER PRIMARY KEY AUTOINCREMENT,
    username TEXT NOT NULL UNIQUE,
    display_name TEXT NOT NULL,
    password_hash TEXT NOT NULL,
    role TEXT NOT NULL DEFAULT 'admin',
    status TEXT NOT NULL DEFAULT 'active',
    ban_reason TEXT,
    strikes INTEGER NOT NULL DEFAULT 0,
    created_at INTEGER NOT NULL
  );
  CREATE TABLE IF NOT EXISTS sessions (
    token_hash TEXT PRIMARY KEY,
    admin_id INTEGER NOT NULL,
    expires_at INTEGER NOT NULL
  );
  CREATE TABLE IF NOT EXISTS apps (
    id INTEGER PRIMARY KEY AUTOINCREMENT,
    admin_id INTEGER NOT NULL,
    name TEXT NOT NULL,
    tagline TEXT NOT NULL DEFAULT '',
    description TEXT NOT NULL DEFAULT '',
    category TEXT NOT NULL DEFAULT 'Other',
    version TEXT NOT NULL DEFAULT '1.0',
    icon TEXT NOT NULL DEFAULT '',
    file_url TEXT NOT NULL,
    status TEXT NOT NULL DEFAULT 'live',
    strikes INTEGER NOT NULL DEFAULT 0,
    created_at INTEGER NOT NULL,
    updated_at INTEGER NOT NULL
  );
  CREATE TABLE IF NOT EXISTS installs (
    id INTEGER PRIMARY KEY AUTOINCREMENT,
    app_id INTEGER NOT NULL,
    vid TEXT NOT NULL,
    created_at INTEGER NOT NULL
  );
  CREATE INDEX IF NOT EXISTS idx_installs_app ON installs(app_id);
  CREATE TABLE IF NOT EXISTS strikes (
    id INTEGER PRIMARY KEY AUTOINCREMENT,
    app_id INTEGER,
    app_name TEXT NOT NULL,
    admin_id INTEGER,
    admin_name TEXT NOT NULL,
    reason TEXT NOT NULL,
    revoked INTEGER NOT NULL DEFAULT 0,
    created_at INTEGER NOT NULL
  );
  CREATE TABLE IF NOT EXISTS visitors (
    vid TEXT PRIMARY KEY,
    visits INTEGER NOT NULL DEFAULT 1,
    first_seen INTEGER NOT NULL,
    last_seen INTEGER NOT NULL
  );
  CREATE TABLE IF NOT EXISTS ads (
    id INTEGER PRIMARY KEY AUTOINCREMENT,
    advertiser TEXT NOT NULL,
    title TEXT NOT NULL,
    image_url TEXT NOT NULL DEFAULT '',
    link_url TEXT NOT NULL,
    status TEXT NOT NULL DEFAULT 'active',
    impressions INTEGER NOT NULL DEFAULT 0,
    clicks INTEGER NOT NULL DEFAULT 0,
    created_at INTEGER NOT NULL
  );
`;

let db; // set in start()

/* ----------------------------------------------------------------- helpers */
class HttpError extends Error {
  constructor(status, message) { super(message); this.status = status; }
}
const now = () => Date.now();
const sha = (s) => crypto.createHash('sha256').update(s).digest('hex');

function hashPassword(pw) {
  const salt = crypto.randomBytes(16);
  const hash = crypto.scryptSync(pw, salt, 64);
  return `scrypt$${salt.toString('hex')}$${hash.toString('hex')}`;
}
function verifyPassword(pw, stored) {
  try {
    const [, saltHex, hashHex] = String(stored).split('$');
    const expected = Buffer.from(hashHex, 'hex');
    const actual = crypto.scryptSync(pw, Buffer.from(saltHex, 'hex'), expected.length);
    return crypto.timingSafeEqual(actual, expected);
  } catch { return false; }
}
const DUMMY_HASH = hashPassword('dummy-password-for-timing');

function text(v, name, min, max, optional = false) {
  v = String(v ?? '').trim();
  if (!v && optional) return '';
  if (v.length < min) throw new HttpError(400, `${name} must be at least ${min} characters`);
  if (v.length > max) throw new HttpError(400, `${name} must be at most ${max} characters`);
  return v;
}
function cleanUrl(v, name) {
  v = String(v ?? '').trim();
  if (v.length > 1000) throw new HttpError(400, `${name} is too long`);
  let u;
  try { u = new URL(v); } catch { throw new HttpError(400, `${name} must be a full http(s) link`); }
  if (u.protocol !== 'http:' && u.protocol !== 'https:') throw new HttpError(400, `${name} must start with http:// or https://`);
  return u.href;
}
function cleanIcon(v) {
  v = String(v ?? '').trim();
  if (!v) return '';
  if (/^https?:\/\//i.test(v)) return cleanUrl(v, 'Icon link');
  return Array.from(v).slice(0, 4).join('');
}
function cleanUsername(v) {
  v = String(v ?? '').trim().toLowerCase();
  if (!/^[a-z0-9_]{3,24}$/.test(v)) throw new HttpError(400, 'Username: 3-24 letters, numbers or underscore');
  return v;
}
function cleanPassword(v) {
  v = String(v ?? '');
  if (v.length < 8 || v.length > 200) throw new HttpError(400, 'Password must be 8-200 characters');
  return v;
}
function appFields(b) {
  const category = String(b.category || 'Other');
  if (!CATEGORIES.includes(category)) throw new HttpError(400, 'Unknown category');
  return {
    name: text(b.name, 'App name', 2, 60),
    tagline: text(b.tagline, 'Tagline', 0, 100, true),
    description: text(b.description, 'Description', 0, 2000, true),
    category,
    version: text(b.version || '1.0', 'Version', 1, 20),
    icon: cleanIcon(b.icon),
    file_url: cleanUrl(b.file_url, 'App file link'),
  };
}

/* --------------------------------------------------------- request context */
function parseCookies(req) {
  const out = {};
  for (const part of String(req.headers.cookie || '').split(';')) {
    const i = part.indexOf('=');
    if (i > 0) out[part.slice(0, i).trim()] = decodeURIComponent(part.slice(i + 1).trim());
  }
  return out;
}
function clientIp(req) {
  const xf = String(req.headers['x-forwarded-for'] || '').split(',')[0].trim();
  return xf || req.socket.remoteAddress || 'unknown';
}
function isSecure(req) {
  return req.socket.encrypted || String(req.headers['x-forwarded-proto'] || '').split(',')[0].trim() === 'https';
}
function setCookie(req, res, name, value, { maxAge, httpOnly = true, sameSite = 'Strict' }) {
  const parts = [`${name}=${encodeURIComponent(value)}`, 'Path=/', `SameSite=${sameSite}`];
  if (httpOnly) parts.push('HttpOnly');
  if (isSecure(req)) parts.push('Secure');
  parts.push(`Max-Age=${Math.floor(maxAge / 1000)}`);
  (res._cookies ||= []).push(parts.join('; '));
}
function securityHeaders() {
  return {
    'X-Content-Type-Options': 'nosniff',
    'X-Frame-Options': 'DENY',
    'Referrer-Policy': 'same-origin',
    'Content-Security-Policy': "default-src 'self'; img-src 'self' https: http: data:; style-src 'self'; script-src 'self'; base-uri 'none'; form-action 'self'; frame-ancestors 'none'",
  };
}
function sendJson(res, status, obj) {
  const headers = { 'Content-Type': 'application/json; charset=utf-8', 'Cache-Control': 'no-store', ...securityHeaders() };
  if (res._cookies) headers['Set-Cookie'] = res._cookies;
  res.writeHead(status, headers);
  res.end(JSON.stringify(obj));
}
function readBody(req) {
  return new Promise((resolve, reject) => {
    let size = 0; const chunks = [];
    req.on('data', (c) => {
      size += c.length;
      if (size > 100 * 1024) { reject(new HttpError(413, 'Request too big')); req.destroy(); return; }
      chunks.push(c);
    });
    req.on('end', () => {
      if (!chunks.length) return resolve({});
      try { resolve(JSON.parse(Buffer.concat(chunks).toString('utf8'))); }
      catch { reject(new HttpError(400, 'Bad JSON')); }
    });
    req.on('error', reject);
  });
}

/* -------------------------------------------------------------------- auth */
async function currentUser(req) {
  const tok = parseCookies(req).os_sid;
  if (!tok) return null;
  const row = await db.get(`
    SELECT a.id, a.username, a.display_name, a.role, a.status, a.strikes, s.expires_at
    FROM sessions s JOIN admins a ON a.id = s.admin_id WHERE s.token_hash = ?`, [sha(tok)]);
  if (!row) return null;
  if (row.expires_at < now() || row.status !== 'active') {
    await db.run('DELETE FROM sessions WHERE token_hash = ?', [sha(tok)]);
    return null;
  }
  return row;
}
const attempts = new Map();
function tooManyAttempts(key) {
  const rec = attempts.get(key);
  if (!rec || rec.reset < now()) return false;
  return rec.n >= 10;
}
function noteFailure(key) {
  const rec = attempts.get(key);
  if (!rec || rec.reset < now()) attempts.set(key, { n: 1, reset: now() + 15 * 60 * 1000 });
  else rec.n++;
}

function getVid(req, res) {
  let vid = parseCookies(req).os_vid;
  if (!vid || !/^[a-f0-9]{32}$/.test(vid)) {
    vid = crypto.randomBytes(16).toString('hex');
    setCookie(req, res, 'os_vid', vid, { maxAge: 365 * 24 * 60 * 60 * 1000, sameSite: 'Lax' });
  }
  return vid;
}

/* ------------------------------------------------------------ app queries */
const APP_SELECT = `
  SELECT a.id, a.admin_id, a.name, a.tagline, a.description, a.category, a.version, a.icon,
         a.file_url, a.status, a.strikes, a.created_at, a.updated_at,
         ad.display_name AS studio, ad.username AS studio_user, ad.status AS studio_status,
         (SELECT COUNT(*) FROM installs i WHERE i.app_id = a.id) AS installs,
         (SELECT COUNT(DISTINCT i.vid) FROM installs i WHERE i.app_id = a.id) AS users
  FROM apps a JOIN admins ad ON ad.id = a.admin_id`;
const PUBLIC_WHERE = `a.status = 'live' AND ad.status = 'active'`;
function publicApp(r, withDesc) {
  const o = {
    id: r.id, name: r.name, tagline: r.tagline, category: r.category, version: r.version,
    icon: r.icon, studio: r.studio, installs: r.installs, users: r.users,
    copyright_notice: r.strikes > 0, updated_at: r.updated_at,
  };
  if (withDesc) o.description = r.description;
  return o;
}
function ownerOrMaster(user, appRow) {
  if (!appRow) throw new HttpError(404, 'App not found');
  if (user.role !== 'master' && appRow.admin_id !== user.id) throw new HttpError(403, 'Not your app');
}
async function deleteApp(id) {
  await db.batch([
    ['DELETE FROM installs WHERE app_id = ?', [id]],
    ['DELETE FROM apps WHERE id = ?', [id]],
  ]);
}

/* ------------------------------------------------------------------ routes */
const routes = [];
function route(method, pattern, auth, handler) {
  const keys = [];
  const rx = new RegExp('^' + pattern.replace(/:(\w+)/g, (_, k) => { keys.push(k); return '([^/]+)'; }) + '$');
  routes.push({ method, rx, keys, auth, handler });
}

/* ---- public */
route('GET', '/api/categories', null, () => ({ categories: CATEGORIES }));

async function publicStats() {
  const r = await db.get(`
    SELECT (SELECT COUNT(*) FROM visitors) AS visitors,
           (SELECT COALESCE(SUM(visits), 0) FROM visitors) AS visits,
           (SELECT COUNT(*) FROM apps a JOIN admins ad ON ad.id = a.admin_id WHERE ${PUBLIC_WHERE}) AS apps,
           (SELECT COUNT(*) FROM installs) AS installs`);
  return { visits: r.visits, visitors: r.visitors, apps: r.apps, installs: r.installs };
}
route('POST', '/api/visit', null, async ({ req, res }) => {
  const vid = getVid(req, res);
  const t = now();
  const r = await db.run('UPDATE visitors SET visits = visits + 1, last_seen = ? WHERE vid = ?', [t, vid]);
  if (!r.changes) await db.run('INSERT OR IGNORE INTO visitors (vid, visits, first_seen, last_seen) VALUES (?, 1, ?, ?)', [vid, t, t]);
  return publicStats();
});
route('GET', '/api/stats', null, () => publicStats());

route('GET', '/api/apps', null, async ({ query }) => {
  const where = [PUBLIC_WHERE]; const args = [];
  const q = String(query.get('q') || '').trim().slice(0, 60);
  if (q) {
    const like = '%' + q.replace(/[\\%_]/g, (c) => '\\' + c) + '%';
    where.push(`(a.name LIKE ? ESCAPE '\\' OR a.tagline LIKE ? ESCAPE '\\' OR ad.display_name LIKE ? ESCAPE '\\')`);
    args.push(like, like, like);
  }
  const cat = String(query.get('category') || '');
  if (cat && CATEGORIES.includes(cat)) { where.push('a.category = ?'); args.push(cat); }
  const order = query.get('sort') === 'new' ? 'a.created_at DESC' : 'installs DESC, a.created_at DESC';
  const rows = await db.all(`${APP_SELECT} WHERE ${where.join(' AND ')} ORDER BY ${order} LIMIT 200`, args);
  return { apps: rows.map((r) => publicApp(r, false)) };
});

route('GET', '/api/apps/:id', null, async ({ params }) => {
  const r = await db.get(`${APP_SELECT} WHERE a.id = ? AND ${PUBLIC_WHERE}`, [Number(params.id)]);
  if (!r) throw new HttpError(404, 'App not found');
  return { app: publicApp(r, true) };
});

/* install click: count it, then send the visitor to the app file link */
route('GET', '/go/:id', null, async ({ req, res, params }) => {
  const r = await db.get(`${APP_SELECT} WHERE a.id = ? AND ${PUBLIC_WHERE}`, [Number(params.id)]);
  if (!r) throw new HttpError(404, 'App not available');
  const vid = getVid(req, res);
  const target = cleanUrl(r.file_url, 'App file link');
  await db.run('INSERT INTO installs (app_id, vid, created_at) VALUES (?, ?, ?)', [r.id, vid, now()]);
  return { __redirect: target };
});

/* ---- ads (side billboards) */
route('GET', '/api/ads', null, async () => ({
  ads: await db.all("SELECT id, advertiser, title, image_url FROM ads WHERE status = 'active' ORDER BY RANDOM() LIMIT 6"),
}));
route('POST', '/api/ads/seen', null, async ({ body }) => {
  const ids = Array.isArray(body.ids) ? body.ids.slice(0, 6).map(Number).filter(Number.isInteger) : [];
  if (ids.length) {
    await db.batch(ids.map((id) => ["UPDATE ads SET impressions = impressions + 1 WHERE id = ? AND status = 'active'", [id]]));
  }
  return { ok: true };
});
route('GET', '/ad/:id', null, async ({ params }) => {
  const a = await db.get("SELECT * FROM ads WHERE id = ? AND status = 'active'", [Number(params.id)]);
  if (!a) throw new HttpError(404, 'Ad not available');
  const target = cleanUrl(a.link_url, 'Ad link');
  await db.run('UPDATE ads SET clicks = clicks + 1 WHERE id = ?', [a.id]);
  return { __redirect: target };
});

/* ---- login */
route('POST', '/api/login', null, async ({ req, res, body }) => {
  const username = String(body.username || '').trim().toLowerCase().slice(0, 40);
  const password = String(body.password || '').slice(0, 200);
  const ipKey = 'ip:' + clientIp(req); const userKey = 'u:' + username;
  if (tooManyAttempts(ipKey) || tooManyAttempts(userKey)) throw new HttpError(429, 'Too many tries. Wait 15 minutes.');
  const admin = await db.get('SELECT * FROM admins WHERE username = ?', [username]);
  const ok = verifyPassword(password, admin ? admin.password_hash : DUMMY_HASH) && admin;
  if (!ok) { noteFailure(ipKey); noteFailure(userKey); throw new HttpError(401, 'Wrong username or password'); }
  if (admin.status !== 'active') throw new HttpError(403, `This studio is banned. Reason: ${admin.ban_reason || 'not given'}`);
  const token = crypto.randomBytes(32).toString('hex');
  await db.run('INSERT INTO sessions (token_hash, admin_id, expires_at) VALUES (?, ?, ?)', [sha(token), admin.id, now() + SESSION_MS]);
  setCookie(req, res, 'os_sid', token, { maxAge: SESSION_MS });
  return { user: { id: admin.id, username: admin.username, display_name: admin.display_name, role: admin.role, strikes: admin.strikes } };
});
route('POST', '/api/logout', null, async ({ req, res }) => {
  const tok = parseCookies(req).os_sid;
  if (tok) await db.run('DELETE FROM sessions WHERE token_hash = ?', [sha(tok)]);
  setCookie(req, res, 'os_sid', '', { maxAge: 0 });
  return { ok: true };
});
route('GET', '/api/me', null, ({ user }) => ({
  user: user ? { id: user.id, username: user.username, display_name: user.display_name, role: user.role, strikes: user.strikes } : null,
}));

/* ---- studio (admin or master) */
route('POST', '/api/me/password', 'admin', async ({ user, body }) => {
  const row = await db.get('SELECT password_hash FROM admins WHERE id = ?', [user.id]);
  if (!verifyPassword(String(body.current || ''), row.password_hash)) throw new HttpError(400, 'Current password is wrong');
  await db.run('UPDATE admins SET password_hash = ? WHERE id = ?', [hashPassword(cleanPassword(body.next)), user.id]);
  return { ok: true };
});

route('GET', '/api/my/apps', 'admin', async ({ user }) => ({
  apps: await db.all(`${APP_SELECT} WHERE a.admin_id = ? ORDER BY a.created_at DESC`, [user.id]),
}));
route('POST', '/api/my/apps', 'admin', async ({ user, body }) => {
  const f = appFields(body); const t = now();
  const r = await db.run(`INSERT INTO apps (admin_id, name, tagline, description, category, version, icon, file_url, created_at, updated_at)
    VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?)`, [user.id, f.name, f.tagline, f.description, f.category, f.version, f.icon, f.file_url, t, t]);
  return { id: r.lastId };
});
route('PUT', '/api/my/apps/:id', 'admin', async ({ user, params, body }) => {
  const a = await db.get('SELECT * FROM apps WHERE id = ?', [Number(params.id)]);
  ownerOrMaster(user, a);
  const f = appFields(body);
  await db.run(`UPDATE apps SET name=?, tagline=?, description=?, category=?, version=?, icon=?, file_url=?, updated_at=? WHERE id=?`,
    [f.name, f.tagline, f.description, f.category, f.version, f.icon, f.file_url, now(), a.id]);
  return { ok: true };
});
route('DELETE', '/api/my/apps/:id', 'admin', async ({ user, params }) => {
  const a = await db.get('SELECT * FROM apps WHERE id = ?', [Number(params.id)]);
  ownerOrMaster(user, a);
  await deleteApp(a.id);
  return { ok: true };
});

/* ---- master only */
route('GET', '/api/master/overview', 'master', async () => {
  const o = await db.get(`
    SELECT (SELECT COUNT(*) FROM apps) AS all_apps,
           (SELECT COUNT(*) FROM apps WHERE status <> 'live') AS taken_down,
           (SELECT COUNT(*) FROM admins WHERE role = 'admin') AS studios,
           (SELECT COUNT(*) FROM admins WHERE status = 'banned') AS banned,
           (SELECT COUNT(*) FROM strikes WHERE revoked = 0) AS active_strikes`);
  return { ...(await publicStats()), ...o };
});

route('GET', '/api/master/admins', 'master', async () => ({
  admins: await db.all(`
    SELECT a.id, a.username, a.display_name, a.role, a.status, a.ban_reason, a.strikes, a.created_at,
      (SELECT COUNT(*) FROM apps p WHERE p.admin_id = a.id) AS apps,
      (SELECT COUNT(*) FROM installs i JOIN apps p ON p.id = i.app_id WHERE p.admin_id = a.id) AS installs
    FROM admins a ORDER BY a.role DESC, a.created_at DESC`),
}));
route('POST', '/api/master/admins', 'master', async ({ body }) => {
  const username = cleanUsername(body.username);
  const display = text(body.display_name, 'Studio name', 2, 40);
  const hash = hashPassword(cleanPassword(body.password));
  if (await db.get('SELECT id FROM admins WHERE username = ?', [username])) throw new HttpError(409, 'Username already taken');
  const r = await db.run(`INSERT INTO admins (username, display_name, password_hash, role, created_at) VALUES (?, ?, ?, 'admin', ?)`,
    [username, display, hash, now()]);
  return { id: r.lastId };
});
async function targetAdmin(id) {
  const a = await db.get('SELECT * FROM admins WHERE id = ?', [Number(id)]);
  if (!a) throw new HttpError(404, 'Studio not found');
  if (a.role === 'master') throw new HttpError(400, 'That is the master account');
  return a;
}
async function banAdmin(id, reason) {
  await db.batch([
    ["UPDATE admins SET status = 'banned', ban_reason = ? WHERE id = ?", [reason, id]],
    ['DELETE FROM sessions WHERE admin_id = ?', [id]],
  ]);
}
route('POST', '/api/master/admins/:id/ban', 'master', async ({ params, body }) => {
  const a = await targetAdmin(params.id);
  await banAdmin(a.id, text(body.reason, 'Reason', 3, 300));
  return { ok: true };
});
route('POST', '/api/master/admins/:id/unban', 'master', async ({ params }) => {
  const a = await targetAdmin(params.id);
  await db.run("UPDATE admins SET status = 'active', ban_reason = NULL WHERE id = ?", [a.id]);
  return { ok: true };
});
route('POST', '/api/master/admins/:id/password', 'master', async ({ params, body }) => {
  const a = await targetAdmin(params.id);
  await db.batch([
    ['UPDATE admins SET password_hash = ? WHERE id = ?', [hashPassword(cleanPassword(body.password)), a.id]],
    ['DELETE FROM sessions WHERE admin_id = ?', [a.id]],
  ]);
  return { ok: true };
});
route('DELETE', '/api/master/admins/:id', 'master', async ({ params }) => {
  const a = await targetAdmin(params.id);
  await db.batch([
    ['DELETE FROM sessions WHERE admin_id = ?', [a.id]],
    ['DELETE FROM installs WHERE app_id IN (SELECT id FROM apps WHERE admin_id = ?)', [a.id]],
    ['DELETE FROM apps WHERE admin_id = ?', [a.id]],
    ['DELETE FROM admins WHERE id = ?', [a.id]],
  ]);
  return { ok: true };
});

route('GET', '/api/master/apps', 'master', async () => ({
  apps: await db.all(`${APP_SELECT} ORDER BY a.created_at DESC`),
}));
route('POST', '/api/master/apps', 'master', async ({ user, body }) => {
  const owner = body.admin_id ? Number(body.admin_id) : user.id;
  const adm = await db.get('SELECT id, status FROM admins WHERE id = ?', [owner]);
  if (!adm) throw new HttpError(404, 'Studio not found');
  const f = appFields(body); const t = now();
  const r = await db.run(`INSERT INTO apps (admin_id, name, tagline, description, category, version, icon, file_url, created_at, updated_at)
    VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?)`, [owner, f.name, f.tagline, f.description, f.category, f.version, f.icon, f.file_url, t, t]);
  return { id: r.lastId };
});
route('POST', '/api/master/apps/:id/status', 'master', async ({ params, body }) => {
  const status = body.status === 'live' ? 'live' : 'taken_down';
  const r = await db.run('UPDATE apps SET status = ?, updated_at = ? WHERE id = ?', [status, now(), Number(params.id)]);
  if (!r.changes) throw new HttpError(404, 'App not found');
  return { ok: true };
});
route('POST', '/api/master/apps/:id/strike', 'master', async ({ params, body }) => {
  const a = await db.get(`SELECT a.*, ad.display_name AS studio, ad.role AS role FROM apps a JOIN admins ad ON ad.id = a.admin_id WHERE a.id = ?`, [Number(params.id)]);
  if (!a) throw new HttpError(404, 'App not found');
  const reason = text(body.reason, 'Copyright reason', 3, 300);
  const takedown = body.takedown !== false;
  await db.batch([
    ['INSERT INTO strikes (app_id, app_name, admin_id, admin_name, reason, created_at) VALUES (?, ?, ?, ?, ?, ?)',
      [a.id, a.name, a.admin_id, a.studio, reason, now()]],
    ["UPDATE apps SET strikes = strikes + 1, status = CASE WHEN ? THEN 'taken_down' ELSE status END, updated_at = ? WHERE id = ?",
      [takedown ? 1 : 0, now(), a.id]],
    ['UPDATE admins SET strikes = strikes + 1 WHERE id = ?', [a.admin_id]],
  ]);
  let autoBanned = false;
  const adm = await db.get('SELECT strikes, status FROM admins WHERE id = ?', [a.admin_id]);
  if (a.role !== 'master' && adm.strikes >= MAX_STRIKES && adm.status === 'active') {
    await banAdmin(a.admin_id, `Auto-ban: ${MAX_STRIKES} copyright strikes`);
    autoBanned = true;
  }
  return { ok: true, auto_banned: autoBanned };
});
route('GET', '/api/master/strikes', 'master', async () => ({
  strikes: await db.all('SELECT * FROM strikes ORDER BY created_at DESC LIMIT 300'),
}));
route('POST', '/api/master/strikes/:id/revoke', 'master', async ({ params }) => {
  const s = await db.get('SELECT * FROM strikes WHERE id = ?', [Number(params.id)]);
  if (!s) throw new HttpError(404, 'Strike not found');
  if (s.revoked) throw new HttpError(400, 'Already revoked');
  await db.batch([
    ['UPDATE strikes SET revoked = 1 WHERE id = ?', [s.id]],
    ['UPDATE apps SET strikes = MAX(strikes - 1, 0) WHERE id = ?', [s.app_id]],
    ['UPDATE admins SET strikes = MAX(strikes - 1, 0) WHERE id = ?', [s.admin_id]],
  ]);
  return { ok: true };
});

route('GET', '/api/master/ads', 'master', async () => ({
  ads: await db.all('SELECT * FROM ads ORDER BY created_at DESC'),
}));
route('POST', '/api/master/ads', 'master', async ({ body }) => {
  const advertiser = text(body.advertiser, 'Advertiser', 2, 40);
  const title = text(body.title, 'Ad title', 2, 60);
  const image = String(body.image_url || '').trim() ? cleanUrl(body.image_url, 'Image link') : '';
  const link = cleanUrl(body.link_url, 'Ad link');
  const r = await db.run('INSERT INTO ads (advertiser, title, image_url, link_url, created_at) VALUES (?, ?, ?, ?, ?)',
    [advertiser, title, image, link, now()]);
  return { id: r.lastId };
});
route('POST', '/api/master/ads/:id/status', 'master', async ({ params, body }) => {
  const status = body.status === 'active' ? 'active' : 'paused';
  const r = await db.run('UPDATE ads SET status = ? WHERE id = ?', [status, Number(params.id)]);
  if (!r.changes) throw new HttpError(404, 'Ad not found');
  return { ok: true };
});
route('DELETE', '/api/master/ads/:id', 'master', async ({ params }) => {
  const r = await db.run('DELETE FROM ads WHERE id = ?', [Number(params.id)]);
  if (!r.changes) throw new HttpError(404, 'Ad not found');
  return { ok: true };
});

/* ------------------------------------------------------------- static files */
const MIME = {
  '.html': 'text/html; charset=utf-8', '.css': 'text/css; charset=utf-8', '.js': 'text/javascript; charset=utf-8',
  '.png': 'image/png', '.ico': 'image/x-icon', '.svg': 'image/svg+xml', '.txt': 'text/plain; charset=utf-8',
};
function serveStatic(req, res, pathname) {
  let rel = decodeURIComponent(pathname);
  if (rel === '/' || rel === '') rel = '/index.html';
  const file = path.normalize(path.join(PUBLIC_DIR, rel));
  if (!file.startsWith(PUBLIC_DIR + path.sep) || !fs.existsSync(file) || !fs.statSync(file).isFile()) {
    res.writeHead(404, { 'Content-Type': 'text/plain; charset=utf-8', ...securityHeaders() });
    return res.end('404 - page not found');
  }
  const ext = path.extname(file).toLowerCase();
  res.writeHead(200, {
    'Content-Type': MIME[ext] || 'application/octet-stream',
    'Cache-Control': ext === '.html' ? 'no-cache' : 'public, max-age=300',
    ...securityHeaders(),
  });
  if (req.method === 'HEAD') return res.end();
  fs.createReadStream(file).pipe(res);
}

/* ------------------------------------------------------------------ server */
const server = http.createServer(async (req, res) => {
  try {
    const url = new URL(req.url, 'http://localhost');
    const isApi = url.pathname.startsWith('/api/') || url.pathname.startsWith('/go/') || url.pathname.startsWith('/ad/');
    if (!isApi) {
      if (req.method !== 'GET' && req.method !== 'HEAD') throw new HttpError(405, 'Method not allowed');
      return serveStatic(req, res, url.pathname);
    }
    const method = req.method === 'HEAD' ? 'GET' : req.method;
    let matched = null; let params = {};
    for (const r of routes) {
      if (r.method !== method) continue;
      const m = r.rx.exec(url.pathname);
      if (m) { matched = r; r.keys.forEach((k, i) => { params[k] = decodeURIComponent(m[i + 1]); }); break; }
    }
    if (!matched) throw new HttpError(404, 'Not found');
    if (method !== 'GET' && req.headers['x-requested-with'] !== 'OpenStore') throw new HttpError(403, 'Bad request origin');
    const user = await currentUser(req);
    if (matched.auth) {
      if (!user) throw new HttpError(401, 'Please log in');
      if (matched.auth === 'master' && user.role !== 'master') throw new HttpError(403, 'Master admin only');
    }
    const body = method === 'GET' ? {} : await readBody(req);
    const out = await matched.handler({ req, res, params, query: url.searchParams, body, user });
    if (out && out.__redirect) {
      const headers = { Location: out.__redirect, 'Cache-Control': 'no-store', ...securityHeaders() };
      if (res._cookies) headers['Set-Cookie'] = res._cookies;
      res.writeHead(302, headers);
      return res.end();
    }
    sendJson(res, 200, out);
  } catch (e) {
    if (!(e instanceof HttpError)) console.error(e);
    const status = e instanceof HttpError ? e.status : 500;
    const message = e instanceof HttpError ? e.message : 'Server error';
    if (req.url.startsWith('/go/') || req.url.startsWith('/ad/')) {
      res.writeHead(status, { 'Content-Type': 'text/plain; charset=utf-8', ...securityHeaders() });
      return res.end(message);
    }
    sendJson(res, status, { error: message });
  }
});

/* ---------------------------------------------------------- master account */
async function seedMaster() {
  const envUser = process.env.MASTER_USER ? cleanUsername(process.env.MASTER_USER) : null;
  const envPass = process.env.MASTER_PASS || null;
  if (envPass && envPass.length < 8) { console.error('MASTER_PASS must be at least 8 characters'); process.exit(1); }
  const m = await db.get("SELECT * FROM admins WHERE role = 'master'");
  if (!m) {
    const username = envUser || 'master';
    const generated = !envPass;
    const pass = envPass || crypto.randomBytes(9).toString('base64url');
    await db.run(`INSERT INTO admins (username, display_name, password_hash, role, created_at) VALUES (?, 'Open Store', ?, 'master', ?)`,
      [username, hashPassword(pass), now()]);
    console.log('Master account created.');
    if (generated) {
      console.log('  No MASTER_PASS set, so a random one was made. Save it, then set MASTER_PASS in your host settings:');
      console.log(`  username: ${username}\n  password: ${pass}`);
    }
  } else if (envPass && (!verifyPassword(envPass, m.password_hash) || (envUser && envUser !== m.username))) {
    // MASTER_PASS / MASTER_USER changed in the host settings: apply them and log the master out
    await db.batch([
      ['UPDATE admins SET password_hash = ?, username = ? WHERE id = ?', [hashPassword(envPass), envUser || m.username, m.id]],
      ['DELETE FROM sessions WHERE admin_id = ?', [m.id]],
    ]);
    console.log('Master login updated from environment settings.');
  }
}

async function start() {
  if (TURSO_URL) {
    db = await openTurso(TURSO_URL, TURSO_TOKEN);
    console.log('Database: Turso (online, data survives redeploys)');
  } else {
    db = openLocal(DB_PATH);
    console.log(`Database: local file ${DB_PATH}`);
    if (process.env.RENDER) {
      console.warn('WARNING: running on Render with a local file. Data is wiped on every redeploy/restart.');
      console.warn('         Set TURSO_DATABASE_URL and TURSO_AUTH_TOKEN in the Environment settings.');
    }
  }
  await db.exec(SCHEMA);
  await seedMaster();
  setInterval(() => {
    for (const [k, v] of attempts) if (v.reset < now()) attempts.delete(k);
    db.run('DELETE FROM sessions WHERE expires_at < ?', [now()]).catch(() => {});
  }, 10 * 60 * 1000).unref();
  server.listen(PORT, '0.0.0.0', () => console.log(`Open Store running on port ${PORT}`));
}

start().catch((e) => {
  console.error('Could not start Open Store:', e && e.message ? e.message : e);
  process.exit(1);
});
