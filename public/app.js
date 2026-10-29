'use strict';
/* OPEN STORE front end. No libraries, no inline handlers (the server CSP blocks them). */

const $ = (s, r = document) => r.querySelector(s);
const root = $('#root');
const esc = (s) => String(s ?? '').replace(/[&<>"']/g, (c) => ({ '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;', "'": '&#39;' }[c]));
const num = (n) => Number(n || 0).toLocaleString('en-IN');
const day = (t) => new Date(t).toLocaleDateString('en-GB', { day: '2-digit', month: 'short', year: 'numeric' });

const state = {
  user: null,
  stats: { visits: 0, visitors: 0, apps: 0, installs: 0 },
  categories: [],
  edit: null,          // app being edited in a form
  masterTab: 'overview',
  cache: { apps: [], admins: [] },
};

async function api(method, url, body) {
  const opt = { method, credentials: 'same-origin', headers: { 'X-Requested-With': 'OpenStore' } };
  if (body !== undefined) { opt.headers['Content-Type'] = 'application/json'; opt.body = JSON.stringify(body); }
  const r = await fetch(url, opt);
  let data = null;
  try { data = await r.json(); } catch { /* not json */ }
  if (!r.ok) throw new Error((data && data.error) || `Error ${r.status}`);
  return data;
}

/* ------------------------------------------------------------ small pieces */
function iconHtml(icon) {
  if (/^https?:\/\//i.test(icon || '')) return `<img class="icon" src="${esc(icon)}" alt="" loading="lazy" referrerpolicy="no-referrer">`;
  return `<span class="icon" aria-hidden="true">${esc(icon || '📦')}</span>`;
}
function win(title, inner) {
  return `<section class="win"><div class="title"><span>${esc(title)}</span></div><div class="body">${inner}</div></section>`;
}
function setMsg(id, text, kind = 'err') {
  const el = document.getElementById(id);
  if (el) el.innerHTML = text ? `<div class="${kind}">${esc(text)}</div>` : '';
}
function counterHtml(n) {
  return `<span class="counter">${String(n).padStart(6, '0').split('').map((d) => `<i>${d}</i>`).join('')}</span>`;
}

function shell(inner, route) {
  const u = state.user;
  const links = [`<a href="#/" class="${route === 'home' ? 'on' : ''}">Home</a>`];
  if (u) {
    links.push(`<a href="#/studio" class="${route === 'studio' ? 'on' : ''}">My Studio</a>`);
    if (u.role === 'master') links.push(`<a href="#/master" class="${route === 'master' ? 'on' : ''}">Master Panel</a>`);
    links.push(`<a href="#/logout" data-act="logout">Logout (${esc(u.username)})</a>`);
  } else {
    links.push(`<a href="#/login" class="${route === 'login' ? 'on' : ''}">Studio Login</a>`);
  }
  return `
  <div class="topbar"><span class="status"><i class="dot"></i>System online</span><span>${num(state.stats.apps)} apps</span><span class="hide-sm">${num(state.stats.installs)} installs logged</span></div>
  <header class="brand">
    <a href="#/" class="mark" aria-label="Open Store home"><span class="ring"></span><span class="word">Open<b>Store</b></span></a>
    <nav class="nav" aria-label="Main">${links.join('')}</nav>
  </header>
  <main>${inner}</main>
  <footer class="footer">
    <div><p>Apps are made and hosted by independent studios. Found something that is yours? The master admin removes it.</p><p>&copy; 2026 Open Store</p></div>
    <div>Visits${counterHtml(state.stats.visits)}</div>
  </footer>`;
}
function draw(inner, route) { root.innerHTML = shell(inner, route); window.scrollTo(0, 0); }

/* -------------------------------------------------------------------- home */
function appCard(a) {
  return `<article class="card">
    <div class="head">${iconHtml(a.icon)}
      <div class="meta">
        <h3><a href="#/app/${a.id}">${esc(a.name)}</a></h3>
        <div class="studio">by ${esc(a.studio)} &middot; v${esc(a.version)}</div>
        <span class="pill gray">${esc(a.category)}</span>${a.copyright_notice ? ' <span class="pill red">COPYRIGHT NOTICE</span>' : ''}
      </div>
    </div>
    <div class="tag">${esc(a.tagline)}</div>
    <div class="foot"><span class="studio">${num(a.installs)} installs</span>
      <span><a class="btn small" href="#/app/${a.id}">Info</a> <a class="btn small install" href="/go/${a.id}">INSTALL</a></span></div>
  </article>`;
}

async function viewHome() {
  const cats = state.categories.map((c) => `<option>${esc(c)}</option>`).join('');
  const s = state.stats;
  draw(`<section class="hero">
      <p class="eyebrow">Independent studios // open distribution</p>
      <h2>Find an app. <em>Install it in one tap.</em></h2>
      <p class="lede">Every app on Open Store comes straight from the studio that built it. No middle layer, no account needed.</p>
      <div class="readouts">
        <div class="readout"><b>${num(s.apps)}</b><span>apps live</span></div>
        <div class="readout"><b>${num(s.installs)}</b><span>installs</span></div>
        <div class="readout"><b>${num(s.visitors)}</b><span>visitors</span></div>
      </div>
    </section>` + win('Find Apps', `
    <form id="search" class="searchbar" data-form="search" role="search">
      <input type="search" id="q" name="q" placeholder="Search apps or studios..." aria-label="Search">
      <select id="cat" name="category" aria-label="Category"><option value="">All categories</option>${cats}</select>
      <select id="sort" name="sort" aria-label="Sort"><option value="top">Most installed</option><option value="new">Newest</option></select>
      <button type="submit">Go!</button>
    </form>`) + `<div id="results"></div>`, 'home');
  await loadApps();
}
async function loadApps() {
  const form = $('#search'); if (!form) return;
  const p = new URLSearchParams(new FormData(form));
  const box = $('#results'); box.innerHTML = win('Loading', '<div class="empty">Please wait... <span class="blink">loading</span></div>');
  try {
    const { apps } = await api('GET', '/api/apps?' + p);
    box.innerHTML = apps.length
      ? win(`${apps.length} app${apps.length === 1 ? '' : 's'} found`, `<div class="grid">${apps.map(appCard).join('')}</div>`)
      : win('No results', '<div class="empty">Nothing here yet. Try another search!</div>');
  } catch (e) { box.innerHTML = win('Oops', `<div class="err">${esc(e.message)}</div>`); }
}

/* ------------------------------------------------------------------ detail */
async function viewApp(id) {
  try {
    const { app: a } = await api('GET', `/api/apps/${encodeURIComponent(id)}`);
    document.title = `${a.name} - Open Store`;
    draw(win(a.name, `
      <div class="detail-head">${iconHtml(a.icon)}
        <div>
          <h2>${esc(a.name)}</h2>
          <div class="studio">by <b>${esc(a.studio)}</b> &middot; version ${esc(a.version)} &middot; updated ${day(a.updated_at)}</div>
          <div class="stats-row"><span class="pill gray">${esc(a.category)}</span><span class="pill green">${num(a.installs)} installs</span><span class="pill">${num(a.users)} users</span>${a.copyright_notice ? '<span class="pill red">COPYRIGHT NOTICE</span>' : ''}</div>
          <p>${esc(a.tagline)}</p>
          <a class="btn install" href="/go/${a.id}">INSTALL NOW</a>
          <a class="btn" href="#/">Back</a>
        </div>
      </div>
      ${a.copyright_notice ? '<div class="notice">This app received a copyright notice. The master admin is looking into it.</div>' : ''}
      <div class="detail-desc">${esc(a.description || 'No description yet.')}</div>
      <p class="studio">Install sends you to the studio's download link. Only install files from studios you trust.</p>`), 'home');
  } catch (e) { draw(win('Not found', `<div class="err">${esc(e.message)}</div><a class="btn" href="#/">Back to home</a>`), 'home'); }
}

/* ------------------------------------------------------------------- login */
function viewLogin() {
  if (state.user) { location.hash = '#/studio'; return; }
  draw(win('Studio Login', `
    <p>Studios and the master admin log in here. Studio accounts are created by the master admin.</p>
    <form id="login" data-form="login" autocomplete="on">
      <label for="u">Username</label><input type="text" id="u" name="username" autocomplete="username" required>
      <label for="p">Password</label><input type="password" id="p" name="password" autocomplete="current-password" required>
      <div id="msg"></div>
      <p><button type="submit">Log in</button></p>
    </form>`), 'login');
}

/* ------------------------------------------------------------- app form */
function appFormHtml({ app, studios }) {
  const a = app || {};
  const cats = state.categories.map((c) => `<option ${a.category === c ? 'selected' : ''}>${esc(c)}</option>`).join('');
  const studioPick = !app && studios
    ? `<label for="f_admin">Studio</label><select id="f_admin" name="admin_id">${studios.map((s) => `<option value="${s.id}">${esc(s.display_name)} (${esc(s.username)})${s.status === 'banned' ? ' - BANNED' : ''}</option>`).join('')}</select>`
    : '';
  return `<form id="appform" data-form="app" data-id="${a.id || ''}">
    ${studioPick}
    <div class="row">
      <div><label for="f_name">App name</label><input type="text" id="f_name" name="name" maxlength="60" required value="${esc(a.name)}"></div>
      <div><label for="f_ver">Version</label><input type="text" id="f_ver" name="version" maxlength="20" value="${esc(a.version || '1.0')}"></div>
    </div>
    <label for="f_tag">Tagline (short line under the name)</label><input type="text" id="f_tag" name="tagline" maxlength="100" value="${esc(a.tagline)}">
    <label for="f_desc">Description</label><textarea id="f_desc" name="description" maxlength="2000">${esc(a.description)}</textarea>
    <div class="row">
      <div><label for="f_cat">Category</label><select id="f_cat" name="category">${cats}</select></div>
      <div><label for="f_icon">Icon (an emoji, or a link to an image)</label><input type="text" id="f_icon" name="icon" maxlength="500" placeholder="🎮 or https://..." value="${esc(a.icon)}"></div>
    </div>
    <label for="f_url">App file link (Install sends people here)</label>
    <input type="url" id="f_url" name="file_url" maxlength="1000" required placeholder="https://example.com/my-app.apk" value="${esc(a.file_url)}">
    <div id="appmsg"></div>
    <p><button type="submit">${app ? 'Save changes' : 'Add app'}</button>
    ${app ? '<button type="button" data-act="cancel-edit">Cancel</button>' : ''}</p>
  </form>`;
}

function statusPill(a) {
  if (a.studio_status === 'banned') return '<span class="pill red">STUDIO BANNED</span>';
  if (a.status === 'live') return '<span class="pill green">LIVE</span>';
  return '<span class="pill red">TAKEN DOWN</span>';
}

/* ------------------------------------------------------------------ studio */
async function viewStudio() {
  if (!state.user) { location.hash = '#/login'; return; }
  try {
    const { apps } = await api('GET', '/api/my/apps');
    state.cache.apps = apps;
    const u = state.user;
    const total = apps.reduce((n, a) => n + a.installs, 0);
    const rows = apps.map((a) => `<tr>
      <td>${esc(a.name)}<br><span class="studio">v${esc(a.version)} &middot; ${esc(a.category)}</span></td>
      <td>${statusPill(a)}${a.strikes ? ` <span class="pill red">${a.strikes} strike${a.strikes > 1 ? 's' : ''}</span>` : ''}</td>
      <td class="num">${num(a.installs)}</td><td class="num">${num(a.users)}</td>
      <td><div class="acts"><a class="btn small" href="#/app/${a.id}">View</a>
        <button class="small" data-act="edit" data-id="${a.id}">Edit</button>
        <button class="small danger" data-act="del-app" data-id="${a.id}">Delete</button></div></td></tr>`).join('');
    draw(
      win(`Welcome, ${u.display_name}`, `
        <div class="bigstats">
          <div class="bigstat"><b>${num(apps.length)}</b><span>your apps</span></div>
          <div class="bigstat"><b>${num(total)}</b><span>total installs</span></div>
          <div class="bigstat"><b>${num(u.strikes)}/3</b><span>copyright strikes</span></div>
        </div>
        ${u.strikes ? '<div class="notice">You have copyright strikes. At 3 strikes your studio is banned automatically.</div>' : ''}`) +
      win(state.edit ? `Edit: ${state.edit.name}` : 'Add a new app', appFormHtml({ app: state.edit })) +
      win('Your apps', apps.length
        ? `<div class="scroll"><table><thead><tr><th>App</th><th>Status</th><th class="num">Installs</th><th class="num">Users</th><th>Actions</th></tr></thead><tbody>${rows}</tbody></table></div>`
        : '<div class="empty">No apps yet. Add your first one above!</div>') +
      win('Change password', `<form id="pw" data-form="password">
        <div class="row"><div><label for="pw1">Current password</label><input type="password" id="pw1" name="current" autocomplete="current-password" required></div>
        <div><label for="pw2">New password (8+ characters)</label><input type="password" id="pw2" name="next" autocomplete="new-password" required></div></div>
        <div id="pwmsg"></div><p><button type="submit">Change password</button></p></form>`),
      'studio');
  } catch (e) { draw(win('Error', `<div class="err">${esc(e.message)}</div>`), 'studio'); }
}

/* ------------------------------------------------------------------ master */
async function viewMaster() {
  if (!state.user) { location.hash = '#/login'; return; }
  if (state.user.role !== 'master') { location.hash = '#/studio'; return; }
  const tabs = ['overview', 'studios', 'apps', 'strikes'];
  const tabBar = `<div class="tabs" role="tablist">${tabs.map((t) => `<button role="tab" class="${state.masterTab === t ? 'on' : ''}" data-act="tab" data-tab="${t}">${t[0].toUpperCase() + t.slice(1)}</button>`).join('')}</div>`;
  let inner = '';
  try {
    if (state.masterTab === 'overview') {
      const o = await api('GET', '/api/master/overview');
      inner = win('Site numbers', `<div class="bigstats">
        <div class="bigstat"><b>${num(o.visitors)}</b><span>unique visitors</span></div>
        <div class="bigstat"><b>${num(o.visits)}</b><span>page visits</span></div>
        <div class="bigstat"><b>${num(o.installs)}</b><span>total installs</span></div>
        <div class="bigstat"><b>${num(o.apps)}</b><span>live apps</span></div>
        <div class="bigstat"><b>${num(o.all_apps)}</b><span>all apps</span></div>
        <div class="bigstat"><b>${num(o.taken_down)}</b><span>taken down</span></div>
        <div class="bigstat"><b>${num(o.studios)}</b><span>studios</span></div>
        <div class="bigstat"><b>${num(o.banned)}</b><span>banned studios</span></div>
        <div class="bigstat"><b>${num(o.active_strikes)}</b><span>active strikes</span></div>
      </div><p class="studio">Installs count every click on an Install button. "Users" on an app means different visitors (counted by browser).</p>`);
    } else if (state.masterTab === 'studios') {
      const { admins } = await api('GET', '/api/master/admins');
      state.cache.admins = admins;
      const rows = admins.map((a) => `<tr>
        <td>${esc(a.display_name)}<br><span class="studio">@${esc(a.username)}</span></td>
        <td>${a.role === 'master' ? '<span class="pill">MASTER</span>' : a.status === 'banned' ? `<span class="pill red">BANNED</span><br><span class="studio">${esc(a.ban_reason)}</span>` : '<span class="pill green">ACTIVE</span>'}</td>
        <td class="num">${num(a.apps)}</td><td class="num">${num(a.installs)}</td><td class="num">${a.strikes}/3</td>
        <td>${a.role === 'master' ? '' : `<div class="acts">
          ${a.status === 'banned' ? `<button class="small" data-act="unban" data-id="${a.id}">Unban</button>` : `<button class="small warn" data-act="ban" data-id="${a.id}">Ban</button>`}
          <button class="small" data-act="reset-pw" data-id="${a.id}">Reset password</button>
          <button class="small danger" data-act="del-admin" data-id="${a.id}">Delete</button></div>`}</td></tr>`).join('');
      inner = win('Add a studio (admin)', `<form id="adminform" data-form="admin">
          <div class="row"><div><label for="a_name">Studio name</label><input type="text" id="a_name" name="display_name" maxlength="40" required></div>
          <div><label for="a_user">Username</label><input type="text" id="a_user" name="username" maxlength="24" autocomplete="off" required></div>
          <div><label for="a_pass">Password (8+ characters)</label><input type="text" id="a_pass" name="password" autocomplete="off" required></div></div>
          <div id="adminmsg"></div><p><button type="submit">Create studio</button></p></form>
          <p class="studio">Tell the studio their username and password. They can change the password after logging in.</p>`) +
        win('All studios', `<div class="scroll"><table><thead><tr><th>Studio</th><th>Status</th><th class="num">Apps</th><th class="num">Installs</th><th class="num">Strikes</th><th>Actions</th></tr></thead><tbody>${rows}</tbody></table></div>`);
    } else if (state.masterTab === 'apps') {
      const [{ apps }, { admins }] = await Promise.all([api('GET', '/api/master/apps'), api('GET', '/api/master/admins')]);
      state.cache.apps = apps; state.cache.admins = admins;
      const rows = apps.map((a) => `<tr>
        <td>${esc(a.name)}<br><span class="studio">v${esc(a.version)} &middot; ${esc(a.category)}</span></td>
        <td>${esc(a.studio)}</td>
        <td>${statusPill(a)}${a.strikes ? `<br><span class="pill red">${a.strikes} strike${a.strikes > 1 ? 's' : ''}</span>` : ''}</td>
        <td class="num">${num(a.installs)}</td><td class="num">${num(a.users)}</td>
        <td><div class="acts"><a class="btn small" href="#/app/${a.id}">View</a>
          <button class="small" data-act="edit" data-id="${a.id}">Edit</button>
          <button class="small warn" data-act="strike" data-id="${a.id}">Copyright strike</button>
          ${a.status === 'live' ? `<button class="small" data-act="takedown" data-id="${a.id}">Take down</button>` : `<button class="small" data-act="restore" data-id="${a.id}">Restore</button>`}
          <button class="small danger" data-act="del-app" data-id="${a.id}">Remove</button></div></td></tr>`).join('');
      inner = win(state.edit ? `Edit: ${state.edit.name}` : 'Add an app', appFormHtml({ app: state.edit, studios: admins })) +
        win(`All apps (${apps.length})`, apps.length
          ? `<div class="scroll"><table><thead><tr><th>App</th><th>Studio</th><th>Status</th><th class="num">Installs</th><th class="num">Users</th><th>Actions</th></tr></thead><tbody>${rows}</tbody></table></div>`
          : '<div class="empty">No apps yet.</div>');
    } else {
      const { strikes } = await api('GET', '/api/master/strikes');
      const rows = strikes.map((s) => `<tr>
        <td>${day(s.created_at)}</td><td>${esc(s.app_name)}</td><td>${esc(s.admin_name)}</td><td>${esc(s.reason)}</td>
        <td>${s.revoked ? '<span class="pill gray">REVOKED</span>' : `<button class="small" data-act="revoke" data-id="${s.id}">Revoke</button>`}</td></tr>`).join('');
      inner = win('Copyright strike log', strikes.length
        ? `<p class="studio">3 active strikes on one studio bans it automatically.</p><div class="scroll"><table><thead><tr><th>Date</th><th>App</th><th>Studio</th><th>Reason</th><th></th></tr></thead><tbody>${rows}</tbody></table></div>`
        : '<div class="empty">No strikes. Clean!</div>');
    }
  } catch (e) { inner = win('Error', `<div class="err">${esc(e.message)}</div>`); }
  draw(win('Master Panel', tabBar) + inner, 'master');
}

/* ------------------------------------------------------------------ router */
async function router() {
  document.title = 'Open Store';
  const h = location.hash.replace(/^#\/?/, '');
  const [page, arg] = h.split('/');
  if (page !== 'studio' && page !== 'master') state.edit = null;
  if (page === 'app' && arg) return viewApp(arg);
  if (page === 'login') return viewLogin();
  if (page === 'studio') return viewStudio();
  if (page === 'master') return viewMaster();
  if (page === 'logout') return;
  return viewHome();
}
function reloadView() { return router(); }

/* ---------------------------------------------------------------- handlers */
const formHandlers = {
  async search(e) { e.preventDefault(); await loadApps(); },

  async login(e, form) {
    e.preventDefault();
    const f = Object.fromEntries(new FormData(form));
    try {
      const { user } = await api('POST', '/api/login', f);
      state.user = user;
      location.hash = user.role === 'master' ? '#/master' : '#/studio';
    } catch (err) { setMsg('msg', err.message); }
  },

  async app(e, form) {
    e.preventDefault();
    const f = Object.fromEntries(new FormData(form));
    const id = form.dataset.id;
    try {
      if (id) await api('PUT', `/api/my/apps/${id}`, f);
      else if (state.user.role === 'master') await api('POST', '/api/master/apps', f);
      else await api('POST', '/api/my/apps', f);
      state.edit = null;
      await reloadView();
    } catch (err) { setMsg('appmsg', err.message); }
  },

  async password(e, form) {
    e.preventDefault();
    try {
      await api('POST', '/api/me/password', Object.fromEntries(new FormData(form)));
      form.reset(); setMsg('pwmsg', 'Password changed!', 'ok');
    } catch (err) { setMsg('pwmsg', err.message); }
  },

  async admin(e, form) {
    e.preventDefault();
    try {
      await api('POST', '/api/master/admins', Object.fromEntries(new FormData(form)));
      await reloadView();
    } catch (err) { setMsg('adminmsg', err.message); }
  },
};

const actions = {
  async logout(e) {
    e.preventDefault();
    try { await api('POST', '/api/logout'); } catch { /* ignore */ }
    state.user = null; state.edit = null;
    if (location.hash === '' || location.hash === '#/') router();
    else location.hash = '#/';
  },
  tab(e, el) { state.masterTab = el.dataset.tab; state.edit = null; viewMaster(); },
  edit(e, el) {
    const a = state.cache.apps.find((x) => x.id === Number(el.dataset.id));
    if (!a) return;
    state.edit = a; reloadView();
  },
  'cancel-edit'() { state.edit = null; reloadView(); },
  async 'del-app'(e, el) {
    if (!confirm('Delete this app for good? Its install counts go too.')) return;
    await run(() => api('DELETE', `/api/my/apps/${el.dataset.id}`));
  },
  async strike(e, el) {
    const reason = prompt('Copyright reason (shown in the strike log):');
    if (!reason) return;
    const takedown = confirm('Take the app down now too?\nOK = take down, Cancel = keep it live with a copyright notice.');
    const r = await run(() => api('POST', `/api/master/apps/${el.dataset.id}/strike`, { reason, takedown }));
    if (r && r.auto_banned) alert('That studio now has 3 strikes and was banned automatically.');
  },
  async takedown(e, el) { await run(() => api('POST', `/api/master/apps/${el.dataset.id}/status`, { status: 'taken_down' })); },
  async restore(e, el) { await run(() => api('POST', `/api/master/apps/${el.dataset.id}/status`, { status: 'live' })); },
  async revoke(e, el) {
    if (!confirm('Revoke this strike?')) return;
    await run(() => api('POST', `/api/master/strikes/${el.dataset.id}/revoke`));
  },
  async ban(e, el) {
    const reason = prompt('Why is this studio being banned?');
    if (!reason) return;
    await run(() => api('POST', `/api/master/admins/${el.dataset.id}/ban`, { reason }));
  },
  async unban(e, el) { await run(() => api('POST', `/api/master/admins/${el.dataset.id}/unban`)); },
  async 'reset-pw'(e, el) {
    const password = prompt('New password for this studio (8+ characters):');
    if (!password) return;
    await run(() => api('POST', `/api/master/admins/${el.dataset.id}/password`, { password }));
    alert('Password changed. The studio was logged out.');
  },
  async 'del-admin'(e, el) {
    if (!confirm('Delete this studio AND all its apps for good?')) return;
    await run(() => api('DELETE', `/api/master/admins/${el.dataset.id}`));
  },
};
async function run(fn) {
  try { const r = await fn(); await reloadView(); return r; }
  catch (err) { alert(err.message); return null; }
}

root.addEventListener('submit', (e) => {
  const form = e.target.closest('form[data-form]');
  if (form && formHandlers[form.dataset.form]) formHandlers[form.dataset.form](e, form);
});
root.addEventListener('click', (e) => {
  const el = e.target.closest('[data-act]');
  if (el && actions[el.dataset.act]) actions[el.dataset.act](e, el);
});
let typing;
root.addEventListener('input', (e) => {
  if (e.target.id === 'q') { clearTimeout(typing); typing = setTimeout(loadApps, 250); }
});
root.addEventListener('change', (e) => {
  if (e.target.id === 'cat' || e.target.id === 'sort') loadApps();
});
window.addEventListener('hashchange', router);

/* -------------------------------------------------------------------- boot */
(async function boot() {
  try {
    const [me, cats] = await Promise.all([api('GET', '/api/me'), api('GET', '/api/categories')]);
    state.user = me.user; state.categories = cats.categories;
    state.stats = await api('POST', '/api/visit');
  } catch { /* site still shows; individual calls report errors */ }
  router();
})();
