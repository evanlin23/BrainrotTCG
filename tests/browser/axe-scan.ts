import AxeBuilder from '@axe-core/playwright';
import { expect, type Page, type TestInfo } from '@playwright/test';

/**
 * One bounded axe scan for a loaded screen (#747). Specs call `expectAxeClean(page, testInfo, state)`
 * once the screen they care about is on show; the rule list, the settle step, the exception list and
 * the report of what axe could not judge all live here, so a later route or focus sweep (#766) adds
 * states, not another scanner.
 *
 * What an automated scan is not: a full accessibility audit or a physical-phone check. Keyboard order,
 * focus rings, reduced motion, target sizes and screen-reader wording stay with the specs that already
 * own them (accessibility.spec.ts, a11y-states.spec.ts, pack-targets.spec.ts).
 */

/** Rules run on every scan: a fixed list, never a tag or the whole rule set, so axe upgrades cannot widen it silently. */
export const AXE_RULES = [
  // Names: every control and region a screen reader announces has one.
  'button-name', 'link-name', 'input-button-name', 'label', 'select-name', 'image-alt', 'role-img-alt', 'svg-img-alt',
  'aria-dialog-name', 'aria-input-field-name', 'aria-toggle-field-name', 'aria-command-name', 'aria-meter-name',
  'aria-progressbar-name', 'aria-tooltip-name', 'aria-treeitem-name', 'form-field-multiple-labels',
  // Roles and relationships: valid roles and attributes, required parents and children, ids that resolve.
  'aria-roles', 'aria-allowed-role', 'aria-allowed-attr', 'aria-required-attr', 'aria-required-children',
  'aria-required-parent', 'aria-valid-attr', 'aria-valid-attr-value', 'aria-deprecated-role', 'aria-conditional-attr',
  'aria-hidden-body', 'aria-hidden-focus', 'aria-prohibited-attr', 'presentation-role-conflict', 'nested-interactive',
  'duplicate-id-aria', 'list', 'listitem', 'definition-list', 'dlitem',
  // The document: its title, language and viewport.
  'document-title', 'html-has-lang', 'html-lang-valid', 'valid-lang', 'meta-viewport',
  // Colour contrast as rendered (WCAG AA), once fonts, images and animations have settled.
  'color-contrast',
] as const;

/** The screens scanned. A scan or an exception for any other name is a typo, not a state. */
export const AXE_STATES = ['first-pack', 'summary', 'settings', 'card-share', 'mid-reveal', 'cards', 'rankings', 'profile', 'shared-pull'] as const;

/** Rules a scan must have reached on every screen, so a scan of an empty or wrong page cannot pass. */
const ALWAYS_APPLICABLE = ['color-contrast', 'document-title', 'html-has-lang'] as const;

/** What axe cannot see, written into every report so a green scan is not read as more than it is. */
export const NOT_COVERED = [
  'Text on art, gradients, overlapping layers or partly transparent backgrounds: axe marks these "needs review" (listed per scan).',
  'Anything drawn on a canvas, including card faces and effects, and the content of images.',
  'Keyboard order, focus visibility, target sizes, reduced motion and forced colours: owned by the specs that test them.',
  'Real screen readers and physical phones.',
] as const;

/**
 * A violation accepted for now. Each entry names the exact rule and selector, why it stays, who owns the
 * fix and what removes the entry. A scan fails on an entry that no longer matches anything, so this list
 * only shrinks. It is empty on purpose: add to it only with a linked follow-up.
 */
export interface AxeException {
  state: string;
  rule: (typeof AXE_RULES)[number];
  /** The axe target, exactly as reported (CSS selectors, shadow and frame parts joined with " >> "). */
  selector: string;
  reason: string;
  owner: string;
  removeWhen: string;
}
export const AXE_EXCEPTIONS: readonly AxeException[] = [];

/** What is wrong with an exception list: an unknown rule or state, or a missing reason, owner or removal condition. */
export function invalidExceptions(exceptions: readonly AxeException[], states: readonly string[] = AXE_STATES): string[] {
  return exceptions.flatMap((e) => [
    ...((AXE_RULES as readonly string[]).includes(e.rule) ? [] : [`unknown rule "${e.rule}"`]),
    ...(states.includes(e.state) ? [] : [`unknown state "${e.state}"`]),
    ...(e.selector.trim() ? [] : [`${e.rule} in ${e.state} has no selector`]),
    ...(['reason', 'owner', 'removeWhen'] as const).filter((key) => !e[key].trim()).map((key) => `${e.rule} in ${e.state} has no ${key}`),
  ]);
}

interface Finding { rule: string; selector: string; summary: string }
export interface AxeReport {
  state: string;
  /** Violations nobody accepted. */
  violations: Finding[];
  /** Accepted violations that matched this scan. */
  excepted: Finding[];
  /** Exceptions for this state that matched nothing. */
  staleExceptions: AxeException[];
  /** Nodes axe could not judge (art, transparency, overlap), by rule. */
  needsReview: Finding[];
  /** Always-applicable rules that found nothing to check. */
  notApplied: string[];
  /** Nodes axe checked and passed, across all rules. */
  passedNodes: number;
}

const selectorOf = (target: unknown[]) => target.map((part) => (Array.isArray(part) ? part.join(' >> ') : String(part))).join(' >> ');
const finding = (rule: string, node: { target: unknown[]; failureSummary?: string; html: string }): Finding => ({
  rule,
  selector: selectorOf(node.target),
  summary: (node.failureSummary ?? node.html).replace(/\s+/g, ' ').replace(/^Fix any of the following: /, '').trim().slice(0, 240),
});

/**
 * Waits for the page to stop changing, on what the page reports: webfonts loaded, every image still
 * loading finished (load or error), finite running animations and transitions finished, and two
 * animation frames so layout has run on the final styles. Contrast read before this would be read
 * mid-fade. An animation cancelled while waited on counts as finished; a paused one is not waited for.
 * It does not call `decode()`: that rejects when an image's source changes mid-decode, which the
 * summary cards do as their art swaps in. Specs that need decoded art wait with `expectDecoded`.
 */
export async function settle(page: Page) {
  await page.evaluate(async () => {
    await document.fonts.ready;
    await Promise.all(Array.from(document.images)
      .filter((image) => !image.complete && image.loading !== 'lazy')
      .map((image) => new Promise<void>((resolve) => {
        image.addEventListener('load', () => resolve(), { once: true });
        image.addEventListener('error', () => resolve(), { once: true });
      })));
    await Promise.all(document.getAnimations()
      .filter((animation) => animation.playState === 'running' && Number.isFinite(animation.effect?.getComputedTiming().endTime ?? Infinity))
      .map((animation) => animation.finished.then(() => undefined, () => undefined)));
    await new Promise<void>((resolve) => requestAnimationFrame(() => requestAnimationFrame(() => resolve())));
  });
}

/**
 * Scans `page` as it is now and returns the report. Reduced motion is emulated for the scan so looping
 * pulses (the pack's waiting hint fades to 0.55 opacity) cannot make contrast depend on the animation
 * phase; the page's own setting comes back afterwards.
 */
export async function scanPage(page: Page, state: string, scope?: string, exceptions: readonly AxeException[] = AXE_EXCEPTIONS): Promise<AxeReport> {
  await page.emulateMedia({ reducedMotion: 'reduce' });
  let results;
  try {
    await settle(page);
    const builder = new AxeBuilder({ page }).withRules([...AXE_RULES]);
    results = await (scope ? builder.include(scope) : builder).analyze();
  } finally {
    await page.emulateMedia({ reducedMotion: null });
  }

  const applied = new Set([...results.passes, ...results.violations, ...results.incomplete].map((r) => r.id));
  const mine = exceptions.filter((exception) => exception.state === state);
  const used = new Set<AxeException>();
  const violations: Finding[] = [];
  const excepted: Finding[] = [];
  for (const violation of results.violations) {
    for (const node of violation.nodes) {
      const found = finding(violation.id, node);
      const exception = mine.find((e) => e.rule === found.rule && e.selector === found.selector);
      if (exception) { used.add(exception); excepted.push(found); } else violations.push(found);
    }
  }
  return {
    state,
    violations,
    excepted,
    staleExceptions: mine.filter((exception) => !used.has(exception)),
    needsReview: results.incomplete.flatMap((r) => r.nodes.map((node) => finding(r.id, node))),
    notApplied: ALWAYS_APPLICABLE.filter((rule) => !applied.has(rule)),
    passedNodes: results.passes.reduce((total, r) => total + r.nodes.length, 0),
  };
}

/** The failures in a report: what must be empty for the scan to count. */
export function problems(report: AxeReport): string[] {
  return [
    ...report.violations.map((v) => `${v.rule} at ${v.selector}: ${v.summary}`),
    ...report.staleExceptions.map((e) => `stale exception ${e.rule} at ${e.selector} (${e.owner}; remove when ${e.removeWhen})`),
    ...report.notApplied.map((rule) => `${rule} found nothing to check`),
    ...(report.passedNodes > 0 ? [] : ['axe passed no nodes at all']),
  ];
}

/** Scans the loaded screen, attaches what axe could not judge to the test report, and fails on any problem. */
export async function expectAxeClean(page: Page, testInfo: TestInfo, state: string, scope?: string) {
  expect(AXE_STATES as readonly string[], 'a scanned state is listed in AXE_STATES').toContain(state);
  const report = await scanPage(page, state, scope);
  await testInfo.attach(`axe-${state}`, {
    contentType: 'application/json',
    body: JSON.stringify({ state, passedNodes: report.passedNodes, excepted: report.excepted, needsReview: report.needsReview, notCovered: NOT_COVERED }, null, 2),
  });
  if (report.needsReview.length) {
    const reasons = new Map<string, number>();
    for (const { rule, summary } of report.needsReview) reasons.set(`${rule}: ${summary}`, (reasons.get(`${rule}: ${summary}`) ?? 0) + 1);
    const description = `${state}: ${report.needsReview.length} node(s) axe could not judge. ${[...reasons].map(([reason, count]) => `${reason} (x${count})`).join('; ')}`;
    testInfo.annotations.push({ type: 'axe-needs-review', description });
    // Annotations are not shown for a passing test in CI; the list reporter prints stdout.
    console.log(`[${testInfo.project.name}] axe needs review: ${description}`);
  }
  expect(problems(report), `axe on ${state}`).toEqual([]);
  return report;
}
