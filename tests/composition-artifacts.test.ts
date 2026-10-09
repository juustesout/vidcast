import { describe, expect, it } from 'vitest';

import { createCompositionPaths } from '@/lib/render/composition-artifacts';

describe('composition artifacts', () => {
  it('creates deterministic composition output naming', () => {
    const paths = createCompositionPaths('project-test', 'composition-abc');
    expect(paths.relativeOutputPath).toBe('renders/compositions/final-composition-abc.mp4');
    expect(paths.outputPath.endsWith('final-composition-abc.mp4')).toBe(true);
    expect(paths.metadataPath.endsWith('final-composition-abc.json')).toBe(true);
  });
});
