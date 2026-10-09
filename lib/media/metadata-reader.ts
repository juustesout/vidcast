import { imageSize } from 'image-size';
import { parseBuffer } from 'music-metadata';

import type { AssetType } from '@/lib/types/asset';

export interface MediaMetadata {
  mimeType?: string;
  width?: number;
  height?: number;
  duration?: number;
  filesize: number;
}

export interface MediaMetadataReader {
  read(buffer: Buffer, filename: string, mimeType: string, assetType: AssetType): Promise<MediaMetadata>;
}

function extension(filename: string): string {
  const parts = filename.toLowerCase().split('.');
  return parts.length > 1 ? parts[parts.length - 1] : '';
}

function isMp4Like(fileExtension: string, mimeType: string): boolean {
  return fileExtension === 'mp4' || fileExtension === 'mov' || fileExtension === 'm4v' || mimeType === 'video/mp4' || mimeType === 'video/quicktime';
}

function readMp4DurationSeconds(buffer: Buffer): number | undefined {
  // Lightweight ISO BMFF parser that finds mvhd and reads timescale/duration.
  let offset = 0;
  while (offset + 8 <= buffer.length) {
    const size = buffer.readUInt32BE(offset);
    const type = buffer.toString('ascii', offset + 4, offset + 8);
    if (size < 8) {
      break;
    }

    if (type === 'moov') {
      let inner = offset + 8;
      const moovEnd = offset + size;
      while (inner + 8 <= moovEnd && inner + 8 <= buffer.length) {
        const atomSize = buffer.readUInt32BE(inner);
        const atomType = buffer.toString('ascii', inner + 4, inner + 8);
        if (atomSize < 8) {
          break;
        }
        if (atomType === 'mvhd') {
          const version = buffer.readUInt8(inner + 8);
          if (version === 0) {
            const timescale = buffer.readUInt32BE(inner + 20);
            const duration = buffer.readUInt32BE(inner + 24);
            if (timescale > 0) {
              return duration / timescale;
            }
          } else if (version === 1) {
            const timescale = buffer.readUInt32BE(inner + 28);
            const durationHigh = buffer.readUInt32BE(inner + 32);
            const durationLow = buffer.readUInt32BE(inner + 36);
            const duration = durationHigh * 2 ** 32 + durationLow;
            if (timescale > 0) {
              return duration / timescale;
            }
          }
          return undefined;
        }
        inner += atomSize;
      }
    }

    offset += size;
  }

  return undefined;
}

class DefaultMediaMetadataReader implements MediaMetadataReader {
  async read(buffer: Buffer, filename: string, mimeType: string, assetType: AssetType): Promise<MediaMetadata> {
    const base: MediaMetadata = {
      mimeType,
      filesize: buffer.byteLength
    };

    if (assetType === 'image' || assetType === 'graphic') {
      try {
        const size = imageSize(buffer);
        return {
          ...base,
          width: size.width,
          height: size.height
        };
      } catch {
        return base;
      }
    }

    if (assetType === 'audio' || assetType === 'music' || assetType === 'voice') {
      try {
        const parsed = await parseBuffer(buffer, mimeType ? { mimeType } : undefined, { duration: true });
        return {
          ...base,
          duration: parsed.format.duration
        };
      } catch {
        return base;
      }
    }

    if (assetType === 'video') {
      const ext = extension(filename);
      if (isMp4Like(ext, mimeType)) {
        return {
          ...base,
          duration: readMp4DurationSeconds(buffer)
        };
      }

      try {
        const parsed = await parseBuffer(buffer, mimeType ? { mimeType } : undefined, { duration: true });
        return {
          ...base,
          duration: parsed.format.duration
        };
      } catch {
        return base;
      }
    }

    return base;
  }
}

export const mediaMetadataReader: MediaMetadataReader = new DefaultMediaMetadataReader();
