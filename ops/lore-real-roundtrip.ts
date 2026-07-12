/**
 * Manual/staging check only. This is not run in CI because it requires a live loreserver.
 *
 * Locally, build and run lore-server/Dockerfile with local stores, make it reachable at
 * LORE_BASE, and set presigned_url_hmac_key to the same hex value as LORE_HMAC. See
 * https://epicgames.github.io/lore/how-to/deploy-local-lore-server/ for setup guidance.
 *
 * Run: LORE_HMAC=<key> bun run verify:lore:real
 */
import {
  mintLorePresignedUrl,
  putBackstageBytesToLore,
  requireLoreBackstageConfig,
} from '@yucp/shared/loreBackstageClient';

const BASE = process.env.LORE_BASE ?? 'http://localhost:41339';
const HMAC = process.env.LORE_HMAC;

if (!HMAC) {
  console.error('LORE_HMAC is required (loreserver presigned_url_hmac_key hex).');
  process.exit(1);
}

const cfg = requireLoreBackstageConfig({
  apiBaseUrl: BASE,
  presignHmacKey: HMAC,
  repoNamespaceSalt: 'roundtrip',
  accessClientId: 'unused',
  accessClientSecret: 'unused',
  timeoutMs: 20_000,
});
const repositoryId = '0123456789abcdef0123456789abcdef';
const bytes = new Uint8Array(4096);
for (let i = 0; i < bytes.length; i++) {
  bytes[i] = (i * 37 + 11) & 0xff;
}

const put = await putBackstageBytesToLore({ config: cfg, repositoryId, bytes });
const { url } = await mintLorePresignedUrl({
  config: cfg,
  repositoryId,
  address: put.address,
  contentType: 'application/octet-stream',
});
const res = await fetch(url);
if (res.status !== 200) {
  console.error(`FAIL: presigned GET ${res.status}`);
  process.exit(1);
}

const got = new Uint8Array(await res.arrayBuffer());
const ok = got.length === bytes.length && got.every((byte, index) => byte === bytes[index]);
console.log(
  ok ? 'PASS: real loreserver accepted our presigned URL, byte-exact.' : 'FAIL: not byte-exact'
);
process.exit(ok ? 0 : 1);
