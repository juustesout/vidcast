export function resolveNeighborSceneId(
  orderedIds: string[],
  selectedId: string | undefined,
  delta: -1 | 1
): string | undefined {
  if (orderedIds.length === 0) {
    return undefined;
  }

  const index = selectedId ? orderedIds.indexOf(selectedId) : 0;
  const current = index < 0 ? 0 : index;
  const next = current + delta;
  if (next < 0 || next >= orderedIds.length) {
    return undefined;
  }
  return orderedIds[next];
}
