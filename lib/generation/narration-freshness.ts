import type { Asset } from '@/lib/types/asset';
import type { Project } from '@/lib/types/render';
import type { NarrationSpec, Scene } from '@/lib/types/scene';

export type NarrationFreshnessState =
  | 'no_narration'
  | 'no_audio'
  | 'generating'
  | 'failed'
  | 'current'
  | 'stale';

export interface NarrationFreshness {
  sceneId: string;
  state: NarrationFreshnessState;
  reason?: string;
  narrationSignature: string;
  linkedAudioAssetId?: string;
}

function normalize(value: string | undefined): string {
  return (value ?? '').trim();
}

function getLatestGeneratedAttempt(narration: NarrationSpec | undefined) {
  const attempts = narration?.attempts ?? [];
  for (let index = attempts.length - 1; index >= 0; index -= 1) {
    if (attempts[index].status === 'generated') {
      return attempts[index];
    }
  }
  return undefined;
}

function narrationInputSignature(input: {
  text: string;
  voiceId: string;
  model: string;
  format: string;
  audioAssetId: string;
}): string {
  return [
    `text:${input.text}`,
    `voice:${input.voiceId}`,
    `model:${input.model}`,
    `format:${input.format}`,
    `asset:${input.audioAssetId}`
  ].join('|');
}

function expectedSignatureFromCurrent(scene: Scene): string {
  const narration = scene.narration;
  return narrationInputSignature({
    text: normalize(narration?.text),
    voiceId: normalize(narration?.voiceId),
    model: normalize(narration?.model),
    format: normalize(narration?.format),
    audioAssetId: normalize(narration?.audioAssetId)
  });
}

function generatedSignatureFromRecordedInputs(scene: Scene, asset: Asset | undefined): string {
  const narration = scene.narration;
  const generatedAttempt = getLatestGeneratedAttempt(narration);

  const generatedText = normalize(typeof asset?.generation?.prompt === 'string' ? asset.generation.prompt : narration?.text);
  const generatedVoice = normalize(
    typeof asset?.metadata?.voiceId === 'string'
      ? asset.metadata.voiceId
      : generatedAttempt?.voiceId
  );
  const generatedModel = normalize(
    typeof asset?.generation?.model === 'string'
      ? asset.generation.model
      : generatedAttempt?.model
  );
  const generatedFormat = normalize(generatedAttempt?.format ?? narration?.format);
  const generatedAudioAssetId = normalize(narration?.audioAssetId);

  return narrationInputSignature({
    text: generatedText,
    voiceId: generatedVoice,
    model: generatedModel,
    format: generatedFormat,
    audioAssetId: generatedAudioAssetId
  });
}

function resolveLinkedAudioAsset(project: Project, narration: NarrationSpec | undefined): Asset | undefined {
  const assetId = narration?.audioAssetId;
  if (!assetId) {
    return undefined;
  }
  return project.assets.find((asset) => asset.id === assetId);
}

export function deriveNarrationFreshness(project: Project, scene: Scene): NarrationFreshness {
  const narration = scene.narration;
  const narrationSignature = expectedSignatureFromCurrent(scene);

  if (!narration || !normalize(narration.text)) {
    return {
      sceneId: scene.id,
      state: 'no_narration',
      reason: 'Narration text is empty.',
      narrationSignature
    };
  }

  if (narration.status === 'generating') {
    return {
      sceneId: scene.id,
      state: 'generating',
      reason: 'Narration generation is running.',
      narrationSignature,
      linkedAudioAssetId: narration.audioAssetId
    };
  }

  if (narration.status === 'failed') {
    return {
      sceneId: scene.id,
      state: 'failed',
      reason: narration.error || 'Narration generation failed.',
      narrationSignature,
      linkedAudioAssetId: narration.audioAssetId
    };
  }

  const asset = resolveLinkedAudioAsset(project, narration);
  if (!narration.audioAssetId || !asset) {
    return {
      sceneId: scene.id,
      state: 'no_audio',
      reason: 'Narration text exists but no generated audio is linked.',
      narrationSignature,
      linkedAudioAssetId: narration.audioAssetId
    };
  }

  const generatedSignature = generatedSignatureFromRecordedInputs(scene, asset);
  if (generatedSignature !== narrationSignature) {
    return {
      sceneId: scene.id,
      state: 'stale',
      reason: 'Narration inputs changed after audio generation.',
      narrationSignature,
      linkedAudioAssetId: narration.audioAssetId
    };
  }

  return {
    sceneId: scene.id,
    state: 'current',
    reason: 'Narration audio matches current narration inputs.',
    narrationSignature,
    linkedAudioAssetId: narration.audioAssetId
  };
}
