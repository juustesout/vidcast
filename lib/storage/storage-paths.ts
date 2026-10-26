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

export function getProjectClaimPath(projectId: string): string {
  return path.join(getProjectRoot(projectId), 'claim.json');
}

export function getProjectMandatePath(projectId: string): string {
  return path.join(getProjectRoot(projectId), 'mandate.json');
}

export function getProjectMandateSpendPath(projectId: string): string {
  return path.join(getProjectRoot(projectId), 'mandate-spend.json');
}

export function getProjectAssetsRoot(projectId: string): string {
  return path.join(getProjectRoot(projectId), 'assets');
}

export function getProjectStudioAssetsRoot(projectId: string): string {
  return path.join(getProjectAssetsRoot(projectId), 'studio');
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

export function getProjectRunsRoot(projectId: string): string {
  return path.join(getProjectRoot(projectId), 'runs');
}

export function getRunJsonPath(projectId: string, runId: string): string {
  return path.join(getProjectRunsRoot(projectId), `${runId}.json`);
}

// Cross-project stock router state (quota accounting + selection cache). Kept
// at the projects root because provider quota is shared by every project that
// uses the same API key.
export function getStockStatePath(): string {
  return path.join(getProjectsRoot(), '_stock', 'stock-state.json');
}

export function getStockStateDir(): string {
  return path.join(getProjectsRoot(), '_stock');
}

export function getPaidSpendStatePath(): string {
  return path.join(getProjectsRoot(), '_spend', 'spend-state.json');
}

export function getPaidSpendStateDir(): string {
  return path.join(getProjectsRoot(), '_spend');
}
