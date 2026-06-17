/**
 * Private Eye flavor — minimal, tasteful detective copy so the app never feels
 * frozen while it's working. One short line per stage; the long "analyzing"
 * phase rotates a few so a slow page still shows life. Used sparingly.
 */
import type { StageKey } from '../workers/protocol.ts';

const ANALYZING = [
  'Examining the evidence…',
  'Reading the fine print…',
  'Following the paper trail…',
  'Dusting for details…',
  'Piecing it together…',
];

export const WARMING = 'Polishing the magnifying glass…';
export const CASE_CLOSED = 'Case closed.';

export function stageMessage(stage: StageKey, tick = 0): string {
  switch (stage) {
    case 'loading':
      return WARMING;
    case 'decoding':
      return 'Examining the evidence…';
    case 'analyzing':
      return ANALYZING[tick % ANALYZING.length]!;
    case 'finishing':
      return 'Closing the case…';
  }
}
