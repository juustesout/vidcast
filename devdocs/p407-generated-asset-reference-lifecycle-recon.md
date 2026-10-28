# P407 - Levenscyclus van `asset.generation.referenceIds`

Recon only. Geen productiecode gewijzigd, geen model- of migratiewijziging, geen
UI-wijziging, geen commit en geen push. Er zijn geen betaalde provider-calls
gedaan, geen generatie- of renderjobs gestart en geen assets geregenereerd. Alle
probes zijn read-only of schrijven uitsluitend naar een tijdelijke map onder
`/tmp/opencode/`; `projects/` in de workspace is niet gemuteerd.

Inspectiedatum: 2026-10-28. Branch: `261021-feat-motion-canvas-animation-mcp`.
HEAD: `a163da2` (`docs(p405): add project bible and prompt compiler recon`).
Working tree bevat de nog niet gecommitte P406-wijzigingen
(`lib/projects/usage.ts`, `lib/projects/normalize-project.ts`,
`lib/explainer/human-approval.ts`, `tests/p406-reference-integrity.test.ts`);
die zijn niet aangepast tijdens deze recon.

Methode: code-inspectie van het projectmodel, normalisatie, validatie,
generatie-services, opslag, verwijderpaden, productieplanner, renderpaden en de
UI; plus read-only `tsx`-probes (`/tmp/opencode/probe-p407*.ts`) tegen de echte
functies en de echte seed-projectflow. De probes draaien in een tijdelijke
`process.cwd()`, zodat `getProjectsRoot()` daar een verse `projects/` aanmaakt.

---

## 1. Oordeel

**Bevestigd defect, met een echte deadlock voor een normale gebruiker.**

`asset.generation.referenceIds` is een blijvende herkomst-trace op een
gegenereerd asset. Die trace:

- wordt eenmalig geschreven bij het aanmaken van het asset;
- wordt door `getReferenceUsage` **niet** als gebruik geteld;
- wordt door `validateProject` **wel** als harde fout gevalideerd.

Daardoor geldt: een referentie die alleen nog in zo'n trace voorkomt, mag worden
verwijderd, waarna het project ongeldig wordt. Omdat een ongeldig project niet
meer opgeslagen kan worden, kan de gebruiker daarna het asset niet meer losmaken
van zijn scènes. En omdat `deleteAsset` een asset dat nog aan een scène hangt
weigert, is er geen UI-pad meer terug.

Er zijn precies drie reparaties, en in de deadlock werkt er geen enkele vanuit de
UI:

1. het asset verwijderen - geblokkeerd zolang een scène het gebruikt, en juist
   dat losmaken kan niet meer omdat opslaan faalt;
2. een volledige project-PUT die de trace leegmaakt - werkt (F4), maar vereist
   een client die `assets` meestuurt;
3. het referentie-record opnieuw aanmaken - werkt (F4), maar vereist idem een
   project-PUT en geeft een referentie zonder `filePath`.

Reparaties 2 en 3 zijn niet in de UI beschikbaar. Ze werken überhaupt alleen
omdat `mutateProject` zelf niet valideert; de PUT-route doet dat wel.

Dit is reproduceerbaar op de echte seed-projectflow (probe `p407h`), niet alleen
op een synthetische fixture.

---

## 2. Wat er feitelijk is onderzocht

| Onderdeel | Bestanden |
| --- | --- |
| Schrijfpad van de trace | `lib/storage/media-store.ts`, `lib/generation/image-generation-service.ts`, `lib/generation/video-generation-service.ts`, `lib/generation/presenter-service.ts` |
| Model en normalisatie | `lib/types/asset.ts`, `lib/types/generation.ts`, `lib/types/render.ts`, `lib/projects/normalize-project.ts` |
| Validatie | `lib/validation/project-validation.ts` |
| Gebruik en verwijdering | `lib/projects/usage.ts`, `lib/storage/project-store.ts`, `app/api/projects/[id]/assets/[assetId]/route.ts`, `app/api/projects/[id]/references/[referenceId]/route.ts` |
| Patch/save-pad | `lib/projects/project-update.ts`, `app/api/projects/[id]/route.ts`, `components/project/project-workspace.tsx` |
| Productie en render | `lib/production/production-planner.ts`, `lib/production/production-runner.ts`, `lib/render/render-status.ts`, `app/api/projects/[id]/render/route.ts`, `app/api/projects/[id]/compose/route.ts` |
| UI | `components/project/project-workspace.tsx`, `components/project/references-panel.tsx`, `components/project/validation-panel.tsx` |
| Seed | `lib/storage/project-store.ts` (seed-builder) |

---

## 3. Levenscyclus zoals die nu is

### 3.1 Ontstaan: precies een schrijfmoment

De trace wordt alleen gezet op het moment dat een gegenereerd asset wordt
opgeslagen:

| Functie | Regel | Trace-inhoud |
| --- | --- | --- |
| `saveGeneratedImage` | `lib/storage/media-store.ts:299`, trace op `:332` | `input.generation.referenceIds` |
| `saveGeneratedVideo` | `lib/storage/media-store.ts:379`, trace op `:413` | `input.generation.referenceIds` |
| `saveGeneratedPresenter` | `lib/storage/media-store.ts:420`, trace op `:460` | `input.generation.referenceIds` |
| `saveGeneratedAudio` | `lib/storage/media-store.ts:467`, trace op `:499` | altijd `[]` |
| `saveGeneratedMusic` | `lib/storage/media-store.ts:506`, trace op `:551` | altijd `[]` |

De waarde komt uit de generation-service:

- image: `lib/generation/image-generation-service.ts:256` kiest
  `current.referenceIds` (snapshot) en valt terug op `scene.referenceIds`;
  `:369-381` geeft die door aan `saveGeneratedImage`. Het asset wordt daarna
  toegevoegd op `:412`.
- video: `lib/generation/video-generation-service.ts:1025` gebruikt
  `attempt.referenceIds ?? []`; het asset wordt toegevoegd op `:1100`.

Belangrijk: de trace wordt **nooit** bijgewerkt. Regenereert de gebruiker een
scène, dan blijft het oude asset met zijn oude trace in `project.assets` staan
(zie 3.5).

### 3.2 Opslag en normalisatie

`normalizeAsset` (`lib/projects/normalize-project.ts:421-428`) laat
`asset.generation` ongewijzigd. Er is dus geen normalisatie die verouderde ids
opruimt, en `writeProjectFile` (`lib/storage/project-store.ts:165`) normaliseert
alleen; het valideert niet. `readProjectFile` (`:104`) leest en normaliseert
eveneens zonder validatie.

### 3.3 Lezen

De enige productiecode die de trace leest, is de validatie:

- `lib/validation/project-validation.ts:637-643` ->
  `asset.generation.reference.missing` op pad
  `assets.<id>.generation.referenceIds`.

Er is geen UI die de trace toont of bewerkbaar maakt. `Asset details`
(`components/project/project-workspace.tsx:4451-4470`) toont filename, type,
MIME, afmetingen, duur, filesize, provenance, status en created; geen
`generation`-velden. De trace is dus alleen via een volledige project-PUT te
wijzigen.

### 3.4 Gebruik en verwijdering

`getReferenceUsage` (`lib/projects/usage.ts:71`) telt uitsluitend scènes, via
`sceneUsesReference` (`:53`): de scène-lijst, de generation-snapshot en de
start/end-keyframes. `asset.generation.referenceIds` komt daar niet in voor.

Gevolg in `deleteReference` (`lib/storage/project-store.ts:920-939`):

```text
usageSceneIds = getReferenceUsage(project, referenceId)   // leeg bij trace-only
if (usageSceneIds.length > 0) return { usageSceneIds }    // geen blokkade
deleteReferenceFile(...)                                  // bestand weg
mutateProject(references zonder id)                       // record weg
```

De route geeft alleen 409 bij `usageSceneIds.length > 0`
(`app/api/projects/[id]/references/[referenceId]/route.ts:50-59`). De UI doet
hetzelfde (`components/project/project-workspace.tsx:1883-1900`) en de
referentie-panelen tonen `getReferenceUsage` als "used by"
(`components/project/references-panel.tsx:80,135`).

`deleteAsset` (`lib/storage/project-store.ts:899-917`) gebruikt
`getAssetUsage` (`lib/projects/usage.ts:9`) en weigert zolang een scène het
asset gebruikt. Dat is de tweede helft van de deadlock.

### 3.5 Regeneratie hoopt traces op

Omdat assets nooit worden opgeruimd bij regeneratie
(`image-generation-service.ts:412`, `video-generation-service.ts:1100`,
`presenter-service.ts`), blijft elk historisch gegenereerd asset met zijn eigen
trace bestaan. Probe `p407l` laat zien dat één referentie dan door meerdere
assets vastgehouden kan worden, ook als geen enkele scène hem nog noemt.

### 3.6 Validatie is geen globale poort

`validateProject` wordt uitgevoerd in:

- `applyProjectUpdate` (`lib/projects/project-update.ts:73`), dus elke
  project-PUT (`app/api/projects/[id]/route.ts:54-84`);
- de productieplanner (`lib/production/production-planner.ts:183`), die
  `hasBlockingValidation` (`:684`) gebruikt om `final_compose` te blokkeren
  (`:715-718`);
- de UI voor het validatiepaneel (`components/project/project-workspace.tsx:643`);
- `getProjectValidation` (`lib/storage/project-store.ts:977`).

Hij wordt **niet** uitgevoerd bij `deleteAsset`, `deleteReference`,
`writeProject`, `readProjectFile`, de scene-renderroute
(`app/api/projects/[id]/render/route.ts`) of de compose-route
(`app/api/projects/[id]/compose/route.ts`). Een ongeldig project op schijf kan
dus nog wel gerenderd/gecomponeerd worden via die directe endpoints; alleen
opslaan en de productieplanner weigeren.

### 3.7 Seed

De seed-builder maakt `doctor_skin_generated` met
`generation.referenceIds: ['skin_closeup']`
(`lib/storage/project-store.ts:373-405`), voegt die toe op `:595` en wordt
aangemaakt door `ensureSeedProject` (`:611`) zodra `projects/` leeg is. De seed
bevat dus vanaf het eerste moment een trace die naar een echte referentie
wijst.

---

## 4. Reproduceerbare bevindingen

Alle probes zijn herhaald op 2026-10-28. Ze gebruiken de echte
`projectStore`/`validateProject`/`applyProjectUpdate`/`getReferenceUsage`.

### F1 - Trace-telling ontbreekt (kern)

`probe-p407.ts` (synthetisch, via de echte store):

```text
usage(sceneIds) for trace ref: []
valid before delete: true
delete result: {"usageSceneIds":[]}
reference still on disk: false
valid after delete: false
reference errors: [ 'asset.generation.reference.missing' ]
applyProjectUpdate valid: false errors: [ 'asset.generation.reference.missing' ]
trace persisted in json: ["ref-trace"]
```

De trace staat dus gewoon nog in `project.json`; alleen het referentie-record en
het bestand zijn weg.

### F2 - De deadlock is bereikbaar via de normale flow

`probe-p407c` (pure functies: scène gebruikt de referentie, asset hangt aan de
scène; de verwijdering is gesimuleerd met `applyProjectUpdate`, precies zoals de
PUT-route die zou uitvoeren):

```text
== initial generated state ==
ref usage: ["s1"] asset usage: ["s1"] valid: true

== after deselecting reference (asset trace untouched) ==
valid: true
ref usage: []
asset trace still: ["ref-a"]

== after deleting the now-unused reference ==
valid: false [ 'asset.generation.reference.missing' ]
asset usage (blocks asset delete): ["s1"]
any further save allowed: false
unbind scene allowed: false
```

`probe-p407b` bevestigt hetzelfde met een asset-visual in plaats van een
generated visual:

```text
scene uses asset: ["scene_3a87..."]
ref usage in scenes: []
valid before: true
reference delete allowed: {"usageSceneIds":[]}
valid after: false [ 'asset.generation.reference.missing' ]
normal save allowed: false
unbind-asset save allowed: false
asset delete blocked by scene: {"usageSceneIds":["scene_3a87..."]}
asset still present: true valid: false
```

`unbind-asset save allowed: false` is de beslissende regel: zelfs de stap die de
gebruiker uit de deadlock zou halen, wordt door de validatie geweigerd.

### F3 - De echte seed reproduceert het

`probe-p407h` (leeg tijdelijk `projects/`, dus `ensureSeedProject` maakt de
echte sample):

```text
seed title: Why Does Hot Water Make Your Skin Red?
refs: main_character,bathroom,skin_closeup
traced assets: [["doctor_skin_generated",["skin_closeup"]]]
ref usage skin_closeup: ["sample-scene-2","sample-scene-4","sample-scene-5"]
asset usage doctor_skin_generated: ["sample-scene-5"]
seed valid: true

after unbinding from scenes: usage= [] valid= true
delete skin_closeup result: {"usageSceneIds":[]}
valid after delete: false [
  'asset.generation.reference.missing @ assets.doctor_skin_generated.generation.referenceIds'
]
asset trace for doctor_skin_generated: ["skin_closeup"]
still blocked from deleting the asset: ["sample-scene-5"]
```

Dit is exact de flow die een gebruiker in de UI kan uitvoeren: referentie uit de
scènes halen, opslaan (lukt), referentie verwijderen (lukt), en daarna zit het
project vast.

### F4 - Reparaties die nu werken

`probe-p407e`:

```text
poisoned valid: false
re-inserting the reference record repairs it: true []
restored reference has no filePath: ""
clearing asset trace via a project patch repairs it: true
```

`probe-p407f`:

```text
deadlocked project valid: false
clear-trace patch valid: true
same patch with scene still using asset: asset
any other patch (rename) valid: false
drop-asset-without-clearing-trace patch valid: true []
```

`probe-p407j` (dezelfde PUT, met en zonder trace-cleanup):

```text
PUT that drops the reference (trace still points at it):
  valid: false [ 'asset.generation.reference.missing' ]
same PUT but with the trace cleaned in the same payload:
  valid: true
```

Conclusie: alleen een payload die de trace zelf leegmaakt (of het
referentie-record terugzet) komt door de validatie. Een "gewone" save
(hernoemen, ontbinden) wordt geweigerd.

Let op: het opnieuw invoegen van een referentie met `filePath: ""` slaagt omdat
`project-validation.ts:656-667` alleen een niet-lege maar onveilige padwaarde
afkeurt; een leeg pad is toegestaan. Dat is een tweede, zwakkere
integriteitsbevinding (zie 6).

### F5 - De veilige volgorde bestaat en werkt

`probe-p407i`:

```text
step1 unbind asset -> valid: true
step2 delete asset -> {"usageSceneIds":[]}
   assets left: 0 ref usage: [] valid: true
step3 delete reference -> {"usageSceneIds":[]}
   final valid: true errors: []
```

Dus: **asset van de scènes losmaken -> asset verwijderen -> referentie
verwijderen** is een geldig pad. Het probleem is dat de gebruiker deze volgorde
niet kent en dat de verkeerde volgorde onherstelbaar vastloopt in de UI.

### F6 - Historische attempts zijn niet beschermd en niet gevalideerd

`probe-p407d`:

```text
historical attempt holds a deleted ref id: ["deleted-ref"]
project valid: true errors: []
reference usage reported for attempts-only ref: []
```

`attempts[].referenceIds` komt niet voor in `lib/validation/project-validation.ts`
(0 treffers op `attempts`) en niet in `getReferenceUsage`. Een dangling
attempt-referentie is dus toegestaan. Dat is een bestaand, bewust of onbewust
getolereerd gat; het is niet de oorzaak van de deadlock.

### F7 - Regenereer-accumulatie pint referenties

`probe-p407l`:

```text
ref usage (scenes) with scene deselected: []
scenes still reference ref-a: false
valid now: true
after removing the reference record: valid: false
errors: [
  'asset.generation.reference.missing@assets.asset-old.generation.referenceIds',
  'asset.generation.reference.missing@assets.asset-new.generation.referenceIds'
]
```

Zelfs een asset dat allang niet meer aan een scène hangt, houdt de referentie
tegen nadat hij is verwijderd. Bij reparatie-optie "blokkeren" betekent dit dat
een gebruiker eerst alle historische assets moet opruimen.

### F8 - Huidige workspace heeft nog geen slachtoffers

`probe-p407k` scant alle `projects/*/project.json`:

```text
scanned projects: 2
assets with non-empty generation.referenceIds: 0
invalid projects at rest: 0
```

Er staan op dit moment twee projectbestanden op schijf (de overige
projectmappen hebben geen `project.json`) en geen daarvan heeft een gevulde
trace. De bug is dus nog niet in bestaande data geactiveerd; de seed activeert
hem zodra `projects/` leeg is.

---

## 5. Call paths

### 5.1 Verwijderen van een referentie (huidig)

```text
UI deleteSelectedReference
  components/project/project-workspace.tsx:1883
  -> DELETE /api/projects/{id}/references/{referenceId}
     app/api/projects/[id]/references/[referenceId]/route.ts:37
     -> projectStore.deleteReference
        lib/storage/project-store.ts:920
        -> getReferenceUsage            (scènes + snapshot + keyframes)
           lib/projects/usage.ts:71
        -> mediaStore.deleteReferenceFile
        -> mutateProject (schrijft zonder validatie)
```

### 5.2 Verwijderen van een asset (huidig)

```text
UI deleteSelectedAsset
  components/project/project-workspace.tsx:1819
  -> DELETE /api/projects/{id}/assets/{assetId}
     app/api/projects/[id]/assets/[assetId]/route.ts:11
     -> projectStore.deleteAsset
        lib/storage/project-store.ts:899
        -> getAssetUsage (scènes + music)
           lib/projects/usage.ts:9
```

### 5.3 Opslaan (waar de deadlock toeslaat)

```text
UI saveProject
  components/project/project-workspace.tsx:1133
  -> PUT /api/projects/{id}
     app/api/projects/[id]/route.ts:25
     -> applyProjectUpdate
        lib/projects/project-update.ts:73
        -> validateProject
           lib/validation/project-validation.ts:637-643  (harde fout)
        -> 422 bij fouten (route :55-62) of ProjectUpdateValidationError (:69-84)
```

### 5.4 Productie

```text
planProduction
  -> validateProject                 production-planner.ts:183
  -> hasBlockingValidation           :684
  -> final_compose blocked           :715-718
runProduction
  -> acties blocked/waiting          production-runner.ts:420-444
```

### 5.5 Render/compose (geen validatie)

```text
POST /api/projects/{id}/render   -> sceneRenderService.renderScene
POST /api/projects/{id}/compose  -> videoCompositionService.composeProject
```

Beide lezen het project via `requireProjectAccess`/de store en roepen
`validateProject` niet aan. Dit is een aparte bevinding (zie 6, R4).

---

## 6. Restrisico's

| Id | Risico | Bewijs/onderbouwing |
| --- | --- | --- |
| R1 | Historische attempts met dangling ids blijven toegestaan | F6; geen `attempts` in validatie en usage |
| R2 | Regenereer-accumulatie pint referenties via oude assets | F7 |
| R3 | Geen UI om de trace te bekijken of te wissen | asset-detail toont geen `generation`; alleen PUT |
| R4 | Ongeldig project kan nog renderen/composen via directe endpoints | render/compose routes valideren niet |
| R5 | Referentie met leeg `filePath` geldt als geldig | `project-validation.ts:656-667`; F4 |
| R6 | `deleteReference` verwijdert het bestand vóór de projectmutatie | `project-store.ts:936-938`: faalt de mutatie, dan is het bestand al weg |
| R7 | Dubbel gevalideerd bij PUT (buiten en binnen de lock) | `route.ts:54` en `:69`; gedrag is consistent, maar kost dubbel werk |

R1 en R2 zijn bewust niet opgelost in deze recon. R2 wordt pas urgent als
P407 "blokkeren" als reparatie kiest.

---

## 7. Voorgestelde P407-implementatie

Doel: de deadlock onmogelijk maken zonder de herkomst-trace te verliezen.

### 7.1 Aanbevolen: verwijdering blokkeren op asset-traces

Minimale, additieve wijziging:

1. `lib/projects/usage.ts`
   - nieuwe pure functie
     `getReferenceAssetUsage(project, referenceId): string[]` die
     `project.assets` scant op `asset.generation?.referenceIds?.includes(referenceId)`.
   - `getReferenceUsage` blijft ongewijzigd (scène-semantiek, geen
     breaking change voor bestaande tests/UI).
2. `lib/storage/project-store.ts`
   - `deleteReference` berekent beide lijsten en blokkeert als een van beide
     niet leeg is.
   - return-shape additief uitbreiden:
     `{ usageSceneIds: string[]; usageAssetIds: string[] }`.
   - interface op `:697` bijwerken.
3. `app/api/projects/[id]/references/[referenceId]/route.ts`
   - 409-body krijgt `usageAssetIds` en een bericht dat zowel scènes als
     assets noemt, met de veilige volgorde.
4. `components/project/references-panel.tsx`
   - "used by" toont ook "N generated asset(s)".
5. Nieuwe test `tests/p407-reference-lifecycle.test.ts`:
   - trace-only referentie blokkeert verwijdering;
   - na unbind + deleteAsset is verwijderen toegestaan (F5);
   - seed-projectflow (F3) blijft geldig na de nieuwe guard;
   - regenereer-accumulatie (F7) blokkeert zoals bedoeld.

Trade-off: een oud asset pint een referentie totdat het asset is verwijderd.
Dat is bewust: de trace is herkomst en mag niet stilzwijgend breken. De 409-
melding moet daarom expliciet de volgorde noemen.

### 7.2 Alternatief (alleen als herkomst niet nodig is)

Bij `deleteReference` in dezelfde `mutateProject` de id uit alle
`asset.generation.referenceIds` strippen (en optioneel uit `attempts`). Dit is
atomair en laat geen pinning achter, maar verwijdert bewijs van welke
referenties een asset hebben geproduceerd. Gezien P405.2 ("regenerate from
asset") is dit niet aanbevolen.

### 7.3 Niet aanbevolen

- Validatie downgraden naar warning: lost de deadlock op, maar geeft de
  integriteitsgarantie op en maakt dangling traces structureel.
- Alleen `deleteAsset` de trace laten opschonen: te laat in de volgorde; de
  gebruiker kan het asset niet meer losmaken zodra het project ongeldig is.

### 7.4 Acceptatiecriteria

1. Een referentie die alleen in een asset-trace voorkomt, geeft 409 met
   `usageAssetIds` en wordt niet verwijderd.
2. Na unbind + deleteAsset + deleteReference is het project geldig (F5).
3. De seed-flow (F3) kan niet meer in de ongeldige toestand komen via
   referentieverwijdering.
4. Geen wijziging aan `validateProject`-severity, fingerprints of
   approval-hashes.
5. `npx vitest run tests/p406-reference-integrity.test.ts
   tests/p407-reference-lifecycle.test.ts tests/p2-domain.test.ts
   tests/references-panel.test.tsx` is groen; `npx tsc --noEmit` schoon.

### 7.5 Plaats in de reeks

P406 wijzigt `lib/projects/usage.ts` al (uncommitted). P407 moet daar bovenop,
na P406-commit, of in dezelfde commit-reeks; anders ontstaat een conflict in
dezelfde functie.

---

## 8. Verificatie van deze recon

- `npx vitest run tests/p406-reference-integrity.test.ts
  tests/references-panel.test.tsx`: 2 files, 20 tests, passed.
- Read-only probes met `npx tsx` (lokaal, geen netwerk, geen writes buiten
  `/tmp/opencode/`):
  - `probe-p407.ts` - trace-only referentie: verwijderen toegestaan, project
    daarna ongeldig, trace blijft in JSON (F1);
  - `probe-p407b.ts` - deadlock met asset-visual, unbind-save geweigerd,
    asset-delete geblokkeerd (F2);
  - `probe-p407c.ts` - deadlock via de normale deselecteer/verwijder-flow (F2);
  - `probe-p407d.ts` - attempts niet gevalideerd, niet geteld (F6);
  - `probe-p407e.ts` / `probe-p407f.ts` / `probe-p407j.ts` - reparatiepaden
    (F4);
  - `probe-p407g.ts` - eerste opzet; deze bleek op een nieuw leeg project te
    draaien en niet op de seed, dus niet gebruikt als bewijs;
  - `probe-p407h.ts` - echte seed-projectflow, inclusief deadlock (F3);
  - `probe-p407i.ts` - veilige volgorde werkt (F5);
  - `probe-p407k.ts` - scan van `projects/*/project.json`: 2 projecten, 0
    traces, 0 ongeldig (F8);
  - `probe-p407l.ts` - regenereer-accumulatie pint referenties (F7).
- Geen betaalde provider-calls, geen externe jobs, geen `projects/`-mutaties,
  geen commit.

Stop na de recon.
