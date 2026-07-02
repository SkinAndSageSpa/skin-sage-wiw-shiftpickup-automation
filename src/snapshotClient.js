/**
 * snapshotClient.js
 * Persists the set of open (unassigned) shifts we're watching for pickup,
 * accumulated across runs — not just the immediately preceding one.
 *
 * Why accumulate instead of overwrite: the original design compared only
 * against the single most recent run's snapshot. If any one run failed to
 * record a shift as unassigned (a truncated query, a failed WIW login, a
 * missed cron tick), that shift's "unassigned" sighting was gone for good —
 * the diff could never catch it becoming assigned no matter how long it sat
 * open. Confirmed root cause of 3 missed pickups (Saralyn->Amber 2026-06-28,
 * Priscilla 2026-07-20, Katie Bennett 2026-07-29). Accumulating means a shift
 * stays watched from the first run that ever sees it open until the run that
 * detects it picked up and successfully creates the task — any number of
 * failed/gappy runs in between are harmless.
 *
 * State is stored as state/open-shifts-snapshot.json in this repo via the
 * GitHub Contents API using the GITHUB_TOKEN that Actions provides automatically.
 */

const GITHUB_API    = 'https://api.github.com';
const SNAPSHOT_PATH = 'state/open-shifts-snapshot.json';

function headers() {
  const token = process.env.GITHUB_TOKEN;
  if (!token) throw new Error('GITHUB_TOKEN env var not set');
  return {
    'Authorization': `Bearer ${token}`,
    'Content-Type':  'application/json',
    'Accept':        'application/vnd.github+json',
    'X-GitHub-Api-Version': '2022-11-28',
  };
}

function repoUrl() {
  const repo = process.env.GITHUB_REPOSITORY;
  if (!repo) throw new Error('GITHUB_REPOSITORY env var not set');
  return `${GITHUB_API}/repos/${repo}/contents/${SNAPSHOT_PATH}`;
}

async function loadSnapshot() {
  const res = await fetch(repoUrl(), { headers: headers() });
  if (res.status === 404) {
    console.log('  No snapshot found — first run, will save baseline.');
    return { watched: new Map(), sha: null };
  }
  if (!res.ok) throw new Error(`Failed to load snapshot: HTTP ${res.status}`);
  const file    = await res.json();
  const content = JSON.parse(Buffer.from(file.content, 'base64').toString('utf8'));

  // Migrate from the old single-hop format ({ unassignedIds: [...] }), which
  // carries no per-shift first-seen/date info — treat any surviving entries
  // as freshly seen so they re-enter accumulation going forward.
  if (Array.isArray(content.unassignedIds)) {
    const watched = new Map(content.unassignedIds.map(id => [id, { firstSeenAt: content.capturedAt || new Date().toISOString(), shiftDate: null }]));
    return { watched, sha: file.sha };
  }

  const watched = new Map(Object.entries(content.watched || {}).map(([id, v]) => [Number(id), v]));
  return { watched, sha: file.sha };
}

async function saveSnapshot(watched, existingSha) {
  const payload = {
    capturedAt: new Date().toISOString(),
    watched:    Object.fromEntries(watched),
  };
  const body = {
    message: 'chore: update open shifts snapshot [skip ci]',
    content: Buffer.from(JSON.stringify(payload, null, 2)).toString('base64'),
  };
  if (existingSha) body.sha = existingSha;

  const res = await fetch(repoUrl(), {
    method:  'PUT',
    headers: headers(),
    body:    JSON.stringify(body),
  });
  if (!res.ok) throw new Error(`Failed to save snapshot: HTTP ${res.status} ${await res.text()}`);
}

module.exports = { loadSnapshot, saveSnapshot };
