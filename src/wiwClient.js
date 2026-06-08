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
const POSITION_ESTI = 11742907;
const POSITION_LMT  = 11742908;
const PROVIDER_POSITION_IDS = [POSITION_ESTI, POSITION_LMT];
const PROVIDER_LOCATION_ID  = 5837840;

const TIMEZONE = 'America/Los_Angeles';

// How far back to look for recent pickups (minutes). Run interval is 60 min;
// 30-min buffer ensures no pickups are missed if the cron fires slightly late.
const LOOKBACK_MINUTES = 90;

let _token = null;

function getDevKey() {
  const k = process.env.WIW_API_KEY || process.env.WIW_API_TOKEN;
  if (!k) throw new Error('WIW_API_KEY env var not set');
  return k;
}

async function login() {
  if (_token) return _token;
  const email    = process.env.WIW_EMAIL;
  const password = process.env.WIW_PASSWORD;
  if (!email || !password) throw new Error('WIW_EMAIL and WIW_PASSWORD env vars required');

  const res = await fetch(LOGIN_URL, {
    method: 'POST',
    headers: { 'W-Key': getDevKey(), 'Content-Type': 'application/json' },
    body: JSON.stringify({ email, password }),
  });
  if (!res.ok) throw new Error(`WIW login failed: HTTP ${res.status} ${await res.text()}`);
  const data = await res.json();
  // Login response uses "person" key (not "user") and token is at the top level.
  const token = data.token || data.session_token || data?.person?.token || data?.user?.token;
  if (!token) throw new Error('WIW login OK but no token in response');
  _token = token;
  return _token;
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

function cutoffTime() {
  return new Date(Date.now() - LOOKBACK_MINUTES * 60 * 1000);
}

function isRecent(timestamp) {
  return timestamp && new Date(timestamp) >= cutoffTime();
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

// Returns completed swaps/drops updated within the lookback window.
// status=3 is auto-completed on this account (manager review is disabled),
// which covers both one-sided drops and two-sided swaps.
async function getRecentApprovedSwaps() {
  const data  = await apiGet(`/swaps?status=3&start=${todayKey()}&end=${futureKey(60)}`);
  const swaps = data.swaps || [];
  return swaps.filter(s => isRecent(s.updated_at || s.created_at));
}

// Returns all shifts at the provider location for today through 60 days out.
// Used by handler.js to diff against the previous snapshot for open shift detection.
async function getLocationShifts() {
  const data = await apiGet(`/shifts?start=${todayKey()}&end=${futureKey(60)}&location_id=${PROVIDER_LOCATION_ID}`);
  return data.shifts || [];
}

// Returns all assigned shifts for a user on a given YYYY-MM-DD date.
async function getUserShiftsOnDate(userId, date) {
  const data = await apiGet(`/shifts?start=${date}&end=${date}&user_id=${userId}&location_id=${PROVIDER_LOCATION_ID}`);
  return (data.shifts || []).filter(s => s.user_id === Number(userId));
}

function isProvider(user) {
  const positions = user.positions || (user.position_id ? [user.position_id] : []);
  return positions.some(pid => PROVIDER_POSITION_IDS.includes(pid));
}

function positionLabel(user) {
  const positions = user.positions || (user.position_id ? [user.position_id] : []);
  if (positions.includes(POSITION_ESTI)) return 'Esthetician';
  if (positions.includes(POSITION_LMT))  return 'Massage Therapist';
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
  getRecentApprovedSwaps, getLocationShifts,
  isProvider, positionLabel,
  shiftDateKey, formatShiftDate, formatShiftTime, shiftHours,
  POSITION_ESTI, POSITION_LMT, PROVIDER_POSITION_IDS, PROVIDER_LOCATION_ID,
};
