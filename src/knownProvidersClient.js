/**
 * knownProvidersClient.js
 * Tracks every WIW user_id ever seen holding a tracked-provider shift, so
 * the batch-publish guard in handler.js can tell a brand-new hire's first
 * batch of published shifts apart from an existing provider's routine
 * weekly republish.
 *
 * The guard normally suppresses task creation for a large, far-out batch of
 * newly-assigned shifts, on the assumption someone already has a process
 * for entering the master schedule into Mangomint for existing staff. That
 * assumption doesn't hold for a provider nobody has ever tracked before —
 * their first published week of shifts is the only time this automation
 * will ever see it as "new," so it must not be silently suppressed.
 *
 * State is stored as state/known-providers.json in this repo via the
 * GitHub Contents API, same mechanism as snapshotClient.js.
 */

const GITHUB_API  = 'https://api.github.com';
const KNOWN_PATH  = 'state/known-providers.json';

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
  return `${GITHUB_API}/repos/${repo}/contents/${KNOWN_PATH}`;
}

async function loadKnownProviders() {
  const res = await fetch(repoUrl(), { headers: headers() });
  if (res.status === 404) {
    console.log('  No known-providers file found — will bootstrap from current roster.');
    return { known: new Set(), sha: null, isFirstRun: true };
  }
  if (!res.ok) throw new Error(`Failed to load known providers: HTTP ${res.status}`);
  const file    = await res.json();
  const content = JSON.parse(Buffer.from(file.content, 'base64').toString('utf8'));

  return { known: new Set(content.userIds || []), sha: file.sha, isFirstRun: false };
}

async function saveKnownProviders(known, existingSha) {
  const payload = {
    updatedAt: new Date().toISOString(),
    userIds:   [...known].sort((a, b) => a - b),
  };
  const body = {
    message: 'chore: update known providers [skip ci]',
    content: Buffer.from(JSON.stringify(payload, null, 2)).toString('base64'),
  };
  if (existingSha) body.sha = existingSha;

  const res = await fetch(repoUrl(), {
    method:  'PUT',
    headers: headers(),
    body:    JSON.stringify(body),
  });
  if (!res.ok) throw new Error(`Failed to save known providers: HTTP ${res.status} ${await res.text()}`);
}

module.exports = { loadKnownProviders, saveKnownProviders };
