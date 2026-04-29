import { McpServer } from '@modelcontextprotocol/sdk/server/mcp.js';
import { StreamableHTTPServerTransport } from '@modelcontextprotocol/sdk/server/streamableHttp.js';
import type { FastifyInstance, FastifyPluginAsync, FastifyReply, FastifyRequest } from 'fastify';
import { z } from 'zod';
import type { AppConfig } from '../../core/config.js';
import type { AggregatesRepository } from '../../storage/repositories/aggregates.repo.js';
import type { ClaimsRepository } from '../../storage/repositories/claims.repo.js';
import type { EpochsRepository } from '../../storage/repositories/epochs.repo.js';
import type { ProfilesRepository } from '../../storage/repositories/profiles.repo.js';
import type { LeaderboardSort, StatsRepository } from '../../storage/repositories/stats.repo.js';
import type { ValidatorsRepository } from '../../storage/repositories/validators.repo.js';
import type {
  EpochAggregate,
  EpochInfo,
  EpochValidatorStats,
  IdentityPubkey,
  Validator,
  VotePubkey,
} from '../../types/domain.js';

export interface McpRoutesDeps {
  config: AppConfig;
  validatorsRepo: Pick<
    ValidatorsRepository,
    'findByVote' | 'findByIdentity' | 'getInfosByIdentities'
  >;
  epochsRepo: Pick<EpochsRepository, 'findCurrent'>;
  statsRepo: Pick<StatsRepository, 'findHistoryByVote' | 'findTopNByEpoch'>;
  aggregatesRepo: Pick<AggregatesRepository, 'findByEpochTopN'>;
  profilesRepo: Pick<ProfilesRepository, 'findOptedOutVotes' | 'findByVote'>;
  claimsRepo: Pick<ClaimsRepository, 'findClaimedVotes'>;
}

/**
 * Streamable-HTTP MCP server in-process at `/mcp`. Exposes three
 * read-only tools (`get_current_epoch`, `get_leaderboard`,
 * `get_validator`) that AI agents — Claude Desktop, Claude Code,
 * custom MCP clients — can call directly without scraping the UI or
 * parsing OpenAPI.
 *
 * Why in-process Fastify routes instead of a sidecar:
 *   * No new Docker image, no Helm changes, no extra port.
 *   * Same observability + auth boundary as the rest of the API.
 *   * Cold-start cost is one shared `McpServer` instance per pod —
 *     created lazily on first hit, kept alive for the pod lifetime.
 *
 * Stateless mode (`sessionIdGenerator: undefined`):
 *   Each POST is a complete JSON-RPC exchange — no session cookies,
 *   no in-memory state to leak across requests. This is the right
 *   choice for a public, read-only API where every "tool call" is
 *   independent and there's no auth context to thread through. If
 *   we ever add long-running streaming tools or per-client memory,
 *   switch to stateful mode (`sessionIdGenerator: () => randomUUID()`).
 *
 * Tool descriptions ARE the prompt:
 *   The LLM agent reads each tool's `description` to decide when to
 *   call it. Time spent making these descriptions precise about
 *   current-epoch lower bounds, units ("all lamport values are
 *   STRINGS — parse as BigInt"), and input shape (vote-pubkey vs
 *   identity-pubkey) directly improves agent behaviour for free.
 */
const SHARED_TOOL_PROVENANCE_NOTE = [
  'Numeric fields ending in "Lamports" are STRINGS (decimal). Parse as BigInt — values',
  'routinely exceed Number.MAX_SAFE_INTEGER. SOL fields are decimal strings (1 SOL =',
  '1_000_000_000 lamports). Current-epoch income is a monotonic lower bound;',
  'closed-epoch income is final. Missing data is represented by null numerics and',
  'hasSlots/hasIncome booleans.',
].join(' ');

const mcpRoutes: FastifyPluginAsync<McpRoutesDeps> = async (
  app: FastifyInstance,
  opts: McpRoutesDeps,
) => {
  /**
   * Build a fresh `McpServer` + `StreamableHTTPServerTransport` for
   * EVERY request. The SDK docs explicitly call out this pattern for
   * stateless HTTP mode: the transport is "single-use" — its internal
   * pump caches the request/response handles on first invocation and
   * subsequent `handleRequest` calls hit a stuck state and 500.
   *
   * Original implementation cached one transport per pod, which
   * passed the local-docker smoke test (1 request) but blew up on
   * the second prod request. The ingress logs make the failure mode
   * obvious: the very first POST /mcp returns 200 with a real
   * payload, every subsequent request returns 500 with a 5-byte
   * body — no Fastify "incoming request" log because the SDK
   * resolves before reaching our route handler.
   *
   * Cost of per-request setup: one McpServer constructor + three
   * registerTool calls (~microseconds each, no I/O), plus the
   * transport instance. The tool handlers still close over the
   * shared `opts` repos so DB pool reuse is unaffected.
   */
  function buildServerForRequest(): {
    server: McpServer;
    transport: StreamableHTTPServerTransport;
  } {
    // The MCP `name` field is shown in Claude Desktop's MCP catalog
    // and used as the registry key in client configs. Lowercase ASCII
    // + hyphens to keep it stable + URL-safe across rebrands (e.g.
    // SITE_NAME='WhoEarns' → name='whoearns').
    const mcpName = opts.config.SITE_NAME.toLowerCase().replace(/[^a-z0-9]+/g, '-');
    const server = new McpServer(
      {
        name: mcpName,
        version: '1.0.0',
      },
      {
        capabilities: { tools: {} },
        instructions: [
          'This MCP server queries Solana mainnet validator data — slot production,',
          'block fees (base + priority), and on-chain Jito tips — indexed by',
          `${opts.config.SITE_NAME} at`,
          `${opts.config.SITE_URL}.`,
          'Three tools:',
          '  • get_current_epoch — returns the current epoch state (call first).',
          '  • get_leaderboard — top-N validators ranked by performance / income / etc.',
          '  • get_validator — per-epoch history for one validator (vote OR identity).',
          'Data is read-only. Closed-epoch numbers are final; running-epoch numbers',
          'grow until the epoch closes (~2 days). All lamport amounts are decimal',
          'strings — parse as BigInt to avoid precision loss.',
        ].join(' '),
      },
    );

    server.registerTool(
      'get_current_epoch',
      {
        title: 'Get current Solana epoch',
        description:
          'Returns the running epoch number, slot range, and elapsed slot count. Call this first to anchor any per-epoch question. ' +
          SHARED_TOOL_PROVENANCE_NOTE,
        inputSchema: {},
      },
      async () => {
        const epoch: EpochInfo | null = await opts.epochsRepo.findCurrent();
        // Derive slotsElapsed inline rather than reading it from EpochInfo
        // (which doesn't carry it). Null when the epoch watcher hasn't
        // reported a current_slot yet — same semantic the UI uses.
        const slotsElapsed =
          epoch === null || epoch.currentSlot === null
            ? null
            : Math.max(0, epoch.currentSlot - epoch.firstSlot);
        return {
          content: [
            {
              type: 'text',
              text: JSON.stringify(
                epoch === null
                  ? { available: false, reason: 'epoch watcher has not ticked yet' }
                  : {
                      epoch: epoch.epoch,
                      firstSlot: epoch.firstSlot,
                      lastSlot: epoch.lastSlot,
                      slotCount: epoch.slotCount,
                      currentSlot: epoch.currentSlot,
                      slotsElapsed,
                      isClosed: epoch.isClosed,
                      observedAt: epoch.observedAt.toISOString(),
                    },
                null,
                2,
              ),
            },
          ],
        };
      },
    );

    server.registerTool(
      'get_leaderboard',
      {
        title: 'Get top Solana validators',
        description:
          'Returns the top-N validators for the most recent CLOSED epoch, ranked by the chosen metric. ' +
          'sort=performance is stake-neutral (income per scheduled block) — best for "who runs their node well". ' +
          'sort=total_income biases toward big-stake validators (raw revenue). ' +
          'sort=income_per_stake is operator-side APR (NOT delegator yield — multiply by (1 - commission) for delegator). ' +
          'sort=skip_rate ranks by reliability (lower is better). ' +
          'sort=median_fee ranks by typical per-block fee capture. ' +
          SHARED_TOOL_PROVENANCE_NOTE,
        inputSchema: {
          sort: z
            .enum(['performance', 'total_income', 'income_per_stake', 'skip_rate', 'median_fee'])
            .optional()
            .describe('Ranking metric. Default: performance.'),
          limit: z
            .number()
            .int()
            .min(1)
            .max(100)
            .optional()
            .describe('How many rows to return (1-100). Default: 25.'),
        },
      },
      async (args) => {
        const sort = args.sort ?? 'performance';
        const limit = args.limit ?? 25;
        return {
          content: [
            {
              type: 'text',
              text: JSON.stringify(await buildLeaderboardPayload(opts, sort, limit), null, 2),
            },
          ],
        };
      },
    );

    server.registerTool(
      'get_validator',
      {
        title: 'Get validator income history',
        description:
          'Returns per-epoch income history for ONE validator. Pass either a vote pubkey OR an identity pubkey — both resolve to the same validator. Items are newest-first. ' +
          'Each item carries slotsAssigned/Produced/Skipped, blockBaseFeesTotalLamports, blockPriorityFeesTotalLamports, blockTipsTotalLamports, totalIncomeLamports, and the cluster median for the same epoch. ' +
          SHARED_TOOL_PROVENANCE_NOTE,
        inputSchema: {
          voteOrIdentity: z
            .string()
            .min(32)
            .max(44)
            .describe('Vote pubkey OR identity pubkey (base58, 32-44 chars).'),
          epochLimit: z
            .number()
            .int()
            .min(1)
            .max(50)
            .optional()
            .describe('How many recent epochs to return (1-50). Default: 10.'),
        },
      },
      async (args) => {
        const limit = args.epochLimit ?? 10;
        const result = await buildValidatorPayload(opts, args.voteOrIdentity, limit);
        return {
          content: [
            {
              type: 'text',
              text: JSON.stringify(result, null, 2),
            },
          ],
          isError: result.found === false,
        };
      },
    );

    // SDK option types declare `sessionIdGenerator: () => string` as
    // required, but the stateless-mode contract documented in the
    // README explicitly accepts `undefined`. Cast at the boundary
    // rather than fighting `exactOptionalPropertyTypes`. Verified by
    // running the SDK source — the stateless code path branches on
    // `sessionIdGenerator === undefined`.
    const transport = new StreamableHTTPServerTransport({
      sessionIdGenerator: undefined,
      enableJsonResponse: true,
    } as unknown as ConstructorParameters<typeof StreamableHTTPServerTransport>[0]);

    return { server, transport };
  }

  /**
   * Single handler for all three HTTP verbs the MCP transport
   * expects. POST handles JSON-RPC requests (tool calls); GET opens
   * an SSE stream for server-initiated messages; DELETE tears down
   * the (stateless) session — for stateless mode it's a no-op but
   * the transport still expects the route to exist so client SDKs
   * don't 404.
   *
   * Per-request fresh server + transport (see `buildServerForRequest`
   * docstring for why singleton-ing breaks). `connect` is awaited
   * before `handleRequest` so the tool catalog is registered when
   * the JSON-RPC dispatch lands. Cleanup on response close prevents
   * the per-request McpServer / transport pair from leaking; even
   * though they hold no DB handles directly, letting GC reclaim them
   * eagerly avoids steady-state memory growth at high RPS.
   */
  const handle = async (request: FastifyRequest, reply: FastifyReply): Promise<void> => {
    const { server, transport } = buildServerForRequest();
    reply.raw.on('close', () => {
      void transport.close();
      void server.close();
    });
    // SDK Transport interface declares `onclose: () => void` as
    // non-optional; the concrete StreamableHTTPServerTransport has
    // it as optional. Strict-mode-friendly cast — see top-of-file
    // comment on the same shape mismatch in the constructor options.
    await server.connect(transport as unknown as Parameters<typeof server.connect>[0]);
    // The SDK reads + writes via Node's IncomingMessage / ServerResponse.
    // Fastify exposes both as `request.raw` and `reply.raw`. We pass
    // the parsed body (Fastify already JSON-parsed it) so the
    // transport doesn't try to read the stream a second time.
    await transport.handleRequest(request.raw, reply.raw, request.body);
  };

  app.post('/mcp', handle);
  app.get('/mcp', handle);
  app.delete('/mcp', handle);
};

export default mcpRoutes;

// ────────────────────────────────────────────────────────────────────
// Tool-payload builders. Extracted as plain functions so the actual
// route-registration code reads as a tool catalog and the data-shape
// logic lives somewhere greppable.
// ────────────────────────────────────────────────────────────────────

interface LeaderboardPayloadRow {
  rank: number;
  vote: string;
  identity: string;
  name: string | null;
  slotsAssigned: number;
  slotsProduced: number;
  slotsSkipped: number;
  skipRate: number | null;
  blockFeesTotalLamports: string;
  blockTipsTotalLamports: string;
  totalIncomeLamports: string;
  performanceLamportsPerSlot: string | null;
  activatedStakeLamports: string | null;
  incomePerStake: number | null;
  claimed: boolean;
}

async function buildLeaderboardPayload(
  opts: McpRoutesDeps,
  sort: LeaderboardSort,
  limit: number,
): Promise<{
  epoch: number | null;
  epochClosedAt: string | null;
  sort: string;
  count: number;
  items: LeaderboardPayloadRow[];
  cluster: {
    topN: number;
    sampleValidators: number;
    medianBlockFeeLamports: string | null;
    medianBlockTipLamports: string | null;
  } | null;
}> {
  const epoch = await opts.epochsRepo.findCurrent();
  if (epoch === null) {
    return { epoch: null, epochClosedAt: null, sort, count: 0, items: [], cluster: null };
  }
  // Same closed-epoch-only rule the leaderboard route enforces:
  // never rank against the running epoch — its numbers grow.
  const targetEpoch = epoch.isClosed ? epoch.epoch : epoch.epoch - 1;
  if (targetEpoch < 0) {
    return { epoch: null, epochClosedAt: null, sort, count: 0, items: [], cluster: null };
  }

  const [statsRows, optedOut, aggregate] = await Promise.all([
    // We over-fetch by 50% then trim to `limit` after opt-out
    // filtering — keeps the result honest even if a couple of the
    // top validators have opted out. Cap at 200 to bound the
    // round-trip; the inevitable corner case of >200 opt-outs in
    // a row is nonexistent in practice.
    opts.statsRepo.findTopNByEpoch(targetEpoch, Math.min(200, Math.ceil(limit * 1.5)), sort),
    opts.profilesRepo.findOptedOutVotes(),
    // Top-100 sample matches the leaderboard route's choice — the
    // explorer treats 100 as the canonical "cluster benchmark" set.
    opts.aggregatesRepo.findByEpochTopN(targetEpoch, 100),
  ]);

  const filtered = statsRows.filter((r) => !optedOut.has(r.votePubkey));
  const trimmed = filtered.slice(0, limit);

  const identities = trimmed.map((r) => r.identityPubkey);
  const votes = trimmed.map((r) => r.votePubkey);
  const [infoMap, claimedSet] = await Promise.all([
    opts.validatorsRepo.getInfosByIdentities(identities),
    opts.claimsRepo.findClaimedVotes(votes),
  ]);

  const items: LeaderboardPayloadRow[] = trimmed.map((row, i) =>
    serializeLeaderboardRow(
      row,
      i + 1,
      infoMap.get(row.identityPubkey),
      claimedSet.has(row.votePubkey),
    ),
  );

  return {
    epoch: targetEpoch,
    epochClosedAt: epoch.isClosed ? epoch.observedAt.toISOString() : null,
    sort,
    count: items.length,
    items,
    cluster: aggregate === null ? null : serializeCluster(aggregate),
  };
}

function serializeLeaderboardRow(
  stats: EpochValidatorStats,
  rank: number,
  info: { name: string | null } | undefined,
  claimed: boolean,
): LeaderboardPayloadRow {
  const blockFees = stats.blockFeesTotalLamports;
  const blockTips = stats.blockTipsTotalLamports;
  const total = blockFees + blockTips;
  const skipRate = stats.slotsAssigned > 0 ? stats.slotsSkipped / stats.slotsAssigned : null;
  const stake = stats.activatedStakeLamports;
  const incomePerStake = stake !== null && stake > 0n ? Number(total) / Number(stake) : null;
  const performance = stats.slotsAssigned > 0 ? total / BigInt(stats.slotsAssigned) : null;
  return {
    rank,
    vote: stats.votePubkey,
    identity: stats.identityPubkey,
    name: info?.name ?? null,
    slotsAssigned: stats.slotsAssigned,
    slotsProduced: stats.slotsProduced,
    slotsSkipped: stats.slotsSkipped,
    skipRate,
    blockFeesTotalLamports: blockFees.toString(),
    blockTipsTotalLamports: blockTips.toString(),
    totalIncomeLamports: total.toString(),
    performanceLamportsPerSlot: performance === null ? null : performance.toString(),
    activatedStakeLamports: stake === null ? null : stake.toString(),
    incomePerStake,
    claimed,
  };
}

function serializeCluster(a: EpochAggregate): {
  topN: number;
  sampleValidators: number;
  medianBlockFeeLamports: string | null;
  medianBlockTipLamports: string | null;
} {
  return {
    topN: a.topN,
    sampleValidators: a.sampleValidators,
    medianBlockFeeLamports: a.medianFeeLamports === null ? null : a.medianFeeLamports.toString(),
    medianBlockTipLamports: a.medianTipLamports === null ? null : a.medianTipLamports.toString(),
  };
}

async function buildValidatorPayload(
  opts: McpRoutesDeps,
  voteOrIdentity: string,
  limit: number,
): Promise<
  | {
      found: false;
      reason: string;
    }
  | {
      found: true;
      vote: string;
      identity: string;
      name: string | null;
      iconUrl: string | null;
      website: string | null;
      claimed: boolean;
      profile: {
        twitterHandle: string | null;
        narrativeOverride: string | null;
      } | null;
      items: ValidatorHistoryItem[];
    }
> {
  // Try vote first, then identity — same dual-lookup pattern the
  // /income page uses. Operators rotate identities, but the vote
  // pubkey lives forever, so we query that first.
  let validator: Validator | null = await opts.validatorsRepo.findByVote(
    voteOrIdentity as VotePubkey,
  );
  if (validator === null) {
    validator = await opts.validatorsRepo.findByIdentity(voteOrIdentity as IdentityPubkey);
  }
  if (validator === null) {
    return { found: false, reason: `validator not found: ${voteOrIdentity}` };
  }

  const [history, profile, claimedSet] = await Promise.all([
    opts.statsRepo.findHistoryByVote(validator.votePubkey, limit),
    opts.profilesRepo.findByVote(validator.votePubkey),
    opts.claimsRepo.findClaimedVotes([validator.votePubkey]),
  ]);

  return {
    found: true,
    vote: validator.votePubkey,
    identity: validator.identityPubkey,
    name: validator.name,
    iconUrl: validator.iconUrl,
    website: validator.website,
    claimed: claimedSet.has(validator.votePubkey),
    profile:
      profile === null
        ? null
        : {
            twitterHandle: profile.twitterHandle,
            narrativeOverride: profile.narrativeOverride,
          },
    items: history.map(serializeHistoryItem),
  };
}

interface ValidatorHistoryItem {
  epoch: number;
  slotsAssigned: number;
  slotsProduced: number;
  slotsSkipped: number;
  skipRate: number | null;
  blockFeesTotalLamports: string;
  blockBaseFeesTotalLamports: string;
  blockPriorityFeesTotalLamports: string;
  blockTipsTotalLamports: string;
  totalIncomeLamports: string;
  activatedStakeLamports: string | null;
  slotsUpdatedAt: string | null;
  feesUpdatedAt: string | null;
}

function serializeHistoryItem(stats: EpochValidatorStats): ValidatorHistoryItem {
  const skipRate = stats.slotsAssigned > 0 ? stats.slotsSkipped / stats.slotsAssigned : null;
  return {
    epoch: stats.epoch,
    slotsAssigned: stats.slotsAssigned,
    slotsProduced: stats.slotsProduced,
    slotsSkipped: stats.slotsSkipped,
    skipRate,
    blockFeesTotalLamports: stats.blockFeesTotalLamports.toString(),
    blockBaseFeesTotalLamports: stats.blockBaseFeesTotalLamports.toString(),
    blockPriorityFeesTotalLamports: stats.blockPriorityFeesTotalLamports.toString(),
    blockTipsTotalLamports: stats.blockTipsTotalLamports.toString(),
    totalIncomeLamports: (stats.blockFeesTotalLamports + stats.blockTipsTotalLamports).toString(),
    activatedStakeLamports:
      stats.activatedStakeLamports === null ? null : stats.activatedStakeLamports.toString(),
    slotsUpdatedAt: stats.slotsUpdatedAt === null ? null : stats.slotsUpdatedAt.toISOString(),
    feesUpdatedAt: stats.feesUpdatedAt === null ? null : stats.feesUpdatedAt.toISOString(),
  };
}

// (no module-level state to reset between tests — server + transport
// are now per-request)
