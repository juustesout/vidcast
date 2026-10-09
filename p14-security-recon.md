# P14 Security Boundary Recon

Scope: audit of the current (post-P13) security/access-control posture across
pages, API routes, MCP tools, P13 durable runs, and secrets/provider
enforcement. Recon only. No code changes made.

## 1. Surface inventory

- API routes (all under `app/api`):
  - `auth/session`, `health`, `image-generation/status` (unauthenticated by design).
  - `projects/**` (list, get, update, assets, references, files, renders,
    compositions, scene-intents, validation-report, production-plan,
    generation-jobs, generate-image/video/narration, render, compose).
  - `production-runs/[runId]` and `production-runs/[runId]/log`.
- Pages (React Server Components, no middleware):
  - `app/page.tsx` (home + projects list + New project server action).
  - `app/projects/page.tsx` (projects list).
  - `app/projects/[id]/page.tsx` (single project -> `ProjectWorkspace`).
- MCP servers: `mcp/read-only` and `mcp/production` (HTTP api-clients).
- Security libs: `lib/security/auth.ts`, `lib/security/access-control.ts`,
  `lib/security/http-response.ts`.

## 2. Findings

Severity: kritiek / hoog / middel / laag.

### K1 (kritiek) Page layer bypasses API authorization

The API auth boundary added in P11.7 is completely bypassed by the RSC pages.
There is no `middleware.ts` to guard them.

- `app/projects/[id]/page.tsx:12` calls `projectStore.getProject(id)` directly
  and, if found, renders the full `Project` (all scenes/assets/references) via
  `ProjectWorkspace`. No `requireProjectAccess`, no identity check.
- `app/projects/page.tsx:6` and `app/page.tsx:8` call
  `projectStore.listProjects()` with no `ownerId`. `listProjects` only filters
  when an owner is passed (`lib/storage/project-store.ts:600-618`), so both
  pages enumerate every project on disk.
- The client session bootstrap
  (`components/project/project-workspace.tsx:267-273`, `POST /api/auth/session`)
  runs client-side, i.e. after the server has already embedded the project data
  in the rendered payload. It cannot protect the page.

Impact: any actor able to reach the app can, without authentication, enumerate
all projects and read any project by ID (IDOR), defeating the entire
`requireProjectAccess` layer.

### K2 (kritiek) Session secret defaults to a hardcoded public value

- `lib/security/auth.ts:31`:
  `process.env.EXPLAINER_SESSION_SECRET?.trim() || 'explainer-local-dev-session-secret'`.

If `EXPLAINER_SESSION_SECRET` is unset (the default in dev and easy to miss in
deploy), the HMAC key is public and constant. Anyone can forge a session cookie
with an arbitrary `sub` (see `createUserSessionCookie`,
`lib/security/auth.ts:71-85`) and impersonate any owner, fully defeating
per-owner authorization. This is a fail-open secret.

### H1 (hoog) Read-only MCP client never sends the service token

- `mcp/read-only/api-client.ts:70-84`: requests send only `accept`; no
  `Authorization` header.
- The production client does forward it
  (`mcp/production/api-client.ts:128,131-137`).

Impact: with `EXPLAINER_API_TOKEN` set, all read-only MCP tools
(list_projects/get_project/get_scene/validation/plan) return 401 and are
non-functional; the two MCP servers have inconsistent auth behavior.

### H2 (hoog) Anonymous self-service session minting

- `app/api/auth/session/route.ts:11`: `POST` mints a session cookie for any
  caller, no credentials and no throttle.

There is no real identity concept: any visitor obtains a `sub`. This is
consistent with "local-first", but in any shared/hosted deployment it means
authentication does not gate access; it only separates anonymous cookies.
Combined with first-claim ownerless projects
(`lib/security/access-control.ts:91-98`) an anonymous caller can claim an
ownerless project. Confirm intended deployment model.

### M1 (middel) Server action creates ownerless projects

- `app/page.tsx:40-44`: the "New project" server action calls
  `projectStore.createProject()` with no ownerId and no identity. Every project
  created from the landing page is ownerless, hence claimable by the first
  authenticated caller (same first-claim path as H2).

### M2 (middel) No fail-fast for insecure default posture

No startup/env validation warns when `EXPLAINER_API_TOKEN` and/or
`EXPLAINER_SESSION_SECRET` are unset. The system silently runs with a forgeable
session secret (K2) and no service auth, and nothing surfaces this (health
returns only `{ ok: true }`).

### L1 (laag) Unauthenticated status endpoint

- `app/api/image-generation/status/route.ts:5` returns
  `{ openaiConfigured, defaultProvider }`
  (`lib/ai/image-generation/registry.ts:31-37`) with no auth. Only booleans and
  a provider name are exposed, no secret. Low. (`app/api/health` is fine.)

### L2 (laag) Run-status/log ordering

- `app/api/production-runs/[runId]/route.ts:18-19` and
  `app/api/production-runs/[runId]/log/route.ts:53-54` call
  `getRun(runId)` before `requireProjectAccess`. Identity is checked first and
  both "missing" and "not owner" resolve to 404, so there is no existence
  disclosure. Acceptable; optional tidy.

## 3. Working protections (verified)

- All `app/api/projects/**` and `app/api/production-runs/**` routes call
  `requireProjectAccess`.
- Cross-project access returns 404, not 403 (no existence disclosure).
- File serving allow-lists head directories and enforces a `path.resolve`
  prefix check (`app/api/projects/[id]/files/[...path]/route.ts:14-27`), so
  traversal is resisted.
- Session cookie is HMAC-signed with `timingSafeEqual` and expiry-checked
  (`lib/security/auth.ts:87-128`).
- Per-identity throttling (`lib/security/access-control.ts:108-172`).
- MCP credential fail-closed coverage exists
  (`tests/mcp-credential-failclosed-stdio.integration.test.ts`).

## 4. Missing tests

- No page-level auth tests: nothing renders `app/page.tsx`,
  `app/projects/page.tsx`, or `app/projects/[id]/page.tsx` with a foreign or
  absent session. K1 is completely untested.
- No test that the read-only MCP client attaches the service token (H1).
- No test for the forgeable-session-secret path / production startup guard
  (K2/M2).
- No test that page data access is owner-scoped where required.

## 5. Prioritized P14 proposal (bounded)

1. K1: introduce a single session-aware server-side project access helper
   (reuse `lib/security/access-control` semantics) and apply it in the three
   pages; add `middleware.ts` only if page-level checks are insufficient.
   Tests: unauthenticated/foreign page access -> 404 / empty list; owner sees
   own project.
2. K2/M2: session-secret policy - fail fast in production when unset; permit
   the dev default only when `NODE_ENV !== 'production'`. Tests: forged cookie
   rejected; startup guard trips.
3. H1: make the read-only MCP client forward `EXPLAINER_API_TOKEN` like the
   production client; add a client test asserting the header.
4. H2/M1: decide and implement the creation/ownership policy
   (session-bound `createProject` vs. keep first-claim). Confirm intent first.
5. Defer L1/L2 (low).

Verification plan for any implementation: `npm run lint`, `tsc --noEmit`,
`npx vitest run`, plus the new tests above. No paid provider calls.

## 6. Awaiting approval

No changes will be made until the scope above is approved.
