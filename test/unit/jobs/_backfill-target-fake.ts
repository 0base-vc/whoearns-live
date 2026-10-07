import { vi } from 'vitest';

/**
 * Job tests supply known historical fixture identities at this boundary.
 * This is not a provenance resolver: production fresh claims pin only epoch.
 */
export function withBulkTargets<
  T extends {
    listPendingBackfill(): Promise<string[]>;
    getOrSetBackfillTarget(
      vote: string,
      epoch: number,
      identity: string,
    ): Promise<{ epoch: number; identity: string } | null>;
  },
>(repo: T, identities: (votes: string[]) => Promise<Map<string, string>>) {
  return {
    ...repo,
    getOrSetBackfillTargets: vi.fn(async (epoch: number) => {
      const pending = await repo.listPendingBackfill();
      const mapping = await identities(pending);
      const targets = new Map<string, { epoch: number; identity: string }>();
      for (const vote of pending) {
        const identity = mapping.get(vote);
        if (identity === undefined) continue;
        const target = await repo.getOrSetBackfillTarget(vote, epoch, identity);
        if (target) targets.set(vote, target);
      }
      return targets;
    }),
  };
}
