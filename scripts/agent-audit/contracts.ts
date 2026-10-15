export const tasks = {
  opening: 'You found this game for the first time. Try to open a pack and find out what you received.',
  sharing: 'Try to understand how rare an item is and how you would show one item to a friend. Do not send, submit, copy, download or export anything.',
  results: 'Try to find your own previous results and compare them with results from other people.',
  recovery: 'Explore whether you can comfortably use this game with a keyboard and recover when something is confusing. Do not change browser settings or import/export anything.',
} as const;
export type Task = keyof typeof tasks;
export function clean(value: unknown): string {
  return String(value).replace(/https?:\/\/[^\s]+/g, '[URL]')
    .replace(/[a-f0-9]{32,}/gi, '[opaque value]')
    .replace(/[\w.+-]+@[\w.-]+\.[a-z]{2,}/gi, '[email]')
    .split('').map((character) => character.charCodeAt(0) < 32 ? ' ' : character).join('').slice(0, 1200);
}
export function parseOptions(args: string[]) {
  const selected: Task[] = [];
  let seconds = 90;
  for (const argument of args) {
    if (argument.startsWith('--task=')) {
      const task = argument.slice(7);
      if (!Object.hasOwn(tasks, task) || selected.includes(task as Task)) throw Error('Unknown or duplicate task');
      selected.push(task as Task);
    } else if (/^--seconds=\d+$/.test(argument)) seconds = Number(argument.slice(10));
    else throw Error('Use --task=opening|sharing|results|recovery and --seconds=30..180');
  }
  if (seconds < 30 || seconds > 180) throw Error('Task limit must be 30..180 seconds');
  return { selected: selected.length ? selected : ['opening'] as Task[], seconds };
}
export function parseOutcome(raw: string, steps: string[]) {
  if (raw.length > 16384) throw Error('Oversized agent report');
  const value: unknown = JSON.parse(raw);
  if (!value || typeof value !== 'object') throw Error('Invalid agent report');
  const { outcome, observations } = value as Record<string, unknown>;
  if (!['completed', 'blocked', 'ambiguous'].includes(String(outcome)) || typeof observations !== 'string') throw Error('Invalid agent report');
  if (outcome === 'completed' && (!steps.some((step) => step.startsWith('snapshot:')) || !steps.some((step) => /^(click|press):/.test(step)))) throw Error('No browser evidence');
  return { outcome, observations: clean(observations) };
}
export const coordinatorPrompt = 'Review actual task reports without coaching the reviewers. Reproduce observations on the same revision and conditions, distinguish blocked tasks from product defects, deduplicate against canonical issues, and retest affected tasks with a fresh reviewer after fixes. Prepare evidence for owner review; do not publish, merge or deploy. Agent outcomes are not human statistics.';

export function isBasePath(value: string) {
  return /^\/(?:[a-zA-Z0-9_-]+\/)*$/.test(value);
}
