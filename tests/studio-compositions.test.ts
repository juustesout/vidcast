import { describe, expect, it } from 'vitest';

import {
  STUDIO_PIP_PRESETS,
  studioPresenterSceneSetting
} from '@/lib/render/studio-compositions';

describe('studio composition presenter presets', () => {
  it('keeps the intro presenter larger than the news PiP', () => {
    expect(STUDIO_PIP_PRESETS.intro.widthRatio).toBeGreaterThan(STUDIO_PIP_PRESETS.news.widthRatio);
    expect(STUDIO_PIP_PRESETS.intro.position).toBe('top_right');
    expect(STUDIO_PIP_PRESETS.news.position).toBe('top_right');
  });

  it('builds PiP scene settings for intro and news', () => {
    expect(studioPresenterSceneSetting('intro', 'scene-intro')).toEqual({
      sceneId: 'scene-intro',
      layout: 'pip',
      pip: { position: 'top_right', widthRatio: 0.26, marginRatio: 0.04 }
    });
    expect(studioPresenterSceneSetting('news', 'scene-news')).toEqual({
      sceneId: 'scene-news',
      layout: 'pip',
      pip: { position: 'top_right', widthRatio: 0.2, marginRatio: 0.06 }
    });
  });

  it('leaves the outro free of presenter settings', () => {
    expect(studioPresenterSceneSetting('outro', 'scene-outro')).toBeUndefined();
  });
});
