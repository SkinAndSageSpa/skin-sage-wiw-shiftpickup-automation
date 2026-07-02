/**
 * handler.js
 * Polling orchestrator. Runs on a GitHub Actions cron schedule.
 * Fetches recent WIW shift pickups and creates Asana tasks for each one.
 */

const wiw                        = require('./wiwClient');
const { createDroppedShiftTask, createOpenShiftTask, createDropPickupTask, pickAssignee } = require('./asanaClient');
const { loadSnapshot, saveSnapshot }                  = require('./snapshotClient');

async function processDroppedShift(swap, userCache) {
  const droppingUserId = swap.creator_id;

  if (!droppingUserId) {
    console.log(`  Swap ${swap.id}: missing creator_id, skipping`);
    return;
  }

  // On one-sided drops, swap.user_id === creator_id (the dropper). The real picker
  // is shift.user_id after the swap completes (status=3).
  const shift = await wiw.getShift(swap.shift_id);
  const pickingUserId = shift.user_id;

  if (!pickingUserId || pickingUserId === 0 || String(pickingUserId) === String(droppingUserId)) {
    console.log(`  Swap ${swap.id}: shift not yet reassigned to a different picker, skipping`);
    return;
  }

  const [pickingUser, droppingUser] = await Promise.all([
    userCache.get(pickingUserId),
    userCache.get(droppingUserId),
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

  const [droppingShiftsToday, pickingShiftsToday] = await Promise.all([
    wiw.getUserShiftsOnDate(droppingUserId, shiftDate),
    wiw.getUserShiftsOnDate(pickingUserId,  shiftDate),
  ]);
  const droppingHasRemainingShift = droppingShiftsToday.length > 0;
  const pickingIsBackToBack       = pickingShiftsToday.length >= 2;
  const isUrgent                  = (new Date(shift.start_time) - Date.now()) < 24 * 60 * 60 * 1000;
  const assigneeGid               = pickAssignee(isUrgent);

  console.log(`  Swap ${swap.id}: ${droppingName} → ${pickingName}, ${shiftDisplay} (${hours} hrs)${isUrgent ? ' [URGENT — assigned to Sofie]' : ''}`);

  const [closeTask, openTask] = await Promise.all([
    createDroppedShiftTask({
      droppingProvider: { name: droppingName, position: droppingPosition },
      pickingProvider:  { name: pickingName,  position: pickingPosition  },
      shiftDate,
      shiftDisplay,
      shiftHours: hours,
      droppingHasRemainingShift,
      assigneeGid,
      now: new Date(),
    }),
    createDropPickupTask({
      pickingProvider:  { name: pickingName,  position: pickingPosition  },
      droppingProvider: { name: droppingName, position: droppingPosition },
      shiftDate,
      shiftDisplay,
      shiftHours: hours,
      isBackToBack: pickingIsBackToBack,
      assigneeGid,
      now: new Date(),
    }),
  ]);

  if (closeTask) console.log(`    Close-books task: ${closeTask?.data?.permalink_url || '(no url)'}`);
  if (openTask)  console.log(`    Open-books task:  ${openTask?.data?.permalink_url  || '(no url)'}`);
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
  const isUrgent     = (new Date(shift.start_time) - Date.now()) < 24 * 60 * 60 * 1000;
  const assigneeGid  = pickAssignee(isUrgent);

  console.log(`  Open shift ${shift.id}: ${name} (${position}), ${shiftDisplay} (${hours} hrs)${isUrgent ? ' [URGENT — assigned to Sofie]' : ''}`);

  const task = await createOpenShiftTask({
    provider: { name, position },
    shiftDate,
    shiftDisplay,
    shiftHours: hours,
    isBackToBack,
    assigneeGid,
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

  // --- Open shift pickups (accumulated watch-list diff) ---
  // We watch every shift ever seen unassigned — not just the ones seen on the
  // immediately preceding run — so a gap in any single run (failed WIW login,
  // transient API error, a truncated query) can't cause a permanent miss. A
  // shift stays watched until a run sees it assigned and successfully creates
  // its task, or its date passes unfilled. See snapshotClient.js for why.
  // We don't rely on openshift_approval_request_id because this account auto-assigns
  // without creating an approval request record.
  const snapshot  = await loadSnapshot();
  const watched   = snapshot.watched;
  const allShifts = await wiw.getLocationShifts();
  const byId      = new Map(allShifts.map(s => [s.id, s]));
  const todayKey  = wiw.todayKey();

  const pickedUp = [];
  for (const [id, info] of watched) {
    const shift = byId.get(id);
    if (!shift) {
      // Aged out of the 60-day window (or deleted) without ever being picked up.
      // Only prune once its date has passed, in case this is just a transient
      // gap in this run's query rather than a real disappearance.
      if (info.shiftDate && info.shiftDate < todayKey) {
        console.log(`  Shift ${id}: aged out unfilled (was ${info.shiftDate}), removing from watch`);
        watched.delete(id);
      }
      continue;
    }
    if (!info.shiftDate) info.shiftDate = wiw.shiftDateKey(shift); // backfill for migrated entries
    if (shift.user_id && shift.user_id !== 0) pickedUp.push(shift);
  }

  console.log(`Watching ${watched.size} open shift(s) (accumulated) — ${pickedUp.length} picked up this run.`);

  for (const shift of pickedUp) {
    try {
      await processOpenShiftPickup(shift, userCache);
      watched.delete(shift.id); // handled — stop watching
    } catch (err) {
      console.error(`  Shift ${shift.id}: ERROR - ${err.message} (staying watched, will retry next run)`);
    }
  }

  for (const shift of allShifts) {
    if ((!shift.user_id || shift.user_id === 0) && !watched.has(shift.id)) {
      watched.set(shift.id, { firstSeenAt: new Date().toISOString(), shiftDate: wiw.shiftDateKey(shift) });
    }
  }

  await saveSnapshot(watched, snapshot.sha);
  console.log(`Snapshot updated: watching ${watched.size} open shift(s).`);

  console.log('Done.');
}

main().catch(err => {
  console.error('Fatal error:', err);
  process.exit(1);
});
