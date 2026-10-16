# P22: Secure MCP Project Claim + Immutable Ownership - Implementation report

Status: **partial, fail-closed.** One safe part implemented and verified
(immutable ownership). The claim endpoint was **not** implemented because the
current architecture offers **no trusted authorization basis**; per the task this
stops and reports instead of shipping an insecure claim.

No commit or push.

---

## 1. What was done

### 1.1 Ownership is now immutable through generic project updates

`ApplyProjectUpdate` merges a request body over the stored project. Previously an
incoming `ownerId` was spread through and won (`lib/projects/project-update.ts` +
`normalize-project.ts:374`), so any caller could reassign or clear ownership.

Change (`lib/projects/project-update.ts`): after the incoming-body spread, the
merge now forces `ownerId: existingProject.ownerId`, exactly like `id`,
`createdAt` and `updatedAt`. Ownership can only change through the server-
controlled paths (`createProject` owner argument, `claimUnownedProjects`, the
legacy first-claim), never through a project patch.

This is the single choke point for every generic patch route:

- `PUT /api/projects/{id}` (`app/api/projects/[id]/route.ts:54,69`)
- `POST /api/projects/{id}/scene-intents/plan` (`.../plan/route.ts:29,38`)
- `POST /api/projects/{id}/scene-intents/materialize` (`.../materialize/route.ts:29,39`)

### 1.2 Other generic write routes reviewed

- Global search for `ownerId` in `app/api/` finds it only in
  `app/api/projects/route.ts:29-30`, where it is derived from the **server**
  identity (`service -> undefined`, `user -> subject`); the POST body is typed
  narrowly and never spread onto the project. Safe.
- `scene-intents/approve/route.ts`, `music/route.ts`, render/compose/generate-*
  routes and the assets/references routes mutate specific fields or append
  resources via `mutateProject`; none accepts a whole project body, and none
  writes `ownerId`. No additional `ownerId` vector was found.
- `projectStore.updateProject(project)` writes a whole project object, but no
  route passes a raw request body to it (only server-derived projects in
  `run-service.ts:552` and tests).

So the generic-update risk is fully closed at the shared merge layer.

---

## 2. Authorization model

- Ownership can only be **assigned by the server**: from the request identity
  (a user session subject or nothing for a service), or by the existing
  `claimUnownedProjects` / legacy first-claim paths.
- A generic update can never change or clear ownership; the stored owner always
  wins over the body, for both user and service callers.
- A service token still cannot establish browser ownership: it never carried an
  owner (POST stores none) and now cannot inject one through `PUT` either.

---

## 3. Why the claim endpoint was NOT implemented (blocker)

The task requires a **fail-closed** claim: claim only when the project is
ownerless **and** the server has a trustworthy reason to allow it; a random
project id is not proof of ownership.

Investigation result: **no such reason exists in the current architecture.**

- Ids are `project_<uuid>` (`lib/utils/ids.ts:2`) - unguessable, but not secret
  capabilities; they leak through URLs, logs and MCP output.
- There is no per-project secret, invite, share link, capability or claim token
  anywhere (verified: no `share|invite|capability|claimToken|ownerToken` concept
  in `app/`, `lib/`, `mcp/`).
- The two existing "claim" mechanisms are both first-caller-wins and id-based:
  - `projectStore.claimUnownedProjects` on **new-session creation**
    (`app/api/auth/session/route.ts:28`) claims **all** ownerless projects;
  - the legacy first-claim in `requireProjectAccess` /
    `getProjectForIdentity` (`lib/security/access-control.ts:91-111`,
    `lib/security/page-access.ts:34-47`) claims an ownerless project by id.
- A user subject is random per session (`auth.ts:71-73`) and there is no IdP, so
  a service cannot name "the intended user" either.

Therefore a `POST /api/projects/{id}/claim` guarded only by "valid user session +
ownerless" would let **any** authenticated user who learns a project id claim it
- exactly the case the task forbids. Per instruction 3 ("stop ... instead of
allowing an insecure claim"), it was not built. Discoverability is likewise
blocked: there is no way to couple the intended user to a specific project
without a new trust mechanism (instruction 6/10), so no listing/UI was added.

Related observation (unchanged, reported not fixed): the bulk
`claimUnownedProjects`-on-new-session remains first-caller-wins over all
ownerless projects. With ownership now immutable via `PUT`, the bulk path is the
only remaining automatic capture, and it is unaffected by this change.

---

## 4. Smallest safe next step (proposal - needs approval, not implemented)

Introduce a **server-minted, single-use claim capability**, delivered over the
already-trusted service channel:

1. When a **service** caller creates a project (`POST /api/projects`), the server
   also mints a high-entropy `claimToken` (e.g. 32 random bytes, base64url),
   stores only its **hash** (and an expiry) on the project, and returns the token
   **once** to the service. The browser never sees it in a list.
2. Hermes passes the token to the intended user out-of-band (it is the party that
   knows who asked).
3. `POST /api/projects/{id}/claim` (user session only; a service token is
   rejected) verifies the presented token against the stored hash in constant
   time, then **atomically** under the project keyed lock assigns
   `ownerId = identity.subject` and consumes the token. Fail-closed: already
   owned -> `CONFLICT`; unknown id -> `NOT_FOUND`; missing/wrong/expired token ->
   `FORBIDDEN`/`NOT_FOUND`.

Properties: authorization is possession of a capability created by the trusted
server and delivered by the trusted channel - not a freely supplied subject and
not merely knowing the id. It is small (one optional project field, one route,
reuse of `mutateProject`). It **is** a new trust mechanism, so per the task it is
proposed here rather than implemented.

Cheaper alternative with no new state (not recommended): keep using the existing
deep-link first-claim and treat the UUID as a bearer capability. This conflicts
with the task's explicit "a random id is not proof of ownership" and was
rejected.

---

## 5. Files changed

| File | Change |
| --- | --- |
| `lib/projects/project-update.ts` | Force `ownerId: existingProject.ownerId` in the merge (server-authoritative). |
| `tests/project-update.test.ts` | +4 unit tests: reassign ignored, clear ignored, ownerless stays ownerless, partial patch preserves owner. |
| `tests/project-ownership.test.ts` | New route-level tests for `PUT /api/projects/:id` (see below). |

`tests/project-ownership.test.ts` cases: owner renames + tries `ownerId`
reassign; owner tries to clear owner; service token tries to assign owner to a
browser subject (stays ownerless); service token tries to strip an owner (owner
kept); normal owner content update still applies.

---

## 6. Verification (exact commands and results)

- `npx vitest run tests/project-update.test.ts tests/project-ownership.test.ts`
  -> 2 files, 21 tests passed.
- `npm run typecheck` (`tsc --noEmit`) -> clean.
- `npm run lint` (`next lint`) -> "No ESLint warnings or errors".
- `npm test` (`vitest run`) -> **95 files / 705 tests passed** (baseline was
  94/696; +1 file, +9 tests).
- `npm run build` (`next build`) -> succeeded; `/projects/[id]` unchanged at
  49.4 kB / 152 kB first-load.

---

## 7. Remaining blockers

1. **Claim authorization**: no trusted basis in the current architecture
   (section 3). Needs the claim-capability mechanism (section 4) or a real IdP.
2. **Discoverability**: cannot safely surface ownerless/service projects to a
   browser without the same new capability; intentionally not implemented.
3. **Bulk first-claim on new session** remains first-caller-wins (pre-existing).

Awaiting approval before implementing the claim capability.
