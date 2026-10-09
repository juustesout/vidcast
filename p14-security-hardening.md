# P14 Security & Access Control Hardening

Implementation report. Scope is limited to the findings in `p14-security-recon.md`.
No P15+ work.

## 1. Summary

| Finding | Severity | Status |
|---|---|---|
| K1 page-layer authorization bypass (IDOR + enumeration) | kritiek | Fixed |
| K2 hardcoded session-secret default | kritiek | Fixed |
| H1 read-only MCP client never sends service token | hoog | Fixed |
| H2 anonymous self-service identity minting | hoog | Fixed + blocker reported |
| M1 ownerless project creation from the landing page | middel | Fixed |
| M2 no fail-fast for insecure production config | middel | Fixed |
| L1 unauthenticated status endpoint | laag | Reviewed, no change |
| L2 run-status/log ordering | laag | Reviewed, no change |

## 2. Identity model after P14

Two identity sources remain, both server-verified:

- Service: `Authorization: Bearer <EXPLAINER_API_TOKEN>` (MCP / automation).
- Browser: server-signed HMAC session cookie, subject generated server-side.

There is still **no external identity provider**. Therefore:

- Outside production the anonymous session flow is an **explicit, shielded local
  development mode** (`isAnonymousSessionAllowed`).
- In production the anonymous flow is refused (403 `AUTH_SESSION_DISABLED`) and
  startup fails unless strong secrets are configured. Enabling real
  authenticated browser sessions in production is an **open blocker** (section 6).

## 3. Changes by finding

### K2 - unsafe session-secret default removed

- New `lib/security/config.ts`:
  - `getSecurityMode()` - production is forced whenever `NODE_ENV=production`,
    so it cannot be downgraded via `EXPLAINER_SECURITY_MODE`.
  - `getSessionSecret()` - returns a strong configured secret; in production it
    throws for a missing, weak (<32 chars) or the known dev-default secret;
    outside production it uses the explicit dev secret.
  - `getServiceToken()`, `isAnonymousSessionAllowed()`,
    `assertSecurityConfiguration()` (requires strong session secret + API token
    in production).
- `lib/security/constants.ts`: cookie name extracted so middleware can import it
  without pulling `node:crypto` into the edge bundle.
- `lib/security/auth.ts`: uses `getSessionSecret()`; adds
  `generateUserSubject()` and pure `getIdentityFromHeaders(cookie, authorization)`.
- `instrumentation.ts`: runs `assertSecurityConfiguration()` at server startup
  (skipped during the production build phase) so a misconfigured production
  deploy stops with a clear error instead of starting insecurely.

### H2 - session issuance no longer self-chosen, production refused

- `app/api/auth/session/route.ts`:
  - never reads the request body, so a client cannot supply `sub`;
  - generates the subject server-side via `generateUserSubject()`;
  - refuses to mint anonymous sessions outside the shielded local mode
    (403 in production);
  - claims legacy ownerless projects for the new subject (keeps first-claim
    semantics while enabling owner-scoped listing).

### K1 - server-rendered pages protected

- `lib/security/server-identity.ts`: `getServerIdentity()` resolves the identity
  from request headers for RSC.
- `lib/security/page-access.ts`:
  - `listProjectsForIdentity()` - users get owner-scoped listings, service gets
    all;
  - `getProjectForIdentity()` - same ownership rules as `requireProjectAccess`,
    returning `null` for foreign/missing projects (no existence disclosure).
- `app/page.tsx`, `app/projects/page.tsx`, `app/projects/[id]/page.tsx`:
  resolve identity first, render no project data when unauthenticated
  (`/projects` redirects, `/projects/[id]` returns not-found).
- `components/session/session-bootstrap.tsx` + `app/layout.tsx`: a client
  bootstrap mints the local session then refreshes the server tree; protected
  content stays hidden until an identity exists.
- `middleware.ts`: central defense-in-depth gate (cookie or bearer required for
  `/projects*`) that never replaces page/data-layer authorization.

### H1 - read-only MCP authentication

- `mcp/read-only/api-client.ts`: forwards `EXPLAINER_API_TOKEN` as a bearer
  header, mirroring the production client. Fail-closed: with no token, requests
  are unauthenticated and the server rejects them.

### M1 - owner-bound project creation

- `app/actions.ts`: `createProjectAction` reads the server identity and creates
  the project with the verified subject; unauthenticated callers are redirected
  without creating anything. `app/page.tsx` uses this action.

### M2 - production fail-fast

- Covered by `assertSecurityConfiguration()` + `instrumentation.ts`.

### L1 / L2 - reviewed, no change

- `/api/image-generation/status` exposes only `openaiConfigured` (boolean) and a
  provider name; no secret. No integrity impact.
- `production-runs/[runId]` and `/log` check identity first and both the
  "missing" and "not owner" paths return 404; no existence disclosure.

## 4. Files changed

New:
- `lib/security/config.ts`, `lib/security/constants.ts`,
  `lib/security/page-access.ts`, `lib/security/server-identity.ts`
- `components/session/session-bootstrap.tsx`, `app/actions.ts`,
  `instrumentation.ts`, `middleware.ts`

Modified:
- `app/api/auth/session/route.ts`, `app/layout.tsx`, `app/page.tsx`,
  `app/projects/page.tsx`, `app/projects/[id]/page.tsx`
- `lib/security/auth.ts`, `lib/storage/project-store.ts`
- `mcp/read-only/api-client.ts`
- `vitest.config.ts` (enable JSX transform so page modules can be unit tested)

Tests:
- `tests/security-config.test.ts`, `tests/session-identity.test.ts`,
  `tests/auth-session-route.test.ts`, `tests/page-access.test.ts`,
  `tests/page-authorization.test.ts`, `tests/mcp-read-only.test.ts` (extended)

## 5. Verification

- `npx tsc --noEmit` - clean.
- `npm run lint` - no warnings/errors.
- `npm run build` - success; middleware and instrumentation compiled.
- `npx vitest run` - 246 passed, 2 failed (pre-existing FFmpeg/PATH failures in
  `local-ffmpeg-renderer.test.ts` and `fake-image-provider-render.test.ts`,
  unrelated to P14).
- Runtime smoke test (dev server):
  - `GET /` anonymous renders no project data (`Establishing a local session`).
  - `GET /projects/<id>` anonymous -> 307 to `/`.
  - `POST /api/auth/session` -> 201, server-generated `user_...` subject;
    body-supplied `sub` ignored.
  - Authenticated `GET /` lists the owner-scoped seed; `GET /projects/<id>` 200.
  - Forged cookie -> 404 on page, 401 on `/api/projects`.
  - `/api/projects` anonymous -> 401, authenticated -> 200.

## 6. Blocker and remaining risks

Blocker (reported, not worked around):
- **Production browser identity requires an identity provider.** With no IdP
  available, production refuses anonymous sessions and there is currently no way
  for a browser to obtain a trusted identity. Production browser use is
  therefore unsupported until an IdP (OIDC/SAML or equivalent) is integrated.
  No fake security was added to hide this.

Remaining risks:
- Legacy project first-claim: ownerless projects are claimed by the first local
  session (by design). In a shared, non-production deployment the first user
  would claim legacy ownerless projects.
- `EXPLAINER_API_TOKEN` / `EXPLAINER_SESSION_SECRET` rotation and storage are
  operator responsibilities; the app only validates presence/strength.
- Throttling remains in-memory and single-process (unchanged from P11.7).
- Deep-linking to `/projects/<id>` without a session bounces through `/` once to
  bootstrap the local session.
