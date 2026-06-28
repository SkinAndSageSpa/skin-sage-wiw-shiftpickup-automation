/**
 * One-shot script: creates the two missed Asana tasks for the
 * Saralyn Bustos → Amber Croyl drop on 2026-06-28.
 * Run via GitHub Actions (needs ASANA_ACCESS_TOKEN + ASANA_PROJECT_GID secrets).
 * Delete this file after the workflow run completes.
 */

const { createDroppedShiftTask, createDropPickupTask } = require('../src/asanaClient');

const SHIFT_DATE    = '2026-06-28';
const SHIFT_DISPLAY = 'Sun, 28 Jun 2026 1:00pm-4:45pm';
const SHIFT_HOURS   = 3.75;

const droppingProvider = { name: 'Saralyn Bustos', position: 'Massage Therapist' };
const pickingProvider  = { name: 'Amber Croyl',    position: 'Massage Therapist' };

async function main() {
  console.log('Creating manual Asana tasks for missed shift pickup...');

  const [closeTask, openTask] = await Promise.all([
    createDroppedShiftTask({
      droppingProvider,
      pickingProvider,
      shiftDate: SHIFT_DATE,
      shiftDisplay: SHIFT_DISPLAY,
      shiftHours: SHIFT_HOURS,
      droppingHasRemainingShift: false,
      now: new Date(),
    }),
    createDropPickupTask({
      pickingProvider,
      droppingProvider,
      shiftDate: SHIFT_DATE,
      shiftDisplay: SHIFT_DISPLAY,
      shiftHours: SHIFT_HOURS,
      isBackToBack: false,
      now: new Date(),
    }),
  ]);

  if (closeTask) console.log('Close-books task:', closeTask?.data?.permalink_url || JSON.stringify(closeTask));
  if (openTask)  console.log('Open-books task: ', openTask?.data?.permalink_url  || JSON.stringify(openTask));
  console.log('Done.');
}

main().catch(err => { console.error(err); process.exit(1); });
