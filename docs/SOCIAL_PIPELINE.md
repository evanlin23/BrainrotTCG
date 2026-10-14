# Social content production and publishing

The pipeline turns real gameplay into funny, visually loud, platform-appropriate content. Viral entertainment is the primary lane; technical explanation is a smaller separate lane. Start with three formats and twelve reviewed posts in the four-week experiment (#77). Automate drafting/rendering before automating publication. Editorial judgment stays with a person until a format has proved repeatable.

Start with an 80% viral / 20% technical mix, adjusting to observed results. Viral clips lead with a meme, a question, a reveal or a reaction. Technical clips lead with a concrete question such as "Can this pull be faked?" and explain one design choice.

Phase 1 account readiness is tracked in #358: owner-controlled brand email/recovery and consistent official accounts for Instagram, YouTube, TikTok, Facebook and Reddit, plus LinkedIn if already created. The owner completes registration/verification and keeps credentials/recovery codes private. Record confirmed public handles/URLs in that issue and consolidate canonical links here after confirmation; none are assumed created. API eligibility, integrations and posting authorization remain #77/#214.

Owner-confirmed public properties: [LinkedIn](https://www.linkedin.com/company/brainrottcg/) and [Linktree](https://linktr.ee/brainrottcg). The current handle research and unconfirmed candidates live in #358, referenced by Phase 2 #77; no other social account ownership is assumed.

## Workflow and ownership

Trend inputs (#83) and reviewed set data feed a content brief (#213). Reusable rendering (#38) produces assets. An editor approves an exact revision. A publisher (#214) schedules that revision through a supported integration, records the result and feeds aggregate results back to the weekly experiment review.

Suggested roles: maintainer owns product/release readiness; editor owns joke, caption, credits and approval; publisher owns destination settings, retries and reconciliation. One person can hold all roles initially. No task in this plan assigns a person or grants access automatically.

## Brief contract

A brief includes a stable content ID and revision, source pull proof or set/version, audience/language, format, hook, payoff, caption, call to action, credited contributors/sources, asset locations/hashes, destination-specific text, scheduled time/timezone and reviewer/approval status. Do not store credentials in briefs, generated files or logs.

Use actual verified cards and outcomes in pull-based posts. Clearly label staged demonstrations or promotional examples; do not present a fabricated pack as a lucky verified pull. Preserve the source version so later generator changes cannot alter the advertised result. Refer to docs/ART_STYLE.md and the decisions tracked by #22 for imagery and credits.

## Starter formats

| Format | Hook and payoff | Participation |
| --- | --- | --- |
| Rare-card / rare-pack hunt | Immediate chase target, short buildup, visible real outcome | Invite viewers to compare their actual pulls |
| Your internet era in five cards | Recognizable era, quick reveals, a closing joke | Ask which era the audience belongs to |
| Common card, legendary behavior | Overly dramatic presentation of an ordinary meme | Invite a friendly disagreement about rarity |
| Which meme did we miss? | Show a coherent set and an obvious gap | Route suggestions to the proposal process (#15) |
| Community chose this (after the pilot) | Reveal a reviewed community card and its story | Credit the contributor and invite the next proposal |

Pick three viral formats initially and one lightweight technical format; do not generate a large volume before finding a voice. Avoid identical AI-style captions, misleading rarity claims or jokes that need a paragraph of explanation. Review the opening frame, readable captions, pacing, audio rights, visible payoff and final invitation to play.

## Destination outputs

- Reels/Shorts/TikTok: a short vertical video, typically 6–15 seconds as an initial hypothesis, with legible captions, a payoff and a brief play invitation. Longer pack hunts can be tested separately rather than stretching a one-card clip. Verify each destination's actual codec/duration/audio requirements before implementation.
- Instagram carousel: set showcase or pick-your-favorite sequence with credits.
- Reddit: a community-specific discussion, image or clip, with a person participating in replies. Review community rules; do not automatically spray the same promotional post across subreddits.
- LinkedIn: occasional project/build/community milestones in an understandable voice, rather than a copy of every meme post.

## Creative brief for short-form clips

Use an immediate recognizable hook (initial hypothesis: first 1–2 seconds), short anticipation and a complete visible payoff. Start single-card clips around 6–15 seconds and test 15–30-second hunts separately; these are experiments, not platform rules or neurological claims. Don't withhold a result just to inflate watch time.

Make finishes visually distinctive, synchronize sound/captions, keep one readable focal point and verify destination overlays/safe areas. Ordinary memes can be funny without a rare score. Live play remains fast/manual, with free gesture alternatives/reduced motion; cinematic export can be flashier without imposing its ceremony on everyone. Preserve actual outcomes and distinguish presentation order from derivation; staged demonstrations are labeled.

Start around 80% viral / 20% technical content as a hypothesis. Viral hooks target recognizable memes, hunts and creator reactions; technical posts explain one demonstrated verification/design choice. Compare one major creative variable at a time where feasible and record platform-specific denominators/context. Pilot watch/rewatch/share and game-entry signals guide repeat/change/stop decisions, not a promise of virality. Verify current official destination specs/discovery guidance before execution; blocked source pages were not reviewed as algorithm evidence.

## Queue states

`draft -> review -> approved -> scheduled -> publishing -> published`

Other outcomes are `rejected`, `cancelled`, `failed` and `unknown`. Changing an approved caption or asset hash creates a new revision that returns to review. Cancellation and a global pause must prevent jobs that have not started. Approval records who approved which exact revision; a trend-agent output is not publishing approval.

## Serverless implementation boundaries

GitHub Actions can render assets and orchestrate scheduled jobs; a supported scheduler or official API can publish. Choose one initial destination/provider and validate its current capabilities, account eligibility, permissions, rate limits and scheduling support. Instagram/TikTok/YouTube/Reddit do not share a universal publishing API. Account setup, tokens and any app review are implementation prerequisites, not assumed complete.

Keep a durable ledger of job ID, content revision/hash, destination, scheduled time, attempt state and remote post ID. Short-lived Actions logs/artifacts alone are not a durable ledger. Decide on approved persistent storage during #214; GitHub or object storage remains an external service even without a continuously running backend.

Use one logical job per content revision/destination, serialize concurrent publishers, and reconcile remote IDs to avoid duplicates. Retry only explicit safe/transient failures with bounded backoff. A timeout after sending can mean the post exists: mark it unknown, inspect/reconcile and do not blindly resend. Provide dry-run previews, cancellation, a kill switch and manual fallback. Test in supported test/sandbox accounts before separately authorized production posts.

This documentation authorizes no social posting. The planning PR does not configure accounts, credentials, schedules or services.

## Four-week experiment

Each week produces three reviewed posts across the initial destinations chosen in #77. Record format, revision, destination, timing, edit effort, available platform watch/engagement results and aggregate game visits/first-pack events. Compare formats within their context rather than combine incompatible metrics into a single score. Make a written repeat/change/stop decision each week, and define the next month's cadence from that evidence.
