'use client';

import Image from 'next/image';
import { useEffect, useRef } from 'react';

export interface SceneLintItem {
  sceneId: string;
  order: number;
  type: string;
  durationLabel: string;
  statusLabel: string;
  selected: boolean;
  thumbnailUrl?: string;
  placeholder: string;
}

interface SceneLintProps {
  items: SceneLintItem[];
  onSelect: (sceneId: string) => void;
  onPrevious: () => void;
  onNext: () => void;
  canGoPrevious: boolean;
  canGoNext: boolean;
}

export function SceneLint({ items, onSelect, onPrevious, onNext, canGoPrevious, canGoNext }: SceneLintProps): JSX.Element {
  const scrollerRef = useRef<HTMLDivElement | null>(null);
  const selectedId = items.find((item) => item.selected)?.sceneId;

  useEffect(() => {
    const selected = scrollerRef.current?.querySelector<HTMLElement>('[data-selected="true"]');
    selected?.scrollIntoView({ behavior: 'smooth', inline: 'center', block: 'nearest' });
  }, [selectedId]);

  return (
    <div className="space-y-3">
      <div className="flex items-center justify-between gap-3">
        <button
          type="button"
          onClick={onPrevious}
          disabled={!canGoPrevious}
          className="rounded-2xl border border-slate-700 bg-slate-950/50 px-4 py-2 text-sm text-slate-200 disabled:opacity-40"
        >
          Previous scene
        </button>
        <button
          type="button"
          onClick={onNext}
          disabled={!canGoNext}
          className="rounded-2xl border border-slate-700 bg-slate-950/50 px-4 py-2 text-sm text-slate-200 disabled:opacity-40"
        >
          Next scene
        </button>
      </div>
      <div ref={scrollerRef} className="flex gap-3 overflow-x-auto studio-scrollbar pb-1">
        {items.map((item) => (
          <button
            key={item.sceneId}
            type="button"
            data-selected={item.selected ? 'true' : 'false'}
            onClick={() => onSelect(item.sceneId)}
            className={`w-[min(22vw,220px)] min-w-[180px] shrink-0 rounded-3xl border px-3 py-3 text-left transition ${item.selected ? 'border-amber-300/50 bg-amber-200/10' : 'border-slate-700/70 bg-slate-950/30 hover:border-slate-500/80'}`}
          >
            <div className="relative mb-2 aspect-video overflow-hidden rounded-2xl bg-slate-900">
              {item.thumbnailUrl ? (
                <Image src={item.thumbnailUrl} alt={`Scene ${item.order}`} fill unoptimized sizes="220px" className="object-cover" />
              ) : (
                <div className="flex h-full items-center justify-center px-2 text-center text-[11px] uppercase tracking-[0.18em] text-slate-400">
                  {item.placeholder}
                </div>
              )}
            </div>
            <p className="font-mono text-[10px] uppercase tracking-[0.3em] text-slate-500">Scene {String(item.order).padStart(2, '0')}</p>
            <p className="mt-1 text-sm font-semibold text-white">{item.type.toUpperCase()}</p>
            <p className="mt-1 text-xs text-slate-400">{item.durationLabel}</p>
            <p className="mt-1 text-xs text-slate-300">{item.statusLabel}</p>
          </button>
        ))}
      </div>
    </div>
  );
}
