/**
 * handler.js
 * Polling orchestrator. Runs on a GitHub Actions cron schedule.
 *
 * Detects pickups and trades by diffing this run's currently-assigned WIW
 * shifts against a snapshot of the last run's assigned shifts, rather than
 * watching for open shifts directly — this account's /shifts endpoint never
 * returns genuinely open/unassigned shifts under any parameters (confirmed
 * against WIW's own schedule export as ground truth; reported to WIW support).
 * Assigned-shift data has always been reliable, so a self-diff of that is
 * used instead. This also replaces the old /swaps-based trade detection: a
 * trade is just "same shift_id, different user_id" in this same diff.
 */

const wiw                        = require('./wiwClient');
const { createDroppedShiftTask, createOpenShiftTask, createDropPickupTask, pickAssignee } = require('./asanaClient');
const { loadSnapshot, saveSnapshot }                  = require('./snapshotClient');

// Routine weekly schedule publishing (skin-sage-wiw-publish-weekly-schedule,
// separate repo) creates a full batch of brand-new, already-assigned shift
// rows ~23-30 days out every Tuesday, all in one run. Without a guard, every
// shift in that batch would look identical to a real pickup (a shift_id never
// seen before, now assigned) and flood Asana with dozens of tasks at once.
// That job never reassigns an *existing* shift_id — only creates new ones for
// weeks that are currently empty — so trades need no guard at all: they're
// inherently immune since they always involve a shift_id we've already seen.
//
// The guard below only suppresses a newly-seen shift when BOTH signals match
// the batch's actual profile: (a) it arrived alongside an unusually large
// number of other newly-seen shifts in this same run, AND (b) it's far enough
// out in date to match where that job publishes. Deliberately not a plain
// date cutoff — a lone real pickup for a shift 15+ days out must still fire,
// since it was never part of a batch to begin with. Requiring both signals
// means a near-term pickup is never suppressed even if it happens to land in
// the same run as a real batch-publish.
const BATCH_SIZE_THRESHOLD  = 8;  // this many+ newly-seen shifts in one run looks like a publish batch, not individual pickups
const BATCH_MIN_DAYS_OUT    = 18; // safely under the ~23-30 day horizon the publish job actually targets

function daysOut(shiftDateKey) {
  return (new Date(`${shiftDateKey}T00:00:00Z`) - new Date(`${wiw.todayKey()}T00:00:00Z`)) / 86400000;
}

async function processTrade({ droppingUserId, pickingUserId, shift, userCache }) {
  const [pickingUser, droppingUser] = await Promise.all([
    userCache.get(pickingUserId),
    userCache.get(droppingUserId),
  ]);

  if (!wiw.isProvider(pickingUser)) {
    console.log(`  Shift ${shift.id}: picking user ${pickingUser?.first_name} is not a tracked provider position, skipping`);
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

  console.log(`  Trade — shift ${shift.id}: ${droppingName} → ${pickingName}, ${shiftDisplay} (${hours} hrs)${isUrgent ? ' [URGENT — assigned to Sofie]' : ''}`);

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

async function processPickup({ shift, userCache }) {
  const user = await userCache.get(shift.user_id);

  if (!wiw.isProvider(user)) {
    console.log(`  Shift ${shift.id}: user ${user?.first_name} is not a tracked provider position, skipping`);
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

  console.log(`  Pickup — shift ${shift.id}: ${name} (${position}), ${shiftDisplay} (${hours} hrs)${isUrgent ? ' [URGENT — assigned to Sofie]' : ''}`);

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

// Builds the snapshot payload for a set of currently-assigned shifts.
function toSnapshotMap(shifts) {
  return new Map(shifts.map(s => [s.id, {
    userId:     s.user_id,
    shiftDate:  wiw.shiftDateKey(s),
    startTime:  s.start_time,
    endTime:    s.end_time,
    positionId: s.position_id,
  }]));
}

async function main() {
  console.log(`[${new Date().toISOString()}] Polling WIW for recent shift pickups and trades...`);

  await wiw.login();
  const userCache = makeUserCache();

  const { assigned: previous, sha, isFirstRun } = await loadSnapshot();
  const currentShifts = await wiw.getAssignedShifts();
  console.log(`Fetched ${currentShifts.length} currently-assigned shift(s).`);

  if (isFirstRun) {
    await saveSnapshot(toSnapshotMap(currentShifts), sha);
    console.log(`First run — saved baseline snapshot of ${currentShifts.length} shift(s), no tasks created.`);
    return;
  }

  const trades    = [];
  const newlySeen = [];

  for (const shift of currentShifts) {
    const prev = previous.get(shift.id);
    if (!prev) {
      newlySeen.push(shift);
    } else if (prev.userId !== shift.user_id) {
      trades.push({ shift, droppingUserId: prev.userId, pickingUserId: shift.user_id });
    }
  }

  // Only suppress a newly-seen shift when it matches BOTH signals of the
  // weekly-publish batch's actual profile — see comment above BATCH_SIZE_THRESHOLD.
  const looksLikeBatch = newlySeen.length >= BATCH_SIZE_THRESHOLD;
  const pickups = [];
  for (const shift of newlySeen) {
    const shiftDate = wiw.shiftDateKey(shift);
    if (looksLikeBatch && daysOut(shiftDate) >= BATCH_MIN_DAYS_OUT) {
      console.log(`  Shift ${shift.id}: newly-assigned, part of a ${newlySeen.length}-shift batch and ${shiftDate} is far out — treating as routine weekly publish, tracking only`);
    } else {
      pickups.push(shift);
    }
  }

  console.log(`Found ${trades.length} trade(s) and ${pickups.length} pickup(s) (${newlySeen.length} newly-assigned total).`);

  for (const { shift, droppingUserId, pickingUserId } of trades) {
    try { await processTrade({ droppingUserId, pickingUserId, shift, userCache }); }
    catch (err) { console.error(`  Shift ${shift.id}: ERROR - ${err.message}`); }
  }

  for (const shift of pickups) {
    try { await processPickup({ shift, userCache }); }
    catch (err) { console.error(`  Shift ${shift.id}: ERROR - ${err.message}`); }
  }

  await saveSnapshot(toSnapshotMap(currentShifts), sha);
  console.log(`Snapshot updated: tracking ${currentShifts.length} assigned shift(s).`);

  console.log('Done.');
}

main().catch(err => {
  console.error('Fatal error:', err);
  process.exit(1);
});
