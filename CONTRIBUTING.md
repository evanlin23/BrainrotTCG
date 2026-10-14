# Contributing to BrainrotTCG

Welcome! This document outlines guidelines for both human contributors and AI agents working on BrainrotTCG.

## Development & Verification
1. **Install Dependencies:** `npm install`
2. **Local Dev Server (Humans only):** `npm run dev` (Agents must NOT launch this server).
3. **CI Verification:** Always run `npm run check` before submitting a PR. This runs linting, TypeScript typechecks, tests, and set lock verification.

## Card Sets & Locking
- Card sets are cryptographically version-locked.
- If you edit or add sets in `src/content/sets/`, you must update the lockfile by running:
  ```bash
  npm run check:sets -- --update
  ```
- To scaffold a new set, use `.claude/skills/new-set` and review `docs/ADDING_A_SET.md`.

## Note on GitHub Issues
The global Hall of Fame uses automated GitHub Issues as its database.
For bugs and feature discussions, please use the official issue templates so development tasks are easily distinguished from game submissions.
