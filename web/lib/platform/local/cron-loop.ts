export type CronStep = [name: string, fn: () => Promise<unknown>];

/**
 * Runs every step on a loop of its own until `stopping()` is true. A step's next run starts
 * `intervalMs` after its last one ended, so a step never overlaps itself, and a slow step (a
 * webhook to a slow endpoint, a long load) does not hold back the others.
 */
export async function runCronLoops(
  steps: CronStep[],
  run: (step: CronStep) => Promise<void>,
  intervalMs: number,
  stopping: () => boolean,
  tickMs = 500,
): Promise<void> {
  const loop = async (step: CronStep) => {
    while (!stopping()) {
      await run(step);
      for (let t = 0; t < intervalMs && !stopping(); t += tickMs) await new Promise((r) => setTimeout(r, tickMs));
    }
  };
  await Promise.all(steps.map(loop));
}
