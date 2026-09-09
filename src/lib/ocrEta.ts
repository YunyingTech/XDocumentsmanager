import type { OcrEngine } from '../types';

interface OcrTimingSample {
  status: string;
  engine: OcrEngine;
  progress?: number | null;
  startedAt?: number;
  completedAt?: number;
}

export function ocrWorkerCount(engine: OcrEngine | undefined, rapidWorkerCount: number): number {
  if (engine === 'rapid') return Math.max(1, Math.trunc(rapidWorkerCount));
  if (engine === 'windows') return 2;
  return 1;
}

export function averageCompletedOcrDuration(
  tasks: OcrTimingSample[],
  engine: OcrEngine,
): number | null {
  const durations = tasks
    .filter((task) => task.engine === engine && task.status === 'completed' && task.startedAt !== undefined && task.completedAt !== undefined)
    .slice(-20)
    .map((task) => Math.max(1, task.completedAt! - task.startedAt!));
  if (durations.length === 0) return null;
  return durations.reduce((sum, duration) => sum + duration, 0) / durations.length;
}

export function estimateBulkOcrRemaining(
  tasks: OcrTimingSample[],
  remaining: number,
  workerCount: number,
  completedAverageMs: number | null,
  now = Date.now(),
): number | null {
  if (remaining <= 0) return 0;
  const running = tasks
    .filter((task) => task.status === 'running' && task.startedAt !== undefined && (task.progress ?? 0) > 0)
    .map((task) => {
      const elapsed = Math.max(0, now - task.startedAt!);
      const projectedTotal = elapsed * 100 / task.progress!;
      return { projectedTotal, remaining: Math.max(0, projectedTotal - elapsed) };
    });
  const samples = completedAverageMs === null
    ? running.map((sample) => sample.projectedTotal)
    : [completedAverageMs, ...running.map((sample) => sample.projectedTotal)];
  if (samples.length === 0) return null;

  const average = samples.reduce((sum, duration) => sum + duration, 0) / samples.length;
  const queued = Math.max(0, remaining - running.length);
  const runningWork = running.reduce((sum, sample) => sum + sample.remaining, 0);
  const longestRunning = running.reduce((longest, sample) => Math.max(longest, sample.remaining), 0);
  const parallelWork = (runningWork + queued * average) / Math.max(1, workerCount);
  return Math.round(Math.max(longestRunning, parallelWork));
}
