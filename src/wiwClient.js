/**
 * wiwClient.js
 * When I Work API client — matches the official OpenAPI spec at
 * https://apidocs.wheniwork.com/external/index.html
 *
 * Auth note: W-UserId must NOT be included in request headers —
 * doing so triggers a 401 on this account. W-Token alone is sufficient.
 */

const API = 'https://api.wheniwork.com/2';
const LOGIN_URL = 'https://api.login.wheniwork.com/login';

// === Account-specific IDs (skinandsagespa.com WIW account, May 2026) ===
const POSITION_ESTI      = 11742907;
const POSITION_LMT       = 11742908;
const POSITION_BROW_LASH = 11742911;
const PROVIDER_POSITION_IDS = [POSITION_ESTI, POSITION_LMT, POSITION_BROW_LASH];

// "Provider Schedule" location — covers all provider rooms/sites (Grandma's House
// and others), as distinct from "SOM Schedule" and "Leadership Schedule".
const PROVIDER_LOCATION_ID = 5837840;

const TIMEZONE = 'America/Los_Angeles';

let _token = null;

function getDevKey() {
  const k = process.env.WIW_API_KEY || process.env.WIW_API_TOKEN;
  if (!k) throw new Error('WIW_API_KEY env var not set');
  return k;
}

// WIW's login endpoint occasionally returns a raw WAF/edge 403 (not a JSON
// error from the app itself) for no account-related reason — seen twice in
// production, both times the very next scheduled run succeeded with no
// changes. Retry a few times with backoff before giving up.
const LOGIN_RETRIES = 3;
const LOGIN_RETRY_DELAY_MS = 5000;

function sleep(ms) {
  return new Promise((resolve) => setTimeout(resolve, ms));
}

async function login() {
  if (_token) return _token;
  const email    = process.env.WIW_EMAIL;
  const password = process.env.WIW_PASSWORD;
  if (!email || !password) throw new Error('WIW_EMAIL and WIW_PASSWORD env vars required');

  let lastErr;
  for (let attempt = 1; attempt <= LOGIN_RETRIES; attempt++) {
    try {
      const res = await fetch(LOGIN_URL, {
        method: 'POST',
        headers: { 'W-Key': getDevKey(), 'Content-Type': 'application/json' },
        body: JSON.stringify({ email, password }),
      });
      if (!res.ok) throw new Error(`WIW login failed: HTTP ${res.status} ${await res.text()}`);
      const data = await res.json();
      const token = data.token || data.session_token || data?.person?.token || data?.user?.token;
      if (!token) throw new Error('WIW login OK but no token in response');
      _token = token;
      return _token;
    } catch (err) {
      lastErr = err;
      if (attempt < LOGIN_RETRIES) {
        console.error(`Login attempt ${attempt} failed: ${err.message}. Retrying in ${LOGIN_RETRY_DELAY_MS}ms...`);
        await sleep(LOGIN_RETRY_DELAY_MS);
      }
    }
  }
  throw lastErr;
}

function authHeaders() {
  // W-UserId must NOT be included — it causes 401 on this account.
  return { 'W-Token': _token, 'Content-Type': 'application/json' };
}

async function apiGet(path) {
  const res = await fetch(`${API}${path}`, { headers: authHeaders() });
  if (!res.ok) throw new Error(`GET ${path} -> HTTP ${res.status} ${await res.text()}`);
  return res.json();
}

function todayKey() {
  return new Date().toLocaleDateString('en-CA', { timeZone: TIMEZONE });
}

function futureKey(days) {
  return new Date(Date.now() + days * 86400000).toLocaleDateString('en-CA', { timeZone: TIMEZONE });
}

async function getUser(userId) {
  const data = await apiGet(`/users/${userId}`);
  return data.user;
}

async function getShift(shiftId) {
  const data = await apiGet(`/shifts/${shiftId}`);
  return data.shift;
}

// Returns all currently-assigned shifts for today through 60 days out.
//
// NOTE: this account's /shifts endpoint never returns genuinely open/unassigned
// shifts (is_open:true), under any parameter combination — confirmed by
// exhaustive testing (include_open, is_open, show_open, unassigned, status=open,
// every location_id individually and combined) against WIW's own schedule
// export as ground truth. A real open shift can sit unassigned and visible in
// the app for a month and never once appear via this API. Reported to WIW
// support; not waiting on them. Detection here is a self-diff of *assigned*
// shifts across runs (see handler.js) rather than watching for open shifts,
// since assigned-shift data has always been reliable.
//
// The /shifts endpoint also silently caps results at ~400 with no pagination
// support (a `page` param is accepted but ignored) and no total/meta field to
// detect truncation — confirmed separately (missed pickup, 2026-07-01).
// Querying in 7-day chunks keeps each request well under the cap.
const SHIFT_QUERY_CHUNK_DAYS = 7;

async function getAssignedShifts() {
  const shiftsById = new Map();
  for (let offset = 0; offset < 60; offset += SHIFT_QUERY_CHUNK_DAYS) {
    const start = futureKey(offset);
    const end   = futureKey(Math.min(offset + SHIFT_QUERY_CHUNK_DAYS, 60));
    const data  = await apiGet(`/shifts?start=${start}&end=${end}&location_id=${PROVIDER_LOCATION_ID}`);
    for (const s of data.shifts || []) {
      if (s.user_id && s.user_id !== 0) shiftsById.set(s.id, s);
    }
  }
  return [...shiftsById.values()];
}

// Returns all assigned shifts for a user on a given YYYY-MM-DD date.
// `end` is exclusive on this API (start=end returns zero shifts even when
// shifts exist that day), so the end boundary is bumped by one day and
// results are filtered back down to the requested date.
async function getUserShiftsOnDate(userId, date) {
  const nextDay = new Date(`${date}T00:00:00Z`);
  nextDay.setUTCDate(nextDay.getUTCDate() + 1);
  const end = nextDay.toISOString().slice(0, 10);
  const data = await apiGet(`/shifts?start=${date}&end=${end}&user_id=${userId}`);
  return (data.shifts || []).filter(s => s.user_id === Number(userId) && shiftDateKey(s) === date);
}

function isProvider(user) {
  const positions = user.positions || (user.position_id ? [user.position_id] : []);
  return positions.some(pid => PROVIDER_POSITION_IDS.includes(pid));
}

function positionLabel(user) {
  const positions = user.positions || (user.position_id ? [user.position_id] : []);
  if (positions.includes(POSITION_ESTI))      return 'Esthetician';
  if (positions.includes(POSITION_LMT))       return 'Massage Therapist';
  if (positions.includes(POSITION_BROW_LASH)) return 'Brow/Lash Esti';
  return 'Provider';
}

// YYYY-MM-DD in Pacific time — used for WIW API date params and task names.
function shiftDateKey(shift) {
  return new Date(shift.start_time).toLocaleDateString('en-CA', { timeZone: TIMEZONE });
}

// "Sun, 17 May 2026" in Pacific time.
function formatShiftDate(shift) {
  return new Date(shift.start_time).toLocaleDateString('en-GB', {
    weekday: 'short', day: 'numeric', month: 'short', year: 'numeric',
    timeZone: TIMEZONE,
  });
}

// "4:45pm-8:30pm" in Pacific time.
function formatShiftTime(shift) {
  const fmt = d => new Date(d)
    .toLocaleTimeString('en-US', { hour: 'numeric', minute: '2-digit', hour12: true, timeZone: TIMEZONE })
    .toLowerCase()
    .replace(' ', '');
  return `${fmt(shift.start_time)}-${fmt(shift.end_time)}`;
}

function shiftHours(shift) {
  const ms = new Date(shift.end_time) - new Date(shift.start_time);
  return Math.round((ms / 3600000) * 100) / 100;
}

module.exports = {
  login, getUser, getShift, getUserShiftsOnDate,
  getAssignedShifts,
  isProvider, positionLabel, todayKey,
  shiftDateKey, formatShiftDate, formatShiftTime, shiftHours,
  POSITION_ESTI, POSITION_LMT, POSITION_BROW_LASH, PROVIDER_POSITION_IDS, PROVIDER_LOCATION_ID,
};
