import type { GenerationStatus } from '@/lib/types/generation';

const ALLOWED_TRANSITIONS: Record<GenerationStatus, GenerationStatus[]> = {
  planned: ['queued'],
  queued: ['generating'],
  generating: ['generated', 'failed', 'rejected'],
  generated: [],
  failed: ['queued'],
  rejected: ['queued']
};

export function canTransitionGenerationStatus(current: GenerationStatus, next: GenerationStatus, regenerate: boolean): boolean {
  if (regenerate && current === 'generated' && next === 'queued') {
    return true;
  }

  return ALLOWED_TRANSITIONS[current]?.includes(next) ?? false;
}

export function assertGenerationTransition(current: GenerationStatus, next: GenerationStatus, regenerate: boolean): void {
  if (!canTransitionGenerationStatus(current, next, regenerate)) {
    throw new Error(`Invalid generation status transition: ${current} -> ${next}`);
  }
}
