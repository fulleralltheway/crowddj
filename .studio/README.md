# .studio/

Engineering artifacts for spec-driven feature work in this project. Managed by `Hub/development/skills/ship-feature.md`.

## Layout

```
.studio/
├── state.md              # Current state — read this first
├── README.md             # This file
├── specs/
│   └── <feature-slug>/
│       ├── spec.md       # The contract: outcomes, scope, constraints, verification
│       └── tasks.md      # Implementation breakdown (status: todo / doing / done)
├── adr/
│   └── NNNN-<slug>.md    # Architecture Decision Records (numbered, immutable once accepted)
└── reviews/
    └── <feature-slug>.md # Reviewer's report from Phase 5
```

## Conventions

- **Spec status:** `draft` → `signed-off` → `in-progress` → `shipped`
- **ADR status:** `proposed` → `accepted` → `superseded`
- **ADR numbering:** start at `0001`, increment per project, never reuse
- **Slugs:** lowercase, hyphens (`members-onboarding`, not `MembersOnboarding`)
- **Files commit with the code.** Don't `.gitignore` `.studio/`.

## How to Use

- **Starting a new feature:** Invoke `Hub/development/skills/ship-feature.md`. It runs the full 7-phase gated flow.
- **Picking up where someone left off:** Read `state.md`, then the active spec at `specs/<slug>/spec.md`.
- **Reviewing this work as a sub-agent:** The spec is the source of truth for "what was supposed to happen." Compare the diff against it.
- **Looking up "why did we do X this way?":** Check `adr/`. ADRs are dated and immutable — they're the project's decision history.

## Why This Exists

Specs and ADRs travel with the code through git history. Six months from now, anyone (including future-you or a new contributor) can answer:

- "What was this feature supposed to do?" → `specs/<slug>/spec.md`
- "Why was X decided?" → `adr/NNNN-<slug>.md`
- "Where is the project right now?" → `state.md`

…by reading these files. Not by digging through chat history that no longer exists.
