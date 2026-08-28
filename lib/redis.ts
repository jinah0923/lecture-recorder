import Redis from "ioredis";

// The project's actual connected storage is a Vercel Marketplace Redis
// integration (a plain REDIS_URL connection string), not the older Vercel
// KV product (@vercel/kv, which expects KV_REST_API_URL/KV_REST_API_TOKEN
// and is itself deprecated in favor of this) — so a standard Redis client
// talking to REDIS_URL is what actually matches what's provisioned.
//
// Cached on `global` so a warm serverless instance reuses one TCP
// connection across requests instead of opening a fresh one every call.
declare global {
  // eslint-disable-next-line no-var
  var __redisClient: Redis | undefined;
}

export function isRedisConfigured(): boolean {
  return Boolean(process.env.REDIS_URL);
}

export function getRedisClient(): Redis | null {
  const url = process.env.REDIS_URL;
  if (!url) return null;
  if (!global.__redisClient) {
    global.__redisClient = new Redis(url, { maxRetriesPerRequest: 2 });
  }
  return global.__redisClient;
}
