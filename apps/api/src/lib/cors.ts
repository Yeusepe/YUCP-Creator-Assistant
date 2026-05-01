import { buildAllowedBrowserOrigins } from '@yucp/shared/authOrigins';

const LOCAL_DEVELOPMENT_BROWSER_ORIGINS = [
  'http://localhost:3000',
  'http://localhost:3001',
  'http://localhost:5173',
  'http://127.0.0.1:3000',
  'http://127.0.0.1:3001',
  'http://127.0.0.1:5173',
  'http://[::1]:3000',
  'http://[::1]:3001',
  'http://[::1]:5173',
];

const API_CORS_ALLOWED_HEADERS = [
  'Authorization',
  'Content-Type',
  'Traceparent',
  'traceparent',
  'Tracestate',
  'tracestate',
  'Baggage',
  'baggage',
  'X-YUCP-File-Name',
  'x-yucp-file-name',
];

export type ApiCorsHeaderInput = {
  allowedOrigins: ReadonlySet<string>;
  origin: string | null;
};

export type ApiAllowedCorsOriginInput = {
  frontendUrl: string;
  nodeEnv?: string;
  publicBaseUrl: string;
  siteUrl: string;
};

export function buildApiAllowedCorsOrigins(input: ApiAllowedCorsOriginInput): Set<string> {
  const origins = new Set(
    buildAllowedBrowserOrigins({
      siteUrl: input.siteUrl,
      frontendUrl: input.frontendUrl,
      additionalOrigins: [input.publicBaseUrl],
    })
  );

  if ((input.nodeEnv ?? 'development') !== 'production') {
    for (const origin of LOCAL_DEVELOPMENT_BROWSER_ORIGINS) {
      origins.add(origin);
    }
  }

  return origins;
}

export function buildApiCorsHeaders(input: ApiCorsHeaderInput): Record<string, string> {
  const corsHeaders: Record<string, string> = {};
  if (!input.origin || !input.allowedOrigins.has(input.origin)) {
    return corsHeaders;
  }

  corsHeaders['Access-Control-Allow-Origin'] = input.origin;
  corsHeaders['Access-Control-Allow-Credentials'] = 'true';
  corsHeaders['Access-Control-Allow-Methods'] = 'GET, POST, PATCH, DELETE, OPTIONS';
  corsHeaders['Access-Control-Allow-Headers'] = API_CORS_ALLOWED_HEADERS.join(', ');
  corsHeaders['Access-Control-Expose-Headers'] = 'X-Request-Id, X-Trace-Id';
  corsHeaders['Access-Control-Max-Age'] = '600';
  corsHeaders['Timing-Allow-Origin'] = input.origin;
  corsHeaders.Vary = 'Origin';
  return corsHeaders;
}
