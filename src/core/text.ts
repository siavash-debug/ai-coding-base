export function normalizeText(value: string): string {
  return value.trim().replace(/\s+/g, " ");
}
