#!/usr/bin/env node
'use strict';

// AGG-DEADNESS-1 (consumer): coverage for the confirmed-dead hide path in
// aggregator-consumer.js. The producer's link-checker writes hard-404/410,
// recurrence-confirmed ids to data/stale-job-candidates.json; the consumer reads
// it fresh each generation and hides matching ids everywhere (tag-not-filter
// preserved — producer rows are never dropped). These tests pin the exclusion
// logic and the defensive R2 read (missing/empty list => no jobs hidden).

const assert = require('assert');
const { applyDeadList, fetchDeadJobIds } = require('../aggregator-consumer');
(async () => {

function mkJob(id, extra = {}) {
  return { id, title: `Job ${id}`, source: 'simplify', posted_at: new Date().toISOString(), tags: { domains: ['software'], locations: ['us'] }, ...extra };
}

// --- Case 1: a sample dead id is excluded; all others are kept ---
{
  const jobs = [mkJob('alive1'), mkJob('DEAD_BAE_410'), mkJob('alive2')];
  const deadIds = new Set(['DEAD_BAE_410']);
  const kept = applyDeadList(jobs, deadIds);
  assert.deepStrictEqual(kept.map(j => j.id), ['alive1', 'alive2'],
    'the confirmed-dead id must be removed and only that one');
  console.log('✓ case 1: confirmed-dead id excluded, survivors kept');
}

// --- Case 2: empty / null / non-array inputs are no-ops (defensive) ---
{
  const jobs = [mkJob('a'), mkJob('b')];
  assert.strictEqual(applyDeadList(jobs, new Set()), jobs, 'empty dead set returns input unchanged');
  assert.strictEqual(applyDeadList(jobs, null), jobs, 'null dead set returns input unchanged');
  assert.deepStrictEqual(applyDeadList(null, new Set(['a'])), null, 'non-array jobs returned as-is');
  console.log('✓ case 2: empty/null/non-array inputs are defensive no-ops');
}

// --- Case 3: real producer shape {checked_at, dead:[{id,...}]} is honored ---
{
  const candidatesFile = { checked_at: '2026-07-02T00:00:00Z', dead: [{ id: 'X1', status: 'dead', code: 410 }, { id: 'X2', status: 'dead', code: 404 }] };
  const deadIds = new Set(candidatesFile.dead.map(d => d.id).filter(Boolean));
  const jobs = [mkJob('X1'), mkJob('keep'), mkJob('X2')];
  assert.deepStrictEqual(applyDeadList(jobs, deadIds).map(j => j.id), ['keep'],
    'both hard-410/404 dead ids hidden when parsed from the producer file shape');
  console.log('✓ case 3: producer file shape {checked_at, dead:[{id}]} parsed correctly');
}

// --- Case 4: fetchDeadJobIds is defensive when R2 is NOT configured (no throw, empty Set) ---
{
  const saved = ['R2_BUCKET_NAME', 'R2_ACCESS_KEY_ID', 'R2_SECRET_ACCESS_KEY', 'R2_ENDPOINT'].map(k => [k, process.env[k]]);
  for (const [k] of saved) delete process.env[k];
  const ids = await fetchDeadJobIds();
  assert.ok(ids instanceof Set && ids.size === 0, 'unconfigured R2 must yield an empty Set, never throw');
  for (const [k, v] of saved) { if (v !== undefined) process.env[k] = v; }
  console.log('✓ case 4: fetchDeadJobIds returns empty Set (no throw) when R2 unconfigured');
}

// --- Case 5: fetchDeadJobIds against REAL R2 for the (currently missing/empty) list ---
// End-to-end defensiveness: downloadJson returns null for a missing object, and a
// present-but-empty {dead:[]} yields zero ids. In both cases no job is ever hidden.
{
  const ids = await fetchDeadJobIds();
  assert.ok(ids instanceof Set, 'fetchDeadJobIds always returns a Set');
  // The list is currently empty/missing — so size MUST be 0 today. Once the Simplify
  // age-bypass detection run populates it, this assert is the canary that it is read live.
  assert.strictEqual(ids.size, 0, 'real R2 dead list is currently empty/missing — nothing hidden yet');
  console.log(`✓ case 5: live R2 read of stale-job-candidates.json returned ${ids.size} ids (missing/empty => nothing hidden)`);
}

  console.log('\nAll consumer dead-list tests passed.');
})();
