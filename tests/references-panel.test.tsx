import React from 'react';
import { renderToStaticMarkup } from 'react-dom/server';
import { describe, expect, it, vi } from 'vitest';

import { ReferencesPanel } from '@/components/project/references-panel';
import type { Project } from '@/lib/types/render';
import type { ReferenceImage } from '@/lib/types/reference';

vi.mock('next/image', () => ({
  default: (props: React.ImgHTMLAttributes<HTMLImageElement>) => React.createElement('img', props)
}));

function createReference(overrides: Partial<ReferenceImage> = {}): ReferenceImage {
  const now = new Date().toISOString();
  return {
    id: 'reference-1',
    name: 'Main Character',
    description: 'A friendly guide',
    filePath: 'references/reference-1.png',
    tags: ['character', 'hero'],
    createdAt: now,
    updatedAt: now,
    ...overrides
  };
}

function createProject(overrides: Partial<Project> = {}): Project {
  const now = new Date().toISOString();
  return {
    id: 'project-1',
    title: 'References Panel Test',
    description: 'desc',
    durationTarget: 30,
    aspectRatio: '16:9',
    fps: 30,
    createdAt: now,
    updatedAt: now,
    narration: { text: '', segments: [] },
    renderSettings: {
      aspectRatio: '16:9',
      fps: 30,
      width: 1280,
      height: 720,
      background: { type: 'color', value: '#000' },
      audio: { narrationVolume: 1, musicVolume: 0.35, effectsVolume: 0.2 },
      subtitlesEnabled: true
    },
    assets: [],
    references: [],
    scenes: [],
    ...overrides
  };
}

function createSceneWithReference(referenceId: string): Project['scenes'][number] {
  const now = new Date().toISOString();
  return {
    id: 'scene-1',
    order: 1,
    duration: 5,
    type: 'image',
    narration: { text: '' },
    visual: { kind: 'blank' },
    render: { motion: { preset: 'zoom_in' }, transition: { type: 'fade' } },
    overlay: { type: 'none' },
    referenceIds: [referenceId],
    notes: ''
  };
}

const noop = (): void => {};

function renderPanel(overrides: Partial<React.ComponentProps<typeof ReferencesPanel>> = {}): string {
  const project = overrides.project ?? createProject();
  const props: React.ComponentProps<typeof ReferencesPanel> = {
    project,
    references: project.references,
    referenceQuery: '',
    onReferenceQueryChange: noop,
    selectedReferenceId: '',
    onSelectReference: noop,
    onNavigateScene: noop,
    newReferenceName: 'Main Character',
    newReferenceDescription: '',
    newReferenceTags: '',
    onNewReferenceNameChange: noop,
    onNewReferenceDescriptionChange: noop,
    onNewReferenceTagsChange: noop,
    onImportReference: noop,
    onSaveReferenceDetails: noop,
    onDeleteReference: noop,
    referenceMessage: '',
    ...overrides
  };

  return renderToStaticMarkup(React.createElement(ReferencesPanel, props));
}

describe('ReferencesPanel', () => {
  it('renders the intake toolbar and an empty selection state', () => {
    const html = renderPanel();

    expect(html).toContain('Import reference');
    expect(html).toContain('Reference name');
    expect(html).toContain('Filter references');
    expect(html).toContain('Select a reference to inspect and edit.');
    expect(html).not.toContain('Reference details');
  });

  it('renders reference cards with usage counts and the filter value', () => {
    const reference = createReference();
    const project = createProject({ references: [reference], scenes: [createSceneWithReference(reference.id)] });

    const html = renderPanel({ project, references: [reference], referenceQuery: 'hero' });

    expect(html).toContain('Main Character');
    expect(html).toContain('A friendly guide');
    expect(html).toContain('character, hero');
    expect(html).toContain('/api/projects/project-1/references/reference-1/file');
    expect(html).toContain('used by 1');
    expect(html).toContain('value="hero"');
    expect(html).toContain('Select a reference to inspect and edit.');
  });

  it('renders the detail card for the selected reference with its scene usage', () => {
    const reference = createReference();
    const project = createProject({ references: [reference], scenes: [createSceneWithReference(reference.id)] });

    const html = renderPanel({ project, references: [reference], selectedReferenceId: reference.id, referenceMessage: 'Reference updated.' });

    expect(html).toContain('Reference details');
    expect(html).toContain('Used by scenes');
    expect(html).toContain('Scene 01');
    expect(html).toContain('Save reference');
    expect(html).toContain('Delete reference');
    expect(html).toContain('Reference updated.');
    expect(html).not.toContain('Select a reference to inspect and edit.');
  });
});
