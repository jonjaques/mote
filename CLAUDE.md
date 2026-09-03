# Mote (llmcoder)

@AGENTS.md

Read `HANDOFF.md` before changing behavior; it records what is on disk, what
was measured, and the landmines. `PLAN.md` is the spec.

Session notes for Claude Code specifically:

- Start the dev server yourself on the fixed port: `pnpm dev --port 5180 --strictPort`.
  Check `lsof -nP -iTCP:5180 -sTCP:LISTEN` first; another instance may be up.
- Model runs go through `pnpm cdp:agent` (headed by default so the user can
  watch). Do not edit `src/` while one is running, and `pkill -f cdp-profile`
  if a run was interrupted before starting another.
- Commit only at milestones, never push (there is no remote).
