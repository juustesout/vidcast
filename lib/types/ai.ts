import type { AspectRatio } from './render';
import type { ReferenceImage } from './reference';

export interface GenerationMetadata {
  [key: string]: string | number | boolean | null | undefined;
}

export interface VisualGenerationRequest {
  prompt: string;
  negativePrompt?: string;
  referenceImages: ReferenceImage[];
  aspectRatio: AspectRatio;
  style?: string;
  metadata?: GenerationMetadata;
  seed?: number;
}

export type ImageGenerationRequest = VisualGenerationRequest;

export interface VideoGenerationRequest extends VisualGenerationRequest {
  durationSeconds: number;
}

export interface ScriptGenerationRequest {
  title: string;
  description: string;
  targetDurationSeconds: number;
  referenceImages: ReferenceImage[];
  metadata?: GenerationMetadata;
}

export interface ImageGenerator {
  generateImage(request: ImageGenerationRequest): Promise<unknown>;
}

export interface VideoGenerator {
  generateVideo(request: VideoGenerationRequest): Promise<unknown>;
}

export interface ScriptGenerator {
  generateScript(request: ScriptGenerationRequest): Promise<unknown>;
}
