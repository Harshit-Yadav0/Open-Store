'use strict';
/*
 * OPEN STORE server
 * Zero dependencies. Needs Node.js 22.5 or newer (built-in SQLite + crypto).
 *
 * Env vars:
 *   PORT          port to listen on (hosts like pxxl.app set this for you)
 *   MASTER_USER   master admin username   (default: master)
 *   MASTER_PASS   master admin password   (set this! min 8 chars)
 *   DB_PATH       sqlite file location     (default: ./data/openstore.db)
 */
const http = require('http');
const fs = require('fs');
const path = require('path');
const crypto = require('crypto');
const { DatabaseSync } = require('node:sqlite');

const PORT = Number(process.env.PORT) || 3000;
const DB_PATH = process.env.DB_PATH || path.join(__dirname, 'data', 'openstore.db');
const PUBLIC_DIR = path.join(__dirname, 'public');
const CATEGORIES = ['Games', 'Tools', 'Social', 'Music', 'Photo', 'Education', 'Productivity', 'Other'];
const MAX_STRIKES = 3;
const SESSION_MS = 7 * 24 * 60 * 60 * 1000;

/* ---------------------------------------------------------------- database */
fs.mkdirSync(path.dirname(DB_PATH), { recursive: true });
const db = new DatabaseSync(DB_PATH);
db.exec(`
  PRAGMA journal_mode = WAL;
  PRAGMA foreign_keys = ON;
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
    admin_id INTEGER NOT NULL REFERENCES admins(id) ON DELETE CASCADE,
    expires_at INTEGER NOT NULL
  );
  CREATE TABLE IF NOT EXISTS apps (
    id INTEGER PRIMARY KEY AUTOINCREMENT,
    admin_id INTEGER NOT NULL REFERENCES admins(id) ON DELETE CASCADE,
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
    app_id INTEGER NOT NULL REFERENCES apps(id) ON DELETE CASCADE,
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
`);

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
function currentUser(req) {
  const tok = parseCookies(req).os_sid;
  if (!tok) return null;
  const row = db.prepare(`
    SELECT a.id, a.username, a.display_name, a.role, a.status, a.strikes, s.expires_at
    FROM sessions s JOIN admins a ON a.id = s.admin_id WHERE s.token_hash = ?`).get(sha(tok));
  if (!row) return null;
  if (row.expires_at < now() || row.status !== 'active') {
    db.prepare('DELETE FROM sessions WHERE token_hash = ?').run(sha(tok));
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
setInterval(() => {
  for (const [k, v] of attempts) if (v.reset < now()) attempts.delete(k);
  db.prepare('DELETE FROM sessions WHERE expires_at < ?').run(now());
}, 10 * 60 * 1000).unref();

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

/* ------------------------------------------------------------------ routes */
const routes = [];
function route(method, pattern, auth, handler) {
  const keys = [];
  const rx = new RegExp('^' + pattern.replace(/:(\w+)/g, (_, k) => { keys.push(k); return '([^/]+)'; }) + '$');
  routes.push({ method, rx, keys, auth, handler });
}

/* ---- public */
route('GET', '/api/categories', null, () => ({ categories: CATEGORIES }));

route('POST', '/api/visit', null, ({ req, res }) => {
  const vid = getVid(req, res);
  const t = now();
  const row = db.prepare('SELECT vid FROM visitors WHERE vid = ?').get(vid);
  if (row) db.prepare('UPDATE visitors SET visits = visits + 1, last_seen = ? WHERE vid = ?').run(t, vid);
  else db.prepare('INSERT INTO visitors (vid, first_seen, last_seen) VALUES (?, ?, ?)').run(vid, t, t);
  return publicStats();
});
function publicStats() {
  const v = db.prepare('SELECT COUNT(*) AS unique_visitors, COALESCE(SUM(visits),0) AS visits FROM visitors').get();
  const a = db.prepare(`SELECT COUNT(*) AS n FROM apps a JOIN admins ad ON ad.id = a.admin_id WHERE ${PUBLIC_WHERE}`).get();
  const i = db.prepare('SELECT COUNT(*) AS n FROM installs').get();
  return { visits: v.visits, visitors: v.unique_visitors, apps: a.n, installs: i.n };
}
route('GET', '/api/stats', null, () => publicStats());

route('GET', '/api/apps', null, ({ query }) => {
  const where = [PUBLIC_WHERE]; const params = [];
  const q = String(query.get('q') || '').trim().slice(0, 60);
  if (q) {
    const like = '%' + q.replace(/[\\%_]/g, (c) => '\\' + c) + '%';
    where.push(`(a.name LIKE ? ESCAPE '\\' OR a.tagline LIKE ? ESCAPE '\\' OR ad.display_name LIKE ? ESCAPE '\\')`);
    params.push(like, like, like);
  }
  const cat = String(query.get('category') || '');
  if (cat && CATEGORIES.includes(cat)) { where.push('a.category = ?'); params.push(cat); }
  const order = query.get('sort') === 'new' ? 'a.created_at DESC' : 'installs DESC, a.created_at DESC';
  const rows = db.prepare(`${APP_SELECT} WHERE ${where.join(' AND ')} ORDER BY ${order} LIMIT 200`).all(...params);
  return { apps: rows.map((r) => publicApp(r, false)) };
});

route('GET', '/api/apps/:id', null, ({ params }) => {
  const r = db.prepare(`${APP_SELECT} WHERE a.id = ? AND ${PUBLIC_WHERE}`).get(Number(params.id));
  if (!r) throw new HttpError(404, 'App not found');
  return { app: publicApp(r, true) };
});

/* install click: count it, then send the visitor to the app file link */
route('GET', '/go/:id', null, ({ req, res, params }) => {
  const r = db.prepare(`${APP_SELECT} WHERE a.id = ? AND ${PUBLIC_WHERE}`).get(Number(params.id));
  if (!r) throw new HttpError(404, 'App not available');
  const vid = getVid(req, res);
  db.prepare('INSERT INTO installs (app_id, vid, created_at) VALUES (?, ?, ?)').run(r.id, vid, now());
  return { __redirect: cleanUrl(r.file_url, 'App file link') };
});

/* ---- ads (side billboards) */
route('GET', '/api/ads', null, () => ({
  ads: db.prepare("SELECT id, advertiser, title, image_url FROM ads WHERE status = 'active' ORDER BY RANDOM() LIMIT 6").all(),
}));
route('POST', '/api/ads/seen', null, ({ body }) => {
  const ids = Array.isArray(body.ids) ? body.ids.slice(0, 6).map(Number).filter(Number.isInteger) : [];
  const st = db.prepare("UPDATE ads SET impressions = impressions + 1 WHERE id = ? AND status = 'active'");
  for (const id of ids) st.run(id);
  return { ok: true };
});
route('GET', '/ad/:id', null, ({ params }) => {
  const a = db.prepare("SELECT * FROM ads WHERE id = ? AND status = 'active'").get(Number(params.id));
  if (!a) throw new HttpError(404, 'Ad not available');
  db.prepare('UPDATE ads SET clicks = clicks + 1 WHERE id = ?').run(a.id);
  return { __redirect: cleanUrl(a.link_url, 'Ad link') };
});

/* ---- login */
route('POST', '/api/login', null, async ({ req, res, body }) => {
  const username = String(body.username || '').trim().toLowerCase().slice(0, 40);
  const password = String(body.password || '').slice(0, 200);
  const ipKey = 'ip:' + clientIp(req); const userKey = 'u:' + username;
  if (tooManyAttempts(ipKey) || tooManyAttempts(userKey)) throw new HttpError(429, 'Too many tries. Wait 15 minutes.');
  const admin = db.prepare('SELECT * FROM admins WHERE username = ?').get(username);
  const ok = verifyPassword(password, admin ? admin.password_hash : DUMMY_HASH) && admin;
  if (!ok) { noteFailure(ipKey); noteFailure(userKey); throw new HttpError(401, 'Wrong username or password'); }
  if (admin.status !== 'active') throw new HttpError(403, `This studio is banned. Reason: ${admin.ban_reason || 'not given'}`);
  const token = crypto.randomBytes(32).toString('hex');
  db.prepare('INSERT INTO sessions (token_hash, admin_id, expires_at) VALUES (?, ?, ?)').run(sha(token), admin.id, now() + SESSION_MS);
  setCookie(req, res, 'os_sid', token, { maxAge: SESSION_MS });
  return { user: { id: admin.id, username: admin.username, display_name: admin.display_name, role: admin.role, strikes: admin.strikes } };
});
route('POST', '/api/logout', null, ({ req, res }) => {
  const tok = parseCookies(req).os_sid;
  if (tok) db.prepare('DELETE FROM sessions WHERE token_hash = ?').run(sha(tok));
  setCookie(req, res, 'os_sid', '', { maxAge: 0 });
  return { ok: true };
});
route('GET', '/api/me', null, ({ user }) => ({
  user: user ? { id: user.id, username: user.username, display_name: user.display_name, role: user.role, strikes: user.strikes } : null,
}));

/* ---- studio (admin or master) */
route('POST', '/api/me/password', 'admin', ({ user, body }) => {
  const row = db.prepare('SELECT password_hash FROM admins WHERE id = ?').get(user.id);
  if (!verifyPassword(String(body.current || ''), row.password_hash)) throw new HttpError(400, 'Current password is wrong');
  db.prepare('UPDATE admins SET password_hash = ? WHERE id = ?').run(hashPassword(cleanPassword(body.next)), user.id);
  return { ok: true };
});

route('GET', '/api/my/apps', 'admin', ({ user }) => {
  const rows = db.prepare(`${APP_SELECT} WHERE a.admin_id = ? ORDER BY a.created_at DESC`).all(user.id);
  return { apps: rows };
});
route('POST', '/api/my/apps', 'admin', ({ user, body }) => {
  const f = appFields(body); const t = now();
  const r = db.prepare(`INSERT INTO apps (admin_id, name, tagline, description, category, version, icon, file_url, created_at, updated_at)
    VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?)`).run(user.id, f.name, f.tagline, f.description, f.category, f.version, f.icon, f.file_url, t, t);
  return { id: Number(r.lastInsertRowid) };
});
route('PUT', '/api/my/apps/:id', 'admin', ({ user, params, body }) => {
  const a = db.prepare('SELECT * FROM apps WHERE id = ?').get(Number(params.id));
  ownerOrMaster(user, a);
  const f = appFields(body);
  db.prepare(`UPDATE apps SET name=?, tagline=?, description=?, category=?, version=?, icon=?, file_url=?, updated_at=? WHERE id=?`)
    .run(f.name, f.tagline, f.description, f.category, f.version, f.icon, f.file_url, now(), a.id);
  return { ok: true };
});
route('DELETE', '/api/my/apps/:id', 'admin', ({ user, params }) => {
  const a = db.prepare('SELECT * FROM apps WHERE id = ?').get(Number(params.id));
  ownerOrMaster(user, a);
  db.prepare('DELETE FROM apps WHERE id = ?').run(a.id);
  return { ok: true };
});

/* ---- master only */
route('GET', '/api/master/overview', 'master', () => {
  const one = (sql) => db.prepare(sql).get().n;
  return {
    ...publicStats(),
    all_apps: one('SELECT COUNT(*) AS n FROM apps'),
    taken_down: one("SELECT COUNT(*) AS n FROM apps WHERE status <> 'live'"),
    studios: one("SELECT COUNT(*) AS n FROM admins WHERE role = 'admin'"),
    banned: one("SELECT COUNT(*) AS n FROM admins WHERE status = 'banned'"),
    active_strikes: one('SELECT COUNT(*) AS n FROM strikes WHERE revoked = 0'),
  };
});

route('GET', '/api/master/admins', 'master', () => {
  const rows = db.prepare(`
    SELECT a.id, a.username, a.display_name, a.role, a.status, a.ban_reason, a.strikes, a.created_at,
      (SELECT COUNT(*) FROM apps p WHERE p.admin_id = a.id) AS apps,
      (SELECT COUNT(*) FROM installs i JOIN apps p ON p.id = i.app_id WHERE p.admin_id = a.id) AS installs
    FROM admins a ORDER BY a.role DESC, a.created_at DESC`).all();
  return { admins: rows };
});
route('POST', '/api/master/admins', 'master', ({ body }) => {
  const username = cleanUsername(body.username);
  const display = text(body.display_name, 'Studio name', 2, 40);
  const hash = hashPassword(cleanPassword(body.password));
  if (db.prepare('SELECT id FROM admins WHERE username = ?').get(username)) throw new HttpError(409, 'Username already taken');
  const r = db.prepare(`INSERT INTO admins (username, display_name, password_hash, role, created_at) VALUES (?, ?, ?, 'admin', ?)`)
    .run(username, display, hash, now());
  return { id: Number(r.lastInsertRowid) };
});
function targetAdmin(id) {
  const a = db.prepare('SELECT * FROM admins WHERE id = ?').get(Number(id));
  if (!a) throw new HttpError(404, 'Studio not found');
  if (a.role === 'master') throw new HttpError(400, 'That is the master account');
  return a;
}
function banAdmin(id, reason) {
  db.prepare("UPDATE admins SET status = 'banned', ban_reason = ? WHERE id = ?").run(reason, id);
  db.prepare('DELETE FROM sessions WHERE admin_id = ?').run(id);
}
route('POST', '/api/master/admins/:id/ban', 'master', ({ params, body }) => {
  const a = targetAdmin(params.id);
  banAdmin(a.id, text(body.reason, 'Reason', 3, 300));
  return { ok: true };
});
route('POST', '/api/master/admins/:id/unban', 'master', ({ params }) => {
  const a = targetAdmin(params.id);
  db.prepare("UPDATE admins SET status = 'active', ban_reason = NULL WHERE id = ?").run(a.id);
  return { ok: true };
});
route('POST', '/api/master/admins/:id/password', 'master', ({ params, body }) => {
  const a = targetAdmin(params.id);
  db.prepare('UPDATE admins SET password_hash = ? WHERE id = ?').run(hashPassword(cleanPassword(body.password)), a.id);
  db.prepare('DELETE FROM sessions WHERE admin_id = ?').run(a.id);
  return { ok: true };
});
route('DELETE', '/api/master/admins/:id', 'master', ({ params }) => {
  const a = targetAdmin(params.id);
  db.prepare('DELETE FROM admins WHERE id = ?').run(a.id);
  return { ok: true };
});

route('GET', '/api/master/apps', 'master', () => ({
  apps: db.prepare(`${APP_SELECT} ORDER BY a.created_at DESC`).all(),
}));
route('POST', '/api/master/apps', 'master', ({ user, body }) => {
  const owner = body.admin_id ? Number(body.admin_id) : user.id;
  const adm = db.prepare('SELECT id, status FROM admins WHERE id = ?').get(owner);
  if (!adm) throw new HttpError(404, 'Studio not found');
  const f = appFields(body); const t = now();
  const r = db.prepare(`INSERT INTO apps (admin_id, name, tagline, description, category, version, icon, file_url, created_at, updated_at)
    VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?)`).run(owner, f.name, f.tagline, f.description, f.category, f.version, f.icon, f.file_url, t, t);
  return { id: Number(r.lastInsertRowid) };
});
route('POST', '/api/master/apps/:id/status', 'master', ({ params, body }) => {
  const status = body.status === 'live' ? 'live' : 'taken_down';
  const r = db.prepare('UPDATE apps SET status = ?, updated_at = ? WHERE id = ?').run(status, now(), Number(params.id));
  if (!r.changes) throw new HttpError(404, 'App not found');
  return { ok: true };
});
route('POST', '/api/master/apps/:id/strike', 'master', ({ params, body }) => {
  const a = db.prepare(`SELECT a.*, ad.display_name AS studio, ad.role AS role FROM apps a JOIN admins ad ON ad.id = a.admin_id WHERE a.id = ?`).get(Number(params.id));
  if (!a) throw new HttpError(404, 'App not found');
  const reason = text(body.reason, 'Copyright reason', 3, 300);
  const takedown = body.takedown !== false;
  let autoBanned = false;
  db.exec('BEGIN');
  try {
    db.prepare('INSERT INTO strikes (app_id, app_name, admin_id, admin_name, reason, created_at) VALUES (?, ?, ?, ?, ?, ?)')
      .run(a.id, a.name, a.admin_id, a.studio, reason, now());
    db.prepare('UPDATE apps SET strikes = strikes + 1, status = CASE WHEN ? THEN \'taken_down\' ELSE status END, updated_at = ? WHERE id = ?')
      .run(takedown ? 1 : 0, now(), a.id);
    db.prepare('UPDATE admins SET strikes = strikes + 1 WHERE id = ?').run(a.admin_id);
    const adm = db.prepare('SELECT strikes, status FROM admins WHERE id = ?').get(a.admin_id);
    if (a.role !== 'master' && adm.strikes >= MAX_STRIKES && adm.status === 'active') {
      banAdmin(a.admin_id, `Auto-ban: ${MAX_STRIKES} copyright strikes`);
      autoBanned = true;
    }
    db.exec('COMMIT');
  } catch (e) { db.exec('ROLLBACK'); throw e; }
  return { ok: true, auto_banned: autoBanned };
});
route('GET', '/api/master/strikes', 'master', () => ({
  strikes: db.prepare('SELECT * FROM strikes ORDER BY created_at DESC LIMIT 300').all(),
}));
route('POST', '/api/master/strikes/:id/revoke', 'master', ({ params }) => {
  const s = db.prepare('SELECT * FROM strikes WHERE id = ?').get(Number(params.id));
  if (!s) throw new HttpError(404, 'Strike not found');
  if (s.revoked) throw new HttpError(400, 'Already revoked');
  db.prepare('UPDATE strikes SET revoked = 1 WHERE id = ?').run(s.id);
  db.prepare('UPDATE apps SET strikes = MAX(strikes - 1, 0) WHERE id = ?').run(s.app_id);
  db.prepare('UPDATE admins SET strikes = MAX(strikes - 1, 0) WHERE id = ?').run(s.admin_id);
  return { ok: true };
});

route('GET', '/api/master/ads', 'master', () => ({
  ads: db.prepare('SELECT * FROM ads ORDER BY created_at DESC').all(),
}));
route('POST', '/api/master/ads', 'master', ({ body }) => {
  const advertiser = text(body.advertiser, 'Advertiser', 2, 40);
  const title = text(body.title, 'Ad title', 2, 60);
  const image = String(body.image_url || '').trim() ? cleanUrl(body.image_url, 'Image link') : '';
  const link = cleanUrl(body.link_url, 'Ad link');
  const r = db.prepare('INSERT INTO ads (advertiser, title, image_url, link_url, created_at) VALUES (?, ?, ?, ?, ?)')
    .run(advertiser, title, image, link, now());
  return { id: Number(r.lastInsertRowid) };
});
route('POST', '/api/master/ads/:id/status', 'master', ({ params, body }) => {
  const status = body.status === 'active' ? 'active' : 'paused';
  const r = db.prepare('UPDATE ads SET status = ? WHERE id = ?').run(status, Number(params.id));
  if (!r.changes) throw new HttpError(404, 'Ad not found');
  return { ok: true };
});
route('DELETE', '/api/master/ads/:id', 'master', ({ params }) => {
  const r = db.prepare('DELETE FROM ads WHERE id = ?').run(Number(params.id));
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
    const user = currentUser(req);
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
(function seedMaster() {
  const envUser = process.env.MASTER_USER ? cleanUsername(process.env.MASTER_USER) : null;
  const envPass = process.env.MASTER_PASS || null;
  if (envPass && envPass.length < 8) { console.error('MASTER_PASS must be at least 8 characters'); process.exit(1); }
  const m = db.prepare("SELECT * FROM admins WHERE role = 'master'").get();
  if (!m) {
    const username = envUser || 'master';
    const generated = !envPass;
    const pass = envPass || crypto.randomBytes(9).toString('base64url');
    db.prepare(`INSERT INTO admins (username, display_name, password_hash, role, created_at) VALUES (?, 'Open Store', ?, 'master', ?)`)
      .run(username, hashPassword(pass), now());
    console.log('Master account created.');
    if (generated) {
      console.log('  No MASTER_PASS set, so a random one was made. Save it, then set MASTER_PASS in your host settings:');
      console.log(`  username: ${username}\n  password: ${pass}`);
    }
  } else if (envPass && (!verifyPassword(envPass, m.password_hash) || (envUser && envUser !== m.username))) {
    // MASTER_PASS / MASTER_USER changed in the host settings: apply them and log the master out
    db.prepare('UPDATE admins SET password_hash = ?, username = ? WHERE id = ?').run(hashPassword(envPass), envUser || m.username, m.id);
    db.prepare('DELETE FROM sessions WHERE admin_id = ?').run(m.id);
    console.log('Master login updated from environment settings.');
  }
})();

server.listen(PORT, '0.0.0.0', () => console.log(`Open Store running on port ${PORT}`));
