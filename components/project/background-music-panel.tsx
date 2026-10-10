'use client';

import { useRef, useState } from 'react';

import { clearProjectMusicRequest, generateProjectMusicRequest, selectProjectMusicRequest } from '@/lib/client/music-client';
import {
  formatMusicSeconds,
  listMusicCandidateAssets,
  MUSIC_DEFAULT_DURATION_SECONDS,
  MUSIC_MAX_DURATION_SECONDS,
  MUSIC_MIN_DURATION_SECONDS,
  resolveSelectedMusicAsset,
  validateMusicForm
} from '@/lib/music/music-form';
import { createSingleFlight, type SingleFlight } from '@/lib/utils/single-flight';
import type { Project } from '@/lib/types/render';

interface BackgroundMusicPanelProps {
  project: Project;
  onRefresh: () => Promise<Project | null>;
}

type BusyState = 'idle' | 'generating' | 'regenerating' | 'selecting' | 'clearing';
type Feedback = { tone: 'success' | 'error'; text: string } | null;

export function BackgroundMusicPanel({ project, onRefresh }: BackgroundMusicPanelProps): JSX.Element {
  const music = project.music;
  const selectedAsset = resolveSelectedMusicAsset(project);
  const candidates = listMusicCandidateAssets(project);
  const existingSeconds = typeof music?.musicLengthMs === 'number' ? Math.round(music.musicLengthMs / 1000) : undefined;

  const [prompt, setPrompt] = useState(music?.prompt ?? '');
  const [durationSeconds, setDurationSeconds] = useState<string>(existingSeconds ? String(existingSeconds) : '');
  const [instrumental, setInstrumental] = useState(music?.instrumental ?? true);
  const [busy, setBusy] = useState<BusyState>('idle');
  const [feedback, setFeedback] = useState<Feedback>(null);
  const [candidateId, setCandidateId] = useState('');

  // Single-flight guard: a second click while a request is in flight is ignored.
  const flightRef = useRef<SingleFlight | null>(null);
  if (!flightRef.current) {
    flightRef.current = createSingleFlight();
  }
  const flight = flightRef.current;

  const isBusy = busy !== 'idle';
  const hasSelection = Boolean(music?.assetId && selectedAsset);

  function applyResult(result: Awaited<ReturnType<typeof generateProjectMusicRequest>> | undefined): void {
    if (!result) {
      return;
    }
    setFeedback(result.ok ? { tone: 'success', text: result.message } : { tone: 'error', text: result.message });
  }

  async function submitForm(regenerate: boolean): Promise<void> {
    const validation = validateMusicForm(
      { prompt, durationSeconds, instrumental },
      { defaultDurationSeconds: existingSeconds ?? MUSIC_DEFAULT_DURATION_SECONDS }
    );

    if (!validation.ok || !validation.payload) {
      setFeedback({ tone: 'error', text: validation.errors.prompt ?? validation.errors.duration ?? 'Check the form and try again.' });
      return;
    }

    const result = await flight.run(async () => {
      setBusy(regenerate ? 'regenerating' : 'generating');
      const response = await generateProjectMusicRequest(project.id, { ...validation.payload!, regenerate });
      await onRefresh();
      return response;
    });

    if (result === undefined) {
      return;
    }

    setBusy('idle');
    applyResult(result);
  }

  async function selectCandidate(): Promise<void> {
    if (!candidateId) {
      return;
    }

    const result = await flight.run(async () => {
      setBusy('selecting');
      const response = await selectProjectMusicRequest(project.id, candidateId);
      await onRefresh();
      return response;
    });

    if (result === undefined) {
      return;
    }

    setBusy('idle');
    applyResult(result);
  }

  async function disableMusic(): Promise<void> {
    const result = await flight.run(async () => {
      setBusy('clearing');
      const response = await clearProjectMusicRequest(project.id);
      await onRefresh();
      return response;
    });

    if (result === undefined) {
      return;
    }

    setBusy('idle');
    applyResult(result);
  }

  return (
    <section className="studio-panel rounded-[28px] p-4 shadow-panel">
      <div className="flex flex-wrap items-baseline justify-between gap-2">
        <h2 className="text-xl font-semibold text-white">Background music</h2>
        <p className="text-xs text-slate-400">Generate one AI track per project and select it as the composition soundtrack.</p>
      </div>

      <div className="mt-4 grid gap-4 lg:grid-cols-[minmax(0,1fr)_320px]">
        <div className="space-y-3">
          <label className="grid gap-2">
            <span className="font-mono text-[10px] uppercase tracking-[0.24em] text-slate-500">Music prompt</span>
            <textarea
              value={prompt}
              onChange={(event) => setPrompt(event.target.value)}
              placeholder="Describe the mood, genre and instruments, e.g. calm ambient piano with soft strings"
              className="min-h-20 rounded-2xl border border-slate-700/70 bg-slate-950/30 px-3 py-2 text-sm text-slate-100 outline-none transition focus:border-amber-300/50"
            />
          </label>

          <div className="flex flex-wrap items-end gap-3">
            <label className="grid gap-2">
              <span className="font-mono text-[10px] uppercase tracking-[0.24em] text-slate-500">Duration (seconds, optional)</span>
              <input
                type="number"
                min={MUSIC_MIN_DURATION_SECONDS}
                max={MUSIC_MAX_DURATION_SECONDS}
                step={1}
                value={durationSeconds}
                onChange={(event) => setDurationSeconds(event.target.value)}
                placeholder={String(existingSeconds ?? MUSIC_DEFAULT_DURATION_SECONDS)}
                className="w-40 rounded-2xl border border-slate-700/70 bg-slate-950/30 px-3 py-2 text-sm text-slate-100 outline-none transition focus:border-amber-300/50"
              />
              <span className="text-xs text-slate-500">{MUSIC_MIN_DURATION_SECONDS}-{MUSIC_MAX_DURATION_SECONDS} seconds. Leave empty for the default.</span>
            </label>

            <label className="flex items-center gap-2 rounded-2xl border border-slate-700/70 bg-slate-950/30 px-3 py-2 text-sm text-slate-100">
              <input type="checkbox" checked={instrumental} onChange={(event) => setInstrumental(event.target.checked)} />
              Instrumental
            </label>
          </div>

          <button
            type="button"
            disabled={isBusy}
            onClick={() => void submitForm(hasSelection)}
            className="rounded-2xl bg-amber-300 px-4 py-2 text-sm font-semibold text-slate-950 disabled:opacity-60"
          >
            {busy === 'generating' || busy === 'regenerating'
              ? 'Generating...'
              : hasSelection
                ? 'Regenerate music'
                : 'Generate music'}
          </button>

          {hasSelection ? (
            <p className="text-xs text-amber-200">
              Regenerating creates a new asset and replaces the current selection; the previous audio file is kept.
            </p>
          ) : null}

          {feedback ? (
            <p className={`text-xs ${feedback.tone === 'error' ? 'text-rose-300' : 'text-emerald-300'}`}>{feedback.text}</p>
          ) : null}
        </div>

        <aside className="rounded-2xl border border-slate-700/70 bg-slate-950/30 p-3">
          <p className="font-mono text-[10px] uppercase tracking-[0.24em] text-slate-500">Current selection</p>

          {hasSelection && selectedAsset ? (
            <div className="mt-2 space-y-2">
              <p className="text-sm font-semibold text-white">{selectedAsset.filename}</p>
              <p className="text-xs text-slate-400">
                {formatMusicSeconds(selectedAsset.duration)} • {music?.provider ?? selectedAsset.generation?.provider ?? 'provider'}
                {music?.model ? ` / ${music.model}` : ''}
              </p>
              {music?.prompt ? <p className="text-xs text-slate-400">Prompt: {music.prompt}</p> : null}
              <p className="text-xs text-slate-400">
                Instrumental: {music?.instrumental === undefined ? 'unknown' : music.instrumental ? 'yes' : 'no'}
                {typeof music?.musicLengthMs === 'number' ? ` • requested ${formatMusicSeconds(music.musicLengthMs / 1000)}` : ''}
              </p>
              <audio controls className="w-full" src={`/api/projects/${project.id}/assets/${selectedAsset.id}/file`} />
              <button
                type="button"
                disabled={isBusy}
                onClick={() => void disableMusic()}
                className="rounded-2xl border border-rose-400/60 bg-rose-400/10 px-3 py-2 text-xs text-rose-100 disabled:opacity-60"
              >
                {busy === 'clearing' ? 'Disabling...' : 'Disable background music'}
              </button>
              <p className="text-[10px] text-slate-500">Disabling only removes the selection. The audio asset stays in the project.</p>
            </div>
          ) : (
            <div className="mt-2 space-y-2">
              <p className="text-sm text-slate-300">No background music selected.</p>
              {music?.status === 'failed' && music.error ? <p className="text-xs text-rose-300">{music.error}</p> : null}
            </div>
          )}

          {candidates.length > 0 ? (
            <div className="mt-4 space-y-2 border-t border-slate-700/70 pt-3">
              <p className="font-mono text-[10px] uppercase tracking-[0.24em] text-slate-500">Use an existing asset</p>
              <select
                value={candidateId}
                onChange={(event) => setCandidateId(event.target.value)}
                className="w-full rounded-2xl border border-slate-700/70 bg-slate-950/30 px-3 py-2 text-sm text-slate-100"
              >
                <option value="">Select a music or audio asset</option>
                {candidates.map((asset) => (
                  <option key={asset.id} value={asset.id}>
                    {asset.filename} ({formatMusicSeconds(asset.duration)})
                  </option>
                ))}
              </select>
              <button
                type="button"
                disabled={isBusy || !candidateId || candidateId === selectedAsset?.id}
                onClick={() => void selectCandidate()}
                className="rounded-2xl border border-slate-700 px-3 py-2 text-xs text-slate-200 disabled:opacity-60"
              >
                {busy === 'selecting' ? 'Selecting...' : 'Use as background music'}
              </button>
            </div>
          ) : null}
        </aside>
      </div>
    </section>
  );
}
