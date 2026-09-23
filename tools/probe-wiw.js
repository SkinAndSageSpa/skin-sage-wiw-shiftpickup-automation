/**
 * probe-wiw.js
 * Local diagnostic — logs in and dumps providers, shifts, swaps, and open shift pickups.
 * Usage: WIW_API_KEY=... WIW_EMAIL=... WIW_PASSWORD=... node tools/probe-wiw.js [YYYY-MM-DD]
 */

const wiw = require('../src/wiwClient');

async function main() {
  const date = process.argv[2] || new Date().toLocaleDateString('en-CA', { timeZone: 'America/Los_Angeles' });
  console.log(`Probing WIW for date: ${date}\n`);

  await wiw.login();

  // Providers
  const { users } = await (async () => {
    const { login: _l, ...api } = wiw;
    const res = await fetch('https://api.wheniwork.com/2/users', {
      headers: { 'W-Token': (await wiw.login()), 'Content-Type': 'application/json' },
    });
    return res.json();
  })();

  // Re-fetch using internal auth (already logged in)
  const fetchWIW = async path => {
    const res = await fetch('https://api.wheniwork.com/2' + path, {
      headers: { 'W-Token': process._wiwToken, 'Content-Type': 'application/json' },
    });
    return res.json();
  };

  // Patch: expose token for probe
  const origLogin = wiw.login;
  const token = await origLogin();
  process._wiwToken = token;

  const uData = await fetchWIW('/users');
  const providers = (uData.users || []).filter(wiw.isProvider);
  console.log(`=== Providers (${providers.length}) ===`);
  for (const u of providers) {
    console.log(`  id=${u.id}  ${u.first_name} ${u.last_name}  positions=${JSON.stringify(u.positions)}`);
  }

  const end60 = new Date(Date.now() + 60 * 86400000).toLocaleDateString('en-CA', { timeZone: 'America/Los_Angeles' });

  // Swaps
  const swapData = await fetchWIW(`/swaps?status=2&start=${date}&end=${end60}`);
  console.log(`\n=== Recent approved swaps (${(swapData.swaps || []).length}) ===`);
  for (const s of swapData.swaps || []) {
    console.log(`  swap_id=${s.id}  shift_id=${s.shift_id}  creator_id=${s.creator_id}  user_id=${s.user_id}  updated_at=${s.updated_at}`);
  }

  // Open shift pickups (Ravenna only — pass a second location_id manually to probe Queen Anne)
  const shiftData = await fetchWIW(`/shifts?start=${date}&end=${end60}&location_id=${wiw.LOCATIONS[0].locationId}`);
  const allShifts = shiftData.shifts || [];
  const openPickups = allShifts.filter(s => s.user_id && s.user_id !== 0 && s.openshift_approval_request_id > 0);
  console.log(`\n=== Open shift pickups (openshift_approval_request_id > 0): ${openPickups.length} ===`);
  for (const s of openPickups) {
    console.log(`  shift_id=${s.id}  user_id=${s.user_id}  position_id=${s.position_id}  ${wiw.formatShiftTime(s)}  openshift_req=${s.openshift_approval_request_id}  updated_at=${s.updated_at}`);
  }

  // All shifts today
  const todayShifts = allShifts.filter(s => s.start_time && s.start_time.includes(date.replace(/-/g, '').slice(0, 4)));
  console.log(`\n=== All provider shifts starting ${date} (${allShifts.filter(s => wiw.shiftDateKey(s) === date).length}) ===`);
  for (const s of allShifts.filter(s => wiw.shiftDateKey(s) === date)) {
    console.log(`  shift_id=${s.id}  user_id=${s.user_id}  is_open=${s.is_open}  openshift_req=${s.openshift_approval_request_id}  ${wiw.formatShiftTime(s)}`);
  }
}

main().catch(err => { console.error(err); process.exit(1); });
