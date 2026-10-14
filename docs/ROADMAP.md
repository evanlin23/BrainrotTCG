# Product and launch roadmap

Brainrot TCG should become a meme pack opener built to produce ridiculous, recognizable, shareable moments. Short-form spectacle is the primary product direction; long-term collecting gives people reasons to return. Verification supports credible pulls and a separate technical storytelling lane.

Three loops guide the product: open a recognizable and entertaining pack; collect toward an achievable goal; share something a friend wants to watch or open. Global growth comes from collaborators who understand local meme scenes, not just translating English captions.

## Two public faces

- **Viral entertainment first:** dramatic rare-card reveals, rare-pack hunts, surprising modifier combinations, funny ordinary pulls and creator reactions. Optimize the game and export experience for TikTok, Instagram Reels and YouTube Shorts. Start with an 80% viral / 20% technical publishing mix as a hypothesis, not a fixed rule.
- **Technical credibility:** explain how pulls verify, versioning, the serverless architecture and design tradeoffs. Use developer-focused Shorts plus deeper YouTube, LinkedIn and build posts when appropriate. Do not make a verification tutorial the default opening of a viral clip.

Use [SOCIAL_PIPELINE.md](SOCIAL_PIPELINE.md) for the reveal/clip brief. A satisfying payoff, visible upgrade goal and easy sharing should connect spectacle to repeat play.

## Current baseline

Main already has deterministic versioned pulls, independent verification, era sets, a collection, share images/links, a global Hall of Fame, and verified XP/levels with cosmetics. These are foundations, not future promises. The usability/navigation work is still proposed in [PR #188](https://github.com/evanlin23/BrainrotTCG/pull/188); additional versioned finishes are proposed in [PR #203](https://github.com/evanlin23/BrainrotTCG/pull/203). Neither is assumed merged or deployed by this roadmap. Existing save/focus reports remain tracked in #87, #181 and #186.

The roadmap is an evidence-gated sequence, not a promise of virality or dates. The current October 14, 2026 review has a dated [handoff packet](CLAUDE_HANDOFF.md); it is temporary context, not the entry point for future work. Use this roadmap and the live issue milestones for ongoing sequencing. The following phases supersede the earlier mixed readiness/distribution milestones.

## Phase 1: game quality and verification

Make saves dependable, opening/sharing accessible and the first minute understandable before promotion. Prioritize #181/#87 storage, #226/#228/#229 failure recovery, #8/#12 phones/accessibility, #183/#222 navigation/onboarding and #182/#184/#185/#186 controls/guide/sharing. #73/#233/#234/#239 add layered automation/local agent audits; #211 retains actual newcomer validation. #235–#237 own readiness/rollback, diagnostics and assets; #230–#232 own dependency/CI/docs hygiene.

Owner preparation runs in parallel: #358 establishes a brand email, recovery and official Instagram/YouTube/TikTok/Facebook/Reddit identities, reusing the owner-confirmed LinkedIn page and Linktree. Account reservation/profile setup belongs to Phase 1; content production and publishing remain Phase 2.

Complete Phase 1 in this order; contributor readiness and game readiness are separate gates:

| Gate | Work and evidence |
| --- | --- |
| Engineering foundation | #308: concise shared instructions/token-efficient sessions, owner-selected PR/check policy, least-privilege pinned workflows, unit/type/spec/asset/workflow/built-browser checks, reusable integration fixture #350 and performance measurement runner #351. #349 hardens verified-main automatic deployment; the owner retains administrator bypass and enabled publishing. Commands/settings must actually work; local agents remain separate from Actions. |
| Reliability reconciliation | Review and integrate bounded fixes with their regressions, preserve saves/old proofs, resolve conflicting or superseded drafts and validate the actual combined head. Retain explicit data-preservation holds; optional finishes/rankings do not gate a dependable game. |
| Shared design system | #312: one accessible design artifact with semantic colors, typography, spacing, reusable components/states and responsive first/returning-player flows, mapped to code. Verify Figma authoring access or use the agreed editable prototype; implement approved slices with visual/accessibility checks. |
| Release decision | #235: final unit/integration/UI/spec/asset checks, measured phone performance, newcomer/accessibility evidence, save-compatible rollback and explicit production authorization. Design changes require renewed candidate validation. |

Establish a usable test foundation before broad fixes, then add meaningful feature regressions with those fixes. Do not turn readiness into an unlimited framework project or a requirement to clear every future backlog item.

Exit when release-blocking save/proof/blank-screen/accessibility defects are resolved and relevant checks/audits pass on the actual candidate. Physical-device/human evidence remains separate. Optional top-10/per-card rankings (#223/#224) and new finishes (#187/#203) must not delay basic recovery. Auto-submission (#225) waits for measured capacity.

## Phase 2: social creation and publishing

Build verified-source briefs and bounded auto-drafting (#213), reusable clips (#38/#68), creator assets (#78), exact-revision review, then a small manual four-week pilot (#77). #74 measures comparable format/player signals. Drafts can be prepared during Phase 1; public promotion waits for readiness.

After the pilot, #214 implements one supported official publishing destination with durable jobs, authorized accounts, dry-run/test evidence, safe retries, unknown-response reconciliation and a pause switch. Account/API eligibility and production-post authorization are explicit prerequisites. Reddit/community participation and LinkedIn technical posts are distinct treatments, not automatic copies of every short.

Exit with a complete reviewed production flow, a successful authorized pilot and a repeat/change/stop decision. Use [SOCIAL_PIPELINE.md](SOCIAL_PIPELINE.md); creating a generator is not authorization to upload.

## Phase 3: sustainable growth and scaling

Measure static/media/build/Actions/provider capacity and intake backlog, retention and costs. Enable broader auto-submission (#225) only after bounded load/outage evidence. Reuse #214 for publisher operating controls. Improve predictable collecting (#212/#14/#52), reviewed release cadence (#16/#58), community contributions (#15/#79), and one regional collaboration (#42/#11) based on observed player/content signals.

Exit when the cadence and growth fit recorded operating budgets and recovery/retention policies. Expand destinations or regions one at a time. Accounts, a spending economy and a continuously running server are not required for these loops.

## Phase 4: future systems and optional backend

Use a separate backend decision RFC for account recovery, canonical ownership/spending or trusted ranking eligibility only after a measured limitation justifies it. Preserve static guest play and historical proof compatibility. Compare narrow Cloudflare services with real quota/cost/verification constraints; avoid assuming a server fixes GPU or multiple-account advantage.

Keep trading (#19), battles (#18), prestige/economy (#48/#51), custom game modes and broader platform integrations (#63–#65/#85) as explicit hypotheses. They do not block game quality or the initial social pilot. Editable local spending histories can fork; exclusive ownership/trading needs canonical authority. Keep accessibility free and prefer existing cosmetic goals before a shop economy. Private exported backups can recover identity; public proof links cannot. Clearing site data still loses a local save without a backup.

## Success measures and discipline

Track observed first-pack/share task success with counts/context, available post watch/engagement signals, tagged aggregate game visits, editing effort, voluntary return feedback and operating capacity. A share click does not establish an external post; views do not establish product growth; local saves do not identify unique people or reliable D1/D7 retention. Set numerical targets from baseline rather than invent them.

Each phase records candidate commit, acceptance evidence, unresolved limits and reviewer decision. Use [DEVELOPMENT.md](DEVELOPMENT.md) for verification/backlog/doc hygiene and [RANKINGS.md](RANKINGS.md) for ranking contracts. Issue #1 is the live phase index. All current work remains draft pending Claude review.

## Current simplification proposal

One featured set/Open pack action for fresh visits; repeat openings remain allowed. Unlock other set choices after successful recorded first pack (including skip/exit), recognize legacy returning saves and keep settings/help/accessibility immediately available. Optional exploration bypass needs review. Reveal/summary actions and card/pack sharing stay visible above cards; no A-toggle/auto-open.

Proposed primary order: Open packs, My cards, Rankings. My cards owns Cards/Best pulls/history filters; Player utility owns display name, Goals & rewards and Save & restore; Sound & display is a utility. Today's submissions / All-time submissions show top 10 verified pack pulls; per-card boards live in card detail. Historical firsts/screenshots remain in an explained archive, not primary navigation. #183/#222/#223/#224 own details.

These are hypotheses for review/testing, not current deployed labels. Do not rewrite the app to satisfy a pattern; use shared navigation/image/worker services where justified. #72 owns broader state boundaries; #226/#229 own bounded rendering/verification recovery. Generator odds/finishes require versioning; navigation disclosure does not.
