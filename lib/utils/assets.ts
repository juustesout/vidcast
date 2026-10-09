import type { AssetType } from '@/lib/types/asset';

const IMAGE_EXTENSIONS = new Set(['png', 'jpg', 'jpeg', 'webp', 'gif', 'svg']);
const VIDEO_EXTENSIONS = new Set(['mp4', 'mov', 'webm']);
const AUDIO_EXTENSIONS = new Set(['mp3', 'wav', 'm4a', 'aac', 'ogg']);

export function determineAssetType(filename: string, mimeType?: string): AssetType {
  const extension = filename.split('.').pop()?.toLowerCase() ?? '';

  if (mimeType?.startsWith('image/') || IMAGE_EXTENSIONS.has(extension)) {
    return 'image';
  }

  if (mimeType?.startsWith('video/') || VIDEO_EXTENSIONS.has(extension)) {
    return 'video';
  }

  if (mimeType?.startsWith('audio/') || AUDIO_EXTENSIONS.has(extension)) {
    return 'audio';
  }

  return 'graphic';
}
