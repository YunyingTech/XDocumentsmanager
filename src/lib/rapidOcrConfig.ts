export const DEFAULT_RAPID_OCR_WORKERS = 3;
export const MAX_RAPID_OCR_WORKERS = 256;

export function rapidWorkerCountValue(value: string | number | null | undefined): number {
  const count = typeof value === 'number' ? value : Number.parseInt(value ?? '', 10);
  if (!Number.isFinite(count)) return DEFAULT_RAPID_OCR_WORKERS;
  return Math.min(MAX_RAPID_OCR_WORKERS, Math.max(1, Math.trunc(count)));
}
