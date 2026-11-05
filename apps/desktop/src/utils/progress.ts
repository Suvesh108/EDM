export interface ProgressSpan {
  startPct: number;
  widthPct: number;
}

export interface WorkerByteSpan {
  start: number;
  end: number;
  pos: number;
}

/**
 * Merges adjacent and overlapping completed worker byte ranges into continuous spans.
 * Where spans are adjacent, they are merged into a single span so no seams appear.
 * When download is complete, returns exactly one span covering [0, 100%].
 */
export function getMergedProgressSpans(
  workers: WorkerByteSpan[] | undefined,
  sizeTotal: number,
  sizeDone: number,
  isComplete: boolean
): ProgressSpan[] {
  if (sizeTotal <= 0) {
    return [];
  }

  // When complete, render exactly ONE solid span with zero seams
  if (isComplete || (sizeDone >= sizeTotal && sizeTotal > 0)) {
    return [{ startPct: 0, widthPct: 100 }];
  }

  if (!workers || workers.length === 0) {
    const pct = Math.min(100, Math.max(0, (sizeDone / sizeTotal) * 100));
    return pct > 0 ? [{ startPct: 0, widthPct: pct }] : [];
  }

  // Collect downloaded byte intervals [w.start, Math.min(w.end, w.pos)]
  const completedRanges: [number, number][] = [];
  for (const w of workers) {
    const rangeStart = w.start;
    const rangeEnd = Math.min(w.end, Math.max(w.start, w.pos));
    if (rangeEnd > rangeStart) {
      completedRanges.push([rangeStart, rangeEnd]);
    }
  }

  if (completedRanges.length === 0) {
    const pct = Math.min(100, Math.max(0, (sizeDone / sizeTotal) * 100));
    return pct > 0 ? [{ startPct: 0, widthPct: pct }] : [];
  }

  // Sort by starting offset
  completedRanges.sort((a, b) => a[0] - b[0]);

  // Merge adjacent and overlapping intervals
  const merged: [number, number][] = [];
  let [curStart, curEnd] = completedRanges[0];

  for (let i = 1; i < completedRanges.length; i++) {
    const [nextStart, nextEnd] = completedRanges[i];
    // Check if adjacent (within 1 byte or overlap)
    if (nextStart <= curEnd + 1) {
      curEnd = Math.max(curEnd, nextEnd);
    } else {
      merged.push([curStart, curEnd]);
      curStart = nextStart;
      curEnd = nextEnd;
    }
  }
  merged.push([curStart, curEnd]);

  // If the single merged span covers the full size, return 100%
  if (merged.length === 1 && merged[0][0] === 0 && merged[0][1] >= sizeTotal - 1) {
    return [{ startPct: 0, widthPct: 100 }];
  }

  // Convert byte spans to percentage spans
  return merged.map(([start, end]) => {
    const startPct = (start / sizeTotal) * 100;
    const endPct = (end / sizeTotal) * 100;
    const widthPct = Math.max(0, endPct - startPct);
    return {
      startPct,
      widthPct,
    };
  });
}
