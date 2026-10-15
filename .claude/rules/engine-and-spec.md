---
paths:
  - "src/engine/**"
  - "spec/**"
  - "scripts/spec-vectors.ts"
---

# Engine and proof spec

- Anything that changes a pack, ticket, proof, score or profile result for existing inputs breaks
  old share links and Hall of Fame entries. Keep the old behaviour behind its version and add a new one.
- spec/PULL_SPEC.md is the contract and spec/verify_pull.py is a second implementation written only
  from it. Change the spec text, the engine and the Python verifier together.
- Vectors are history. `npx tsx scripts/spec-vectors.ts` rebuilds all of spec/vectors.json from the
  current engine, and `python3 -I spec/make_python_vectors.py` rebuilds spec/vectors-python.json. To
  add a case, add it to the generator and regenerate, then check with a `python3 -c` script that
  every entry in the committed file (`git show HEAD:<file>`) is unchanged. If one changed, revert:
  that change needs a new version.
- Before pushing, run `npx vitest run src/engine` and
  `python3 -I spec/verify_pull.py --vectors spec/vectors.json spec/vectors-python.json`
  (CI uses Python 3.13 with cryptography 50.0.1).
- The vector files are about 12k tokens each, and settings deny commands that name them. Query
  them from `python3 -c`, or use a path-less `git diff --stat`.
