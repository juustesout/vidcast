import path from 'node:path';

export function getWorkspaceRoot(): string {
  return process.cwd();
}

export function getProjectsRoot(): string {
  return path.join(getWorkspaceRoot(), 'projects');
}

export function getProjectRoot(projectId: string): string {
  return path.join(getProjectsRoot(), projectId);
}

export function getProjectJsonPath(projectId: string): string {
  return path.join(getProjectRoot(projectId), 'project.json');
}

export function getProjectAssetsRoot(projectId: string): string {
  return path.join(getProjectRoot(projectId), 'assets');
}

export function getProjectReferencesRoot(projectId: string): string {
  return path.join(getProjectRoot(projectId), 'references');
}

export function getProjectRendersRoot(projectId: string): string {
  return path.join(getProjectRoot(projectId), 'renders');
}

export function getProjectPreviewsRoot(projectId: string): string {
  return path.join(getProjectRoot(projectId), 'previews');
}
