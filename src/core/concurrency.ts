/**
 * Bounded parallelism.
 *
 * Google's list endpoints return bare ids, so every hit costs a second request.
 * Firing all of them at once trips per-user rate limits; firing them one by one
 * makes a twenty-result search take twenty round trips.
 */

/** Runs `task` over `items` with a fixed number of workers, preserving order. */
export async function mapWithConcurrency<T, R>(
  items: T[],
  limit: number,
  task: (item: T, index: number) => Promise<R>,
): Promise<R[]> {
  const results = new Array<R>(items.length);
  let cursor = 0;

  const workers = Array.from({ length: Math.min(limit, items.length) }, async () => {
    for (;;) {
      const index = cursor++;
      const item = items[index];
      if (index >= items.length || item === undefined) return;
      results[index] = await task(item, index);
    }
  });

  await Promise.all(workers);
  return results;
}
