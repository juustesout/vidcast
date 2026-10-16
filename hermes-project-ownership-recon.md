# Hermes MCP <-> Browser Project Ownership: Recon

Status: recon only. **No code changed, nothing committed or pushed.**
Goal: fix the blocker from `hermes_test_002` so a project that Hermes creates over
MCP is safely visible and editable for the intended browser user.

All statements below are verified against the current tree (HEAD `cbfe7fb`).
File:line references are exact.

---

## 1. Current identity and ownership flow

### 1.1 Identity sources (`lib/security/auth.ts`)

`getIdentityFromHeaders(cookie, authorization)` (`auth.ts:139`) resolves exactly
two identity kinds:

- **service** - `Authorization: Bearer <EXPLAINER_API_TOKEN>` matching
  `getServiceToken()` (`auth.ts:142-148`). Subject is the fixed string
  `service:api_token`; `authType: 'service_token'`.
- **user** - a server-signed session cookie (`explainer_session`), HMAC-verified
  and expiry-checked (`auth.ts:91-132`, resolved at `auth.ts:150-151`). Subject is
  `user_<uuid>` minted by the server (`generateUserSubject`, `auth.ts:71-73`).

There is no third path. A caller can never supply a subject directly; it only
comes from the server-signed cookie (documented intent, `auth.ts:134-138`).

### 1.2 Session issuance (`app/api/auth/session/route.ts`)

- If a valid identity is already present the route returns early and does **not**
  touch ownership (`session/route.ts:8-11`).
- Otherwise, only in local mode (`isAnonymousSessionAllowed`,
  `lib/security/config.ts:43-45`), it mints a new subject, signs a cookie, and
  runs `projectStore.claimUnownedProjects(subject)` (`session/route.ts:26-34`).

### 1.3 Where an `ownerId` comes from

`Project.ownerId` is optional (`lib/types/render.ts:96`). It is set only by:

- `app/api/projects/route.ts:29-30` (POST): `ownerId = identity.kind === 'service'
  ? undefined : identity.subject`.
- `app/actions.ts:19` (server action "New project"): same rule.
- `projectStore.createProject(input, ownerId?)` (`project-store.ts:706-712`).
- `projectStore.claimUnownedProjects(ownerId)` (`project-store.ts:730-774`).
- The **legacy first-claim** inside `requireProjectAccess` / `getProjectForIdentity`
  (see 1.5).
- `normalizeProject` spreads `...project` (`normalize-project.ts:374`), so an
  `ownerId` present in a write is preserved - including one arriving through a
  `PUT /api/projects/{id}` patch (see 5.2).

### 1.4 Listing contract

- API `GET /api/projects` (`app/api/projects/route.ts:7-23`): service -> all
  projects; user -> `listProjects(identity.subject)`.
- Pages use `listProjectsForIdentity` (`lib/security/page-access.ts:9-15`):
  service -> all; user -> owner-scoped.
- Store filter (`project-store.ts:670-695`): `project.ownerId === ownerId`
  (line 689). **Ownerless projects are excluded from every user-scoped list.**
- `buildProjectSummary` (`project-store.ts:172-183`) does not expose `ownerId`,
  so the MCP `list_projects` tool also cannot report ownership.

### 1.5 Detail / read-write contract

`requireProjectAccess(request, id)` (`lib/security/access-control.ts:75-119`):

- service -> bypass owner check (lines 87-89);
- user + ownerless -> **claims** the project for the caller, then verifies it won
  the race, else 404 (lines 91-111);
- user + owned by someone else -> 404 to avoid existence disclosure (lines
  113-116).

`getProjectForIdentity` (page path, `page-access.ts:23-54`) mirrors this
first-claim and returns `null` -> `notFound()` (`app/projects/[id]/page.tsx:19-23`).

`PUT /api/projects/{id}` (`app/api/projects/[id]/route.ts:25-94`) calls
`requireProjectAccess` first, then `applyProjectUpdate`. The patch is spread over
the existing project (`project-update.ts:55-61`), so any field the caller sends -
including `ownerId` - overrides the stored value.

### 1.6 MCP side

- One stdio server (`mcp/read-only/server.ts:8-25`) registering read-only,
  authoring and production tools.
- Every HTTP call carries the **same** service token
  (`mcp/read-only/api-client.ts:86,92`). There is no per-user context anywhere in
  the MCP layer.
- `create_project` (`mcp/authoring/tools.ts:209-221`) -> `POST /api/projects`
  with the service token -> **ownerless project**.
- `update_project` (`mcp/authoring/tools.ts:223-231`) -> `PUT /api/projects/{id}`;
  as a service it always passes the ownership check.
- `list_projects` (`mcp/read-only/tools.ts:135-145`) -> service list (all).

---

## 2. Exact cause of the blocker

1. Hermes calls `create_project` with the **service token**, so
   `app/api/projects/route.ts:29` stores **no `ownerId`** (ownerless).
2. The browser user's project list is owner-scoped
   (`page-access.ts:14` -> `project-store.ts:689`), so the ownerless project is
   **never listed**.
3. The only automatic capture is `claimUnownedProjects`, which runs **once, at
   new-session creation** (`session/route.ts:28`). A browser that already holds
   the 30-day session cookie (`session/route.ts:30`) - i.e. any returning user -
   never re-runs it. Projects Hermes creates afterwards stay ownerless and
   invisible.
4. Direct navigation to `/projects/{id}` *would* claim it via the legacy
   first-claim (`access-control.ts:91-111`, `page-access.ts:34-47`), but the id
   is not discoverable through the UI, and this path is undocumented.

Secondary problem: even on a fresh session, `claimUnownedProjects` claims **all**
ownerless projects to whoever mints the first session - first-caller-wins. That
contradicts the tenant-isolation requirement (section 5) in any shared/local
multi-user deployment (already flagged in `p14-security-hardening.md:153-155`).

---

## 3. Option comparison

### Option A - server-side user-identity delegation at MCP creation

Idea: MCP supplies a browser subject; the server stamps it as `ownerId`.

- **Rejected on principle (task rule 4).** The service token proves *which
  service is calling*, not *which browser user should own the project*. Accepting
  a subject on the request is "trusting a freely supplied user subject".
- There is no stable browser subject locally: subjects are random
  `user_<uuid>` minted per cookie (`auth.ts:71-73`), so a fixed MCP config cannot
  name "the intended user". Delegation is only meaningful once a real IdP
  provides stable subjects, and then it must be a **server-trusted mapping**
  (allowlist/config), never a per-request value.
- **Security:** if any party could pass an arbitrary subject, a service-token
  holder could create projects owned by anyone, or reassign ownership - full
  cross-tenant takeover. This is exactly the anti-pattern already latent in the
  `PUT` ownerId passthrough (section 5.2).
- **Scope:** requires IdP integration plus a trusted subject mapping - medium to
  large, outside "keep the scope small".

### Option B - explicit, authorized project claim (recommended)

Keep service-created projects ownerless; let an authenticated browser user
**claim a specific project by id**, authorized by the user's own server-signed
session (not a supplied subject). This already exists partially as the legacy
first-claim; the work is to make it explicit, discoverable and hardened.

Preferred shape:

- **B1 - narrow claim path.** Add a session-only `POST /api/projects/{id}/claim`
  that claims **only an ownerless** project: idempotent when already owned by the
  caller, `NOT_FOUND`/`CONFLICT` when owned by someone else, `FORBIDDEN` for a
  service identity (a service never "owns"). Reuse the existing
  `mutateProject` claim pattern from `access-control.ts:93-97`.
- **B2 - discovery.** Let the browser obtain the id out-of-band (Hermes already
  returns `projectId` from `create_project`) and open `/projects/{id}` (existing
  first-claim) or call the claim endpoint. Optionally, and **only in local
  security mode**, render ownerless projects as "unclaimed" so the single local
  operator can claim them - never in production, to preserve isolation.
- **B3 - harden ownership immutability.** Strip/reject `ownerId` in the generic
  `update_project`/`PUT` patch so ownership can only change through the explicit
  claim path. This closes the untrusted-subject vector and protects the claim.

- **Security:** authorization derives from the server-signed session; no
  client-supplied subject is trusted. No global visibility outside local mode.
- **Backward compatibility:** ownerless projects remain valid and claimable; no
  data migration required.
- **Scope:** small - one route + reuse of existing store helper; UI optional.

### Verdict

Option B. It satisfies rules 4 and 5, needs no IdP, is backward compatible, and
is far smaller. Option A should only be revisited once a real IdP supplies stable
subjects, and even then only as a server-trusted configuration mapping.

---

## 4. Involved files and routes

| Concern | Location |
| --- | --- |
| Identity resolution | `lib/security/auth.ts:139-156`; `lib/security/server-identity.ts:10-13` |
| Security mode / secrets | `lib/security/config.ts:26-90` |
| Session minting + bulk claim | `app/api/auth/session/route.ts:8-35` |
| Session bootstrap (client) | `components/session/session-bootstrap.tsx:12-23` |
| Create / list (API) | `app/api/projects/route.ts:7-37` |
| Detail read/update/delete | `app/api/projects/[id]/route.ts:12-109` |
| Access enforcement | `lib/security/access-control.ts:75-119` |
| Page access + first-claim | `lib/security/page-access.ts:9-54` |
| Server-action create | `app/actions.ts:13-21` |
| Owner-scoped list filter | `lib/storage/project-store.ts:670-695` |
| Create / claim / readTag | `lib/storage/project-store.ts:114-126, 706-712, 730-774` |
| Patch merge (ownerId passthrough) | `lib/projects/project-update.ts:55-61`; `lib/projects/normalize-project.ts:374` |
| Pages | `app/page.tsx:8-11, 52-83`; `app/projects/page.tsx:7-13`; `app/projects/[id]/page.tsx:11-23` |
| MCP client (service token) | `mcp/read-only/api-client.ts:83-95, 129-146` |
| MCP tools | `mcp/authoring/tools.ts:24-35, 96-116, 209-231`; `mcp/read-only/tools.ts:135-145` |

---

## 5. Security risks found during recon

1. **Ownerless projects are invisible, not protected by oversight.** The current
   safety comes from list filtering, not from a deliberate ownership decision -
   hence the blocker.
2. **`ownerId` is mutable through the generic patch.** `PUT /api/projects/{id}`
   spreads the incoming body over the stored project
   (`project-update.ts:55-61`) and `normalizeProject` preserves `ownerId`
   (`normalize-project.ts:374`). A service caller can therefore set/steal
   ownership, and a user can reassign their own project to an arbitrary subject.
   This is the same "trust a supplied subject" hazard and should be closed (B3)
   before any claim feature is added.
3. **Bulk first-claim on session creation** (`session/route.ts:28`) is
   first-caller-wins over *all* ownerless projects - an isolation smell in any
   shared deployment (already noted at `p14-security-hardening.md:153-155`).
4. **No stable production browser identity.** Production refuses anonymous
   sessions and there is no IdP yet (`p14-security-hardening.md:145-150`), so a
   production "claim by browser user" leans on an identity that does not exist
   yet. The claim design must therefore be explicit and role-tolerant, and it
   cannot assume a stable subject in production.

---

## 6. Migration impact

- **No migration needed.** Ownerless projects stay valid; the legacy first-claim
  keeps working for existing data and for fresh sessions.
- Existing `hermes_test_002` projects are ownerless. Under the current code they
  become claimable either on the next _new_ session or on direct `/projects/{id}`
  navigation. The planned `POST /api/projects/{id}/claim` (and, if adopted, the
  local-mode "unclaimed" list) gives a deterministic path without mutating data
  during recon.
- If the bulk `claimUnownedProjects`-on-session is later replaced by explicit
  claiming, that is a behavior change to document; it improves isolation but is
  **not** required to unblock the current test flow.

---

## 7. Targeted tests to add (user / service / browser identities)

1. **Service create -> ownerless.** `POST /api/projects` with bearer -> 201 and
   stored project has no `ownerId`.
2. **Service read/update bypass.** Service can `GET`/`PUT` any project regardless
   of owner.
3. **Browser claim (explicit).** Authenticated session claims a specific
   ownerless project -> `ownerId === subject`; same subject claims again ->
   idempotent; a different subject claims -> `NOT_FOUND`/`CONFLICT`; no residual
   ownerless state.
4. **Browser list isolation.** A user's list excludes another user's owned
   project; a service list includes it.
5. **Ownerless visibility policy.** Local mode (if adopted) lists ownerless
   projects as "unclaimed"; production mode does not.
6. **Ownership immutability (B3).** `PUT /api/projects/{id}` with a body
   containing `ownerId` does **not** change the stored owner (for both user and
   service callers).
7. **Existing first-claim regression.** `page-access` / `access-control` legacy
   claim behavior unchanged (covered today by `tests/page-access.test.ts`,
   `tests/page-authorization.test.ts`, `tests/project-claim.test.ts`).

Existing coverage to extend: `tests/project-claim.test.ts` (store-level claim),
`tests/auth-session-route.test.ts` (session + bulk claim),
`tests/page-access.test.ts` / `tests/page-authorization.test.ts` (page auth),
`tests/mcp-authoring.test.ts` (create_project).

---

## 8. Recommendation summary

Adopt **Option B**: keep Hermes projects ownerless, add an explicit
session-authorized `claim` path (B1) with a discovery route for the id (B2), and
close the `ownerId` patch passthrough (B3). Reject per-request subject delegation
(Option A). No data migration; scope stays small. Await approval before
implementing.
