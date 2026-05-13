import type { FastifyReply } from 'fastify';

export const HTML_CACHE_CONTROL = 'no-cache';
export const IMMUTABLE_ASSET_CACHE_CONTROL = 'public, max-age=31536000, immutable';
export const STATIC_ASSET_CACHE_CONTROL = 'public, max-age=86400';
export const PUBLIC_READ_CACHE_CONTROL =
  'public, max-age=60, s-maxage=60, stale-while-revalidate=300';
export const CLIENT_READ_CACHE_CONTROL = 'private, max-age=10';
export const NO_STORE_CACHE_CONTROL = 'no-store';

export function setPublicReadCache(reply: FastifyReply): void {
  reply.header('cache-control', PUBLIC_READ_CACHE_CONTROL);
}

export function setClientReadCache(reply: FastifyReply): void {
  reply.header('cache-control', CLIENT_READ_CACHE_CONTROL);
}

export function setNoStoreCache(reply: FastifyReply): void {
  reply.header('cache-control', NO_STORE_CACHE_CONTROL);
}
