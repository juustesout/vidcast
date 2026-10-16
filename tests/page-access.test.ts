import { beforeEach, describe, expect, it, vi } from 'vitest';

vi.mock('@/lib/storage/project-store', () => ({
  projectStore: {
    listProjects: vi.fn(),
    getProject: vi.fn(),
    updateProject: vi.fn(),
    mutateProject: vi.fn(),
    hasPendingClaim: vi.fn()
  }
}));

import { projectStore } from '@/lib/storage/project-store';
import { getProjectForIdentity, listProjectsForIdentity } from '@/lib/security/page-access';
import type { RequestIdentity } from '@/lib/security/auth';

const USER_A: RequestIdentity = { kind: 'user', subject: 'user-a', authType: 'session' };
const SERVICE: RequestIdentity = { kind: 'service', subject: 'service:api_token', authType: 'service_token' };

describe('page data access', () => {
  beforeEach(() => {
    vi.mocked(projectStore.listProjects).mockReset();
    vi.mocked(projectStore.getProject).mockReset();
    vi.mocked(projectStore.updateProject).mockReset();
    vi.mocked(projectStore.mutateProject).mockReset();
    vi.mocked(projectStore.hasPendingClaim).mockReset();
    vi.mocked(projectStore.hasPendingClaim).mockResolvedValue(false);
  });

  it('scopes project listing to the user identity', async () => {
    vi.mocked(projectStore.listProjects).mockResolvedValue([]);

    await listProjectsForIdentity(USER_A);

    expect(projectStore.listProjects).toHaveBeenCalledWith('user-a');
  });

  it('lists all projects for a service identity', async () => {
    vi.mocked(projectStore.listProjects).mockResolvedValue([]);

    await listProjectsForIdentity(SERVICE);

    expect(projectStore.listProjects).toHaveBeenCalledWith();
  });

  it('returns the project for an owner', async () => {
    const project = { id: 'p1', ownerId: 'user-a' } as never;
    vi.mocked(projectStore.getProject).mockResolvedValue(project);

    await expect(getProjectForIdentity(USER_A, 'p1')).resolves.toBe(project);
    expect(projectStore.mutateProject).not.toHaveBeenCalled();
  });

  it('returns null for a foreign project', async () => {
    vi.mocked(projectStore.getProject).mockResolvedValue({ id: 'p1', ownerId: 'user-b' } as never);

    await expect(getProjectForIdentity(USER_A, 'p1')).resolves.toBeNull();
    expect(projectStore.mutateProject).not.toHaveBeenCalled();
  });

  it('returns null when the project does not exist', async () => {
    vi.mocked(projectStore.getProject).mockResolvedValue(null);

    await expect(getProjectForIdentity(USER_A, 'missing')).resolves.toBeNull();
  });

  it('claims a legacy ownerless project for the user', async () => {
    vi.mocked(projectStore.getProject).mockResolvedValue({ id: 'p1' } as never);
    vi.mocked(projectStore.mutateProject).mockImplementation(async (_id, mutator) =>
      (await mutator({ id: 'p1' } as never)) as never
    );

    await expect(getProjectForIdentity(USER_A, 'p1')).resolves.toEqual({ id: 'p1', ownerId: 'user-a' });
    expect(projectStore.mutateProject).toHaveBeenCalledWith('p1', expect.any(Function));
  });

  it('does not legacy-claim an ownerless project while a claim capability is pending', async () => {
    vi.mocked(projectStore.getProject).mockResolvedValue({ id: 'p1' } as never);
    vi.mocked(projectStore.hasPendingClaim).mockResolvedValue(true);

    await expect(getProjectForIdentity(USER_A, 'p1')).resolves.toBeNull();
    expect(projectStore.mutateProject).not.toHaveBeenCalled();
  });

  it('allows a service identity to read any project', async () => {
    const project = { id: 'p1', ownerId: 'user-b' } as never;
    vi.mocked(projectStore.getProject).mockResolvedValue(project);

    await expect(getProjectForIdentity(SERVICE, 'p1')).resolves.toBe(project);
  });
});
