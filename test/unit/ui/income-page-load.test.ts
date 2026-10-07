import { readFile } from 'node:fs/promises';
import { runInNewContext } from 'node:vm';
import ts from 'typescript';
import { describe, expect, it, vi } from 'vitest';

/** Execute the actual route loader, resolving only its framework imports.
 * The backend test harness has no SvelteKit route aliases/generated types.
 * Transpilation erases types; UI check/build separately validate those types.
 */
async function incomeLoader(scoring: Promise<unknown>) {
  const history = { vote: 'VoteA', items: [], profile: { hideFooterCta: true } };
  const fetchHistory = vi.fn(async () => history);
  const fetchScoring = vi.fn(() => scoring);
  const fetchEpoch = vi.fn(async () => ({ epoch: 1051 }));
  const source = await readFile('ui/src/routes/income/[idOrVote]/+page.ts', 'utf8');
  const compiled = ts.transpileModule(source, {
    compilerOptions: { module: ts.ModuleKind.CommonJS, target: ts.ScriptTarget.ES2022 },
  });
  const exports: {
    load?: (event: { params: { idOrVote: string }; fetch: typeof fetch }) => Promise<{
      history: typeof history;
      hideFooterCta: boolean;
    }>;
  } = {};
  runInNewContext(compiled.outputText, {
    exports,
    require: (id: string) => {
      if (id === '$lib/api') {
        return {
          fetchValidatorHistory: fetchHistory,
          fetchScoring,
          fetchCurrentEpoch: fetchEpoch,
          ApiError: Error,
        };
      }
      if (id === '$lib/history-window') return { HISTORY_FETCH_EPOCHS: 52 };
      if (id === '@sveltejs/kit') return { error: vi.fn() };
      throw new Error(`Unexpected loader import: ${id}`);
    },
  });
  if (!exports.load) throw new Error('Missing page load export');
  return { load: exports.load, history, fetchHistory, fetchScoring, fetchEpoch };
}

describe('income page navigation', () => {
  it.each(['late success', 'late failure'])(
    'renders history independently of scoring: %s',
    async (outcome) => {
      let finish!: (value: unknown) => void;
      let fail!: (reason: Error) => void;
      const scoring = new Promise((resolve, reject) => {
        finish = resolve;
        fail = reject;
      });
      // A late failure must be handled even when scoring moves out of navigation.
      void scoring.catch(() => undefined);
      const route = await incomeLoader(scoring);
      const fetchFn = vi.fn<typeof fetch>();
      const loaded = vi.fn();
      const navigation = route.load({ params: { idOrVote: 'IdentityA' }, fetch: fetchFn });
      void navigation.then(loaded);
      try {
        await vi.waitFor(() => expect(loaded).toHaveBeenCalled(), { timeout: 100, interval: 5 });
        expect(loaded.mock.calls[0]?.[0]).toEqual({
          history: route.history,
          hideFooterCta: true,
        });
        expect(route.fetchHistory).toHaveBeenCalledWith('IdentityA', 52, fetchFn);
        expect(route.fetchScoring).not.toHaveBeenCalled();
        expect(route.fetchEpoch).not.toHaveBeenCalled();
      } finally {
        if (outcome === 'late failure') fail(new Error('500'));
        else finish({ tier: {} });
        await navigation;
      }
    },
  );
});
