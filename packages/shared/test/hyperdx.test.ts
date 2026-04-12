import { describe, expect, test } from 'bun:test';
import { applyNodeHyperdxDefaults, resolveHyperdxConfig } from '../src/hyperdx';

describe('hyperdx config helpers', () => {
  test('resolveHyperdxConfig uses local ClickStack endpoints but no fake API key', () => {
    expect(
      resolveHyperdxConfig({
        FRONTEND_URL: 'http://localhost:3000',
      })
    ).toEqual({
      apiKey: undefined,
      hasOtelAuth: false,
      appUrl: 'http://localhost:8080',
      otlpHttpUrl: 'http://localhost:4318',
      otlpGrpcUrl: 'localhost:4317',
      otelExporterEndpoint: 'http://localhost:4318',
      otelExporterHeaders: undefined,
      otelExporterProtocol: 'http/protobuf',
    });
  });

  test('applyNodeHyperdxDefaults preserves explicit env values', () => {
    const env: NodeJS.ProcessEnv = {
      HYPERDX_API_KEY: 'custom-key',
      HYPERDX_OTLP_HTTP_URL: 'https://collector.example.com',
      OTEL_SERVICE_NAME: 'already-set',
    };

    const resolved = applyNodeHyperdxDefaults(env, 'yucp-api');

    expect(resolved.apiKey).toBe('custom-key');
    expect(resolved.hasOtelAuth).toBe(true);
    expect(env.OTEL_SERVICE_NAME).toBe('already-set');
    expect(env.OTEL_EXPORTER_OTLP_ENDPOINT).toBe('https://collector.example.com');
    expect(env.OTEL_EXPORTER_OTLP_HEADERS).toBe('Authorization=custom-key');
    expect(env.OTEL_EXPORTER_OTLP_PROTOCOL).toBe('http/protobuf');
  });

  test('resolveHyperdxConfig preserves explicit OTEL headers without requiring HYPERDX_API_KEY', () => {
    expect(
      resolveHyperdxConfig({
        OTEL_EXPORTER_OTLP_ENDPOINT: 'https://collector.example.com',
        OTEL_EXPORTER_OTLP_HEADERS: 'Authorization=ingest-token',
      })
    ).toEqual({
      apiKey: undefined,
      hasOtelAuth: true,
      appUrl: 'http://localhost:8080',
      otlpHttpUrl: 'https://collector.example.com',
      otlpGrpcUrl: 'localhost:4317',
      otelExporterEndpoint: 'https://collector.example.com',
      otelExporterHeaders: 'Authorization=ingest-token',
      otelExporterProtocol: 'http/protobuf',
    });
  });
});
