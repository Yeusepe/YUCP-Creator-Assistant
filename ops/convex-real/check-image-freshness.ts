import { pinnedImageReference, SELF_HOSTED_CONVEX_IMAGES } from './image-pins';

const INSPECT_TIMEOUT_MS = 60_000;
const FORCE_KILL_GRACE_MS = 5_000;

type ImageToolsInspectOutput = {
  manifest?: {
    digest?: unknown;
  };
};

export function latestImageDigest(inspectOutput: string): string {
  const parsed = JSON.parse(inspectOutput) as ImageToolsInspectOutput;
  const digest = parsed.manifest?.digest;
  if (typeof digest !== 'string' || !/^sha256:[a-f0-9]{64}$/.test(digest)) {
    throw new Error('Docker image inspection did not return an immutable manifest digest');
  }
  return digest;
}

async function inspectLatestImage(repository: string): Promise<string> {
  // Docker Buildx imagetools inspect reference:
  // https://docs.docker.com/reference/cli/docker/buildx/imagetools/inspect/
  let timedOut = false;
  const proc = Bun.spawn(
    ['docker', 'buildx', 'imagetools', 'inspect', '--format', '{{json .}}', `${repository}:latest`],
    {
      stdout: 'pipe',
      stderr: 'pipe',
    }
  );
  const timeoutId = setTimeout(() => {
    timedOut = true;
    proc.kill('SIGTERM');
    setTimeout(() => proc.kill('SIGKILL'), FORCE_KILL_GRACE_MS).unref();
  }, INSPECT_TIMEOUT_MS);
  const [stdout, stderr, exitCode] = await Promise.all([
    new Response(proc.stdout).text(),
    new Response(proc.stderr).text(),
    proc.exited,
  ]);
  clearTimeout(timeoutId);

  if (timedOut) {
    throw new Error(`docker buildx imagetools inspect ${repository}:latest timed out`);
  }
  if (exitCode !== 0) {
    throw new Error(
      `docker buildx imagetools inspect ${repository}:latest failed with exit code ${exitCode}: ${stderr.trim() || 'no stderr output'}`
    );
  }
  return latestImageDigest(stdout);
}

async function main(): Promise<void> {
  let stale = false;
  for (const image of SELF_HOSTED_CONVEX_IMAGES) {
    const latestDigest = await inspectLatestImage(image.repository);
    if (latestDigest === image.digest) {
      console.log(`Self-hosted Convex ${image.name} image is current (${image.digest}).`);
      continue;
    }
    stale = true;
    console.error(
      `Self-hosted Convex ${image.name} image is stale: pinned ${pinnedImageReference(image)}, latest ${image.repository}@${latestDigest}. Bump both reviewed image pins deliberately.`
    );
  }
  if (stale) process.exitCode = 1;
}

if (import.meta.main) {
  main().catch((error) => {
    console.error(error instanceof Error ? error.message : error);
    process.exit(1);
  });
}
