'use client';

import Image from 'next/image';
import { useRef } from 'react';

import { isHtmlStillSlotImageAsset, listHtmlStillSlotImageAssets } from '@/lib/projects/html-still-slot-images';
import type { Asset } from '@/lib/types/asset';
import { joinProjectAssetUrl } from '@/lib/utils/project-files';

export interface HtmlStillSlotImagePickerProps {
  projectId: string;
  assets: readonly Asset[];
  excludeAssetIds?: readonly string[];
  value?: string;
  label?: string;
  onSelect: (assetId: string | undefined) => void;
  onImport: (file: File) => void;
}

export function HtmlStillSlotImagePicker({
  projectId,
  assets,
  excludeAssetIds,
  value,
  label = 'Image',
  onSelect,
  onImport
}: HtmlStillSlotImagePickerProps): JSX.Element {
  const fileInput = useRef<HTMLInputElement | null>(null);
  const eligible = listHtmlStillSlotImageAssets(assets, { excludeAssetIds });
  const selected = value ? assets.find((asset) => asset.id === value) : undefined;
  const selectedEligible = Boolean(selected && isHtmlStillSlotImageAsset(selected) && !excludeAssetIds?.includes(selected.id));
  const selectValue = selectedEligible && selected ? selected.id : '';

  return (
    <div className="rounded-2xl border border-slate-700/70 bg-slate-950/35 p-3 space-y-2">
      <p className="text-xs uppercase tracking-[0.2em] text-slate-500">{label}</p>
      <select
        aria-label={label}
        value={selectValue}
        onChange={(event) => onSelect(event.target.value || undefined)}
        className="w-full rounded-2xl border border-slate-700/70 bg-slate-950/30 px-3 py-2 text-sm text-slate-100"
      >
        <option value="">No image</option>
        {eligible.map((asset) => (
          <option key={asset.id} value={asset.id}>
            {asset.originalFilename || asset.filename}
          </option>
        ))}
      </select>
      {selected && selectedEligible ? (
        <div className="relative aspect-video overflow-hidden rounded-xl border border-slate-800 bg-slate-900">
          <Image
            src={joinProjectAssetUrl(projectId, selected.id)}
            alt={selected.originalFilename || selected.filename}
            fill
            unoptimized
            sizes="320px"
            className="object-cover"
          />
        </div>
      ) : null}
      {value && !selectedEligible ? (
        <p className="text-xs text-amber-200">Selected image is not a usable PNG, JPEG, or WebP project asset.</p>
      ) : null}
      <div className="flex gap-2">
        <button
          type="button"
          onClick={() => fileInput.current?.click()}
          className="rounded-2xl border border-slate-700 px-3 py-2 text-xs text-slate-200"
        >
          Import image
        </button>
        <button
          type="button"
          onClick={() => onSelect(undefined)}
          className="rounded-2xl border border-slate-700 px-3 py-2 text-xs text-slate-200"
        >
          Clear image
        </button>
      </div>
      <input
        ref={fileInput}
        type="file"
        accept="image/png,image/jpeg,image/webp,.png,.jpg,.jpeg,.webp"
        className="hidden"
        onChange={(event) => {
          const file = event.target.files?.[0];
          event.currentTarget.value = '';
          if (file) {
            onImport(file);
          }
        }}
      />
    </div>
  );
}
