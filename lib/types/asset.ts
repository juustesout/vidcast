export type AssetType = 'image' | 'video' | 'audio' | 'music' | 'voice' | 'graphic';

export type AssetStatus = 'available' | 'missing' | 'processing' | 'failed' | 'planned' | 'imported' | 'generated';

export type AssetProvenance = 'imported' | 'generated' | 'stock' | 'derived';

export interface AssetGenerationTrace {
  generationId?: string;
  provider?: string;
  model?: string;
  prompt?: string;
  referenceIds?: string[];
}

export interface AssetMetadata {
  [key: string]: string | number | boolean | null | undefined;
}

export interface Asset {
  id: string;
  type: AssetType;
  status: AssetStatus;
  provenance: AssetProvenance;
  filename: string;
  localPath?: string;
  mimeType?: string;
  originalFilename?: string;
  source?: string;
  width?: number;
  height?: number;
  duration?: number;
  filesize?: number;
  metadata: AssetMetadata;
  generation?: AssetGenerationTrace;
  createdAt: string;
  updatedAt?: string;
}
