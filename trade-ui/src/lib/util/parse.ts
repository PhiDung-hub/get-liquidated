export function num(v: unknown, field: string): number {
  const n = typeof v === 'number' ? v : typeof v === 'string' ? Number(v) : NaN;
  if (!Number.isFinite(n)) throw new Error(`payload: ${field} is not a number (${String(v)})`);
  return n;
}
export const optNum = (v: unknown): number | null => {
  const n = v == null ? NaN : Number(v);
  return Number.isFinite(n) ? n : null;
};
export function str(v: unknown, field: string): string {
  if (typeof v !== 'string') throw new Error(`payload: ${field} is not a string`);
  return v;
}
export function arr<T = unknown>(v: unknown, field: string): T[] {
  if (!Array.isArray(v)) throw new Error(`payload: ${field} is not an array`);
  return v as T[];
}
