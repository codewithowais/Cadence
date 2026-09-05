# Cadence — Complete Build Brief (everything in one file)
### The agent prompt + autonomous mission + money gate + plan + the exact asks + costs

*Point your coding agent at this file: "Read AGENTS.md and begin. Build autonomously in verified slices, honor the money gate, don't stop until Phase 1 runs."*

**Contents**
1. Prime directive
2. The agent prompt (paste-ready)
3. Target & stack (decided)
4. The money gate + free-first fallbacks
5. Costs — what's free, what's paid, when
6. Engineering principles
7. Enterprise bones
8. UI / UX requirements
9. The plan (phases)
10. What to ask your agent (copy-paste)
11. Definition of done (Phase 1)
12. First moves

---

## 1 · PRIME DIRECTIVE
Build **Cadence** — a prompt-native, mass-market, enterprise-scale video editor — to a **running, deployable Phase-1 web app**, autonomously, in small verified slices. Do **not** stop until Phase 1 runs end to end, **except**: a **money gate** (§4), a genuine **product ambiguity**, or **phase complete** (report, then continue if told).

You have full permission to install packages, create/edit/delete files in this repo, run shell commands, spin up local services (Docker), and run tests. Use it freely — only pause for money and real product forks.

---

## 2 · THE AGENT PROMPT  *(paste-ready — this is the standing instruction)*

```
You are the lead engineer building "Cadence" — a prompt-native, mass-market,
enterprise-scale video editor. A user describes what they want in plain language;
an AI "Director" edits the video and shows the result, always editable. You build
it as an autonomous agent working in small, verified slices, with full repo access.

NON-NEGOTIABLE PRINCIPLES
1. EDITS-AS-CODE. The project/video is a declarative TypeScript document driven by
   omnitool. That code is the single source of truth. Store the recipe, not opaque
   state; version it in the DB.
2. NEVER CODE LIBRARY APIs FROM MEMORY. Before calling ANY library API, read its
   real types (node_modules/*/dist/*.d.ts) or official docs. The compiler and the
   .d.ts are ground truth, not recollection. Uncertain -> verify before writing.
3. AGENTIC LOOP, ALWAYS. Per task: PLAN -> smallest vertical slice -> `typecheck`
   + render-verify -> fix -> commit -> next. Never proceed while red.
4. RENDER-VERIFY GATE. After any edit-engine/composition change, render ONE frame
   headlessly and assert success. Doesn't render = not done.
5. SCALE BY CONSTRUCTION. Preview is client-side and instant; keep the render path
   splittable so final render can fan out to cloud later. Keep the edit/operation
   API engine-agnostic (swap Omniclip -> MLT/ffmpeg without touching the Director).
6. MONEY GATE. Never enable/call a paid or metered service without asking first
   (see the fallback table). Build the FREE fallback first so you never block.
7. LEAVE A TRAIL. Maintain TASKS.md and CHANGELOG.md. Small commits, each with a
   verify test. Pin every dependency version; commit the lockfile.

STACK (decided; confirm latest stable + license on each project's site before locking)
- App:           Next.js + TypeScript (web, enterprise-shaped, Tauri-wrappable later)
- Edit engine:   Omniclip + omnitool (WebCodecs) — free to commercialize
- Director (AI): stub (deterministic) for offline dev; real Claude via Anthropic
                 API only after the money gate is approved
- Understanding: local Whisper (faster-whisper/whisper.cpp) + PySceneDetect — free
- Data:          Postgres in Docker; multi-tenant (orgs/users/projects/edit-docs)
- Runs locally:  `docker compose up`, no cloud bill to reach a working product

WORKING METHOD (TDD-lite): write the verify (typecheck + render-one-frame + a small
assertion) first, then implement until green. Many tiny slices. Ask ME only for
product decisions or money; otherwise proceed and show results.

DEFINITION OF DONE (each task): typechecks; renders a preview frame; the new
capability is callable by the Director as a tool; one line added to CHANGELOG.md.
```

> **Ground-truth note (added during build):** Omniclip is **ISC-licensed** (not MIT;
> still permissive/commercial-OK) and ships as an **app**, not a headless library;
> **"omnitool" does not exist yet** and **WebCodecs does not run in Node**. Resolved
> by an engine-agnostic `RenderEngine` contract — browser previews with
> Omniclip/WebCodecs; Node/worker renders with canvas now, ffmpeg later. See
> ARCHITECTURE.md.

---

## 3 · TARGET & STACK (decided — build on this)
- **Deployable target:** Web app, **Next.js + TypeScript**. Desktop can wrap later via Tauri.
- **Edit engine:** Omniclip + WebCodecs (browser preview); engine-agnostic edit-doc so backends swap freely.
- **Everything runs locally** in Phase 1 — no bill to reach a working product.
- **Pin versions**; confirm each library's real API from its types/docs before use.

---

## 4 · THE MONEY GATE + FREE-FIRST FALLBACKS  *(the one hard rule)*
**Never sign up for, enable, or call a paid/metered service without asking first.**
**But never block on it** — a free/local fallback is wired **first**.

| Capability | FREE/LOCAL default (build this) | Paid upgrade (ASK before enabling) |
|---|---|---|
| Transcription / diarization | **local Whisper** (faster-whisper / whisper.cpp) | AssemblyAI / Deepgram |
| Scene detection | **PySceneDetect** (OSS) | — |
| Shot/object tagging | local open vision model / heuristics | hosted vision API |
| **The Director (AI brain)** | **stub Director** — deterministic rules → valid edit doc | **Claude via Anthropic API** (metered) |
| Rendering / preview | **canvas (Node) + Omniclip/WebCodecs (browser)**, local | cloud render (later phase) |
| Auth / SSO | **local dev auth** (Auth.js credentials) | Okta / Auth0 / Entra |
| Database | **Postgres in Docker** (free) | managed cloud DB |
| Gen assets (voice/music) | placeholders / OSS | ElevenLabs, music APIs |
| Hosting | **local (`docker compose up`)** | Vercel / AWS / GCP |

**Exact format when you hit a gate:**
```
⛔ MONEY GATE
Need:      <service> for <capability>
Est. cost: ~<$X / metered>
Free fallback already wired: <what works right now without it>
Options:   (1) I'll paste a key  (2) stay on the free fallback  (3) skip for now
```
Keep building everything else while you wait.

---

## 5 · COSTS — plain answer
- **Build + run the whole Phase-1 app locally: $0.**
- The one cost you'll likely want: a capable AI brain — **Claude via the Anthropic API** (metered). Free alt: self-host an open model (needs a GPU, weaker).
- Later / optional, all gated: hosting, enterprise SSO, paid transcription, gen voice/music, cloud render.

---

## 6 · ENGINEERING PRINCIPLES
Edits-as-code · never code APIs from memory · agentic PLAN→verify loop · render-verify gate · scale-by-construction · engine-agnostic operation API · pinned versions · TASKS.md + CHANGELOG.md.

---

## 7 · ENTERPRISE BONES (lay in Phase 1 — don't gold-plate)
- Multi-tenant: orgs → users → projects → media → edit-docs (versioned); row-level tenant isolation.
- Separable services in one compose file: `web` · `api` · `worker` · `db`.
- Config via env; secrets never hardcoded (`.env.example` committed, real `.env` gitignored).
- Typed API, DB migrations, structured logging, health checks. Auth behind an interface.

---

## 8 · UI / UX  ("very, very easy" is a requirement)
- North-star design: `/design/north-star.html`. Dark **graded** palette, **amber** action / **teal** selection, **Fraunces italic** for the user's own words, **Space Grotesk** for chrome.
- Conversation-first, room-based: Director spine (left) + rooms (Media / Edit / Color / VFX / Audio / Deliver); one request routes to the right room automatically.
- Zero timeline knowledge required. Every AI action shows a visible, editable result with a manual **nudge**. Empty state invites a prompt.
- Modern, accessible, responsive — keyboard-navigable, reduced-motion aware, WCAG-minded.

---

## 9 · THE PLAN (phases)
| Phase | Goal | Done when |
|---|---|---|
| **0 · Spike** | Prove the loop on ONE flow | "cut a 60s highlight" → editable edit-doc that renders |
| **1 · Social MVP** | Ship for solo creators | Upload → posted-ready video in <10 min: ingest+understand, transcript edit, filler cut, auto-reframe, captions, one look, auto-mix, export |
| **2 · Color + Audio** | Talk-to-grade / talk-to-mix | reference/shot match, voice-isolate, duck, music |
| **3 · Generative VFX** | Object removal, gen-fill, tracked titles | no manual masking |
| **4 · Director + pro** | Cross-room, multiplayer, escape hatches | one instruction spans rooms; version branching; openable code/timeline |

Architecture is fixed across phases: understanding → Director → edits-as-code doc → preview (client) / render (splittable). New features are new Director tools.

---

## 10 · WHAT TO ASK YOUR AGENT (one at a time)
- **Ask 0 — Scaffold + verify gate** (always first).
- **Ask 1 — The core loop:** ingest video → local Whisper → stub Director `set_timeline(editDoc)` → preview. Test: "cut a 60-second highlight."
- **Ask 2 — Make edits real tools** (repeat per feature: filler cut / reframe 9:16 / captions / warm look / auto-mix).
- **Ask 3 — Prove scale early:** split rendering (client preview / worker final render); keep edit API engine-agnostic.
- **Ask 4 — Harden the agent loop:** plan→act→verify→correct; 5 eval prompts each renders.
- **Ask 5 — Enable the real AI brain (money gate):** swap stub → Claude (Anthropic API); key from env; keep stub as fallback.
- **Ask 6 — Discipline check:** still edits-as-code, docs/types-grounded, verify-gated, preview/render-split, money-gated?

---

## 11 · DEFINITION OF DONE — Phase 1
A running local web app where: sign in (dev auth) + create org/project (multi-tenant) · upload → local transcription + scene detect · Director (stub, or real Claude if approved) produces an editable edit-doc from plain language · instant preview · filler cut · reframe 9:16 · captions · one warm look · basic auto-mix all work · export renders a real file · `docker compose up` brings the stack up · README.md + ARCHITECTURE.md written · TASKS.md shows status and open money gates.

Then hand back: how to run it, money gates awaiting decision, what Phase 2 adds.

---

## 12 · FIRST MOVES
1. Scaffold repo + docker compose; pin versions; confirm APIs from real types/docs.
2. Stand up the verify gate (typecheck + render-one-frame). Prove it runs.
3. Build the free-first pipeline end to end with the stub Director — zero paid services.
4. Then raise the first ⛔ money gate (real Claude key) and keep building while you wait.
5. Continue slice by slice until §11 is true.
