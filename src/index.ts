import { Hono } from 'hono';
import { cors } from 'hono/cors';
import {
  SecureCrypto,
  createSuccessResponse,
  createErrorResponse,
  AppError,
  ERROR_CODES,
  StructuredLogger,
  DOMAINS,
  API_VERSION,
} from '@iron-island/shared';
import { SlidingWindowRateLimiter } from '@iron-island/security-core';
import { DatabaseClient, StatusRepository } from '@iron-island/database';

export interface Env {
  DB: D1Database;
  KV: KVNamespace;
}

const app = new Hono<{ Bindings: Env; Variables: { requestId: string } }>();
const logger = new StructuredLogger('API-Gateway');

// 1. 全域 Request ID 與日誌注入
app.use('*', async (c, next) => {
  const requestId = c.req.header('x-request-id') || `req_${SecureCrypto.uuid()}`;
  c.set('requestId', requestId);
  c.header('x-request-id', requestId);

  const start = Date.now();
  await next();
  const ms = Date.now() - start;

  logger.info(`HTTP ${c.req.method} ${c.req.path} [${c.res.status}] - ${ms}ms`, {
    requestId,
    ip: c.req.header('cf-connecting-ip'),
    userAgent: c.req.header('user-agent'),
  });
});

// 2. CORS 白名單處理
app.use(
  '*',
  cors({
    origin: (origin) => {
      if (!origin) return 'https://island.iron127.com';
      if (origin.endsWith('.iron127.com') || origin === 'http://localhost:3000' || origin === 'http://127.0.0.1:3000') {
        return origin;
      }
      return 'https://island.iron127.com';
    },
    allowMethods: ['GET', 'POST', 'PUT', 'DELETE', 'OPTIONS', 'PATCH'],
    allowHeaders: ['Content-Type', 'Authorization', 'x-request-id', 'x-reauth-token'],
    credentials: true,
  })
);

// 3. 全域速率限制 (Rate Limiting)
app.use('*', async (c, next) => {
  const ip = c.req.header('cf-connecting-ip') || '127.0.0.1';
  const limiter = new SlidingWindowRateLimiter(c.env.KV);
  const result = await limiter.checkRateLimit(`ip:${ip}`, 120, 60); // 每分鐘 120 次

  if (!result.allowed) {
    c.header('Retry-After', Math.ceil(result.resetTime - Date.now() / 1000).toString());
    return c.json(
      createErrorResponse('請求過於頻率，已觸發 IP 速率限制', ERROR_CODES.TOO_MANY_REQUESTS, c.get('requestId')),
      429
    );
  }

  await next();
});

// 4. 全域例外擷取 (Unified Error Handler)
app.onError((err, c) => {
  const requestId = c.get('requestId') || 'unknown';
  if (err instanceof AppError) {
    return c.json(createErrorResponse(err.message, err.code, requestId, err.details), err.statusCode as any);
  }

  logger.error('未捕捉的系統異常', err, { requestId });
  return c.json(createErrorResponse('伺服器內部錯誤', ERROR_CODES.INTERNAL_ERROR, requestId), 500);
});

// 5. 健康檢查 (Health Check)
app.get('/health', async (c) => {
  const dbClient = new DatabaseClient(c.env.DB);
  let dbStatus = 'HEALTHY';
  try {
    await dbClient.queryFirst('SELECT 1');
  } catch {
    dbStatus = 'UNHEALTHY';
  }

  return c.json(
    createSuccessResponse(
      {
        service: 'API Gateway',
        status: dbStatus === 'HEALTHY' ? 'OPERATIONAL' : 'DEGRADED',
        version: API_VERSION,
        database: dbStatus,
        timestamp: new Date().toISOString(),
      },
      c.get('requestId')
    )
  );
});

// 6. 服務狀態查詢 (Service Status Endpoint)
app.get('/v1/status', async (c) => {
  const dbClient = new DatabaseClient(c.env.DB);
  const statusRepo = new StatusRepository(dbClient);
  const incidents = await statusRepo.listRecentIncidents();

  const services = [
    { id: 'api', name: 'API Gateway', domain: DOMAINS.SERVICES.API, status: 'OPERATIONAL' },
    { id: 'auth', name: 'Auth Service', domain: DOMAINS.SERVICES.AUTH, status: 'OPERATIONAL' },
    { id: 'account', name: 'Account Service', domain: DOMAINS.SERVICES.ACCOUNT, status: 'OPERATIONAL' },
    { id: 'update', name: 'Update Service', domain: DOMAINS.SERVICES.UPDATE, status: 'OPERATIONAL' },
    { id: 'plugins', name: 'Plugin Store', domain: DOMAINS.SERVICES.PLUGINS, status: 'OPERATIONAL' },
    { id: 'developer', name: 'Developer Center', domain: DOMAINS.SERVICES.DEVELOPER, status: 'OPERATIONAL' },
    { id: 'download', name: 'Download Center', domain: DOMAINS.SERVICES.DOWNLOAD, status: 'OPERATIONAL' },
    { id: 'security', name: 'Security Center', domain: DOMAINS.SERVICES.SECURITY, status: 'OPERATIONAL' },
  ];

  return c.json(
    createSuccessResponse(
      {
        overallStatus: incidents.some((i) => i.status !== 'RESOLVED') ? 'DEGRADED' : 'OPERATIONAL',
        services,
        recentIncidents: incidents,
      },
      c.get('requestId')
    )
  );
});

// 7. API Version Route Redirect Notice
app.get('/', (c) => {
  return c.json(
    createSuccessResponse(
      {
        name: 'Iron Island Cloud API Gateway',
        docsUrl: `https://${DOMAINS.SERVICES.DOCS}`,
        apiVersion: API_VERSION,
        endpointPrefix: `/v1`,
      },
      c.get('requestId')
    )
  );
});

export default app;
