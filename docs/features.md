# Feature Notes — newms-plugins (claude-plugins repo)

Persistent ideator memory for the `claude-plugins` Claude Code plugin marketplace.
Scope: `repo` (this repo only). Board: `claude-plugins:claude-plugins-main` (prefix `CP`).

## What this repo is

A GitHub-distributed Claude Code **plugin marketplace** (`newms-plugins`). Six plugins,
each a directory with `.claude-plugin/plugin.json` + `skills/<name>/SKILL.md` (+ optional
`hooks/hooks.json` and `scripts/*.sh`). Consumers install via marketplace; the marketplace
loader auto-updates a plugin ONLY when its `plugin.json` `version` changes — source edits
without a bump never reach consumers. `scripts/publish.sh` automates the bump+commit+push.

Plugins: `base` (universal discipline), `dev` (code-writing discipline),
`human-collaboration` (human-in-loop), `danxbot` (orchestrator domain, the largest).
`investigate` and `pipeline` were retired (DX-3331, DX-3328/DX-3340) — their
surviving content folded into `dev:debugging` and the danxbot/base skills respectively.

---

## Section 1: Feature Inventory

| Feature | Status | Notes |
|---|---|---|
| 6 plugins (base/investigate/dev/pipeline/human-collaboration/danxbot) | Complete | All skills under 300-LOC cap post DX-795 refactor (max 281). |
| `scripts/publish.sh` version-bump automation | Complete | Auto-detects changed plugin trees, bumps semver, commits per-plugin, worktree-aware push (defers to agent-finalize.sh inside agent worktrees). |
| Per-plugin hook mandate system | Complete | SessionStart/UserPromptSubmit/PreToolUse hooks; every referenced `scripts/*.sh` currently resolves. |
| Skill LOC refactor (epic DX-795/796) | Complete | Delivered; matrix + phase-7 report are now stale artifacts (see below). |
| README.md accuracy | **Incomplete** | Lists REMOVED plugins `issues` + `issue-worker` (folded into `danxbot`), OMITS `human-collaboration`. Plugin table + install matrix both wrong. Misleads install. README L12 `pipeline` row also carries stale `flow-*`/"Human-in-loop" wording (fold into this fix). ICE 405 (I5×C9×E9). Carded → CP-5. |
| `dev:git-discipline` mandates dead `/flow-commit` command | **Incomplete** | git-discipline/SKILL.md L48/L50/L159 tell every code-writer to invoke `/flow-commit` — no such command exists; pipeline was renamed `flow-*`→`pipe-*` (real cmd `/pipe-commit`, correct in 12 other refs). Core "never manual git add/commit" rule points at a dead command → agents fall back to the exact manual git it forbids. flow→pipe rename debt = README row (CP-5) + this skill only (grepped; no other dangling flow-* refs). ICE 486 (I6×C9×E9). Carded → CP-44. |
| `deny-destructive-db` docker-volume vector | **Incomplete** | Guard header L18-19 + REASON L44 explicitly promise "recreating the docker volume … will be blocked" but PATTERN L36 has ZERO docker coverage — `docker compose down -v`/`--volumes`, `docker volume rm`/`prune` sail through and destroy the DB volume (same loss as the migrate:fresh incident, which itself ran in docker). Distinct vector from CP-19 (schema APIs) + CP-42 (raw SQL DROP/TRUNCATE); same PATTERN line → implement together. Exclude bare `docker compose down` (legit stop). ICE 448 (I8×C7×E8). Carded → CP-45. |
| Repo integrity validation (manifests / frontmatter / hook-refs / marketplace sources) | **Incomplete** | Nothing validates plugin.json shape+semver, SKILL.md required frontmatter, hook `scripts/*.sh` existence, marketplace `source` dirs, or LOC caps. No CI (`.github/workflows` absent). Broken plugin can ship to all consumers. ICE 336 (I7×C8×E6). Carded → CP-7 Epic / CP-8. |
| Version-bump enforcement | **Incomplete** | README declares the bump MANDATORY but nothing enforces it — a plugin tree can change with a static version and silently never reach consumers (the #1 documented failure mode). No pre-commit hook / CI gate. ICE 240 (I8×C6×E5). Carded → CP-9 (child of CP-7 Epic). |
| Stale root artifacts (`REFACTOR_MATRIX.md` 205L, `REFACTOR_PHASE7_REPORT.md`) | **Removeable** | Completed-epic deliverables, last touched 2026-06-07, cluttering repo root. ICE 243 (I3×C9×E9). Carded → CP-6. |
| `danx-ideate` SKILL card-creation guidance | **Changeable** | SKILL step-2 frames creation as flat `type:'Feature'\|'Bug'` cards with only `ac[]` — contradicts the plugin's own container doctrine (`danx-flesh-out/overview.md`, `issue-card-workflow/phases-epics.md`) and omits that `phase_children[]` is Epic-only (server 400s it on a Feature). Followed literally → bare-Feature defect or 400. ICE 384 (I6×C8×E8). Carded → CP-11. |
| Skill catalog / index | **Incomplete** | 30+ skills across 6 plugins, no single index; no authoring-invariants guide (LOC cap, mandatory bump, frontmatter, hook `${CLAUDE_PLUGIN_ROOT}` pattern, no rules/ dir). ICE 210 (I5×C7×E6). Carded → CP-12 Epic (CP-13 generator / CP-14 commit+link / CP-15 authoring guide). |
| `scripts/publish.sh` UX/safety | **Upgradeable** | No `--dry-run` preview (first happy-path action is a commit); no guard against no-op version-only bumps. ICE 196 (I4×C7×E7). Carded → CP-16 Epic (CP-17 dry-run / CP-18 no-op guard). |
| Plugin description drift (README table / marketplace.json / plugin.json) | **Upgradeable** | Three description sources diverge (danxbot marketplace desc detailed vs plugin.json short; README `pipeline` row says stale `flow-*`/"human-in-loop"). README fixes belong to CP-5; marketplace↔plugin.json single-source not yet carded (low value, adjacency to CP-8). ICE 144 (I4×C6×E6). Scratchpad only. |
| `deny-destructive-db.sh` pattern coverage (schema-builder APIs) | **Incomplete** | Header comment (L34-35) + deny REASON claim `dropAllTables/dropAllViews/dropAllTypes` schema-builder APIs are blocked, but the actual regex (L36) blocks only `migrate:fresh/refresh/reset`, `db:wipe`, `DROP DATABASE/SCHEMA`. `Schema::dropAllTables()` passes through — silent bypass of the repo's top data-loss guard. Doc/code drift. ICE 448 (I8×C8×E7). Carded → CP-19. |
| `deny-destructive-db.sh` pattern coverage (raw SQL table drops) | **Incomplete** | SEPARATE vector from CP-19: PATTERN also misses raw `DROP TABLE` / `TRUNCATE` / `psql -c 'DROP TABLE …'` / tinker `DB::statement("DROP TABLE …")`. Rule says "agents NEVER … drop … databases" and the deny REASON literally claims raw psql DROP / TRUNCATE loops "will be blocked" — but they sail through. Exclude bare `DELETE FROM` (legit scoped deletes). Same PATTERN line as CP-19 → implement together. ICE 392 (I8×C7×E7). Carded → CP-42. |
| `inject-time.sh` PostToolUse over-injection | **Upgradeable** | base/hooks.json wires inject-time on PostToolUse → a `<time> +Ns` context line after EVERY tool call. Long danx-next dispatches emit hundreds of `+0/+1s` stamps (token noise); the valuable long-op signal (`+5m` build) is rare. Fix: on PostToolUse, suppress injection unless delta ≥ threshold (~30s); UserPromptSubmit stays unconditional (per-turn stamp). Delta already computed. Sibling to CP-25 in same script. ICE 160 (I4×C5×E8). Carded → CP-43. |
| Retired `danx_issue_create` refs BEYOND CP-34 | **Incomplete** | CP-34 (CP-35 db-reset only) missed FOUR more files still naming the retired create tool `danx_issue_create` (correct = `mcp__danx_dashboard__issue_create`): `issue-card-workflow/references/lifecycle-states.md` L25 (canonical lifecycle ref!), `danx-flesh-out/references/overview.md` L5, `no-false-blockers/SKILL.md` L36, `issue-blocker/SKILL.md` L235. Hard tool-not-found on the create branch. `slack-agent` L58 `mcp__danxbot__link_thread_to_issue` is a LEGIT runtime tool, not a defect. ICE 405 (I5×C9×E9). Carded → CP-41. |
| `plugin-skill-mandate.sh` hook wiring | **RESOLVED by deletion (DX-3347, 2026-09-26)** | Script header said "Fires on SessionStart and UserPromptSubmit" and had UserPromptSubmit stdin-drain code, but base/hooks.json wired it SessionStart-ONLY — dead code, not a wiring fix. DX-3347 deleted the file outright, folding its skill-load pointer into `danxbot/mantra.md`'s one-line skill routing (PLN-11 R-16: fold into the mantra, or delete if the skill's own description already carries the trigger). CP-20 should be triaged → Cancel, not implemented as originally scoped (there is no longer a script to re-wire). Original claim preserved for history: ICE 280 (I5×C7×E8). |
| Hook-script behavioral tests | **Incomplete** | Zero tests for the runtime logic of deny-destructive-db / investigation-gate / human-loop-mandate / inject-time. CP-7 validates structure, not behavior. No `.bats` suite exists. Silent-regression risk on safety-critical hooks. ICE 245 (I7×C7×E5). Carded → CP-21 Epic (CP-22 harness+deny / CP-23 gates / CP-24 inject-time). |
| `inject-time.sh` /tmp state cleanup | **Upgradeable** | Writes `/tmp/claude-time-hook-${SID}` per session, never pruned → unbounded accumulation on long-lived hosts/workers. Fix: age-based prune on each fire. ICE 168 (I3×C8×E7). Carded → CP-25. |
| Base mandate-script event-wiring drift (`convey-mandate.sh` + `tool-discipline-mandate.sh`) | **Incomplete** | Both headers claim "Fires on SessionStart AND UserPromptSubmit" (tool-discipline L4-5 even states the intent: reinforce "every session AND every turn so they survive context compression") and both carry a `[ "$EVENT" = "UserPromptSubmit" ] && cat >/dev/null` stdin-drain branch — but `base/hooks.json` wires BOTH SessionStart-ONLY (only `inject-time` fires on UserPromptSubmit). So the designed per-turn reinforcement never happens (decays after compression — the exact failure the header cites) and the drain branch is dead code. Same defect CLASS as CP-20 (plugin-skill-mandate) but DIFFERENT files → not a dup. ICE 280 (I5×C7×E8). Carded → CP-26. |
| Post-DB-migration stale references (db-reset tool ref / marketplace.json desc / safe-terminate pkgs) | **Incomplete** | Three assets still name the RETIRED `danx-issue` MCP + YAML card model (the deleted docker-detail skill (DX-3435) L56 "the legacy danx-issue server is gone"; pipe-commit "there is NO YAML file"): `danxbot/skills/db-reset/SKILL.md` L135 calls non-existent `mcp__danxbot__danx_issue_create` (should be `mcp__danx_dashboard__issue_create`); `.claude-plugin/marketplace.json` danxbot desc says "issue-card workflow (YAML schema … danx-issue MCP)"; `human-collaboration/skills/safe-terminate/SKILL.md` item 5 lists retired `danx-issue-mcp/` pkg (actual packages/ tree = `danx-dashboard-mcp`). ICE 360 (I5×C8×E9). Carded → CP-34 Epic (CP-35 db-reset / CP-36 marketplace / CP-37 safe-terminate). |
| Root `.gitignore` absent | **Incomplete** | Repo has NO top-level `.gitignore` (only `.danxbot/.gitignore` scoping that subtree); untracked root-owned `claude-projects/` sits uncovered and `git status` is noisy. ICE 270 (I3×C9×E10). Carded → CP-33. |
| Per-plugin CHANGELOG / release notes | **Incomplete** | Distribution is version-driven; autoUpdate swaps the cache on any `plugin.json` bump with ZERO record of what changed. No CHANGELOG at any level; `publish.sh` emits no release notes → consumers get new behavior blind. ICE 150 (I5×C6×E5). Carded → CP-38 Epic (CP-39 gen-changelog.sh / CP-40 publish.sh wiring + README link). |
| MCP tool namespace `mcp__danx_dashboard__` (underscore) | **REVERSED 2026-08-15 — this row was WRONG, CP-29 was RIGHT** | Original claim below (kept for history) asserted underscore is correct and Claude Code sanitizes hyphens to underscores. That is false. Proven three independent ways in a later session: (1) real production JSONL transcripts of dispatched-worker sessions — `mcp__danx-dashboard__*` (hyphen) calls succeeded with real 200 responses, `mcp__danx_dashboard__*` (underscore) calls failed with `"No such tool available"`; (2) the installed Claude Code CLI binary's own tool-name sanitizer, `e.replace(/[^a-zA-Z0-9_-]/g,"_")` — hyphen is in the allowed/negated character class, never replaced, plus a live example in the same binary, `mcp__claude-in-chrome__tabs_context_mcp`, preserving a real product's hyphenated server name verbatim; (3) **official Claude Code docs**, [Connect to external tools with MCP](https://code.claude.com/docs/en/agent-sdk/mcp) — every code example with a hyphenated server name preserves the hyphen in the tool prefix: `allowedTools: ["mcp__claude-code-docs__*"]`, `mcp__remote-api__*`, `mcp__api-server__*`, `mcp__secure-api__*`, `mcp__oauth-api__*`. Root cause of the ORIGINAL wrong row: `the deleted docker-detail skill (DX-3435)` L56 itself had the same underscore typo (now fixed), and the operator's own personal `~/.claude.json` local-scope MCP entry for this repo is independently registered as `danx_dashboard` (underscore) — a SEPARATE config surface from the DB catalog's `artifactId: "danx-dashboard"` (hyphen) that dispatched workers actually materialize from — so underscore genuinely worked in an interactive operator session while being wrong for every dispatched worker, which is what made the original investigation's "verified this session" claim feel true without being true for the surface that mattered. Fixed repo-wide (40 files in danxbot's own repo + 20 files across 3 plugins here) in the same session, deployed to production, confirmed live. CP-29 should NOT be cancelled. Original claim, preserved for history: `danxbot/skills/the deleted docker-detail skill (DX-3435)` L56 authoritatively states the live agent-facing server `@thehammer/danx-dashboard-mcp` has "tools prefixed `mcp__danx_dashboard__`" (underscore), used uniformly across 16+ production skills that demonstrably work. **CP-29's premise (live namespace is the hyphen form `mcp__danx-dashboard__`) is FALSE** — Claude Code sanitizes hyphens in an MCP server name to underscores in the tool prefix. CP-29 should be triaged → Cancel (verified this session via the plugins' own docs + the danx-dashboard-mcp entrypoint). |
| `the deleted dispatch-detail skill (DX-3435)` LOC cap | **Incomplete** | Grew 281→310 lines (DX-1763/DX-1801 "worker-launch footguns" section added 2026-07-08) — breaches the repo's own documented 300-LOC cap (REFACTOR_MATRIX.md L16). Fresh regression this session; CP-8's future validator would have caught it but hasn't landed. ICE 432 (I6×C9×E8). Carded → CP-52. |
| `agent-finalize.sh` exit 66 undocumented in danx-next recovery table | **Incomplete** | Script gained a new terminal exit code 66 (DX-1665 arm b, generation-superseded split-brain fence) fully documented in its own header, but `danx-next/references/step-procedures.md` Step 7a's "Read exit code" list still only enumerates 0/1/2/64/65 — verified via grep, 66 absent. An agent hitting this live code path has no documented recovery step. ICE 504 (I7×C8×E9). Carded → CP-53. |
| `danxbot` skill "Local vs Deployed" table completeness | **Incomplete** | Self-described "single source of truth" quick-reference table lists only `make launch-worker` + `make deploy`/`make publish-mcp` — omits `make launch-worker-host` and the two new DX-1802 remote variants (`launch-worker-remote`/`launch-worker-host-remote`), both already documented consistently in `the deleted dispatch-detail skill (DX-3435)` + `no-unauthorized-worker-launch`. Redundancy/completeness gap, not a blocking one (info exists elsewhere). ICE 252 (I4×C7×E9). Carded → CP-54. |

---

## Section 2: Desired Features (scratchpad)

- **[Carded CP-5] Fix stale README** — Maintenance — 405 (5×9×9) — correct plugin table + install matrix to the real 6 plugins.
- **[Carded CP-7 Epic] Repo integrity gate** — Maintenance — 336 (7×8×6) — Epic (not Feature: server allows `phase_children` ONLY on type=Epic) with children CP-8 (validate script), CP-9 (version-bump check), CP-10 (GitHub Actions CI).
- **[Carded CP-6] Remove stale REFACTOR artifacts** — Maintenance — 243 (3×9×9) — delete/move completed-epic docs from root.
- **[Carded CP-9] Version-bump enforcement guard** — Maintenance — 240 (8×6×5) — child of CP-7.
- **[Carded CP-11] Fix danx-ideate SKILL container doctrine** — Maintenance — 384 (6×8×8) — align step-2 create guidance with container/phase_children-Epic-only rules.
- **[Carded CP-12 Epic] Skill catalog + authoring guide** — Maintenance — 210 (5×7×6) — gen-skill-index.sh (CP-13), commit+README link (CP-14), docs/authoring-plugins.md (CP-15).
- **[Carded CP-16 Epic] publish.sh dry-run + no-op guard** — Maintenance — 196 (4×7×7) — CP-17 --dry-run, CP-18 skip version-only bumps.
- **[Carded CP-19] deny-destructive-db regex gap** — Maintenance — 448 (8×8×7) — add dropAllTables/Views/Types to the PATTERN so code matches its own doc.
- **[Carded CP-20] plugin-skill-mandate SessionStart-only wiring** — Maintenance — 280 (5×7×8) — align header/code/wiring (prefer wiring on UserPromptSubmit).
- **[Carded CP-21 Epic] bats hook test suite** — Maintenance — 245 (7×7×5) — CP-22 harness+deny-db, CP-23 prompt gates, CP-24 inject-time format/state.
- **[Carded CP-25] inject-time /tmp leak** — Maintenance — 168 (3×8×7) — age-based prune of claude-time-hook-* files.
- **[Uncarded] Plugin description single-source-of-truth** — Maintenance — 144 (4×6×6) — reconcile marketplace.json ↔ plugin.json descriptions + drift check; low value, adjacency to CP-8. README `pipeline` row (`flow-*`, "human-in-loop") is stale → flag for CP-5's implementer, not a new card.
- **[Carded CP-26] Base mandate-script per-turn wiring drift** — Maintenance — 280 (5×7×8) — reconcile `convey-mandate.sh` + `tool-discipline-mandate.sh` header/dead-drain-branch vs SessionStart-only `hooks.json` wiring; resolve consistently with CP-20 (same decision: fire per-turn vs align headers down).
- **[Carded CP-27] investigation-gate ↔ human-loop-mandate double-fire** — Maintenance — 144 (4×6×6) — re-confirmed mechanically (run 4): `investigate/scripts/investigation-gate.sh` fires on "why"/"how does"/etc. → gate says load investigate + gather evidence with Bash/Read/Grep; `human-collaboration/scripts/human-loop-mandate.sh` fires on ANY `?` → gate says "STOP all work — no tool calls except Read." A "why…?" prompt injects BOTH, giving opposite tool-permission instructions in the same turn. Both are read-only, so the clash is narrow (read-only Bash/Grep) but real for co-installed human sessions. Carded to force the precedence decision (likely human-loop answer-first wins).
- **[Uncarded] jq/deps preflight for hooks** — Maintenance — ~125 (5×5×5) — hooks assume `jq` present; if missing under `set -euo pipefail` the deny guard may fail-open. Verify Claude Code fail-open/closed behavior first (base:docs-first). Exploratory until confirmed.
- **[Uncarded] Hook invocation-form inconsistency** — Maintenance — ~168 (3×7×8) — `investigate` + `human-collaboration` hooks.json call their scripts by bare path (`${CLAUDE_PLUGIN_ROOT}/scripts/x.sh`, relying on the +x bit) while base/dev/danxbot use `bash ${CLAUDE_PLUGIN_ROOT}/scripts/x.sh`. Exec bits ARE currently set (100755 in git) so no live bug — purely defensive normalization against a future lost +x bit on the two discipline gates. Below bar given queue depth; fold into CP-8 validate (assert one invocation form) rather than a standalone card.
- **[Exploratory] Split `danxbot` plugin (25 skills)** — Maintenance — not scored/carded — largest plugin; possible sub-plugin split, but big blast radius + unclear payoff. Revisit only when no clearer work remains.
- **[Carded CP-34 Epic] Purge post-DB-migration stale refs** — Maintenance — 360 (5×8×9) — CP-35 db-reset tool ref, CP-36 marketplace.json desc, CP-37 safe-terminate pkg names.
- **[Carded CP-33] Add root `.gitignore`** — Maintenance — 270 (3×9×10).
- **[Carded CP-38 Epic] Per-plugin CHANGELOG** — Maintenance — 150 (5×6×5) — CP-39 gen-changelog.sh, CP-40 publish.sh wiring + README link.
- **[Carded CP-41] Retired `danx_issue_create` in 4 more files** — Maintenance — 405 (5×9×9) — extends CP-34 beyond CP-35's db-reset (lifecycle-states.md, danx-flesh-out overview, no-false-blockers, issue-blocker).
- **[Carded CP-42] deny-db raw SQL table drops** — Maintenance — 392 (8×7×7) — add DROP TABLE / TRUNCATE to PATTERN; implement with CP-19 (same regex line); exclude bare DELETE.
- **[Carded CP-43] inject-time PostToolUse throttle** — Maintenance — 160 (4×5×8) — suppress PostToolUse injection under ~30s delta; keep UserPromptSubmit unconditional.
- **[Uncarded] `argument-hint` frontmatter on 5 SKILL.md** — Maintenance — ~low conf — `argument-hint:` (a slash-command frontmatter key) sits on danx-chat/danx-flesh-out/danx-triage-card/danx-triage-orchestrator/template-app-build SKILL.md; likely ignored by the skill loader. Also non-standard `audience:` on ~6 skills. Uncertain whether these skills double as commands → low confidence; fold into CP-8 validation (assert allowed frontmatter keys) rather than a card.
- **[Uncarded, Dependent] config.yml empty test/lint** — Maintenance — dependent on CP-8/CP-22 — `.danxbot/config/config.yml` declares `commands.test/lint/type_check: ""`, so danx-next Step 5 quality gate runs nothing even once CP-8's validate.sh / CP-22's bats exist. Complements CP-10 (GitHub CI) with the agent-side gate. Card only after CP-8 lands (don't promote a Dependent early).
- **[Verified NOT a defect this run]** — pipeline plugin having ZERO hooks is INTENTIONAL (danx-next step-procedures.md L84 explicitly `/pipe-start`); missing root `.claude/rules/danx-repo-config.md` is MATERIALIZED at dispatch (the deleted docker-detail skill (DX-3435)), not committed (CP-31 handles ideator's missing-file fallback); all SKILL.md have name+description; no broken/orphan `references/` links; no real TODO/FIXME; LOC caps hold (max 281 the deleted dispatch-detail skill (DX-3435)); `current-time-mandate.sh` header matches its SessionStart-only wiring (unlike CP-20/CP-26).
- **[TRIAGE — CANCEL CP-29] REVERSED 2026-08-15 — DO NOT CANCEL CP-29.** The claim below was wrong; see the corrected CP-49 row above for the full proof (real production JSONL, the CLI's own tool-name sanitizer regex, and official docs at https://code.claude.com/docs/en/agent-sdk/mcp — hyphens in MCP server names are preserved, never sanitized to underscores). CP-29's original premise (hyphen is the real live namespace) was CORRECT. Original (wrong) note, preserved for history: the "hyphen namespace" bug is a false positive; underscore prefix is correct per the deleted docker-detail skill (DX-3435) L56. Not re-carded (would duplicate/contradict). Flag to operator for Cancel.
- **[Carded CP-44] git-discipline dead `/flow-commit`** — Maintenance — 486 (6×9×9) — rename 3 refs → `/pipe-commit` in dev/skills/git-discipline/SKILL.md + version bump. flow→pipe rename debt fully accounted: README row (CP-5) + this skill; no other dangling flow-* refs (grepped).
- **[Carded CP-45] deny-db docker-volume gap** — Maintenance — 448 (8×7×8) — add `docker compose down -v`/`--volumes`, `docker volume rm`/`prune` to PATTERN; same regex line as CP-19/CP-42; exclude bare `down`. Guard's own REASON/header already promise this route is blocked (doc/code drift).
- **[Uncarded, Exploratory] human-collaboration on autonomous workers deadlocks** — ~120 (5×4×6) — marketplace.json explicitly warns "Do NOT install on autonomous dispatched workers (diagnostic-mode-on-question would deadlock)": human-loop-mandate STOPs on any `?`, so a dispatched worker with no human hangs. Nothing DETECTS/PREVENTS the misconfig. Possible defensive fix: human-loop-mandate.sh no-ops when an autonomous-dispatch env (DANXBOT_DISPATCH_TOKEN / DANX_RUNTIME=container, no human) is detected. Fuzzy detection → low conf; correct install already excludes it. Scratchpad only. DISTINCT from CP-27 (that's investigate↔human-collaboration double-fire in HUMAN sessions).
- **[Note] Divergent ideator memory** — a parallel narrow-scope (ideator-subtree-only) session created CP-28..CP-32 (ideator plugin self-defects) using a SEPARATE clean-room `docs/features.md` that was never merged here. Those cards are real on the board; this canonical file now records them. CP-29 among them is the false positive above.
- **[Carded CP-52]** — the deleted dispatch-detail skill (DX-3435) LOC cap breach (310>300) — Maintenance — 432 (6×9×8) — split DX-1763/DX-1801 footguns section into a references/ file.
- **[Carded CP-53]** — agent-finalize.sh exit 66 missing from danx-next recovery table — Maintenance — 504 (7×8×9) — add Exit 66 bullet mirroring existing 0/1/2/64/65 format.
- **[Carded CP-54]** — danxbot skill "Local vs Deployed" table missing launch-worker-host + DX-1802 remote variants — Maintenance — 252 (4×7×9) — add 3 rows, transcribe from the deleted dispatch-detail skill (DX-3435)/no-unauthorized-worker-launch.
- **[Note] Board has NO MCP tools this session either** — `mcp__danx_dashboard__*` tools were not present in this dispatch's tool list (same gap CP-28/CP-46/CP-47/CP-48/CP-49/CP-50/CP-51 already describe). Used the documented curl-against-REST-API fallback (session log below has full mechanics). One operational lesson for next session: **the API has no dry-run/validate-only mode** — a test POST to `issue_create` creates a REAL card immediately (learned the hard way this run: an exploratory POST with placeholder description created CP-52 for real; immediately PATCHed it with the full intended content rather than leaving a placeholder card live). Future sessions: compose the FULL description+ac payload before the first POST for a given card; do not "test the shape" with a throwaway body.

---

## Session Log (overwrite each session)

**2026-07-13 (run 8)** — Board now CP-2..CP-54 (51 cards, up from 50 including the CP-46..CP-51
"ideator has no MCP tools" cluster from a session between run 7 and this one). ALL still at Review —
8 runs in, nothing has EVER moved to ToDo/In Progress. Confirmed again this run: board's derived
status for Review/ToDo/InProgress all return the SAME 50 rows (i.e. literally zero cards in ToDo or
In Progress) — the Review queue remains the sole bottleneck; ideation supply is not.

This dispatch itself hit the exact bug CP-28/CP-46..CP-51 describe: no `mcp__danx_dashboard__*` tools
in the tool list. Worked around via the documented curl-against-REST-API fallback (mechanics below).
Did NOT re-card this — already thoroughly covered by 6 existing Review cards.

Repo source changed materially since run 7 (`cc7dbef`→`148d4a2`, 7 new commits): `base v0.3.23`
(bash-exit-capture redirect-to-file guidance), `danxbot v0.3.96/97/98` (the deleted dispatch-detail skill (DX-3435) worker-launch
footguns section, no-unauthorized-worker-launch DX-1802 remote-variant rows, issue-card-workflow
manual-session-finalization section), plus an out-of-band commit to `.danxbot/scripts/agent-finalize.sh`
(DX-1511 worktree-safety `git()` wrapper + DX-1665 arm-b generation-supersede exit 66). Targeted the
diff since run 7 rather than re-sweeping the whole repo (already exhaustively covered 7 times) —
found genuine, fresh regressions/gaps introduced BY that diff:

1. **CP-52** (432, 6×9×8) — `the deleted dispatch-detail skill (DX-3435)` grew 281→310 lines from the new footguns section,
   breaching the repo's own documented 300-LOC cap (REFACTOR_MATRIX.md L16; was clean at 281 per run 7's
   own note). No CI catches this yet (CP-8 still Review) — exactly the risk class CP-7/CP-8 exist for.
2. **CP-53** (504, 7×8×9) — highest-ICE find this run. `agent-finalize.sh`'s new exit code 66 is fully
   documented in the script's own header but ABSENT from `danx-next/references/step-procedures.md`'s
   exit-code recovery table (0/1/2/64/65 present, 66 missing — verified via grep). A dispatched agent
   hitting this live split-brain-fence code path has zero documented recovery step.
3. **CP-54** (252, 4×7×9) — `danxbot` skill's "Local vs Deployed" table (self-described single source
   of truth) omits `launch-worker-host` and the two new DX-1802 remote variants, both already documented
   consistently in `the deleted dispatch-detail skill (DX-3435)` + `no-unauthorized-worker-launch`. Lower severity (info exists
   elsewhere) but a real completeness gap in the canonical doc.

Investigated but found CLEAN / no new defect: `scripts/publish.sh` (matches `.danxbot/config/workflow.md`
exactly); `agent-finalize.sh`'s new `git()` wrapper + curl generation-check parsing (correct bash
parameter-expansion for last-line extraction, fail-open branches all correct per its own header);
`deny-destructive-db.sh` PATTERN unchanged (CP-19/42/45 still valid, not re-carded); all hooks.json
files unchanged; no new dead `/flow-*` refs; no new `danx_issue_create` refs; root `.gitignore` still
absent (CP-33 still valid); `REFACTOR_MATRIX.md`/`REFACTOR_PHASE7_REPORT.md` still present (CP-6 still
valid); `docs/skills-index.md` / `docs/authoring-plugins.md` still don't exist (CP-13/14/15 still
valid); all 6 plugin.json versions present and consistent with recent commits; pipeline/dev/investigate/
human-collaboration skill files (least-recently-touched plugins) show no new drift.

**Operational lesson (see scratchpad note above):** the dashboard REST API has NO dry-run/validate-only
mode — a test POST to `issue_create` creates a real card immediately. Learned this the hard way: an
exploratory POST with a placeholder description created CP-52 for real; immediately PATCHed it with the
full intended content (verified PATCH does NOT accept a `board` field in the body — 400 `Unknown
field(s): board` — omit it, board is query-string only for PATCH). Compose the full payload BEFORE the
first POST next time.

API mechanics (reconfirmed + extended this run): auth `Authorization: Bearer $DANXBOT_DISPATCH_TOKEN`
against `$DANXBOT_DASHBOARD_URL`. GET `/api/issues?board=<qualified-id>&status=<Status>` — board in
query, REQUIRED. POST `/api/issues?board=…` with `board` ALSO in the JSON body → **201** with
`{issue:{issue:{id,…}},checklists:...}`. **PATCH `/api/issues/<ID>?board=…`** — board in query ONLY,
including it in the JSON body → 400 `Unknown field(s): board`; `description` and `ac[]` (re-sent) both
update correctly, `ac[]` items keyed by `title`, returns 200 with the full issue + `checklists[]`
reflecting the new AC items. Single-issue GET (`/api/issues/<ID>?board=…`) returns the issue flat (no
`{issue:{issue:{...}}}` nesting — that nesting is POST/PATCH-response-only). `gate_decisions` NOT
required for `Bug`/`Feature` on this board (201 without it, both types this run).

Process note for operator: 51 cards unactioned at Review after 8 ideation runs (some spanning parallel
clean-room sessions — CP-46..CP-51 came from a session this run's log has no direct visibility into).
Marginal value of MORE cards remains near zero — the constraint is entirely TRIAGE + DISPATCH
throughput, not idea supply. This run intentionally used a targeted diff-since-last-run strategy
(rather than a full re-sweep) specifically because 7 prior full sweeps had already exhausted the
low-hanging structural defects; all 3 new cards trace directly to lines added in the 7-commit diff since
run 7, none are re-discoveries.
