export interface VisibilityTarget {
  visibilityState: string;
  addEventListener(type: 'visibilitychange', listener: () => void): void;
  removeEventListener(type: 'visibilitychange', listener: () => void): void;
}

export function isHidden(visibilityState: string | undefined): boolean {
  return visibilityState === 'hidden';
}

export function resumedFromHidden(previousHidden: boolean, nextHidden: boolean): boolean {
  return previousHidden && !nextHidden;
}

export function subscribeToVisibility(
  handler: (hidden: boolean) => void,
  target?: VisibilityTarget | null
): () => void {
  const doc = target ?? (typeof document !== 'undefined' ? (document as unknown as VisibilityTarget) : null);
  if (!doc) {
    return () => {};
  }

  const listener = () => handler(isHidden(doc.visibilityState));
  doc.addEventListener('visibilitychange', listener);

  return () => doc.removeEventListener('visibilitychange', listener);
}
