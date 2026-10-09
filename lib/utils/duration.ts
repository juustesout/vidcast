export function estimateNarrationSeconds(text: string): number {
  const words = text.trim().split(/\s+/).filter(Boolean).length;
  if (words === 0) {
    return 0;
  }

  return Math.max(1, Math.round((words / 155) * 60 * 10) / 10);
}

export function formatSeconds(value: number): string {
  return `${value.toFixed(1)} sec`;
}
