import type { SceneResult, ScoredFrame } from "./types.js";

export function roundTimestamp(seconds: number): number {
  return Math.round(seconds * 1000) / 1000;
}

export interface GroupScenesOptions {
  sampleStepSeconds: number;
  searchId: string;
  threshold?: number;
}

/**
 * Groups ordered, scored frames into scene intervals.
 *
 * Rules enforced:
 * 1. Any known negative frame (`noul < threshold`) strictly splits intervals.
 * 2. Positive frames are only merged when they are consecutive sampled frames
 *    (`curr.index === prev.index + 1`) AND their measured timestamp gap does not
 *    exceed `sampleStepSeconds * 1.5` (never merging across unsupported gaps).
 * 3. A single isolated positive frame produces `startSeconds === endSeconds`.
 * 4. Each result's `id` is the winning question ID (`peakFrame.id`), so
 *    `result.score` equals `answers[result.id].noul`.
 */
export function groupFramesIntoScenes(
  frames: ScoredFrame[],
  options: GroupScenesOptions
): SceneResult[] {
  const threshold = options.threshold ?? 0.5;
  const maxAllowedGap = Math.max(options.sampleStepSeconds * 1.5, 0.001) + 1e-6;

  const sorted = [...frames].sort((a, b) => {
    if (a.index !== b.index) {
      return a.index - b.index;
    }
    return a.timestampSeconds - b.timestampSeconds;
  });

  const runs: ScoredFrame[][] = [];
  let currentRun: ScoredFrame[] = [];

  for (const frame of sorted) {
    if (!Number.isFinite(frame.noul) || frame.noul < threshold) {
      // Known negative frame: split any active run
      if (currentRun.length > 0) {
        runs.push(currentRun);
        currentRun = [];
      }
      continue;
    }

    if (currentRun.length === 0) {
      currentRun.push(frame);
      continue;
    }

    const prev = currentRun[currentRun.length - 1];
    const isConsecutiveIndex = frame.index === prev.index + 1;
    const timestampDelta = frame.timestampSeconds - prev.timestampSeconds;
    const isSupportedGap = timestampDelta >= -1e-6 && timestampDelta <= maxAllowedGap;

    if (isConsecutiveIndex && isSupportedGap) {
      currentRun.push(frame);
    } else {
      runs.push(currentRun);
      currentRun = [frame];
    }
  }

  if (currentRun.length > 0) {
    runs.push(currentRun);
  }

  const results: SceneResult[] = runs.map((run) => {
    const first = run[0];
    const last = run[run.length - 1];
    let peak = first;
    for (const candidate of run) {
      if (candidate.noul > peak.noul) {
        peak = candidate;
      }
    }

    return {
      id: peak.id,
      startSeconds: roundTimestamp(first.timestampSeconds),
      endSeconds: roundTimestamp(last.timestampSeconds),
      peakTimestampSeconds: roundTimestamp(peak.timestampSeconds),
      score: peak.noul,
      thumbnailUrl: `/api/searches/${encodeURIComponent(options.searchId)}/thumbnails/${encodeURIComponent(peak.id)}.jpg`
    };
  });

  results.sort((a, b) => {
    if (b.score !== a.score) {
      return b.score - a.score;
    }
    return a.startSeconds - b.startSeconds;
  });

  return results;
}
