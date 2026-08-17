// Shared runtime for every Staffroom page: API client, auth guard, sidebar,
// toasts and small render helpers. Loaded before each page's own <script>.
'use strict';

const API = '/api';
const TOKEN_KEY = 'sr_token';

function getToken() { return localStorage.getItem(TOKEN_KEY); }
function setToken(token) { localStorage.setItem(TOKEN_KEY, token); }
function clearToken() { localStorage.removeItem(TOKEN_KEY); }

async function api(path, opts = {}) {
  const token = getToken();
  const headers = opts.body ? { 'Content-Type': 'application/json' } : {};
  if (token) headers.Authorization = `Bearer ${token}`;
  const res = await fetch(API + path, {
    method: opts.method || 'GET',
    headers,
    body: opts.body ? JSON.stringify(opts.body) : undefined
  });
  let data = null;
  try { data = await res.json(); } catch { /* empty body */ }
  if (!res.ok) {
    const err = new Error((data && data.error) || `Request failed (${res.status})`);
    err.status = res.status;
    err.data = data;
    throw err;
  }
  return data;
}

/** Like api(), but for multipart/form-data (file uploads) — no Content-Type
 * header set manually, since the browser needs to add its own boundary. */
async function apiUpload(path, formData) {
  const token = getToken();
  const headers = {};
  if (token) headers.Authorization = `Bearer ${token}`;
  const res = await fetch(API + path, { method: 'POST', headers, body: formData });
  let data = null;
  try { data = await res.json(); } catch { /* empty body */ }
  if (!res.ok) {
    const err = new Error((data && data.error) || `Request failed (${res.status})`);
    err.status = res.status;
    err.data = data;
    throw err;
  }
  return data;
}

/** Redirects to the login page if the visitor isn't signed in; returns the user otherwise. */
async function requireAuth() {
  try {
    const { user } = await api('/auth/me');
    return user;
  } catch {
    const next = encodeURIComponent(location.pathname + location.search);
    location.href = `/login.html?next=${next}`;
    return new Promise(() => {}); // never resolves — we're navigating away
  }
}

function esc(s) {
  return String(s ?? '').replace(/[&<>"']/g, (c) => ({ '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;', "'": '&#39;' }[c]));
}

function initials(name) {
  return String(name || '?').trim().charAt(0).toUpperCase() || '?';
}

/* ------------------------------------------------------------------ toast */

let toastTimer = null;
function toast(msg) {
  let el = document.getElementById('sr-toast');
  if (!el) {
    el = document.createElement('div');
    el.id = 'sr-toast';
    el.className = 'sr-toast';
    document.body.appendChild(el);
  }
  el.textContent = msg;
  el.classList.add('show');
  clearTimeout(toastTimer);
  toastTimer = setTimeout(() => el.classList.remove('show'), 2800);
}

function errorToast(err) {
  if (err?.status === 402) {
    toast(err.message || 'Not enough credits — top up from Credits & Billing.');
  } else if (err?.status === 403 && err.data?.code === 'PLAN_UPGRADE_REQUIRED') {
    toast(`${err.message} Upgrade to ${err.data.requiredPlan} from Credits & Billing.`);
  } else {
    toast(err?.message || 'Something went wrong');
  }
}

/* --------------------------------------------------------------- sidebar */

const NAV_ITEMS = [
  { href: 'dashboard.html', label: 'Dashboard', key: 'dashboard' },
  { href: 'classes.html', label: 'Classes &amp; Subjects', key: 'classes' },
  { href: 'question-bank.html', label: 'Question Bank', key: 'question-bank' },
  { href: 'paper-maker.html', label: 'Assessments', key: 'paper-maker' },
  { href: 'evaluator.html', label: 'Evaluation', key: 'evaluator' },
  { href: 'analytics.html', label: 'Analytics', key: 'analytics' },
  { href: 'materials.html', label: 'Materials', key: 'materials' },
  { href: 'note-maker.html', label: 'Note Maker', key: 'note-maker' }
];

const NAV_ICONS = {
  dashboard: '<rect x="2" y="2" width="5" height="5" rx="1"></rect><rect x="9" y="2" width="5" height="5" rx="1"></rect><rect x="2" y="9" width="5" height="5" rx="1"></rect><rect x="9" y="9" width="5" height="5" rx="1"></rect>',
  classes: '<rect x="2.5" y="3" width="11" height="7.5" rx="1"></rect><path d="M8 10.5v3M5.5 13.5h5"></path>',
  'question-bank': '<rect x="3" y="2.5" width="10" height="11" rx="1.5"></rect><path d="M6.2 2.5v11"></path>',
  evaluator: '<path d="M4 2.5h6l2.5 2.5v8.5a1 1 0 0 1-1 1h-7.5a1 1 0 0 1-1-1v-10a1 1 0 0 1 1-1z"></path><path d="M6 8.5l1.4 1.4L10.5 6.7"></path>',
  'paper-maker': '<rect x="3.5" y="2" width="9" height="12" rx="1.5"></rect><path d="M6 6h4M6 9h2.5"></path>',
  analytics: '<path d="M3.5 13V9M8 13V5.5M12.5 13V3"></path>',
  materials: '<path d="M2.5 12.5v-8a1 1 0 0 1 1-1h3l1.5 2h4.5a1 1 0 0 1 1 1v6a1 1 0 0 1-1 1h-9a1 1 0 0 1-1-1z"></path>',
  'note-maker': '<path d="M4.5 2h5.5l3 3v8.5a1 1 0 0 1-1 1h-7.5a1 1 0 0 1-1-1V3a1 1 0 0 1 1-1z"></path><path d="M6 6.5h4M6 9h4M6 11.5h2.5"></path>',
  credits: '<circle cx="8" cy="8" r="5.5"></circle><circle cx="8" cy="8" r="2"></circle>',
  settings: '<path d="M3 5h10M3 11h10"></path><circle cx="6" cy="5" r="1.7"></circle><circle cx="10.5" cy="11" r="1.7"></circle>',
  logout: '<path d="M6 2.5H3.5a1 1 0 0 0-1 1v9a1 1 0 0 0 1 1H6M10.5 11l3-3-3-3M13.3 8H6"></path>'
};

const SIDEBAR_COLLAPSE_KEY = 'sr-sidebar-collapsed';
function sidebarCollapsed() { return localStorage.getItem(SIDEBAR_COLLAPSE_KEY) === 'true'; }

function sidebarHtml(active, user) {
  const items = NAV_ITEMS.map((it) => navLink(it.href, it.key, it.label, active)).join('');
  const collapsed = sidebarCollapsed();
  return `
  <aside class="sr-side${collapsed ? ' collapsed' : ''}" id="srSide">
    <button id="srSidebarToggle" class="sr-brand" title="${collapsed ? 'Expand sidebar' : 'Collapse sidebar'}">
      <svg width="18" height="18" viewBox="0 0 18 18" style="flex-shrink:0;"><rect x="1.5" y="2" width="15" height="3.2" rx="1.6" fill="var(--sr-primary)" opacity="0.4"></rect><rect x="1.5" y="7" width="15" height="3.2" rx="1.6" fill="var(--sr-primary)" opacity="0.68"></rect><rect x="1.5" y="12" width="15" height="3.2" rx="1.6" fill="var(--sr-primary)"></rect></svg>
      <span class="sr-brand-name">Staffroom</span>
    </button>
    ${items}
    <div style="flex:1;"></div>
    <a href="settings.html" class="sr-account">
      <div class="sr-avatar">${esc(initials(user.name))}</div>
      <div class="sr-account-text">
        <span class="sr-account-name">${esc(user.name)}</span>
        <span class="sr-account-sub">${esc(user.plan)} plan · ${esc((user.boards || [])[0] || 'CBSE')}</span>
      </div>
    </a>
  </aside>`;
}

function navLink(href, key, label, active) {
  const isActive = key === active;
  const icon = NAV_ICONS[key] || '';
  return `<a href="${href}" class="sr-nav-link${isActive ? ' active' : ''}" title="${label.replace(/<[^>]+>/g, '')}">
    <svg width="16" height="16" viewBox="0 0 16 16" fill="none" stroke="currentColor" stroke-width="1.4" stroke-linecap="round">${icon}</svg>
    <span>${label}</span>
  </a>`;
}

function topbarHtml(title, user) {
  return `
  <div class="sr-topbar">
    <span class="sr-topbar-title">${esc(title)}</span>
    <div class="sr-topbar-right">
      <a href="credits.html" class="sr-credit-pill"><span class="sr-dot"></span><span>${Math.round(user.credits).toLocaleString()} credits</span></a>
      <div class="sr-account-menu" id="srAccountMenu">
        <button class="sr-avatar sr-avatar-btn" id="srAvatarBtn">${esc(initials(user.name))}</button>
        <div class="sr-dropdown" id="srDropdown" hidden>
          <div class="sr-dropdown-header">
            <span class="sr-dropdown-name">${esc(user.name)}</span>
            <span class="sr-dropdown-sub">${esc(user.plan)} plan</span>
          </div>
          <a href="credits.html" class="sr-dropdown-item">
            <svg width="15" height="15" viewBox="0 0 16 16" fill="none" stroke="currentColor" stroke-width="1.4">${NAV_ICONS.credits}</svg>
            <span>Credits &amp; Billing</span>
          </a>
          <a href="settings.html" class="sr-dropdown-item">
            <svg width="15" height="15" viewBox="0 0 16 16" fill="none" stroke="currentColor" stroke-width="1.4" stroke-linecap="round">${NAV_ICONS.settings}</svg>
            <span>Settings</span>
          </a>
          <div class="sr-dropdown-sep"></div>
          <button class="sr-dropdown-item sr-dropdown-danger" id="srLogoutBtn">
            <svg width="15" height="15" viewBox="0 0 16 16" fill="none" stroke="currentColor" stroke-width="1.4" stroke-linecap="round" stroke-linejoin="round">${NAV_ICONS.logout}</svg>
            <span>Log out</span>
          </button>
        </div>
      </div>
    </div>
  </div>`;
}

function wireShell() {
  const toggle = document.getElementById('srSidebarToggle');
  if (toggle) toggle.onclick = () => {
    const collapsed = !sidebarCollapsed();
    localStorage.setItem(SIDEBAR_COLLAPSE_KEY, String(collapsed));
    const side = document.getElementById('srSide');
    if (side) {
      side.classList.toggle('collapsed', collapsed);
      toggle.title = collapsed ? 'Expand sidebar' : 'Collapse sidebar';
    }
  };

  const avatarBtn = document.getElementById('srAvatarBtn');
  const dropdown = document.getElementById('srDropdown');
  if (avatarBtn && dropdown) {
    // Some mice/trackpads (and some automation layers) fire two click events
    // for one physical click; a plain toggle then flips twice and the menu
    // looks like it never closes. Guard with a short debounce, and close on
    // mousedown (fires once, before any click synthesis) rather than click.
    let lastToggle = 0;
    const toggle = (e) => {
      e.stopPropagation();
      const now = Date.now();
      if (now - lastToggle < 200) return;
      lastToggle = now;
      dropdown.hidden = !dropdown.hidden;
    };
    avatarBtn.onclick = toggle;
    document.addEventListener('mousedown', (e) => {
      if (!dropdown.hidden && !e.target.closest('#srAccountMenu')) dropdown.hidden = true;
    });
    document.addEventListener('keydown', (e) => {
      if (e.key === 'Escape' && !dropdown.hidden) dropdown.hidden = true;
    });
  }

  const logoutBtn = document.getElementById('srLogoutBtn');
  if (logoutBtn) logoutBtn.onclick = async () => {
    try { await api('/auth/logout', { method: 'POST' }); } catch { /* ignore */ }
    clearToken();
    location.href = 'login.html';
  };
}

/** Renders the standard app shell (sidebar + topbar) and returns the #sr-main content element. */
async function mountShell(activeKey, title) {
  const user = await requireAuth();
  document.getElementById('app').innerHTML = `
    ${sidebarHtml(activeKey, user)}
    <div class="sr-body">
      ${topbarHtml(title, user)}
      <div class="sr-scroll"><div id="sr-main" class="sr-main"></div></div>
    </div>`;
  wireShell();
  return { user, main: document.getElementById('sr-main') };
}

function refreshCreditChips(balance) {
  document.querySelectorAll('.sr-credit-pill span:last-child').forEach((el) => (el.textContent = `${Math.round(balance).toLocaleString()} credits`));
  document.querySelectorAll('.sr-credit-badge').forEach((el) => (el.textContent = Math.round(balance).toLocaleString()));
}

/* ------------------------------------------------------------------ misc */

function fmtDate(iso) {
  if (!iso) return '—';
  const d = new Date(iso);
  if (Number.isNaN(d.getTime())) return iso;
  return d.toLocaleDateString('en-IN', { day: 'numeric', month: 'short' });
}

function relTime(iso) {
  if (!iso) return '—';
  const diff = Date.now() - new Date(iso).getTime();
  const day = 86400000;
  if (diff < day) return 'Today';
  if (diff < 2 * day) return 'Yesterday';
  const days = Math.floor(diff / day);
  if (days < 14) return `${days} days ago`;
  const weeks = Math.floor(days / 7);
  if (weeks < 5) return `${weeks} week${weeks > 1 ? 's' : ''} ago`;
  return fmtDate(iso);
}

function debounce(fn, ms) {
  let t;
  return (...args) => { clearTimeout(t); t = setTimeout(() => fn(...args), ms); };
}
