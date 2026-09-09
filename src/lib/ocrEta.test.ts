import { describe, expect, it } from 'vitest';
import { averageCompletedOcrDuration, estimateBulkOcrRemaining, ocrWorkerCount } from './ocrEta';

describe('OCR ETA calculations', () => {
  it('uses the engine-specific concurrency limit', () => {
    expect(ocrWorkerCount('rapid', 256)).toBe(256);
    expect(ocrWorkerCount('windows', 256)).toBe(2);
    expect(ocrWorkerCount('paddle', 256)).toBe(1);
  });

  it('averages only completed samples from the requested engine', () => {
    expect(averageCompletedOcrDuration([
      { status: 'completed', engine: 'rapid', startedAt: 1_000, completedAt: 3_000 },
      { status: 'completed', engine: 'windows', startedAt: 1_000, completedAt: 10_000 },
      { status: 'failed', engine: 'rapid', startedAt: 1_000, completedAt: 20_000 },
    ], 'rapid')).toBe(2_000);
  });

  it('accounts for partial running work and queued work in parallel', () => {
    const tasks = [
      { status: 'completed', engine: 'rapid' as const, startedAt: 0, completedAt: 1_000, progress: 100 },
      { status: 'running', engine: 'rapid' as const, startedAt: 9_000, progress: 50 },
    ];
    expect(estimateBulkOcrRemaining(tasks, 3, 2, 1_000, 10_000)).toBe(2_000);
    expect(estimateBulkOcrRemaining([], 0, 2, null, 10_000)).toBe(0);
    expect(estimateBulkOcrRemaining([], 3, 2, null, 10_000)).toBeNull();
  });
});
