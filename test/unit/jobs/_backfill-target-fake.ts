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
  const stored = new Map<string, { epoch: number; identity: string }>();
  return {
    ...repo,
    getUnclaimedBackfillCandidates: vi.fn(async () =>
      (await repo.listPendingBackfill())
        .filter((vote) => !stored.has(vote))
        .map((vote) => ({ vote, version: 'fixture', tuple: 'fixture' })),
    ),
    getOrSetBackfillTargets: vi.fn(
      async (epoch: number | null, candidates: { vote: string }[] = []) => {
        const pending = await repo.listPendingBackfill();
        const mapping = await identities(pending);
        const targets = new Map<string, { epoch: number; identity: string }>();
        for (const vote of pending) {
          const identity = mapping.get(vote);
          if (identity === undefined) continue;
          const target =
            epoch === null || !candidates.some((c) => c.vote === vote)
              ? stored.get(vote)
              : await repo.getOrSetBackfillTarget(vote, epoch, identity);
          if (target) stored.set(vote, target);
          if (target) targets.set(vote, target);
        }
        return targets;
      },
    ),
  };
}
