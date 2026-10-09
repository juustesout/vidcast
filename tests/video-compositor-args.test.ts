import { describe, expect, it } from 'vitest';

import { buildComposeArgs, buildNormalizeArgs } from '@/lib/render/video-compositor';
import type { CompositionPlan } from '@/lib/types/render';

const plan: CompositionPlan = {
  projectId: 'project-1',
  items: [],
  width: 1280,
  height: 720,
  fps: 30,
  totalDuration: 3,
  transition: { type: 'none' },
  audio: { narrationVolume: 1, musicVolume: 0.35, effectsVolume: 0.2 }
};

describe('video compositor args', () => {
  it('builds normalize args with deterministic scale/crop/fps pipeline', () => {
    const args = buildNormalizeArgs('in.mp4', 'out.mp4', plan, 1, { inputHasAudio: false });
    expect(args).toContain('-vf');
    expect(args.join(' ')).toContain('scale=1280:720');
    expect(args.join(' ')).toContain('crop=1280:720');
    expect(args.join(' ')).toContain('fps=30');
    expect(args.join(' ')).toContain('format=yuv420p');
    expect(args.join(' ')).toContain('anullsrc=channel_layout=stereo:sample_rate=48000');
    expect(args.join(' ')).toContain('-c:a aac');
  });

  it('prefers narration audio when provided', () => {
    const args = buildNormalizeArgs('in.mp4', 'out.mp4', plan, 1, { inputHasAudio: true, narrationAudioPath: 'voice.mp3' });
    expect(args.join(' ')).toContain('-i voice.mp3');
    expect(args.join(' ')).toContain('[1:a]atrim=0:1.000');
    expect(args.join(' ')).not.toContain('anullsrc');
  });

  it('applies the narration volume to the narration audio track', () => {
    const args = buildNormalizeArgs('in.mp4', 'out.mp4', plan, 1, { inputHasAudio: true, narrationAudioPath: 'voice.mp3' });
    expect(args.join(' ')).toContain('volume=1.000');
  });

  it('applies a custom narration volume and clamps out-of-range values', () => {
    const custom: CompositionPlan = { ...plan, audio: { narrationVolume: 0.5, musicVolume: 0.35, effectsVolume: 0.2 } };
    expect(buildNormalizeArgs('in.mp4', 'out.mp4', custom, 1, { inputHasAudio: false, narrationAudioPath: 'voice.mp3' }).join(' ')).toContain('volume=0.500');

    const clamped: CompositionPlan = { ...plan, audio: { narrationVolume: 42, musicVolume: 0.35, effectsVolume: 0.2 } };
    expect(buildNormalizeArgs('in.mp4', 'out.mp4', clamped, 1, { inputHasAudio: false, narrationAudioPath: 'voice.mp3' }).join(' ')).toContain('volume=4.000');
  });

  it('does not apply a narration volume to silence or embedded scene audio', () => {
    const silence = buildNormalizeArgs('in.mp4', 'out.mp4', plan, 1, { inputHasAudio: false });
    expect(silence.join(' ')).toContain('anullsrc');
    expect(silence.join(' ')).not.toContain('volume=');

    const embedded = buildNormalizeArgs('in.mp4', 'out.mp4', plan, 1, { inputHasAudio: true });
    expect(embedded.join(' ')).toContain('[0:a]atrim=0:1.000');
    expect(embedded.join(' ')).not.toContain('volume=');
  });

  it('builds compose args with concat demuxer and deterministic output settings', () => {
    const args = buildComposeArgs('concat-list.txt', 'final.mp4', plan);
    expect(args.slice(0, 6)).toEqual(['-y', '-f', 'concat', '-safe', '0', '-i']);
    expect(args.join(' ')).toContain('libx264');
    expect(args.join(' ')).toContain('yuv420p');
    expect(args.join(' ')).toContain('-c:a aac');
  });
});
