import { ASPECT_RATIOS, ASSET_PROVENANCE_VALUES, ASSET_STATUS_VALUES, ASSET_TYPES, GENERATION_STATUSES, MAX_SCENE_DURATION_SECONDS, MOTION_PRESETS, OVERLAY_MAX_FADE_SECONDS, OVERLAY_POSITIONS, OVERLAY_STYLE_LIMITS, OVERLAY_TYPES, SCENE_TYPES, TRANSITION_PRESETS } from '@/lib/constants';
import { isValidOverlayColor } from '@/lib/render/overlay-resolve';
import { formatSceneTiming, resolveMeasuredNarrationDuration, resolveSceneTiming } from '@/lib/render/scene-timing';
import type { ExplainerSpec } from '@/lib/types/explainer';
import type { Project } from '@/lib/types/render';
import type { RenderIssue, RenderValidationResult } from '@/lib/types/render';
import type { OverlaySpec, VisualSpec } from '@/lib/types/scene';
import { PRESENTER_DEFAULT_LIMITS, PRESENTER_LIMIT_CEILINGS, PRESENTER_PIP_LIMITS } from '@/lib/presenter/config';

function pushIssue(
  target: RenderIssue[],
  severity: RenderIssue['severity'],
  code: string,
  path: string,
  message: string
): void {
  target.push({ severity, code, path, message });
}

function isPlainObject(value: unknown): value is Record<string, unknown> {
  return Boolean(value) && typeof value === 'object' && !Array.isArray(value);
}

function isFiniteNumber(value: unknown): value is number {
  return typeof value === 'number' && Number.isFinite(value);
}

/**
 * Validate the optional `overlay.style` / `overlay.timing` fields introduced in
 * P29.1. Optional fields may be omitted or `null` (both mean "use the renderer
 * default"); explicitly present values must be well-typed and within bounds so
 * the authoring API returns a usable error instead of relying on silent
 * render-time clamping. `overlay.type` itself is validated by the caller.
 */
function validateOverlayStyleTiming(sceneId: string, overlay: OverlaySpec, errors: RenderIssue[]): void {
  const base = `scenes.${sceneId}.overlay`;

  if (overlay.position !== undefined && overlay.position !== null && !OVERLAY_POSITIONS.includes(overlay.position)) {
    pushIssue(errors, 'error', 'scene.overlay.position.invalid', `${base}.position`, 'Overlay position is not supported.');
  }

  if (overlay.text !== undefined && overlay.text !== null && typeof overlay.text !== 'string') {
    pushIssue(errors, 'error', 'scene.overlay.text.invalid', `${base}.text`, 'Overlay text must be a string.');
  }

  if (overlay.data !== undefined && overlay.data !== null && !isPlainObject(overlay.data)) {
    pushIssue(errors, 'error', 'scene.overlay.data.invalid', `${base}.data`, 'Overlay data must be an object.');
  }

  const style = overlay.style as unknown;
  if (style !== undefined && style !== null) {
    if (!isPlainObject(style)) {
      pushIssue(errors, 'error', 'scene.overlay.style.invalid', `${base}.style`, 'Overlay style must be an object.');
    } else {
      const { fontSize, color, box, margin } = style;
      if (fontSize !== undefined && fontSize !== null) {
        if (!isFiniteNumber(fontSize) || fontSize < OVERLAY_STYLE_LIMITS.MIN_FONT_SIZE || fontSize > OVERLAY_STYLE_LIMITS.MAX_FONT_SIZE) {
          pushIssue(errors, 'error', 'scene.overlay.style.fontSize.invalid', `${base}.style.fontSize`, `Overlay font size must be a number between ${OVERLAY_STYLE_LIMITS.MIN_FONT_SIZE} and ${OVERLAY_STYLE_LIMITS.MAX_FONT_SIZE}.`);
        }
      }
      if (margin !== undefined && margin !== null) {
        if (!isFiniteNumber(margin) || margin < OVERLAY_STYLE_LIMITS.MIN_MARGIN || margin > OVERLAY_STYLE_LIMITS.MAX_MARGIN) {
          pushIssue(errors, 'error', 'scene.overlay.style.margin.invalid', `${base}.style.margin`, `Overlay margin must be a number between ${OVERLAY_STYLE_LIMITS.MIN_MARGIN} and ${OVERLAY_STYLE_LIMITS.MAX_MARGIN}.`);
        }
      }
      if (color !== undefined && color !== null && !isValidOverlayColor(color)) {
        pushIssue(errors, 'error', 'scene.overlay.style.color.invalid', `${base}.style.color`, 'Overlay color must be a hex or FFmpeg named color.');
      }
      if (box !== undefined && box !== null && typeof box !== 'boolean') {
        pushIssue(errors, 'error', 'scene.overlay.style.box.invalid', `${base}.style.box`, 'Overlay box must be a boolean.');
      }
    }
  }

  const timing = overlay.timing as unknown;
  if (timing !== undefined && timing !== null) {
    if (!isPlainObject(timing)) {
      pushIssue(errors, 'error', 'scene.overlay.timing.invalid', `${base}.timing`, 'Overlay timing must be an object.');
    } else {
      for (const field of ['fadeInSeconds', 'fadeOutSeconds'] as const) {
        const value = timing[field];
        if (value === undefined || value === null) {
          continue;
        }
        if (!isFiniteNumber(value) || value < 0 || value > OVERLAY_MAX_FADE_SECONDS) {
          pushIssue(errors, 'error', `scene.overlay.timing.${field}.invalid`, `${base}.timing.${field}`, `Overlay ${field} must be a number between 0 and ${OVERLAY_MAX_FADE_SECONDS}.`);
        }
      }
    }
  }
}

function validatePresenter(project: Project, errors: RenderIssue[], warnings: RenderIssue[]): void {
  const presenter = project.presenter;
  if (!presenter) {
    return;
  }

  const sceneIds = new Set(project.scenes.map((scene) => scene.id));
  const seenSettings = new Set<string>();

  if (presenter.enabled && presenter.sceneSettings.length === 0) {
    pushIssue(warnings, 'warning', 'project.presenter.scenes.empty', 'presenter.sceneSettings', 'Presenter is enabled but no scene uses it.');
  }

  if (presenter.provider === 'heygen' && !presenter.avatarId) {
    pushIssue(warnings, 'warning', 'project.presenter.avatarId.missing', 'presenter.avatarId', 'A HeyGen avatar id is required before a real presenter clip can be generated.');
  }

  if ((presenter.maxGeneratedSeconds ?? PRESENTER_DEFAULT_LIMITS.MAX_GENERATED_SECONDS) > PRESENTER_LIMIT_CEILINGS.MAX_GENERATED_SECONDS) {
    pushIssue(errors, 'error', 'project.presenter.maxGeneratedSeconds.invalid', 'presenter.maxGeneratedSeconds', 'Presenter second budget exceeds the server ceiling.');
  }
  if ((presenter.maxPaidRequests ?? PRESENTER_DEFAULT_LIMITS.MAX_PAID_REQUESTS) > PRESENTER_LIMIT_CEILINGS.MAX_PAID_REQUESTS) {
    pushIssue(errors, 'error', 'project.presenter.maxPaidRequests.invalid', 'presenter.maxPaidRequests', 'Presenter paid-request budget exceeds the server ceiling.');
  }

  for (const setting of presenter.sceneSettings) {
    const base = `presenter.sceneSettings.${setting.sceneId}`;
    if (!sceneIds.has(setting.sceneId)) {
      pushIssue(errors, 'error', 'project.presenter.scene.missing', base, `Presenter references missing scene ${setting.sceneId}.`);
      continue;
    }
    if (seenSettings.has(setting.sceneId)) {
      pushIssue(errors, 'error', 'project.presenter.scene.duplicate', base, `Duplicate presenter setting for scene ${setting.sceneId}.`);
    }
    seenSettings.add(setting.sceneId);

    if (setting.layout === 'pip') {
      const widthRatio = setting.pip?.widthRatio;
      if (widthRatio !== undefined && (widthRatio < PRESENTER_PIP_LIMITS.MIN_WIDTH_RATIO || widthRatio > PRESENTER_PIP_LIMITS.MAX_WIDTH_RATIO)) {
        pushIssue(errors, 'error', 'project.presenter.pip.width.invalid', `${base}.pip.widthRatio`, `Presenter PiP width ratio must be between ${PRESENTER_PIP_LIMITS.MIN_WIDTH_RATIO} and ${PRESENTER_PIP_LIMITS.MAX_WIDTH_RATIO}.`);
      }
      const marginRatio = setting.pip?.marginRatio;
      if (marginRatio !== undefined && (marginRatio < PRESENTER_PIP_LIMITS.MIN_MARGIN_RATIO || marginRatio > PRESENTER_PIP_LIMITS.MAX_MARGIN_RATIO)) {
        pushIssue(errors, 'error', 'project.presenter.pip.margin.invalid', `${base}.pip.marginRatio`, `Presenter PiP margin ratio must be between ${PRESENTER_PIP_LIMITS.MIN_MARGIN_RATIO} and ${PRESENTER_PIP_LIMITS.MAX_MARGIN_RATIO}.`);
      }
    }
  }

  for (const clip of project.presenterClips ?? []) {
    if (!sceneIds.has(clip.sceneId)) {
      pushIssue(errors, 'error', 'project.presenterClip.scene.missing', `presenterClips.${clip.sceneId}`, `Presenter clip references missing scene ${clip.sceneId}.`);
      continue;
    }
    if (clip.status === 'generated') {
      const asset = project.assets.find((entry) => entry.id === clip.assetId);
      if (!asset || asset.status !== 'available' || !asset.localPath) {
        pushIssue(errors, 'error', 'project.presenterClip.asset.missing', `presenterClips.${clip.sceneId}.assetId`, `Presenter clip for scene ${clip.sceneId} is generated but its video asset is missing.`);
      }
    }
  }
}

export function validateProject(project: Project): RenderValidationResult {
    const seenAssetIds = new Set<string>();
    const seenReferenceIds = new Set<string>();

  const errors: RenderIssue[] = [];
  const warnings: RenderIssue[] = [];
  const explainer = project.explainer as ExplainerSpec | undefined;

  if (typeof project.title !== 'string' || !project.title.trim()) {
    pushIssue(errors, 'error', 'project.title.required', 'title', 'Project title is required.');
  }

  if (!ASPECT_RATIOS.includes(project.aspectRatio)) {
    pushIssue(errors, 'error', 'project.aspectRatio.invalid', 'aspectRatio', 'Aspect ratio is not supported.');
  }

  if (project.fps <= 0) {
    pushIssue(errors, 'error', 'project.fps.invalid', 'fps', 'FPS must be greater than zero.');
  }

  if (project.durationTarget <= 0) {
    pushIssue(errors, 'error', 'project.durationTarget.invalid', 'durationTarget', 'Target duration must be greater than zero.');
  }

  if (explainer) {
    if (explainer.brief.targetDurationSeconds <= 0) {
      pushIssue(errors, 'error', 'explainer.brief.targetDuration.invalid', 'explainer.brief.targetDurationSeconds', 'Explainer target duration must be greater than zero.');
    }

    const beatIds = new Set<string>();
    const beatOrders = new Set<number>();
    for (const beat of explainer.story.beats) {
      if (!beat.id.trim()) {
        pushIssue(errors, 'error', 'explainer.story.beat.id.required', 'explainer.story.beats', 'Every beat requires an id.');
      }
      if (beatIds.has(beat.id)) {
        pushIssue(errors, 'error', 'explainer.story.beat.id.duplicate', 'explainer.story.beats', `Duplicate beat id ${beat.id}.`);
      }
      beatIds.add(beat.id);

      if (beat.order <= 0) {
        pushIssue(errors, 'error', 'explainer.story.beat.order.invalid', 'explainer.story.beats', `Beat ${beat.id} has invalid order.`);
      }
      if (beatOrders.has(beat.order)) {
        pushIssue(errors, 'error', 'explainer.story.beat.order.duplicate', 'explainer.story.beats', `Duplicate beat order ${beat.order}.`);
      }
      beatOrders.add(beat.order);

      if (!beat.text.trim()) {
        pushIssue(warnings, 'warning', 'explainer.story.beat.text.empty', `explainer.story.beats.${beat.id}.text`, 'Beat text is empty.');
      }
    }

    const versionIds = new Set<string>();
    for (const version of explainer.story.versions) {
      if (!version.id.trim()) {
        pushIssue(errors, 'error', 'explainer.story.version.id.required', 'explainer.story.versions', 'Every script version requires an id.');
      }
      if (versionIds.has(version.id)) {
        pushIssue(errors, 'error', 'explainer.story.version.id.duplicate', 'explainer.story.versions', `Duplicate script version id ${version.id}.`);
      }
      versionIds.add(version.id);

      if (!version.script.trim()) {
        pushIssue(errors, 'error', 'explainer.story.version.script.required', 'explainer.story.versions', `Script version ${version.id} has empty script text.`);
      }
      if (!version.createdAt.trim()) {
        pushIssue(errors, 'error', 'explainer.story.version.createdAt.required', 'explainer.story.versions', `Script version ${version.id} is missing createdAt.`);
      }
    }

    const intentIds = new Set<string>();
    const approvedStatuses = new Set(['draft', 'approved']);
    for (const intent of explainer.sceneIntents) {
      if (!intent.id.trim()) {
        pushIssue(errors, 'error', 'explainer.sceneIntent.id.required', 'explainer.sceneIntents', 'Every scene intent requires an id.');
      }
      if (intentIds.has(intent.id)) {
        pushIssue(errors, 'error', 'explainer.sceneIntent.id.duplicate', 'explainer.sceneIntents', `Duplicate scene intent id ${intent.id}.`);
      }
      intentIds.add(intent.id);

      if (intent.order <= 0) {
        pushIssue(errors, 'error', 'explainer.sceneIntent.order.invalid', 'explainer.sceneIntents', `Scene intent ${intent.id} has invalid order.`);
      }

      if (!approvedStatuses.has(intent.status)) {
        pushIssue(errors, 'error', 'explainer.sceneIntent.status.invalid', 'explainer.sceneIntents', `Scene intent ${intent.id} has invalid status.`);
      }

      if (intent.beatIds.length === 0) {
        pushIssue(errors, 'error', 'explainer.sceneIntent.beatIds.required', 'explainer.sceneIntents', `Scene intent ${intent.id} must reference at least one beat.`);
      }

      for (const beatId of intent.beatIds) {
        if (!beatIds.has(beatId)) {
          pushIssue(errors, 'error', 'explainer.sceneIntent.beatIds.missing', 'explainer.sceneIntents', `Scene intent ${intent.id} references missing beat ${beatId}.`);
        }
      }

      if (intent.timing.durationSeconds <= 0) {
        pushIssue(errors, 'error', 'explainer.sceneIntent.timing.invalid', 'explainer.sceneIntents', `Scene intent ${intent.id} has invalid timing duration.`);
      }

      if (intent.materializedSceneId && !project.scenes.some((scene) => scene.id === intent.materializedSceneId)) {
        pushIssue(errors, 'error', 'explainer.sceneIntent.materializedScene.missing', 'explainer.sceneIntents', `Scene intent ${intent.id} references missing scene ${intent.materializedSceneId}.`);
      }
    }
  }

  const assetIds = new Set(project.assets.map((asset) => asset.id));
  const referenceIds = new Set(project.references.map((reference) => reference.id));

  function validateVisual(sceneId: string, visual: VisualSpec | undefined): void {
    if (!visual) {
      pushIssue(errors, 'error', 'scene.visual.required', `scenes.${sceneId}.visual`, 'Scene visual specification is required.');
      return;
    }

    if (visual.kind === 'asset') {
      if (!visual.assetId) {
        pushIssue(errors, 'error', 'scene.visual.asset.required', `scenes.${sceneId}.visual.assetId`, 'Existing asset visual requires an asset id.');
      } else if (!assetIds.has(visual.assetId)) {
        pushIssue(errors, 'error', 'scene.visual.asset.missing', `scenes.${sceneId}.visual.assetId`, `Referenced asset ${visual.assetId} does not exist.`);
      }
      return;
    }

    if (visual.kind === 'generated_image' || visual.kind === 'generated_video') {
      if (!GENERATION_STATUSES.includes(visual.generation.status)) {
        pushIssue(errors, 'error', 'scene.visual.generation.status.invalid', `scenes.${sceneId}.visual.generation.status`, 'Generation status is not supported.');
      }

      for (const referenceId of visual.generation.referenceIds ?? []) {
        if (!referenceIds.has(referenceId)) {
          pushIssue(errors, 'error', 'scene.visual.generation.reference.missing', `scenes.${sceneId}.visual.generation.referenceIds`, `Referenced generation reference ${referenceId} does not exist.`);
        }
      }

      // Image-to-video keyframes are references too; validate they resolve so a
      // typo surfaces at project validation instead of at provider submit time.
      for (const [field, frameReferenceId] of [
        ['startFrameReferenceId', visual.generation.startFrameReferenceId],
        ['endFrameReferenceId', visual.generation.endFrameReferenceId]
      ] as const) {
        if (frameReferenceId && !referenceIds.has(frameReferenceId)) {
          pushIssue(errors, 'error', 'scene.visual.generation.frameReference.missing', `scenes.${sceneId}.visual.generation.${field}`, `Referenced generation frame ${frameReferenceId} does not exist.`);
        }
      }

      if (visual.generation.status === 'generated' && !(visual.assetId ?? visual.generation.assetId)) {
        pushIssue(errors, 'error', 'scene.visual.generation.asset.required', `scenes.${sceneId}.visual.assetId`, 'Generated visuals require an asset id when status is generated.');
      }

      return;
    }

    if (visual.kind === 'text' && !visual.text.trim()) {
      pushIssue(warnings, 'warning', 'scene.visual.text.empty', `scenes.${sceneId}.visual.text`, 'Text visual is empty.');
    }
  }

  for (const scene of project.scenes) {
    if (scene.duration <= 0) {
      pushIssue(errors, 'error', 'scene.duration.invalid', `scenes.${scene.id}.duration`, 'Scene duration must be greater than zero.');
    }

    if (!SCENE_TYPES.includes(scene.type)) {
      pushIssue(errors, 'error', 'scene.type.invalid', `scenes.${scene.id}.type`, 'Scene type is not supported.');
    }

    if (!MOTION_PRESETS.includes(scene.render?.motion?.preset as (typeof MOTION_PRESETS)[number])) {
      pushIssue(errors, 'error', 'scene.motion.invalid', `scenes.${scene.id}.render.motion.preset`, 'Motion preset is not supported.');
    }

    if (!TRANSITION_PRESETS.includes(scene.render?.transition?.type as (typeof TRANSITION_PRESETS)[number])) {
      pushIssue(errors, 'error', 'scene.transition.invalid', `scenes.${scene.id}.render.transition.type`, 'Transition preset is not supported.');
    }

    if (scene.overlay && !OVERLAY_TYPES.includes(scene.overlay.type)) {
      pushIssue(errors, 'error', 'scene.overlay.invalid', `scenes.${scene.id}.overlay.type`, 'Overlay type is not supported.');
    }

    if (scene.overlay) {
      validateOverlayStyleTiming(scene.id, scene.overlay, errors);
    }

    for (const referenceId of scene.referenceIds) {
      if (!referenceIds.has(referenceId)) {
        pushIssue(errors, 'error', 'scene.reference.missing', `scenes.${scene.id}.referenceIds`, `Referenced reference ${referenceId} does not exist.`);
      }
    }

    if (scene.narration?.audioAssetId) {
      const audioAsset = project.assets.find((asset) => asset.id === scene.narration?.audioAssetId);
      if (!audioAsset) {
        pushIssue(errors, 'error', 'scene.narration.asset.missing', `scenes.${scene.id}.narration.audioAssetId`, `Narration asset ${scene.narration.audioAssetId} does not exist.`);
      } else {
        const isAudioType = audioAsset.type === 'audio' || audioAsset.type === 'music' || audioAsset.type === 'voice';
        if (!isAudioType) {
          pushIssue(errors, 'error', 'scene.narration.asset.invalidType', `scenes.${scene.id}.narration.audioAssetId`, `Narration asset ${audioAsset.id} is not an audio asset.`);
        }

        if (typeof audioAsset.duration === 'number' && audioAsset.duration > 0) {
          const timing = resolveSceneTiming({
            duration: scene.duration,
            narrationDuration: resolveMeasuredNarrationDuration(scene.narration, project.assets)
          });
          if (timing.exceedsMax) {
            pushIssue(
              errors,
              'error',
              'scene.narration.duration.exceedsMax',
              `scenes.${scene.id}.narration.audioAssetId`,
              `Narration requires ${timing.effectiveDuration.toFixed(2)}s (${formatSceneTiming(timing)}), which exceeds the ${MAX_SCENE_DURATION_SECONDS}s scene limit.`
            );
          }
        }
      }
    }

    if (scene.source?.sceneIntentId) {
      if (!explainer?.sceneIntents.some((intent) => intent.id === scene.source?.sceneIntentId)) {
        pushIssue(errors, 'error', 'scene.source.intent.missing', `scenes.${scene.id}.source.sceneIntentId`, `Scene ${scene.id} references missing scene intent ${scene.source.sceneIntentId}.`);
      }
      for (const beatId of scene.source.beatIds ?? []) {
        if (!explainer?.story.beats.some((beat) => beat.id === beatId)) {
          pushIssue(errors, 'error', 'scene.source.beat.missing', `scenes.${scene.id}.source.beatIds`, `Scene ${scene.id} references missing beat ${beatId}.`);
        }
      }
    }

    validateVisual(scene.id, scene.visual);
  }

  for (const asset of project.assets) {
    if (seenAssetIds.has(asset.id)) {
      pushIssue(errors, 'error', 'asset.id.duplicate', `assets.${asset.id}.id`, `Duplicate asset id ${asset.id}.`);
    }
    seenAssetIds.add(asset.id);

    if (!ASSET_TYPES.includes(asset.type)) {
      pushIssue(errors, 'error', 'asset.type.invalid', `assets.${asset.id}.type`, 'Asset type is not supported.');
    }

    if (!ASSET_PROVENANCE_VALUES.includes(asset.provenance)) {
      pushIssue(errors, 'error', 'asset.provenance.invalid', `assets.${asset.id}.provenance`, 'Asset provenance is not supported.');
    }

    if (!ASSET_STATUS_VALUES.includes(asset.status)) {
      pushIssue(errors, 'error', 'asset.status.invalid', `assets.${asset.id}.status`, 'Asset status is not supported.');
    }

    if (asset.localPath) {
      if (!asset.localPath.startsWith('assets/')) {
        pushIssue(errors, 'error', 'asset.path.invalid', `assets.${asset.id}.localPath`, 'Asset local path must be project-relative under assets/.');
      }
      if (asset.localPath.includes('..') || asset.localPath.includes('\\')) {
        pushIssue(errors, 'error', 'asset.path.unsafe', `assets.${asset.id}.localPath`, 'Asset local path contains unsafe segments.');
      }
    }

    if (asset.status === 'planned' || asset.status === 'processing') {
      pushIssue(warnings, 'warning', 'asset.notReady', `assets.${asset.id}`, `Asset ${asset.filename} is not ready yet.`);
    }

    if (asset.status === 'missing') {
      pushIssue(warnings, 'warning', 'asset.missing', `assets.${asset.id}`, `Asset ${asset.filename} is marked missing.`);
    }

    if (asset.generation?.referenceIds) {
      for (const referenceId of asset.generation.referenceIds) {
        if (!referenceIds.has(referenceId)) {
          pushIssue(errors, 'error', 'asset.generation.reference.missing', `assets.${asset.id}.generation.referenceIds`, `Referenced generation reference ${referenceId} does not exist.`);
        }
      }
    }
  }

  for (const reference of project.references) {
    if (seenReferenceIds.has(reference.id)) {
      pushIssue(errors, 'error', 'reference.id.duplicate', `references.${reference.id}.id`, `Duplicate reference id ${reference.id}.`);
    }
    seenReferenceIds.add(reference.id);

    if (!reference.name.trim()) {
      pushIssue(errors, 'error', 'reference.name.required', `references.${reference.id}.name`, 'Reference name is required.');
    }

    if (reference.filePath && !reference.filePath.trim()) {
      pushIssue(errors, 'error', 'reference.filePath.invalid', `references.${reference.id}.filePath`, 'Reference file path is invalid.');
    }

    if (reference.filePath) {
      if (!reference.filePath.startsWith('references/')) {
        pushIssue(errors, 'error', 'reference.path.invalid', `references.${reference.id}.filePath`, 'Reference file path must be project-relative under references/.');
      }
      if (reference.filePath.includes('..') || reference.filePath.includes('\\')) {
        pushIssue(errors, 'error', 'reference.path.unsafe', `references.${reference.id}.filePath`, 'Reference file path contains unsafe segments.');
      }
    }
  }

  if (project.music?.assetId) {
    const musicAsset = project.assets.find((asset) => asset.id === project.music?.assetId);
    if (!musicAsset) {
      pushIssue(errors, 'error', 'project.music.asset.missing', 'music.assetId', `Background music asset ${project.music.assetId} does not exist.`);
    } else if (musicAsset.type !== 'music' && musicAsset.type !== 'audio') {
      pushIssue(errors, 'error', 'project.music.asset.invalidType', 'music.assetId', `Background music asset ${musicAsset.id} is not a music or audio asset.`);
    }
  }

  validatePresenter(project, errors, warnings);

  return {
    valid: errors.length === 0,
    errors,
    warnings
  };
}
