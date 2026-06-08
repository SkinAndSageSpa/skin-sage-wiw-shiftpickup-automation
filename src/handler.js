/**
 * handler.js
 * Polling orchestrator. Runs on a GitHub Actions cron schedule.
 * Fetches recent WIW shift pickups and creates Asana tasks for each one.
 */

const wiw                        = require('./wiwClient');
const { createDroppedShiftTask, createOpenShiftTask } = require('./asanaClient');
const { loadSnapshot, saveSnapshot }                  = require('./snapshotClient');

async function processDroppedShift(swap, userCache) {
  const pickingUserId  = swap.user_id;
  const droppingUserId = swap.creator_id;

  if (!pickingUserId || !droppingUserId) {
    console.log(`  Swap ${swap.id}: missing user IDs, skipping`);
    return;
  }

  const [pickingUser, droppingUser, shift] = await Promise.all([
    userCache.get(pickingUserId),
    userCache.get(droppingUserId),
    wiw.getShift(swap.shift_id),
  ]);

  if (!wiw.isProvider(pickingUser)) {
    console.log(`  Swap ${swap.id}: picking user ${pickingUser?.first_name} is not Esti/LMT, skipping`);
    return;
  }

  const pickingName      = `${pickingUser.first_name} ${pickingUser.last_name}`;
  const pickingPosition  = wiw.positionLabel(pickingUser);
  const droppingName     = `${droppingUser.first_name} ${droppingUser.last_name}`;
  const droppingPosition = wiw.positionLabel(droppingUser);

  const shiftDate    = wiw.shiftDateKey(shift);
  const shiftDisplay = `${wiw.formatShiftDate(shift)} ${wiw.formatShiftTime(shift)}`;
  const hours        = wiw.shiftHours(shift);

  const droppingShiftsToday       = await wiw.getUserShiftsOnDate(droppingUserId, shiftDate);
  const droppingHasRemainingShift = droppingShiftsToday.length > 0;

  console.log(`  Swap ${swap.id}: ${droppingName} → ${pickingName}, ${shiftDisplay} (${hours} hrs)`);

  const task = await createDroppedShiftTask({
    droppingProvider: { name: droppingName, position: droppingPosition },
    pickingProvider:  { name: pickingName,  position: pickingPosition  },
    shiftDate,
    shiftDisplay,
    shiftHours: hours,
    droppingHasRemainingShift,
    now: new Date(),
  });

  if (task) console.log(`    Asana task: ${task?.data?.permalink_url || '(no url)'}`);
}

async function processOpenShiftPickup(shift, userCache) {
  const user = await userCache.get(shift.user_id);

  if (!wiw.isProvider(user)) {
    console.log(`  Open shift ${shift.id}: user ${user?.first_name} is not Esti/LMT, skipping`);
    return;
  }

  const name     = `${user.first_name} ${user.last_name}`;
  const position = wiw.positionLabel(user);

  const shiftDate    = wiw.shiftDateKey(shift);
  const shiftDisplay = `${wiw.formatShiftDate(shift)} ${wiw.formatShiftTime(shift)}`;
  const hours        = wiw.shiftHours(shift);

  const shiftsToday  = await wiw.getUserShiftsOnDate(shift.user_id, shiftDate);
  const isBackToBack = shiftsToday.length >= 2;

  console.log(`  Open shift ${shift.id}: ${name} (${position}), ${shiftDisplay} (${hours} hrs)`);

  const task = await createOpenShiftTask({
    provider: { name, position },
    shiftDate,
    shiftDisplay,
    shiftHours: hours,
    isBackToBack,
    now: new Date(),
  });

  if (task) console.log(`    Asana task: ${task?.data?.permalink_url || '(no url)'}`);
}

function makeUserCache() {
  const cache = new Map();
  return {
    async get(userId) {
      if (!cache.has(userId)) cache.set(userId, await wiw.getUser(userId));
      return cache.get(userId);
    },
  };
}

async function main() {
  console.log(`[${new Date().toISOString()}] Polling WIW for recent shift pickups...`);

  await wiw.login();
  const userCache = makeUserCache();

  // --- Dropped shifts (swaps) ---
  const swaps = await wiw.getRecentApprovedSwaps();
  console.log(`Found ${swaps.length} recent approved swap(s).`);
  for (const swap of swaps) {
    try { await processDroppedShift(swap, userCache); }
    catch (err) { console.error(`  Swap ${swap.id}: ERROR - ${err.message}`); }
  }

  // --- Open shift pickups (snapshot diff) ---
  // Load the previous snapshot of unassigned shifts, then compare to current
  // state. Any shift that was unassigned last run and is now assigned was picked up.
  // We don't rely on openshift_approval_request_id because this account auto-assigns
  // without creating an approval request record.
  const snapshot       = await loadSnapshot();
  const allShifts      = await wiw.getLocationShifts();
  const nowUnassigned  = allShifts.filter(s => !s.user_id || s.user_id === 0);
  const pickedUp       = snapshot.capturedAt
    ? allShifts.filter(s => s.user_id && s.user_id !== 0 && snapshot.unassignedIds.has(s.id))
    : [];

  console.log(`Snapshot from: ${snapshot.capturedAt || 'none'} — ${snapshot.unassignedIds.size} previously unassigned.`);
  console.log(`Found ${pickedUp.length} open shift pickup(s).`);

  for (const shift of pickedUp) {
    try { await processOpenShiftPickup(shift, userCache); }
    catch (err) { console.error(`  Shift ${shift.id}: ERROR - ${err.message}`); }
  }

  await saveSnapshot(nowUnassigned, snapshot.sha);
  console.log(`Snapshot updated: ${nowUnassigned.length} unassigned shifts saved.`);

  console.log('Done.');
}

main().catch(err => {
  console.error('Fatal error:', err);
  process.exit(1);
});
