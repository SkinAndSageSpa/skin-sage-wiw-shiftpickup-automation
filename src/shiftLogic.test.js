const { describe, it } = require('node:test');
const assert = require('node:assert/strict');

const POSITION_ESTI = 11742907;
const POSITION_LMT  = 11742908;

function isProvider(positionIds) {
  return positionIds.some(id => id === POSITION_ESTI || id === POSITION_LMT);
}

function isBackToBack(shiftsOnDate) {
  return shiftsOnDate.length >= 2;
}

function droppingHasRemainingShift(remainingShifts) {
  return remainingShifts.length > 0;
}

const BATCH_SIZE_THRESHOLD = 8;
const BATCH_MIN_DAYS_OUT   = 18;

// Mirrors the batch-publish guard in handler.js: suppress a newly-seen shift
// only when it matches the routine weekly-publish batch's profile (large
// batch + far out) AND the user has been seen in a prior run. A never-before-
// seen user_id (a new hire's first published week) always bypasses
// suppression, even if the batch otherwise looks routine.
function shouldSuppressAsRoutinePublish({ newlySeenCount, daysOut, isKnownProvider }) {
  const looksLikeBatch = newlySeenCount >= BATCH_SIZE_THRESHOLD;
  const matchesBatchProfile = looksLikeBatch && daysOut >= BATCH_MIN_DAYS_OUT;
  return matchesBatchProfile && isKnownProvider;
}

describe('isProvider', () => {
  it('true for Esthetician', () => assert.ok(isProvider([POSITION_ESTI])));
  it('true for LMT', () => assert.ok(isProvider([POSITION_LMT])));
  it('false for non-provider', () => assert.ok(!isProvider([99999])));
  it('false for empty', () => assert.ok(!isProvider([])));
});

describe('isBackToBack', () => {
  it('true when 2 shifts', () => assert.ok(isBackToBack([{}, {}])));
  it('false when 1 shift', () => assert.ok(!isBackToBack([{}])));
  it('false when 0 shifts', () => assert.ok(!isBackToBack([])));
});

describe('droppingHasRemainingShift', () => {
  it('true when remaining shift exists', () => assert.ok(droppingHasRemainingShift([{}])));
  it('false when no remaining shifts', () => assert.ok(!droppingHasRemainingShift([])));
});

describe('shouldSuppressAsRoutinePublish', () => {
  it('suppresses a known provider\'s far-out batch shift', () => {
    assert.ok(shouldSuppressAsRoutinePublish({ newlySeenCount: 16, daysOut: 21, isKnownProvider: true }));
  });
  it('does not suppress a brand-new hire\'s far-out batch shift', () => {
    assert.ok(!shouldSuppressAsRoutinePublish({ newlySeenCount: 16, daysOut: 21, isKnownProvider: false }));
  });
  it('does not suppress when the batch is too small, regardless of tenure', () => {
    assert.ok(!shouldSuppressAsRoutinePublish({ newlySeenCount: 3, daysOut: 21, isKnownProvider: true }));
  });
  it('does not suppress a near-term shift, regardless of tenure', () => {
    assert.ok(!shouldSuppressAsRoutinePublish({ newlySeenCount: 16, daysOut: 5, isKnownProvider: true }));
  });
});
