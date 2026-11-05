import assert from "node:assert";
import { getMergedProgressSpans } from "./progress";
import type { WorkerByteSpan } from "./progress";

console.log("Running progress renderer unit tests...");

// Test 1: Empty or 0 size
assert.deepStrictEqual(getMergedProgressSpans([], 0, 0, false), []);

// Test 2: 100% complete always produces exactly ONE span covering full bar (0..100%)
const workers100: WorkerByteSpan[] = [
  { start: 0, end: 24, pos: 24 },
  { start: 25, end: 49, pos: 49 },
  { start: 50, end: 74, pos: 74 },
  { start: 75, end: 99, pos: 99 },
];
const result100 = getMergedProgressSpans(workers100, 100, 100, true);
assert.strictEqual(result100.length, 1);
assert.strictEqual(result100[0].startPct, 0);
assert.strictEqual(result100[0].widthPct, 100);

// Test 3: Unsorted and adjacent completed ranges merge into contiguous spans with no gaps
const unsortedWorkers: WorkerByteSpan[] = [
  { start: 50, end: 75, pos: 75 },
  { start: 0, end: 25, pos: 25 },
  { start: 25, end: 50, pos: 50 },
  { start: 75, end: 100, pos: 100 },
];
const resultMerged = getMergedProgressSpans(unsortedWorkers, 100, 100, false);
assert.strictEqual(resultMerged.length, 1);
assert.strictEqual(resultMerged[0].startPct, 0);
assert.strictEqual(resultMerged[0].widthPct, 100);

// Test 4: Partial download with real gaps between completed spans
const partialWorkers: WorkerByteSpan[] = [
  { start: 0, end: 25, pos: 25 },       // 0..25 completed
  { start: 25, end: 50, pos: 35 },      // 25..35 completed (adjacent to previous, merges into 0..35)
  { start: 50, end: 75, pos: 50 },      // 0 bytes done (gap from 35 to 75)
  { start: 75, end: 100, pos: 85 },     // 75..85 completed
];
const resultPartial = getMergedProgressSpans(partialWorkers, 100, 45, false);
assert.strictEqual(resultPartial.length, 2);
// First span: 0% to 35%
assert.strictEqual(resultPartial[0].startPct, 0);
assert.strictEqual(resultPartial[0].widthPct, 35);
// Second span: 75% to 85%
assert.strictEqual(resultPartial[1].startPct, 75);
assert.strictEqual(resultPartial[1].widthPct, 10);

console.log("All progress renderer unit tests passed successfully!");
