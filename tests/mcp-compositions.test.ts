import { describe, expect, it } from 'vitest';

import type { AppApiClient } from '@/mcp/read-only/api-client';
import { createReadOnlyToolService, READ_ONLY_TOOL_DEFINITIONS, registerReadOnlyTools } from '@/mcp/read-only/tools';
import { createAuthoringToolService, registerAuthoringTools, AUTHORING_TOOL_DEFINITIONS } from '@/mcp/authoring/tools';
import { PRODUCTION_TOOL_DEFINITIONS, registerProductionTools, createProductionToolService } from '@/mcp/production/tools';
import type { McpServer } from '@modelcontextprotocol/sdk/server/mcp.js';
import type { CompositionArtifact, Project } from '@/lib/types/render';

function makeComposition(overrides: Partial<CompositionArtifact> = {}): CompositionArtifact {
  return {
    compositionId: 'comp-1',
    projectId: 'project-1',
    outputPath: 'renders/composition-1.mp4',
    createdAt: '2026-01-01T00:00:00.000Z',
    sceneIds: ['scene-1', 'scene-2'],
    duration: 12,
    width: 1920,
    height: 1080,
    fps: 30,
    renderer: 'ffmpeg',
    version: 'p10.1',
    filesize: 123456,
    mimeType: 'video/mp4',
    transition: { type: 'fade' },
    ...overrides
  };
}

function makeProjectWithCompositions(id: string, compositions: CompositionArtifact[]): Project {
  const now = new Date().toISOString();
  return {
    id,
    title: `Project ${id}`,
    description: 'desc',
    durationTarget: 30,
    aspectRatio: '16:9',
    fps: 30,
    createdAt: now,
    updatedAt: now,
    narration: { text: '', segments: [] },
    scenes: [],
    assets: [],
    references: [],
    compositions,
    renderSettings: {
      aspectRatio: '16:9',
      fps: 30,
      width: 1920,
      height: 1080,
      background: { type: 'color', value: '#000000' },
      audio: { narrationVolume: 1, musicVolume: 0.35, effectsVolume: 0.2 },
      subtitlesEnabled: true
    }
  };
}

function makeApiClient(getProject: AppApiClient['getProject']): AppApiClient {
  return {
    listProjects: async () => [],
    getProject,
    getValidationReport: async () => ({}) as never,
    getProductionPlan: async () => ({}) as never
  };
}

function makeFakeServer(): { server: McpServer; names: string[] } {
  const names: string[] = [];
  const server = {
    registerTool: (name: string) => {
      names.push(name);
    }
  } as unknown as McpServer;
  return { server, names };
}

describe('get_project_compositions tool', () => {
  it('is registered as a read-only tool', () => {
    const entry = READ_ONLY_TOOL_DEFINITIONS.find((definition) => definition.name === 'get_project_compositions');
    expect(entry).toBeDefined();
    expect(entry?.annotations.readOnlyHint).toBe(true);
  });

  it('returns composition metadata, newest first, with a download path but no MP4 bytes', async () => {
    const older = makeComposition({ compositionId: 'comp-old', createdAt: '2026-01-01T00:00:00.000Z' });
    const newer = makeComposition({ compositionId: 'comp-new', createdAt: '2026-02-01T00:00:00.000Z', sceneIds: ['scene-1', 'scene-2', 'scene-3'] });
    const project = makeProjectWithCompositions('project-1', [older, newer]);
    const service = createReadOnlyToolService(makeApiClient(async () => project));

    const result = await service.getProjectCompositions({ projectId: 'project-1' });

    expect(result.ok).toBe(true);
    if (result.ok) {
      expect(result.data.available).toBe(true);
      expect(result.data.latest?.compositionId).toBe('comp-new');
      expect(result.data.latest?.sceneCount).toBe(3);
      expect(result.data.latest?.downloadPath).toBe('/api/projects/project-1/compositions/comp-new/file');
      expect(result.data.compositions.map((entry) => entry.compositionId)).toEqual(['comp-new', 'comp-old']);

      const serialized = JSON.stringify(result.data);
      expect(serialized).not.toContain('outputPath');
      expect(serialized).not.toContain('renders/composition-1.mp4');
    }
  });

  it('reports available=false when there are no compositions', async () => {
    const service = createReadOnlyToolService(makeApiClient(async () => makeProjectWithCompositions('project-1', [])));

    const result = await service.getProjectCompositions({ projectId: 'project-1' });

    expect(result.ok).toBe(true);
    if (result.ok) {
      expect(result.data.available).toBe(false);
      expect(result.data.latest).toBeNull();
      expect(result.data.compositions).toEqual([]);
    }
  });

  it('raises NOT_FOUND for an unknown compositionId', async () => {
    const service = createReadOnlyToolService(makeApiClient(async () => makeProjectWithCompositions('project-1', [])));

    const result = await service.getProjectCompositions({ projectId: 'project-1', compositionId: 'missing' });

    expect(result.ok).toBe(false);
    if (!result.ok) {
      expect(result.error.code).toBe('NOT_FOUND');
    }
  });

  it('validates required arguments', async () => {
    const service = createReadOnlyToolService(makeApiClient(async () => makeProjectWithCompositions('project-1', [])));
    const result = await service.getProjectCompositions({});
    expect(result.ok).toBe(false);
    if (!result.ok) {
      expect(result.error.code).toBe('INVALID_ARGUMENT');
    }
  });
});

describe('single MCP server registers all tool groups', () => {
  it('registers read-only, composition, authoring and production tools with no name collisions', () => {
    const readOnly = makeFakeServer();
    registerReadOnlyTools(readOnly.server, createReadOnlyToolService(makeApiClient(async () => makeProjectWithCompositions('p', []))));

    const authoring = makeFakeServer();
    registerAuthoringTools(authoring.server, createAuthoringToolService());

    const production = makeFakeServer();
    registerProductionTools(production.server, createProductionToolService());

    const allNames = [...readOnly.names, ...authoring.names, ...production.names];

    expect(readOnly.names).toEqual([
      'list_projects',
      'get_project',
      'get_scene',
      'get_validation_report',
      'get_production_plan',
      'get_project_compositions'
    ]);
    expect(authoring.names).toEqual(AUTHORING_TOOL_DEFINITIONS.map((definition) => definition.name));
    expect(production.names).toEqual(PRODUCTION_TOOL_DEFINITIONS.map((definition) => definition.name));
    expect(new Set(allNames).size).toBe(allNames.length);
  });
});
