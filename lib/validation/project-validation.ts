import { ASPECT_RATIOS, ASSET_PROVENANCE_VALUES, ASSET_STATUS_VALUES, ASSET_TYPES, GENERATION_STATUSES, MOTION_PRESETS, OVERLAY_TYPES, SCENE_TYPES, TRANSITION_PRESETS } from '@/lib/constants';
import type { ExplainerSpec } from '@/lib/types/explainer';
import type { Project } from '@/lib/types/render';
import type { RenderIssue, RenderValidationResult } from '@/lib/types/render';
import type { VisualSpec } from '@/lib/types/scene';

function pushIssue(
  target: RenderIssue[],
  severity: RenderIssue['severity'],
  code: string,
  path: string,
  message: string
): void {
  target.push({ severity, code, path, message });
}

export function validateProject(project: Project): RenderValidationResult {
    const seenAssetIds = new Set<string>();
    const seenReferenceIds = new Set<string>();

  const errors: RenderIssue[] = [];
  const warnings: RenderIssue[] = [];
  const explainer = project.explainer as ExplainerSpec | undefined;

  if (!project.title.trim()) {
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

    if (!MOTION_PRESETS.includes(scene.render.motion.preset)) {
      pushIssue(errors, 'error', 'scene.motion.invalid', `scenes.${scene.id}.render.motion.preset`, 'Motion preset is not supported.');
    }

    if (!TRANSITION_PRESETS.includes(scene.render.transition.type)) {
      pushIssue(errors, 'error', 'scene.transition.invalid', `scenes.${scene.id}.render.transition.type`, 'Transition preset is not supported.');
    }

    if (scene.overlay && !OVERLAY_TYPES.includes(scene.overlay.type)) {
      pushIssue(errors, 'error', 'scene.overlay.invalid', `scenes.${scene.id}.overlay.type`, 'Overlay type is not supported.');
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

        if (typeof audioAsset.duration === 'number' && audioAsset.duration > scene.duration + 0.01) {
          pushIssue(warnings, 'warning', 'scene.narration.duration.tooLong', `scenes.${scene.id}.narration.audioAssetId`, `Narration audio (${audioAsset.duration.toFixed(2)}s) is longer than scene duration (${scene.duration.toFixed(2)}s).`);
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

  return {
    valid: errors.length === 0,
    errors,
    warnings
  };
}
