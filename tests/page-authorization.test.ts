import { beforeEach, describe, expect, it, vi } from 'vitest';

const hoisted = vi.hoisted(() => ({
  currentHeaders: new Headers(),
  notFoundMock: vi.fn(() => {
    throw new Error('NEXT_NOT_FOUND');
  }),
  redirectMock: vi.fn((url: string) => {
    throw new Error(`NEXT_REDIRECT:${url}`);
  })
}));

vi.mock('next/headers', () => ({
  headers: async () => hoisted.currentHeaders
}));

vi.mock('next/navigation', () => ({
  notFound: hoisted.notFoundMock,
  redirect: hoisted.redirectMock
}));

vi.mock('next/link', () => ({
  default: () => null
}));

vi.mock('@/components/project/project-workspace', () => ({
  ProjectWorkspace: () => null
}));

vi.mock('@/lib/storage/project-store', () => ({
  projectStore: {
    listProjects: vi.fn(async () => []),
    getProject: vi.fn(async () => null),
    updateProject: vi.fn(async (project: unknown) => project),
    claimUnownedProjects: vi.fn(async () => 0)
  }
}));

import HomePage from '@/app/page';
import ProjectsPage from '@/app/projects/page';
import ProjectPage from '@/app/projects/[id]/page';
import { createUserSessionCookie, SESSION_COOKIE_NAME } from '@/lib/security/auth';
import { projectStore } from '@/lib/storage/project-store';

function setSession(subject?: string) {
  if (subject === undefined) {
    hoisted.currentHeaders = new Headers();
    return;
  }

  hoisted.currentHeaders = new Headers({
    cookie: `${SESSION_COOKIE_NAME}=${createUserSessionCookie(subject)}`
  });
}

beforeEach(() => {
  hoisted.notFoundMock.mockClear();
  hoisted.redirectMock.mockClear();
  vi.mocked(projectStore.listProjects).mockClear();
  vi.mocked(projectStore.getProject).mockClear();
  vi.mocked(projectStore.updateProject).mockClear();
  vi.mocked(projectStore.listProjects).mockResolvedValue([]);
  vi.mocked(projectStore.getProject).mockResolvedValue(null);
});

describe('page authorization', () => {
  it('does not load project data for an unauthenticated home page', async () => {
    setSession();

    await HomePage();

    expect(projectStore.listProjects).not.toHaveBeenCalled();
  });

  it('loads owner-scoped projects for an authenticated home page', async () => {
    setSession('user-a');

    await HomePage();

    expect(projectStore.listProjects).toHaveBeenCalledWith('user-a');
  });

  it('redirects unauthenticated access to the projects index', async () => {
    setSession();

    await expect(ProjectsPage()).rejects.toThrow('NEXT_REDIRECT:/');
    expect(hoisted.redirectMock).toHaveBeenCalledWith('/');
    expect(projectStore.listProjects).not.toHaveBeenCalled();
  });

  it('lists owner-scoped projects for an authenticated projects index', async () => {
    setSession('user-a');

    await ProjectsPage();

    expect(projectStore.listProjects).toHaveBeenCalledWith('user-a');
  });

  it('returns not-found for an unauthenticated project page without loading the project', async () => {
    setSession();

    await expect(ProjectPage({ params: Promise.resolve({ id: 'p1' }) })).rejects.toThrow('NEXT_NOT_FOUND');
    expect(projectStore.getProject).not.toHaveBeenCalled();
  });

  it('returns not-found for a foreign project', async () => {
    setSession('user-a');
    vi.mocked(projectStore.getProject).mockResolvedValue({ id: 'p1', ownerId: 'user-b' } as never);

    await expect(ProjectPage({ params: Promise.resolve({ id: 'p1' }) })).rejects.toThrow('NEXT_NOT_FOUND');
  });

  it('renders an owned project', async () => {
    setSession('user-a');
    vi.mocked(projectStore.getProject).mockResolvedValue({ id: 'p1', ownerId: 'user-a' } as never);

    await expect(ProjectPage({ params: Promise.resolve({ id: 'p1' }) })).resolves.toBeTruthy();
  });
});
