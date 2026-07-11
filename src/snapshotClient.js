/**
 * snapshotClient.js
 * Persists the set of currently-*assigned* shifts from the last run, so
 * handler.js can diff this run's roster against it to detect pickups and
 * trades — see handler.js for why this replaced watching for open shifts.
 *
 * Unlike the old open-shift watch-list, this doesn't need to accumulate
 * across runs or survive gaps: assigned-shift data has always been reliable
 * via the API, so each run's fetch is simply the new truth, wholesale.
 *
 * State is stored as state/assigned-shifts-snapshot.json in this repo via the
 * GitHub Contents API using the GITHUB_TOKEN that Actions provides automatically.
 */

const GITHUB_API    = 'https://api.github.com';
const SNAPSHOT_PATH = 'state/assigned-shifts-snapshot.json';

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
    return { assigned: new Map(), sha: null, isFirstRun: true };
  }
  if (!res.ok) throw new Error(`Failed to load snapshot: HTTP ${res.status}`);
  const file    = await res.json();
  const content = JSON.parse(Buffer.from(file.content, 'base64').toString('utf8'));

  const assigned = new Map(Object.entries(content.assigned || {}).map(([id, v]) => [Number(id), v]));
  return { assigned, sha: file.sha, isFirstRun: false };
}

async function saveSnapshot(assigned, existingSha) {
  const payload = {
    capturedAt: new Date().toISOString(),
    assigned:   Object.fromEntries(assigned),
  };
  const body = {
    message: 'chore: update assigned shifts snapshot [skip ci]',
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
