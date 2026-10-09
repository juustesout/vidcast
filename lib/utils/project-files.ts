export function joinProjectFileUrl(projectId: string, relativePath: string): string {
  const encodedPath = relativePath
    .split('/')
    .filter(Boolean)
    .map((segment) => encodeURIComponent(segment))
    .join('/');

  return `/api/projects/${encodeURIComponent(projectId)}/files/${encodedPath}`;
}

export function joinProjectAssetUrl(projectId: string, assetId: string): string {
  return `/api/projects/${encodeURIComponent(projectId)}/assets/${encodeURIComponent(assetId)}/file`;
}

export function joinProjectReferenceUrl(projectId: string, referenceId: string): string {
  return `/api/projects/${encodeURIComponent(projectId)}/references/${encodeURIComponent(referenceId)}/file`;
}
