/**
 * check-locations.js
 * READ-ONLY. Verifies that getAssignedShifts()'s per-location queries behave the
 * way handler.js assumes, for every entry in wiwClient.LOCATIONS:
 *   - each location_id query returns only that location's shifts (the sibling
 *     publish repo found all_locations=true silently ignores location_id; this
 *     checks the plain query used here doesn't have a similar leak)
 *   - each location's providers pass isProvider() and are already in
 *     state/known-providers.json (unknown ones bypass the batch-publish guard)
 *   - which providers work more than one location on the same day, since
 *     getUserShiftsOnDate() isn't location-scoped (affects the close-books
 *     "has remaining shift" wording)
 * Never creates tasks or writes snapshot/known-providers state.
 *
 * Usage: node tools/check-locations.js
 */

const fs  = require('fs');
const wiw = require('../src/wiwClient');

(async () => {
  await wiw.login();
  console.log('Logged in.\n');

  const known  = new Set(JSON.parse(fs.readFileSync('state/known-providers.json', 'utf8')).userIds || []);
  const shifts = await wiw.getAssignedShifts();
  console.log(`getAssignedShifts(): ${shifts.length} assigned shift(s), next 60 days.\n`);

  const users = new Map();
  async function user(id) {
    if (!users.has(id)) users.set(id, await wiw.getUser(id));
    return users.get(id);
  }

  for (const location of wiw.LOCATIONS) {
    const here   = shifts.filter(s => s.locationLabel === location.label);
    const leaked = here.filter(s => s.location_id !== location.locationId);
    const ids    = [...new Set(here.map(s => s.user_id))];
    const dates  = here.map(s => wiw.shiftDateKey(s)).sort();

    console.log(`=== ${location.label} (location ${location.locationId}) ===`);
    console.log(`  ${here.length} shift(s), ${ids.length} distinct user(s), dates ${dates[0] ?? '-'} .. ${dates.at(-1) ?? '-'}`);
    console.log(`  Shifts whose location_id != ${location.locationId}: ${leaked.length}` +
      (leaked.length ? ` (location_ids: ${[...new Set(leaked.map(s => s.location_id))].join(', ')})` : ''));

    for (const id of ids) {
      const u = await user(id);
      const n = here.filter(s => s.user_id === id).length;
      console.log(`  - ${u.first_name} ${u.last_name} (user ${id}): ${n} shift(s), ` +
        `provider=${wiw.isProvider(u)} (${wiw.positionLabel(u)}), known=${known.has(id) || known.has(String(id))}`);
    }
    console.log('');
  }

  const byUserDate = new Map();
  for (const s of shifts) {
    const key = `${s.user_id}|${wiw.shiftDateKey(s)}`;
    if (!byUserDate.has(key)) byUserDate.set(key, new Set());
    byUserDate.get(key).add(s.locationLabel);
  }
  const multi = [...byUserDate].filter(([, locs]) => locs.size > 1);
  console.log(`=== Same-day multi-location providers: ${multi.length} user-day(s) ===`);
  for (const [key, locs] of multi) {
    const [id, date] = key.split('|');
    const u = await user(Number(id));
    console.log(`  - ${u.first_name} ${u.last_name} on ${date}: ${[...locs].join(' + ')}`);
  }
})().catch(err => {
  console.error('FAILED:', err.message);
  process.exit(1);
});
