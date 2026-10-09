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
  transition: { type: 'none' }
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

  it('builds compose args with concat demuxer and deterministic output settings', () => {
    const args = buildComposeArgs('concat-list.txt', 'final.mp4', plan);
    expect(args.slice(0, 6)).toEqual(['-y', '-f', 'concat', '-safe', '0', '-i']);
    expect(args.join(' ')).toContain('libx264');
    expect(args.join(' ')).toContain('yuv420p');
    expect(args.join(' ')).toContain('-c:a aac');
  });
});
