# Scenario selection (load before browser work)

Pick at most the run's journey budget; the table offers coverage, not a mandatory full sweep.
Inspect each named spec and its guards before running. Contained local synthetic fixture
import/export/download is valid scripted QA with trace/video off, temporary directories and
cleanup even on failure. Keep real saves/keys/accounts and OS sharing out of every case.

The simulation column describes only the **pinned Claude CLI runner**, including its fixed
conditions. Native ChatGPT/Codex mode follows [chatgpt.md](chatgpt.md): use a `contracts.ts` task or
short owner-provided player goal, recording it exactly and the scoped adapter's conditions/tools.
It may expose screenshots or ARIA; don't assume the CLI's viewport/input/motion, actions or isolation.
Returning fixtures, swipe, network/CPU and other conditions are supported only if the actual
guarded adapter provides them. No physical-device or native-share evidence is implied.

| Player job / condition | Pinned Claude simulation | Scripted QA entry points |
| --- | --- | --- |
| First visit → opening → reveal → summary | `opening`, fixed fresh fixture | `pack-opener.smoke.spec.ts`, `pack-controls.spec.ts`, `summary-actions.spec.ts` |
| Collection/detail → understand rarity and showing a card | `sharing` observes discoverability only; guarded actions refused | `card-viewer-fit.spec.ts`, safe cases in `card-share.spec.ts` with its clipboard stub |
| Own/shared Profile and Rankings; shared arrival | `results` starts fresh, not a returning/shared fixture | `pages.spec.ts`, `rankings.spec.ts`, `shared-pull.smoke.spec.ts` |
| Returning history/collection after reload | No returning-save task/flag | `pack-return.spec.ts`, `pack-cache-idb.spec.ts`, `multi-tab.spec.ts` |
| Keyboard/confusion, Settings/help | `recovery`, tool keyboard only; no imports/exports/settings changes | `keyboard-reveal.spec.ts`, `a11y-states.spec.ts` |
| Save recovery/storage denial and tab races | No save-recovery simulation | `resilience.spec.ts`, `multi-tab.spec.ts`, `backup-round-trip.spec.ts` (guarded temporary export → fresh-context import, finally cleanup) |
| Narrow/short/enlarged text, motion and touch/swipe | Fixed 393×727 touch/reduced motion only; no swipe tool | `pack-fit.spec.ts`, `enlarged-text.spec.ts`, `motion-setting.spec.ts`, `pack-swipe.spec.ts` |
| Loading/offline, delayed art, interruption/lifecycle | No network/CPU/lifecycle flags | `deferred-chunk.spec.ts`, `card-image-recovery.spec.ts`, `pack-lifecycle.spec.ts` |

Scripted paths above are relative to `tests/browser/`; fixtures/guards live in `support.ts` and
`playwright.config.ts`. Example safe targeted invocation after inspecting the spec:

```sh
npx playwright test tests/browser/keyboard-reveal.spec.ts --project=desktop-chromium
```

Before navigation verify intended local origin/path/GET-only policy, context HTTP/WebSocket guards,
redirect and popup containment, blocked service workers and no real submission. Synthetic local
files stay inside the controlled test and are deleted; staging/production stay read-only, with no
writes or downloads. Both modes forbid actual copy/export/download/native sharing. Declare whether
the adapter supports opening a read-only sharing dialog; the pinned CLI blocks its Share control.
Don't loosen monitor allowlists/writes, use `continueAllowed`, or disable unexpected-I/O failures
to force a result. Disable raw trace/video capture for sensitive fixture flows and sanitize any
failure artifacts before sharing. If an effect cannot be safely contained, leave that case unrun.

Judge every visible flow by its player job, primary fact and next action; inspect relevant empty,
loading/error and recovery states. Scripted lifecycle events, network failures, touch input,
clipboard API stubs and accessibility checks are injected/emulated evidence, never independent
first-time behavior, OS sharing, a physical device or a screen-reader user test. Native share and
actual assistive technology remain unrun until supplied human evidence covers them.
