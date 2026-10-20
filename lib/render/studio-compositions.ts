import type { PresenterPipPosition, PresenterSceneSetting } from '@/lib/types/presenter';

/**
 * Presenter framing presets for the three studio compositions.
 *
 * Intro and news stay rectangular PiP in the studio's right-hand panel even
 * when the clip carries an alpha matte. Intro is deliberately larger than the
 * news PiP; outro keeps the presenter off screen.
 */
export type StudioCompositionKind = 'intro' | 'news' | 'outro';

export interface StudioPipPreset {
  position: PresenterPipPosition;
  widthRatio: number;
  marginRatio: number;
}

export const STUDIO_PIP_PRESETS: Record<Exclude<StudioCompositionKind, 'outro'>, StudioPipPreset> = {
  intro: { position: 'top_right', widthRatio: 0.26, marginRatio: 0.04 },
  news: { position: 'top_right', widthRatio: 0.2, marginRatio: 0.06 }
};

export function studioPresenterSceneSetting(
  kind: StudioCompositionKind,
  sceneId: string
): PresenterSceneSetting | undefined {
  if (kind === 'outro') {
    return undefined;
  }

  return {
    sceneId,
    layout: 'pip',
    pip: { ...STUDIO_PIP_PRESETS[kind] }
  };
}
