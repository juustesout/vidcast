# Handleiding - Local Explainer Video Studio (MCP workflow)

**Laatst bijgewerkt:** 2026-10-13 (na MCP-uitbreiding: references, losse scene-video, cancel, job-polling)

Deze handleiding beschrijft de volledige workflow om via de MCP-tools + REST API een explainer video te bouwen in de Local Explainer Video Studio (localhost:3000). Bijgewerkt na de MCP-uitbreiding waarmee Hermes nu ook reference-images kan uploaden, scene-video's los kan genereren, jobs kan pollen en kan annuleren.

---

## 1. Basis

| Item | Waarde |
|---|---|
| App | `http://localhost:3000` (Next.js, dev mode) |
| API | Zelfde server, `/api/*` routes - NIET :3001 (manual.txt zegt :3001, dat is fout) |
| Token | `test001` (Bearer auth, header `Authorization: Bearer test001`) |
| MCP server | `explainer-local` - stdio via wrapper `/opt/data/profiles/operator/scripts/explainer-mcp.sh` |
| Projecten | Persisteren op disk; MCP tools praten via REST naar de app |

### MCP config (werkt)

```yaml
mcp_servers:
  explainer-local:
    command: bash
    args: [/opt/data/profiles/operator/scripts/explainer-mcp.sh]
    enabled: true
```

Waarom wrapper: directe `npx tsx mcp/read-only/server.ts` + env vars via Hermes config faalde met "Connection closed" (npx resolver/stdio issue). De wrapper zet env vars en start de server.

### .env van de app (belangrijk voor real-mode)

```bash
EXPLAINER_API_TOKEN=test001            # wat de MCP ook moet gebruiken
PRODUCTION_RUN_ALLOW_REAL_PROVIDERS=true
RUN_REAL_IMAGE_PILOT=true
CONFIRM_REAL_IMAGE_PILOT=YES           # MISTE eerst -> images faalden stil
RUN_REAL_NARRATION_PILOT=true
CONFIRM_REAL_NARRATION_PILOT=YES       # MISTE eerst -> narration hing op "generating"
OPENAI_API_KEY=sk-...                  # moet in app-root .env staan (/workspace/explainer/.env)
ELEVENLABS_API_KEY=sk_...
TTS_DEFAULT_VOICE_ID=TX3LPaxmHKxFdv7VOQHJ  # "default" voice bestaat NIET bij ElevenLabs
FAL_KEY=...                            # nodig voor real-mode VIDEO (fal provider)
```

**Pilot-gates:** real-mode providers hebben per-modality bevestiging nodig. Zonder `CONFIRM_REAL_*_PILOT=YES` faalt de boel fail-closed (soms stil). Video via FAL gebruikt `FAL_KEY`; ontbrekende credentials geven `PROVIDER_NOT_CONFIGURED`.

---

## 2. MCP-tools (actueel)

### Read-only
`list_projects`, `get_project`, `get_scene`, `get_validation_report`, `get_production_plan`, `get_project_compositions`.

### Polling / lifecycle
**`get_generation_job`** - LET OP: dit is GEEN pure read. Elke aanroep ververst de poging bij de provider en slaat de nieuwe status op (en downloadt de asset bij voltooiing). Het gedraagt zich als de `video_poll`-stap van een run.

### Authoring (mutating)
`create_project`, `update_project`, `plan_scene_intents`, `materialize_scene_intents`, `approve_scene_intents`, `manage_project_music`, **`create_reference`**, **`generate_video`**, **`cancel_video`**.

### Production
`run_production`, `get_run_status`, `get_run_log`.

`run_production` accepteert nu `mode`, `providers`, `maxIterations` en **`force`** (voorheen niet doorgegeven; nu wel).

---

## 3. De volledige workflow

Er zijn twee routes voor video:
- **Route A - volledige productie-run** (`run_production`): de planner doet beeld + voice + video + render + compose. Handig voor de hele video in een keer.
- **Route B - losse scene-video** (`generate_video`): 1 scene tegelijk, met expliciete provider/model. Handig voor foutzoeken of gerichte regeneratie.

### Stap 1 - Project aanmaken

```
mcp_explainer_local_create_project({
  title, description, durationTarget: 30, aspectRatio: "16:9", fps: 30
})
-> { projectId }
```

`create_project` maakt automatisch 1 default scene aan. Die kun je negeren/overschrijven.

### Stap 2 (optioneel) - Reference-images uploaden

Video-consumerende providers (image-to-video) hebben start- en/of eindframes nodig. Die upload je als reference en verwijs je daarna vanuit de scene.

```
mcp_explainer_local_create_reference({
  projectId,
  name: "start",
  contentBase64: "<raw base64 OF data:image/png;base64,...>",
  mimeType: "image/png",        // optioneel; wordt afgeleid uit data-URL/extensie
  fileName: "start.png",        // optioneel
  description: "openingsframe",
  tags: ["frame"]
})
-> { referenceId, filePath, mimeType, width, height, filesize }
```

- Toegestaan: `png`, `jpg`/`jpeg`, `webp`. De gedecodeerde payload is gecapt op 25 MB.
- `contentBase64` accepteert zowel ruwe base64 als een volledige `data:` URL.
- Ongeldige inhoud -> `INVALID_ARGUMENT`; onbekend project -> `NOT_FOUND`.

### Stap 3 - Scenes + narration in een update

> **update_project MET `scenes` array.** Het scenes array VERVANGT de hele scenes - stuur altijd ALLE scenes in een keer.

```
mcp_explainer_local_update_project({
  projectId,
  project: {
    scenes: [ ...scenes... ],
    narration: { text: "...", segments: [...] }   // fallback op projectniveau
  }
})
-> { valid: true }
```

**Scene met gegenereerde video (image-to-video):**

```json
{
  "id": "scene-1",
  "order": 1,
  "duration": 6,
  "type": "video",
  "narration": {
    "text": "What if you could...",
    "voiceId": "TX3LPaxmHKxFdv7VOQHJ",
    "status": "planned"
  },
  "referenceIds": ["<referenceId-start>", "<referenceId-end>"],
  "visual": {
    "kind": "generated_video",
    "generation": {
      "kind": "video",
      "status": "planned",
      "prompt": "Slow push-in on a browser window ...",
      "provider": "fal",
      "model": "minimax/h3-max-turbo/image-to-video",
      "startFrameReferenceId": "<referenceId-start>",
      "endFrameReferenceId": "<referenceId-end>"
    }
  },
  "render": { "motion": { "preset": "zoom_in" }, "transition": { "type": "fade" } },
  "overlay": { "type": "text", "text": "Create Videos", "position": "center" }
}
```

> **Scene met gegenereerd beeld:** gebruik `"kind": "generated_image"` en `generation.kind: "image"` met `model: "gpt-image-1"` (zie sectie 4).

**Valkuilen:**
- `narration` MOET op scene-niveau staan (niet alleen project-niveau). De productie-run leest van scenes.
- `startFrameReferenceId` / `endFrameReferenceId` moeten elk een van de effectieve reference-ids zijn (`scene.referenceIds`, of `generation.referenceIds` als die gezet is). Ze blijven behouden bij latere updates.
- Voor generieke (non-frame) conditioning ondersteunt FAL image-to-video GEEN losse references; het accepteert alleen start/eindframes. Platte references bij een i2v-model geven `REFERENCE_ERROR`.
- Text-to-video mag geen reference-images hebben.

### Stap 4 - Video genereren

**Route B - losse scene (aanbevolen voor 1 scene / debuggen):**

```
mcp_explainer_local_generate_video({
  projectId, sceneId,
  provider: "fal",
  model: "minimax/h3-max-turbo/image-to-video",   // of .../text-to-video
  mode: "real",                                    // of "mock"
  regenerate: false
})
-> { generationAttemptId, sceneId, status, provider, model, providerJobId, providerStatus }
```

- De start/eindframes en de reference-set komen uit de SCENE, niet uit deze call. Zet die eerst met `update_project`.
- Dit is een **expliciete betaalde actie** in real mode en wordt nooit automatisch hertryd.
- Mock mode staat alleen de lokale video-provider toe; real mode vereist een echte provider + credentials.
- Een scene die al een actieve job heeft geeft `CONFLICT` (`generation.scene.busy`) - een tweede betaalde submit kan niet starten.

**Route A - volledige productie-run:**

```bash
curl -s -X POST "http://localhost:3000/api/projects/<PROJECT_ID>/production-runs" \
  -H "Authorization: Bearer test001" \
  -H "Content-Type: application/json" \
  -d '{
    "mode": "real",
    "providers": { "image": "openai", "narration": "elevenlabs", "video": "fal" },
    "force": true,
    "maxIterations": 24
  }'
```

Of via MCP: `run_production({ projectId, mode, providers, force, maxIterations })`.

- `mode:"mock"` = gratis, geen providers.
- `mode:"real"` = echte calls (kost geld).
- `force:true` = regenereert over bestaande (mock) assets heen. Zonder force: "already current" -> 0 actions.
- `force:false` na een gemiste run = pakt alleen de missende scenes op (handig na restart).

### Stap 5 - Pollen

**Losse scene-video:**

```
mcp_explainer_local_get_generation_job({ projectId, attemptId })
-> { sceneId, generationAttemptId, status, assetId, provider, model,
     providerJobId, providerStatus, errorCode, errorMessage, lastPolledAt }
```

- `status`: `queued` -> `generating` -> `generated` / `failed` / `rejected` (bij succes wordt `status='generated'` en `providerStatus='COMPLETED'`).
- **Recovery:** een transiente poll-fout (incl. ontbrekende/onbereikbare credentials, `NOT_CONFIGURED`) laat de poging actief en herhaalbaar: `providerStatus='status_unresolved'` en HTTP 503 (`generation.attempt.statusUnresolved`). Alleen een echte `INVALID_REQUEST` is definitief.
- **Cancel:** `mcp_explainer_local_cancel_video({ projectId, sceneId })` -> `{ status, providerStatus }`. Annuleren is expliciet en idempotent-veilig; een niet-actieve job geeft `CONFLICT` (`generation.scene.notActive`).

**Productie-run:**

```
mcp_explainer_local_get_run_status({ runId })
-> queued -> running -> completed / partial / failed / unresolved
```

- **completed** = alle actions klaar (render + compose).
- **partial** = een deel van de acties is klaar, de rest niet.
- **unresolved** = gedeeltelijk - check `unresolvedActions` en `failedActionIds`.
- `run_production` retourneert een bestaande actieve run (`reused:true`) in plaats van een nieuwe.

### Stap 6 - MP4 ophalen

```
mcp_explainer_local_get_project_compositions({ projectId })
-> { available: true, latest: { downloadPath, filesize, duration } }
```

Download (REST-only):

```bash
curl -s -o promo.mp4 \
  -H "Authorization: Bearer test001" \
  "http://localhost:3000<downloadPath>"
```

Bestandgrootte als sanity check: mock video's zijn ~156KB (zwarte plaatjes), echte met AI beelden + voice-over ~5.9MB voor 30s.

---

## 4. Provider/model-gids

### OpenAI images (getest)

| Model | Resultaat op deze account |
|---|---|
| `gpt-image-1` (default) | WERKT - b64 terug |
| `dall-e-3` | `Unknown parameter: 'response_format'.` (PROVIDER_REJECTED) |
| `dall-e-2` | waarschijnlijk ook fout (niet getest) |

Conclusie: gebruik ALTIJD `gpt-image-1`. Zet het model expliciet per scene. De scene-waarde overschrijft `OPENAI_IMAGE_MODEL` uit `.env`.

### FAL video

- Endpoint/model-id bepaalt t2v vs i2v via de suffix:
  - `minimax/h3-max-turbo/text-to-video` (t2v, default)
  - `minimax/h3-max-turbo/image-to-video` (i2v)
- Auth: `Authorization: Key $FAL_KEY`.
- i2v accepteert max 1 start- en/of 1 eindframe; heeft minstens een van beide nodig.
- `provider` waarden: `openai` | `fal` | `local` | `fake`. In real mode wordt een niet-echte provider geweigerd (`PROVIDER_NOT_CONFIGURED` / `PROVIDER_ERROR`).

### ElevenLabs voice-over

- `voice_id 'default'` bestaat NIET. Geldige premade voices:
  - `TX3LPaxmHKxFdv7VOQHJ` = Alice (Clear, Engaging Educator)
  - `XrExE9yKIg1WjnnlVkGX` = Matilda (Professional)
  - `cgSgspJ2msm6clMCkdW9` = Jessica (Playful, Warm)
- Zet `voiceId` per scene in `narration.voiceId` - overschrijft `TTS_DEFAULT_VOICE_ID`.

---

## 5. Kosten / mode bewustzijn

- `mode:"mock"` = gratis, geen providers aangeroepen. Goed voor structuurtesten.
- `mode:"real"` = betaalde calls: images (gpt-image-1) + narration (ElevenLabs) + video (FAL) + muziek.
- Zowel `generate_video` als `manage_project_music` zijn aparte betaalde acties in real mode en worden nooit automatisch hertryd.

---

## 6. Bekende beperkingen / valkuilen

| Issue | Symptoom | Fix |
|---|---|---|
| `materialize_scene_intents` | `{materialized:[], skipped:[]}` - maakt NOOIT scenes (visualIntent leeg, status draft) | scenes handmatig via update_project |
| `plan_scene_intents` werkt wel | maakt intents met lege visualIntent | negeren; niet cruciaal voor de flow |
| Restart app mid-run | scenes "Interrupted by process restart" (errorCode INTERNAL), run blijft unresolved hangen | nieuwe run starten (force:false pakt alleen missenden) |
| Mock assets blijven | real-mode run: "already current", 0 actions | `force:true` of nieuw project |
| MCP `force` param | (opgelost) | `run_production` geeft `force` nu door; anders REST curl |
| Manual.txt | zegt :3001, werkelijkheid :3000 | negeer port in manual |
| Scene busy | tweede submit faalt met `CONFLICT` (`generation.scene.busy`) | wacht of `cancel_video`, dan opnieuw |
| i2v met platte references | `REFERENCE_ERROR` | gebruik expliciete start/eindframes |

---

## 7. Snelle referentie - REST endpoints

```
GET    /api/projects                                          # lijst
POST   /api/projects                                          # create
GET    /api/projects/[id]                                     # detail
PUT    /api/projects/[id]                                     # update (project patch incl. scenes)
GET    /api/projects/[id]/validation-report                   # validatie
GET    /api/projects/[id]/production-plan                     # planner
POST   /api/projects/[id]/references                          # reference upload (multipart OF JSON base64)
POST   /api/projects/[id]/scenes/[sceneId]/generate-video     # losse scene-video (provider/model/mode)
POST   /api/projects/[id]/scenes/[sceneId]/cancel-video       # annuleren
GET    /api/projects/[id]/generation-jobs/[attemptId]         # job pollen
POST   /api/projects/[id]/production-runs                     # run starten (force/mode/providers)
GET    /api/production-runs/[runId]                           # status
GET    /api/production-runs/[runId]/log                        # event log
POST   /api/projects/[id]/music                               # muziek (generate/regenerate/select/clear)
GET    /api/projects/[id]/compositions                        # composities lijst
GET    /api/projects/[id]/compositions/[cId]/file             # MP4 download
POST   /api/auth/session                                      # browser session (niet nodig voor MCP)
```

---

## 8. Checklist voor een nieuwe video

1. [ ] `create_project` (durationTarget, aspectRatio)
2. [ ] (optioneel) `create_reference` - start/eindframes uploaden (base64)
3. [ ] `update_project` - scenes (image: `gpt-image-1`; video: `fal` + t2v/i2v model; `voiceId` echt; frames via `startFrameReferenceId`/`endFrameReferenceId`; `overlay`)
4. [ ] `update_project` - narration.project ook vullen (fallback tekst)
5. [ ] (optioneel) `manage_project_music`
6. [ ] Video: `generate_video` per scene (Route B) OF `run_production` met mode/providers/force (Route A)
7. [ ] Poll: `get_generation_job` (per scene) of `get_run_status` (run) tot terminal
8. [ ] Bij failed: check scene `generation.error` + `errorCode` (niet alleen run summary); bij een nog-actieve job `cancel_video`
9. [ ] `get_project_compositions` + curl download
10. [ ] Sanity: filesize >1MB bij real-mode verwacht
