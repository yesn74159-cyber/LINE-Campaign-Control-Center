import type { FastifyInstance } from 'fastify';

export type FixedWindowLimiter = { take(key: string, now?: number): boolean; reset(key: string): void };

export function createFixedWindowLimiter(limit: number, windowMs: number): FixedWindowLimiter {
  const buckets = new Map<string, { count: number; resetAt: number }>();
  return {
    take(key, now = Date.now()) {
      if (buckets.size > 5000) for (const [bucketKey, bucket] of buckets) if (bucket.resetAt <= now) buckets.delete(bucketKey);
      const bucket = buckets.get(key);
      if (!bucket || bucket.resetAt <= now) { buckets.set(key, { count: 1, resetAt: now + windowMs }); return true; }
      if (bucket.count >= limit) return false;
      bucket.count += 1;
      return true;
    },
    reset(key) { buckets.delete(key); }
  };
}

export function registerBaselineSecurity(app: FastifyInstance, allowedOrigins: string[]) {
  const allowed = new Set(allowedOrigins.map((origin) => {
    try { return new URL(origin).origin; } catch { return ''; }
  }).filter(Boolean));
  app.addHook('onRequest', async (request, reply) => {
    reply.header('x-request-id', request.id);
    if (['GET', 'HEAD', 'OPTIONS'].includes(request.method)) return;
    const origin = request.headers.origin;
    if (!origin) return;
    let normalized = '';
    try { normalized = new URL(origin).origin; } catch { return reply.code(403).send({ error: 'request origin is not allowed' }); }
    if (!allowed.has(normalized)) return reply.code(403).send({ error: 'request origin is not allowed' });
  });
  app.addHook('onSend', async (request, reply, payload) => {
    reply.header('x-content-type-options', 'nosniff');
    reply.header('x-frame-options', 'DENY');
    reply.header('referrer-policy', 'no-referrer');
    reply.header('cross-origin-resource-policy', 'same-origin');
    reply.header('permissions-policy', 'camera=(), microphone=(), geolocation=()');
    if (request.url.startsWith('/api/')) reply.header('cache-control', 'no-store');
    return payload;
  });
  app.setErrorHandler((rawError, request, reply) => {
    const error = rawError as { statusCode?: number; message?: string };
    const statusCode = typeof error.statusCode === 'number' && error.statusCode >= 400 && error.statusCode < 500 ? error.statusCode : 500;
    if (statusCode >= 500) return reply.code(500).send({ error: 'internal server error', requestId: request.id });
    return reply.code(statusCode).send({ error: error.message || 'request failed', requestId: request.id });
  });
}
