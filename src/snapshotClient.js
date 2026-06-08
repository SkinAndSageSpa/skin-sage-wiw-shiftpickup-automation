/**
 * snapshotClient.js
 * Persists the list of unassigned open shifts between runs so we can detect
 * pickups by diffing: if a shift was unassigned last run and is now assigned,
 * someone picked it up.
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
    return { unassignedIds: new Set(), sha: null, capturedAt: null };
  }
  if (!res.ok) throw new Error(`Failed to load snapshot: HTTP ${res.status}`);
  const file    = await res.json();
  const content = JSON.parse(Buffer.from(file.content, 'base64').toString('utf8'));
  return {
    unassignedIds: new Set(content.unassignedIds),
    sha:           file.sha,
    capturedAt:    content.capturedAt,
  };
}

async function saveSnapshot(unassignedShifts, existingSha) {
  const payload = {
    capturedAt:    new Date().toISOString(),
    unassignedIds: unassignedShifts.map(s => s.id),
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
