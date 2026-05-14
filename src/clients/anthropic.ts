import type { Logger } from '../core/logger.js';

/**
 * Minimal Anthropic Messages API client. Single endpoint
 * (`POST /v1/messages`) with a constrained interface — the Phase 5
 * curation pipeline is the only consumer today, and it always uses
 * the same model + temperature + max_tokens. Keeping the surface
 * tiny reduces test burden and keeps the upstream-dependency well-
 * scoped (no SDK lock-in).
 *
 * Larger Anthropic features (tool use, streaming, citations) are
 * intentionally NOT supported — when we need them, we re-evaluate
 * between this thin client and `@anthropic-ai/sdk`.
 */

export interface AnthropicClientOptions {
  apiKey: string;
  /** Defaults to `https://api.anthropic.com/v1/messages`. */
  endpointUrl?: string;
  /** Defaults to `claude-sonnet-4-6`. */
  defaultModel?: string;
  /** Total per-call timeout in ms; default 30 s. */
  timeoutMs?: number;
  logger: Logger;
  /** Override for unit tests. */
  fetcher?: typeof fetch;
}

export interface AnthropicMessage {
  role: 'user' | 'assistant';
  content: string;
}

export interface AnthropicMessagesRequest {
  /** Override the default model for this call only. */
  model?: string;
  system?: string;
  messages: AnthropicMessage[];
  /** Hard cap on tokens emitted; default 1024. */
  maxTokens?: number;
  /** 0-1, default 0.2 (we want low-variance summaries). */
  temperature?: number;
}

export interface AnthropicMessagesResponse {
  /** Plain-text content concatenation of all returned blocks. */
  text: string;
  stopReason: string | null;
  inputTokens: number;
  outputTokens: number;
}

const DEFAULT_ENDPOINT = 'https://api.anthropic.com/v1/messages';
const DEFAULT_MODEL = 'claude-sonnet-4-6';
const DEFAULT_MAX_TOKENS = 1024;
const DEFAULT_TEMPERATURE = 0.2;
const DEFAULT_TIMEOUT_MS = 30_000;
const ANTHROPIC_API_VERSION = '2023-06-01';

/**
 * HTTP statuses we retry exactly once: `429` (rate-limited) plus
 * `503`/`529` (Anthropic's "overloaded" responses). One rate-limit
 * hiccup shouldn't lose a whole curation batch; capping at a single
 * retry keeps the error semantics simple — a second failure is a
 * plain throw, same as a non-retryable status.
 */
const RETRYABLE_STATUSES = new Set([429, 503, 529]);

/**
 * Ceiling on how long we honour a `retry-after` before a retry. The
 * curation worker tick runs on its own schedule, so sleeping minutes
 * inside a single call is worse than failing fast and picking the
 * row up next tick.
 */
const MAX_RETRY_AFTER_MS = 10_000;

/**
 * Fallback sleep when a retryable response carries no usable
 * `retry-after` header.
 */
const DEFAULT_RETRY_SLEEP_MS = 1_000;

/**
 * Best-effort parser for the `retry-after` header. Servers send it as
 * either delta-seconds (`"5"`) or an HTTP-date; returns milliseconds
 * or `undefined` when it can't be made sense of.
 */
function parseRetryAfterMs(header: string | null): number | undefined {
  if (header === null) return undefined;
  const trimmed = header.trim();
  if (trimmed === '') return undefined;
  if (/^\d+(\.\d+)?$/.test(trimmed)) {
    const seconds = Number(trimmed);
    if (Number.isFinite(seconds) && seconds >= 0) return Math.round(seconds * 1000);
    return undefined;
  }
  const epochMs = Date.parse(trimmed);
  if (!Number.isNaN(epochMs)) {
    const diff = epochMs - Date.now();
    return diff > 0 ? diff : 0;
  }
  return undefined;
}

function sleep(ms: number): Promise<void> {
  return new Promise((resolve) => setTimeout(resolve, ms));
}

interface AnthropicRawTextBlock {
  type: 'text';
  text: string;
}
interface AnthropicRawResponse {
  content?: Array<AnthropicRawTextBlock | { type: string }>;
  stop_reason?: string;
  usage?: { input_tokens?: number; output_tokens?: number };
  error?: { type: string; message: string };
}

export class AnthropicClient {
  private readonly apiKey: string;
  private readonly endpointUrl: string;
  private readonly defaultModel: string;
  private readonly timeoutMs: number;
  private readonly logger: Logger;
  private readonly fetcher: typeof fetch;

  constructor(opts: AnthropicClientOptions) {
    this.apiKey = opts.apiKey;
    this.endpointUrl = opts.endpointUrl ?? DEFAULT_ENDPOINT;
    this.defaultModel = opts.defaultModel ?? DEFAULT_MODEL;
    this.timeoutMs = opts.timeoutMs ?? DEFAULT_TIMEOUT_MS;
    this.logger = opts.logger;
    this.fetcher = opts.fetcher ?? fetch;
  }

  async messages(req: AnthropicMessagesRequest): Promise<AnthropicMessagesResponse> {
    const body = {
      model: req.model ?? this.defaultModel,
      max_tokens: req.maxTokens ?? DEFAULT_MAX_TOKENS,
      temperature: req.temperature ?? DEFAULT_TEMPERATURE,
      ...(req.system !== undefined ? { system: req.system } : {}),
      messages: req.messages,
    };
    const payload = JSON.stringify(body);

    // Attempt 0 is the initial request; attempt 1 is the single retry
    // we allow on a retryable status (429 / 503 / 529). Anything past
    // that throws — keeping the error path identical to a hard 4xx.
    for (let attempt = 0; ; attempt += 1) {
      const response = await this.fetcher(this.endpointUrl, {
        method: 'POST',
        headers: {
          'content-type': 'application/json',
          'x-api-key': this.apiKey,
          'anthropic-version': ANTHROPIC_API_VERSION,
        },
        body: payload,
        signal: AbortSignal.timeout(this.timeoutMs),
      });

      if (!response.ok) {
        if (RETRYABLE_STATUSES.has(response.status) && attempt === 0) {
          const retryAfterMs = parseRetryAfterMs(response.headers.get('retry-after'));
          const sleepMs = Math.min(retryAfterMs ?? DEFAULT_RETRY_SLEEP_MS, MAX_RETRY_AFTER_MS);
          this.logger.warn(
            { status: response.status, retryAfterMs, sleepMs },
            'anthropic: retryable status — sleeping then retrying once',
          );
          await sleep(sleepMs);
          continue;
        }
        const detail = await response.text().catch(() => '');
        throw new Error(`anthropic: HTTP ${response.status} ${detail.slice(0, 200)}`);
      }

      const json = (await response.json()) as AnthropicRawResponse;
      if (json.error !== undefined) {
        throw new Error(`anthropic: ${json.error.type}: ${json.error.message}`);
      }
      const text = (json.content ?? [])
        .filter((b): b is AnthropicRawTextBlock => b.type === 'text')
        .map((b) => b.text)
        .join('');
      return {
        text,
        stopReason: json.stop_reason ?? null,
        inputTokens: json.usage?.input_tokens ?? 0,
        outputTokens: json.usage?.output_tokens ?? 0,
      };
    }
  }
}
