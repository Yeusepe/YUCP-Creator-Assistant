import { describe, expect, test } from 'bun:test';
import { applyNodeHyperdxDefaults, resolveHyperdxConfig } from '../src/hyperdx';

describe('hyperdx config helpers', () => {
  test('resolveHyperdxConfig falls back to local ClickStack defaults', () => {
    expect(resolveHyperdxConfig({}, { allowLocalFallbackApiKey: true })).toEqual({
      apiKey: 'local',
      appUrl: 'http://localhost:8080',
      otlpHttpUrl: 'http://localhost:4318',
      otlpGrpcUrl: 'localhost:4317',
      otelExporterEndpoint: 'http://localhost:4318',
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
    expect(env.OTEL_SERVICE_NAME).toBe('already-set');
    expect(env.OTEL_EXPORTER_OTLP_ENDPOINT).toBe('https://collector.example.com');
    expect(env.OTEL_EXPORTER_OTLP_PROTOCOL).toBe('http/protobuf');
  });
});
