import { createHash, randomUUID } from 'node:crypto';
import { createReadStream } from 'node:fs';
import { mkdtemp, rm, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { fetchInfisicalSecrets } from '@yucp/shared/infisical/fetchSecrets';
import { type CasConfig, loadCasConfig } from './config';
import { reconstructArtifactFromStore, s3CasStore, storeArtifactToStore } from './desyncCas';
import { deleteS3Objects, listS3Objects } from './s3Control';

type SmokeCounts = {
  objectsDeleted: number;
  objectsRemaining: number;
  objectsStored: number;
};

async function sha256File(filePath: string): Promise<string> {
  const hash = createHash('sha256');
  for await (const chunk of createReadStream(filePath)) {
    hash.update(chunk);
  }
  return hash.digest('hex');
}

function printResult(result: 'PASS' | 'FAIL', counts: SmokeCounts): void {
  console.log(
    `${result} objectsStored=${counts.objectsStored} objectsDeleted=${counts.objectsDeleted} objectsRemaining=${counts.objectsRemaining}`
  );
}

async function hydrateSmokeEnvironment(): Promise<NodeJS.ProcessEnv> {
  const environment = process.env.INFISICAL_ENV?.trim();
  if (!environment) {
    throw new Error('Missing required environment variable: INFISICAL_ENV');
  }
  const env: NodeJS.ProcessEnv = { ...process.env, INFISICAL_ENV: environment };
  const secrets = await fetchInfisicalSecrets(env);
  for (const [key, value] of Object.entries(secrets)) {
    if (!env[key]?.trim()) {
      env[key] = value;
    }
  }
  return env;
}

async function runSmoke(): Promise<void> {
  const counts: SmokeCounts = { objectsDeleted: 0, objectsRemaining: 0, objectsStored: 0 };
  let smokeConfig: CasConfig | undefined;
  let smokePrefix: string | undefined;
  let scratchPath: string | undefined;
  let passed = false;

  try {
    const env = await hydrateSmokeEnvironment();
    const baseConfig = loadCasConfig(env);
    smokePrefix = `smoke/${randomUUID()}/`;
    smokeConfig = {
      ...baseConfig,
      chunkPrefix: `${smokePrefix}chunks/`,
      indexPrefix: `${smokePrefix}indexes/`,
    };
    const store = s3CasStore(smokeConfig);
    scratchPath = await mkdtemp(join(tmpdir(), 'yucp-cas-b2-smoke-'));
    const artifactPath = join(scratchPath, 'artifact.bin');
    const reconstructedPath = join(scratchPath, 'reconstructed.bin');
    await writeFile(artifactPath, Buffer.from('YUCP desync CAS B2 smoke\n'.repeat(4096)));

    await storeArtifactToStore({ artifactPath, indexId: 'artifact.caibx', store });
    const storedObjects = await listS3Objects(smokeConfig, smokePrefix);
    counts.objectsStored = storedObjects.length;
    if (counts.objectsStored === 0) {
      throw new Error('The smoke prefix contains no objects after storage');
    }

    await reconstructArtifactFromStore({
      indexId: 'artifact.caibx',
      outputPath: reconstructedPath,
      store,
    });
    if ((await sha256File(artifactPath)) !== (await sha256File(reconstructedPath))) {
      throw new Error('The reconstructed smoke artifact did not match byte-exactly');
    }
    passed = true;
  } catch {
    passed = false;
  } finally {
    if (smokeConfig && smokePrefix) {
      try {
        const objects = await listS3Objects(smokeConfig, smokePrefix);
        counts.objectsDeleted = await deleteS3Objects(
          smokeConfig,
          objects.map((object) => object.key)
        );
        counts.objectsRemaining = (await listS3Objects(smokeConfig, smokePrefix)).length;
      } catch {
        passed = false;
      }
    }
    if (scratchPath) {
      try {
        await rm(scratchPath, { force: true, recursive: true });
      } catch {
        passed = false;
      }
    }
    if (counts.objectsRemaining !== 0 || counts.objectsDeleted !== counts.objectsStored) {
      passed = false;
    }
    printResult(passed ? 'PASS' : 'FAIL', counts);
  }

  if (!passed) {
    process.exitCode = 1;
  }
}

await runSmoke();
