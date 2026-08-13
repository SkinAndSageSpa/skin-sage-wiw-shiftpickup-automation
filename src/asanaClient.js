/**
 * asanaClient.js
 * Creates Asana tasks when a WIW shift is picked up.
 * All tasks assigned to servicesdirector@skinandsagespa.com (Sofie LaCarrubba).
 * Includes deduplication: checks for an existing task by name before creating.
 */

const ASANA_BASE_URL = 'https://app.asana.com/api/1.0';

const SPA_OPERATIONS_PROJECT_GID = process.env.ASANA_PROJECT_GID        || '1211852426828244';
const ASSIGNEE_GID               = process.env.ASANA_ASSIGNEE_GID       || '1214912621580962'; // assistant.eldestsister@gmail.com
const SOFIE_GID                  =                                          '1211841527818964'; // servicesdirector@skinandsagespa.com (Sofie LaCarrubba)
const PRIORITY_FIELD_GID         = process.env.ASANA_PRIORITY_FIELD_GID || '1204876556629872';
const PRIORITY_HIGH_OPTION_GID   = process.env.ASANA_PRIORITY_HIGH_GID  || '1204876556629873';

// Shifts within 24 hours go to Sofie for immediate action; others to the default assignee.
function pickAssignee(isUrgent) {
  return isUrgent ? SOFIE_GID : ASSIGNEE_GID;
}

let _workspaceGid = null;

function getHeaders() {
  const token = process.env.ASANA_ACCESS_TOKEN;
  if (!token) throw new Error('ASANA_ACCESS_TOKEN is not set.');
  return {
    'Authorization': `Bearer ${token}`,
    'Content-Type': 'application/json',
  };
}

function formatDate(date) {
  return date.toISOString().split('T')[0];
}

function shortDate(shiftDate) {
  const [, m, d] = shiftDate.split('-');
  return `${parseInt(m)}/${parseInt(d)}`;
}

// Task names double as the dedup key (see taskExists()), so two different
// shifts for the same person on the same day must not collide. Without a
// time in the name, a same-day double pickup/drop (confirmed: Ana picking
// up both of Steph's shifts on 2026-08-18/19) either silently skips the
// second task entirely (if the first is already searchable when the second
// dedup check runs) or creates two identically-named tasks that are
// impossible to tell apart in a task list (confirmed: 2026-08-24, both
// created, only one actually actioned in Mangomint).
function shortStartTime(shiftDisplay) {
  const m = shiftDisplay.match(/(\d{1,2}:\d{2}[ap]m)-/);
  return m ? m[1] : '';
}

async function getWorkspaceGid() {
  if (_workspaceGid) return _workspaceGid;
  const res  = await fetch(`${ASANA_BASE_URL}/projects/${SPA_OPERATIONS_PROJECT_GID}?opt_fields=workspace`, { headers: getHeaders() });
  const data = await res.json();
  _workspaceGid = data?.data?.workspace?.gid;
  if (!_workspaceGid) throw new Error('Could not resolve Asana workspace GID from project');
  return _workspaceGid;
}

async function taskExists(name) {
  const wsGid  = await getWorkspaceGid();
  const params = new URLSearchParams({ 'projects.any': SPA_OPERATIONS_PROJECT_GID, text: name, opt_fields: 'name', limit: '5' });
  const res    = await fetch(`${ASANA_BASE_URL}/workspaces/${wsGid}/tasks/search?${params}`, { headers: getHeaders() });
  const data   = await res.json();
  return (data.data || []).some(t => t.name === name);
}

async function createTask({ name, notes, dueDate, assigneeGid = ASSIGNEE_GID }) {
  const res = await fetch(`${ASANA_BASE_URL}/tasks`, {
    method: 'POST',
    headers: getHeaders(),
    body: JSON.stringify({
      data: {
        name,
        notes,
        due_on: dueDate,
        assignee: assigneeGid,
        projects: [SPA_OPERATIONS_PROJECT_GID],
        custom_fields: { [PRIORITY_FIELD_GID]: PRIORITY_HIGH_OPTION_GID },
      },
    }),
  });
  return res.json();
}

/**
 * Dropped shift picked up.
 * shiftDate     — YYYY-MM-DD, used in task name
 * shiftDisplay  — "Sun, 17 May 2026 4:45pm-8:30pm", used in notes
 */
async function createDroppedShiftTask({
  droppingProvider,
  pickingProvider,
  shiftDate,
  shiftDisplay,
  shiftHours,
  droppingHasRemainingShift,
  assigneeGid,
  now,
}) {
  const firstName = droppingProvider.name.split(' ')[0];
  const name  = `Update Mangomint Work Hours for ${firstName}'s ${shortDate(shiftDate)} ${shortStartTime(shiftDisplay)} Shift Drop`;
  const today = formatDate(now);

  if (await taskExists(name)) {
    console.log(`  Skipping (task already exists): ${name}`);
    return null;
  }

  const removeStep = droppingHasRemainingShift
    ? `3. Remove ${droppingProvider.name}'s shift on ${shiftDate}: ${shiftDisplay} (${shiftHours} hrs) — adjust hours only, do not mark "Not Working."`
    : `3. Remove ${droppingProvider.name}'s shift on ${shiftDate}: ${shiftDisplay} (${shiftHours} hrs) — mark schedule as "Not Working."`;

  return createTask({
    name,
    notes: [
      `Dropping Provider: ${droppingProvider.name} (${droppingProvider.position})`,
      `Picking Provider:  ${pickingProvider.name} (${pickingProvider.position})`,
      `Shift Date: ${shiftDisplay} (${shiftHours} hrs)`,
      '',
      'Action Required:',
      `1. Login to Skin & Sage Mangomint.`,
      `2. Apps --> Staff --> ${droppingProvider.name} --> Work Hours.`,
      removeStep,
    ].join('\n'),
    dueDate: today,
    assigneeGid,
  });
}

/**
 * Open shift picked up.
 * shiftDate     — YYYY-MM-DD, used in task name
 * shiftDisplay  — "Sun, 17 May 2026 4:45pm-8:30pm", used in notes
 */
async function createOpenShiftTask({
  provider,
  shiftDate,
  shiftDisplay,
  shiftHours,
  isBackToBack,
  assigneeGid,
  now,
}) {
  const firstName = provider.name.split(' ')[0];
  const name  = `Update Mangomint Work Hours for ${firstName}'s ${shortDate(shiftDate)} ${shortStartTime(shiftDisplay)} Shift Pickup`;
  const today = formatDate(now);

  if (await taskExists(name)) {
    console.log(`  Skipping (task already exists): ${name}`);
    return null;
  }

  const steps = [
    `1. Login to Skin & Sage Mangomint.`,
    `2. Apps --> Staff --> ${provider.name} --> Work Hours.`,
    `3. Adjust ${provider.name}'s schedule to reflect the picked-up shift: ${shiftDisplay} (${shiftHours} hrs).`,
  ];
  if (isBackToBack) {
    steps.push(`4. ${provider.name} is now working 2 shifts back-to-back on ${shiftDate}. Add a 30-min break at 1:00 PM or 4:45 PM.`);
  }

  return createTask({
    name,
    notes: [
      `Provider: ${provider.name} (${provider.position})`,
      `Shift Date: ${shiftDisplay} (${shiftHours} hrs)`,
      '',
      'Action Required:',
      ...steps,
    ].join('\n'),
    dueDate: today,
    assigneeGid,
  });
}

/**
 * Dropped shift picked up by another provider — open picker's books.
 * shiftDate     — YYYY-MM-DD, used in task name
 * shiftDisplay  — "Sun, 17 May 2026 4:45pm-8:30pm", used in notes
 */
async function createDropPickupTask({
  pickingProvider,
  droppingProvider,
  shiftDate,
  shiftDisplay,
  shiftHours,
  isBackToBack,
  assigneeGid,
  now,
}) {
  const firstName = pickingProvider.name.split(' ')[0];
  const name  = `Update Mangomint Work Hours for ${firstName}'s ${shortDate(shiftDate)} ${shortStartTime(shiftDisplay)} Shift Pickup`;
  const today = formatDate(now);

  if (await taskExists(name)) {
    console.log(`  Skipping (task already exists): ${name}`);
    return null;
  }

  const steps = [
    `1. Login to Skin & Sage Mangomint.`,
    `2. Apps --> Staff --> ${pickingProvider.name} --> Work Hours.`,
    `3. Adjust ${pickingProvider.name}'s schedule to reflect the picked-up shift: ${shiftDisplay} (${shiftHours} hrs).`,
  ];
  if (isBackToBack) {
    steps.push(`4. ${pickingProvider.name} is now working 2 shifts back-to-back on ${shiftDate}. Add a 30-min break at 1:00 PM or 4:45 PM.`);
  }

  return createTask({
    name,
    notes: [
      `Picking Provider:  ${pickingProvider.name} (${pickingProvider.position})`,
      `Dropping Provider: ${droppingProvider.name} (${droppingProvider.position})`,
      `Shift Date: ${shiftDisplay} (${shiftHours} hrs)`,
      '',
      'Action Required:',
      ...steps,
    ].join('\n'),
    dueDate: today,
    assigneeGid,
  });
}

module.exports = { createDroppedShiftTask, createOpenShiftTask, createDropPickupTask, pickAssignee };
