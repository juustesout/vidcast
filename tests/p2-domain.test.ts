import { describe, expect, it } from 'vitest';

import { deriveGenerationTasks } from '../lib/projects/generation-tasks';
import { normalizeProject } from '../lib/projects/normalize-project';
import { getAssetUsage, getReferenceUsage, PROJECT_MUSIC_USAGE_ID } from '../lib/projects/usage';
import { resolveRenderPlan } from '../lib/render/scene-resolver';
import type { Project } from '../lib/types/render';
import { validateProject } from '../lib/validation/project-validation';

function buildProject(): Project {
  const now = new Date().toISOString();
  return {
    id: 'project-test',
    title: 'P2 Test Project',
    description: 'Local project',
    durationTarget: 30,
    aspectRatio: '16:9',
    fps: 30,
    createdAt: now,
    updatedAt: now,
    narration: {
      text: '',
      segments: []
    },
    explainer: {
      brief: {
        topic: '',
        goal: '',
        audience: '',
        tone: '',
        targetDurationSeconds: 30,
        notes: ''
      },
      story: {
        title: 'P2 Test Project',
        hook: '',
        script: '',
        beats: [],
        cta: '',
        notes: '',
        versions: []
      },
      sceneIntents: []
    },
    renderSettings: {
      aspectRatio: '16:9',
      fps: 30,
      width: 1920,
      height: 1080,
      background: {
        type: 'color',
        value: '#000000'
      },
      audio: {
        narrationVolume: 1,
        musicVolume: 0.35,
        effectsVolume: 0.2
      },
      subtitlesEnabled: true
    },
    assets: [
      {
        id: 'asset-image-1',
        type: 'image',
        status: 'available',
        provenance: 'imported',
        filename: 'image-1.png',
        originalFilename: 'image-1.png',
        localPath: 'assets/image-1.png',
        mimeType: 'image/png',
        width: 1200,
        height: 675,
        filesize: 1000,
        metadata: {},
        createdAt: now,
        updatedAt: now
      }
    ],
    references: [
      {
        id: 'ref-main',
        name: 'Main Character',
        description: 'Reference character image',
        filePath: 'references/main.png',
        tags: ['character'],
        metadata: {
          width: 1024,
          height: 1024,
          mimeType: 'image/png',
          filesize: 900
        },
        createdAt: now,
        updatedAt: now
      }
    ],
    scenes: [
      {
        id: 'scene-1',
        order: 1,
        duration: 5,
        type: 'image',
        narration: { text: 'Scene 1' },
        visual: {
          kind: 'asset',
          assetId: 'asset-image-1'
        },
        render: {
          motion: { preset: 'zoom_in' },
          transition: { type: 'fade' }
        },
        overlay: { type: 'none' },
        referenceIds: [],
        notes: ''
      },
      {
        id: 'scene-2',
        order: 2,
        duration: 5,
        type: 'image',
        narration: { text: 'Scene 2' },
        visual: {
          kind: 'generated_image',
          generation: {
            id: 'gen-1',
            kind: 'image',
            status: 'planned',
            provider: 'openai',
            prompt: 'Main character in bathroom',
            referenceIds: ['ref-main'],
            aspectRatio: '16:9',
            createdAt: now
          }
        },
        render: {
          motion: { preset: 'none' },
          transition: { type: 'fade' }
        },
        overlay: { type: 'none' },
        referenceIds: ['ref-main'],
        notes: ''
      }
    ]
  };
}

describe('P2 domain validation', () => {
  it('accepts a valid project and planned generation without asset', () => {
    const project = buildProject();
    const result = validateProject(project);
    expect(result.valid).toBe(true);
    expect(result.errors).toHaveLength(0);
  });

  it('rejects invalid asset provenance and type', () => {
    const project = buildProject();
    project.assets[0].provenance = 'bad' as never;
    project.assets[0].type = 'bad' as never;
    const result = validateProject(project);
    expect(result.errors.some((error) => error.code === 'asset.provenance.invalid')).toBe(true);
    expect(result.errors.some((error) => error.code === 'asset.type.invalid')).toBe(true);
  });

  it('detects unsafe paths and missing references in scenes', () => {
    const project = buildProject();
    project.assets[0].localPath = '../escape.png';
    project.references[0].filePath = '../escape.png';
    project.scenes[1].referenceIds = ['missing-ref'];
    const result = validateProject(project);
    expect(result.errors.some((error) => error.code === 'asset.path.invalid' || error.code === 'asset.path.unsafe')).toBe(true);
    expect(result.errors.some((error) => error.code === 'reference.path.invalid' || error.code === 'reference.path.unsafe')).toBe(true);
    expect(result.errors.some((error) => error.code === 'scene.reference.missing')).toBe(true);
  });
});

describe('P2 scene relationships and readiness', () => {
  it('marks existing asset scene renderable and planned generation not renderable', () => {
    const project = buildProject();
    const plan = resolveRenderPlan(project);
    const scene1 = plan.scenes.find((scene) => scene.sceneId === 'scene-1');
    const scene2 = plan.scenes.find((scene) => scene.sceneId === 'scene-2');
    expect(scene1?.status).toBe('renderable');
    expect(scene2?.status).toBe('planned');
  });

  it('detects missing asset references as invalid', () => {
    const project = buildProject();
    project.scenes[0].visual = { kind: 'asset', assetId: 'missing-asset' };
    const plan = resolveRenderPlan(project);
    const scene1 = plan.scenes.find((scene) => scene.sceneId === 'scene-1');
    expect(scene1?.status).toBe('invalid');
  });
});

describe('P2 usage derivation and task derivation', () => {
  it('derives asset and reference usage counts correctly', () => {
    const project = buildProject();
    expect(getAssetUsage(project, 'asset-image-1')).toEqual(['scene-1']);
    expect(getReferenceUsage(project, 'ref-main')).toEqual(['scene-2']);
  });

  it('marks the selected background music asset as used so it cannot be deleted', () => {
    const project = buildProject();
    project.assets.push({
      ...project.assets[0],
      id: 'asset-music-1',
      type: 'music',
      filename: 'music-1.wav',
      mimeType: 'audio/wav'
    });
    project.music = { assetId: 'asset-music-1', status: 'generated' };

    expect(getAssetUsage(project, 'asset-music-1')).toEqual([PROJECT_MUSIC_USAGE_ID]);
  });

  it('derives generation tasks from scene model', () => {
    const project = buildProject();
    const tasks = deriveGenerationTasks(project);
    expect(tasks).toHaveLength(1);
    expect(tasks[0].generation.id).toBe('gen-1');
    expect(tasks[0].readiness).toBe('not_ready');
  });
});

describe('P2 persistence shape', () => {
  it('preserves assets and references across serialize/normalize roundtrip', () => {
    const project = buildProject();
    const serialized = JSON.stringify(project);
    const reloaded = normalizeProject(JSON.parse(serialized) as Project);
    expect(reloaded.assets).toHaveLength(1);
    expect(reloaded.references).toHaveLength(1);
    expect(reloaded.scenes).toHaveLength(2);
    expect(reloaded.scenes[0].visual?.kind).toBe('asset');
  });

  it('keeps explainer story material separate from production scene narration', () => {
    const project = buildProject();
    project.explainer!.story.script = 'Story script source text.';
    project.explainer!.story.beats = [{ id: 'beat-1', order: 1, text: 'Story beat source text.' }];
    project.scenes[0].narration = { text: 'Production scene narration.' };

    const reloaded = normalizeProject(JSON.parse(JSON.stringify(project)) as Project);
    expect(reloaded.explainer?.story.script).toBe('Story script source text.');
    expect(reloaded.explainer?.story.beats[0].text).toBe('Story beat source text.');
    expect(reloaded.scenes[0].narration?.text).toBe('Production scene narration.');
  });
});
