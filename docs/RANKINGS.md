# Rankings and automatic submissions — draft architecture

Status: proposed for Claude review. No odds, scoring, ticket difficulty, accounts or application code change in this PR. “No backend” here means no new always-on application server; the existing Nostr relays and GitHub Actions remain external services with costs, limits and delays.

## Product contract

Primary Rankings has Today's submissions and All-time submissions: top 10 pack pulls, not top 10 profiles. Keep GPU/local mining permitted and clearly separate “submitted today” from “opened today”; proofs do not establish wall-clock opening time. Multiple winning pulls by one player are allowed. #85 remains the separate profile leaderboard proposal.

Card detail offers “Best versions of this card”, initially all-time top 10. Daily per-card boards can follow if people use this. Group by stable set id + card id; show version/era explicitly. Cross-version comparisons are allowed only when identity and scoring are comparable; otherwise split by set version. Rank by the existing verified individual-card point value, not the enclosing pack's poker multiplier. Compute it from the reconstructed proof. Within one pack, two copies of a card are separate instances keyed by pull id + card index. Equal scores tie by trusted first receipt time, then stable instance id. Explain that finite finish combinations can create many tied cards. Do not introduce an artificial rarity multiplier to make the board look exciting.

Overall global “Best cards” across card identities is a distinct all-time top-10 selector contract (#338), sharing those individual-point and proof rules. Local personal Best cards retention/placement is #337; a winning card must remain reconstructible even when its pack leaves retained best packs. Both proposals use the shared design #312, without another primary navigation destination. #339 decides how pack headlines explain a standout card while keeping the true combo/multiplier visible; pack rankings still measure total pack score. These contracts await review and separate implementation slices.

Display exact card modifiers, score, proof link and verification status. Pending relay items appear separately as provisional; never decorate them as accepted daily winners. Keep first-submission/archive data and legacy URLs accessible outside the main tabs.

## Canonical ingestion and snapshots

The current global list retains top 100 plus firsts. Filtering that JSON cannot yield correct daily or per-card rankings: otherwise discarded packs may win those boards. Generate independent bounded indexes from verified candidates, retaining proof evidence for every indexed winner. Incremental top-K merges are valid for immutable scoring and append-only candidates; removals, score changes and schema migrations require replay from retained source evidence, not just the previous winners.

Proposed static schema: schemaVersion, policyVersion, revision, generatedAt, effectiveDayUTC, and board records with scope, capacity, entries, complete/partial status and cutoff. Each entry contains pull id, proof reference, trusted firstReceivedAt, verifiedAt and cardIndex where applicable. Publish revision atomically; clients keep the last good snapshot on refresh failure and show its timestamp.

Use the first receipt by the trusted GitHub intake workflow as the canonical UTC day. Persist that time before verification; delayed Actions verification cannot move it into another day. Relay created_at and client clocks are untrusted. Relay transport acceptance is not canonical intake. Repeat signing/submission of the same pull cannot reset its date. If a receipt was not persisted before failure, it cannot be retrospectively claimed as an earlier day. Existing submittedAt means first verification, so use an explicit migration/cutover; do not silently relabel it first receipt. All-time can retain older entries; historical daily entries need original trusted evidence or remain unavailable.

Persist dedicated daily top-10 snapshots and per-card top-10 indexes through the existing workflow/repository data path, with an archive retention decision made before rollout. Start with current day plus 30 previous daily snapshots as a proposal, not an operational promise; retain evidence and choose long-term archival cost separately. Preserve historical global/firsts records during migration. Archive daily cutoff sets at rollover and make day mismatches force refresh.

## Automatic qualifying submission

Offer a plainly explained “Automatically submit qualifying pulls” preference, initially off until the player opts in once. Public proofs and a chosen display name are shared; private save keys are never transmitted. Opt-in enables hands-free qualified submission, not auto-opening packs. A small status reads Queued, Sent to relays, Awaiting verification, Ranked, Not in top 10, or Retry needed. Manual submission remains available. Obtain consent before publishing previously saved pulls; do not bulk-send history when enabling it.

After successful local recording, evaluate the proof against every relevant board: today's pack, all-time pack and each card instance. One proof transport event can serve multiple boards; do not send a separate event for each card. Coalesce by pull id and persist a bounded pending queue; preserve unsent candidates or show a recoverable export/manual action rather than silently drop a winner. Rate-limit, back off with jitter, cap concurrency and retries, and retry when online. Partial relay success is “sent”, not “ranked”. Lost acknowledgments use a stable event/idempotency key; reconciliation checks trusted status before resending. UI must remain responsive even when someone mines 30 packs/second.

## Stale cutoffs: refresh, compare, reorder

A fresh snapshot can suppress obviously losing candidates only for boards proven full under the exact current policy and scope. The cutoff is a full ranking tuple, not a score alone. A missing/partial board, day change, policy mismatch, failed validation, eviction/moderation or unknown scope means refresh or conservatively queue; never treat unknown as “not qualified”. Old global minimum eligibility cannot exclude ordinary packs that could win a sparse daily or per-card board. Change eligibility consistently in UI, relay inbox and Actions when adopting these boards.

Draft freshness target: revalidate once on entering Rankings and at most every 60 seconds while foregrounded; use ETag/conditional requests and one shared in-flight request. For automatic submission, use snapshot age, revision and day to decide freshness. A missing/offline snapshot conservatively queues local candidates until refresh; it does not publish every ordinary pack. After refresh, re-evaluate the queue and reorder displayed rows with the shared comparator. A stale append-only top-K cutoff usually causes extra candidates rather than missed winners; moderation resets or daily rollover invalidate that assumption. Trusted verification always recomputes eligibility against the current snapshot.

Queue optimization can keep local top-K candidates per relevant scope when that scope's current comparator is known and immutable; tie ordering depends on trusted receipt, so equal-score candidates must not be prematurely dropped using invented client timestamps. Keep bounded replay evidence and define overflow behavior. Publish only candidates plausibly affecting a board; the Actions inbox must also deduplicate, validate proof/signature/size, bound fetched events and verification work, and handle repeated spam. Client throttling alone cannot prevent external scripts abusing public relays/intake.

## Limits and rollout gates

No system here can promise real-time ranking, guaranteed free unlimited verification, proof of today's opening, or protection against GPU advantage. Actions schedules may be delayed and public relays may discard events. Show generatedAt, pending state and refresh/retry options. Public rankings need the existing name moderation policy (#21) and a removal/rebuild mechanism.

Implement schema/selectors and replay tests first, then daily/all-time UI, then per-card indexes, then opt-in auto-submission. Test stale and partial snapshots, UTC rollover, delayed verification, duplicate relay events, equal-score ties, policy migration, failed publish, moderation removal and a 30-packs/second local producer. Measure candidate/verification volume before enabling broadly; use batching and verification budgets rather than weakening proof checks.
