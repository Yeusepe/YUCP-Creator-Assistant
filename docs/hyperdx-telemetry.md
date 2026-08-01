# HyperDX telemetry operations

The application emits redacted operational failures without optional consent. Helpful diagnostics enables HyperDX browser instrumentation, masked replay, console and action capture, Web Vitals, network metadata, and user-associated correlation.

## Required deployment configuration

Set these server-side values in Infisical or the deployment secret store:

- `HYPERDX_API_KEY`: browser ingest key. Expose it only through the existing public runtime configuration path.
- `HYPERDX_SERVICE_KEY`: optional server-side HyperDX API access key (Team Settings, not the ingest key) used by the source-map upload step. Self-hosted ClickStack has no sourcemap endpoint, so this only applies to HyperDX Cloud. Never put it in browser configuration.
- `HYPERDX_API_URL`: HyperDX OTLP base URL when using a self-hosted or non-default endpoint.
- `CONVEX_LOG_STREAM_SECRET`: shared secret for the secured Convex log-stream webhook.

The web deployment runs `@hyperdx/cli upload-sourcemaps` with the build release ID and fails when the upload fails. Without `HYPERDX_SERVICE_KEY` the upload is skipped and browser stack traces stay minified. Hidden production source maps are generated under `apps/web/dist` and are stripped before deploy either way, so they are never served as public assets.

## Cloudflare destinations

Create these HyperDX-backed destinations in the Cloudflare dashboard, then associate them with the destination names in the worker Wrangler files:

- `hyperdx-yucp-web-logs` and `hyperdx-yucp-web-traces`
- `hyperdx-yucp-delivery-logs` and `hyperdx-yucp-delivery-traces`
- `hyperdx-yucp-materialization-logs` and `hyperdx-yucp-materialization-traces`
- `hyperdx-yucp-rendition-logs` and `hyperdx-yucp-rendition-traces`

Production trace sampling is configured at 100%. Cloudflare native export currently covers logs and traces, so application metrics remain on the Bun/OpenTelemetry path to avoid duplicate metrics.

## Convex log stream

Configure the Convex log stream webhook to:

```text
POST https://<api-host>/api/telemetry/convex
Authorization: Bearer <CONVEX_LOG_STREAM_SECRET>
Content-Type: application/json
```

The endpoint rejects missing or invalid authentication and payloads larger than 1 MiB. It redacts before logging and preserves only operational metadata such as function name, deployment, severity, timestamp, and correlation fields.

## Recommended saved views

Create saved HyperDX views using these dimensions:

1. Browser crashes: `service.name = yucp-web`, grouped by `release.id`, route, and exception fingerprint.
2. React and route failures: browser exceptions containing `componentStack`, `route-error`, or `loader`.
3. First-party request failures: actions named `api.request.failed` or `first-party.request.failed`, grouped by route and status.
4. Slow requests: actions with `durationMs` above the agreed threshold, grouped by operation and release.
5. Consent-enabled sessions: browser events with `diagnosticsEnabled = true`, joined by `diagnostics.session.id` and trace ID.
6. Backend failures: service names for API, workers, Bun services, and Convex ingestion, grouped by `app.operation`, `request.id`, and `release.id`.
7. Native installer failures: `telemetry.source = native`, grouped by `native.service.name`, `native.process`, `native.operation`, `native.phase`, `native.error.code`, `run.id`, and trace ID.
8. Installer 500s: API package-install spans with HTTP status 500 joined to `native.lifecycle.failed` by trace ID, run ID, and diagnostics session ID.

## Native installer telemetry

The Windows package broker and lifecycle process use the signed `InstallSessionV2.diagnostics` claim as the consent bridge. The API adds that claim only after the browser accepts Helpful diagnostics and only for a native client that requests the `install-session-diagnostics` capability. A session without that claim produces no native telemetry request.

After the claim is verified, the broker emits `native.lifecycle.started`, deduplicated lifecycle phase events, and either `native.lifecycle.completed` or `native.lifecycle.failed` to:

```text
POST https://<api-host>/api/telemetry/native
X-YUCP-Diagnostics-Session: <consented UUID>
traceparent: <same W3C trace context as the package operation>
```

The native client is keyless. HyperDX credentials remain server-side, and the API places the event on the request span extracted from `traceparent`. Search by `trace.id` to connect the browser or installer request, package authorization and renewal calls, API failures, native phases, and the final result. Use `runId` to distinguish retries within the same trace and `diagnostics.session.id` to correlate only consented diagnostics.

The API re-checks the diagnostics-session consent in Convex for every native event. Withdrawing Helpful diagnostics therefore returns `403` to subsequent native telemetry immediately, even if a previously issued install session has not expired.

Native payloads are limited to service/process, operation, phase, status, duration, stable error code, release, OS, architecture, run ID, and a redacted error message. They do not contain cookies, authorization values, package tokens, signed grants, request or response bodies, project paths, or file contents. Telemetry delivery is best effort and cannot change the install result.

Do not add request bodies, response bodies, authorization headers, cookies, file contents, or token-like query values to any view or alert.

References: [HyperDX Browser SDK](https://www.hyperdx.io/docs/install/browser), [HyperDX Node SDK](https://www.hyperdx.io/docs/install/javascript), [OpenTelemetry error recording](https://opentelemetry.io/docs/specs/semconv/general/recording-errors/), [HyperDX source-map CLI](https://www.npmjs.com/package/%40hyperdx/cli), [Cloudflare OpenTelemetry export](https://developers.cloudflare.com/workers/observability/exporting-opentelemetry-data/), and [Convex log streams](https://docs.convex.dev/production/integrations/log-streams).
