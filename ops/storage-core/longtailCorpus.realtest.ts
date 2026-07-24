import { afterAll, beforeAll, describe, expect, test } from 'bun:test';
import { createHash } from 'node:crypto';
import { mkdtemp, readFile, rm, stat, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join, relative, resolve } from 'node:path';
import { measureDirectory, sha256File } from './desyncPackingTestSupport';
import {
  discoverPackageCorpusCases,
  listPackageCorpusFiles,
  materializePackageCorpusCase,
  type PackageCorpusLogicalVersion,
} from './packageCorpusEvaluation';
import { runCommand } from './process';

const TARGET_CHUNK_BYTES = 256 * 1024;
const TARGET_BLOCK_BYTES = 64 * 1024 * 1024;
const MINIMUM_COST_REDUCTION_PERCENT = 15;

type MeasuredCommand = {
  elapsedMs: number;
  peakMemoryBytes: number;
};

function parsePeakMemory(output: string): number {
  const match = output.match(/peak_mem:\s+[^\r\n]*\((\d+)\)/);
  if (!match?.[1]) {
    throw new Error('Longtail did not report peak memory');
  }
  return Number(match[1]);
}

async function runMeasuredLongtail(executable: string, args: string[]): Promise<MeasuredCommand> {
  const startedAt = performance.now();
  const result = await runCommand(executable, [...args, '--mem-tracer', '--log-level', 'warn']);
  return {
    elapsedMs: Math.round(performance.now() - startedAt),
    peakMemoryBytes: parsePeakMemory(`${result.stdout}\n${result.stderr}`),
  };
}

async function logicalTreeDigest(rootPath: string): Promise<string> {
  const files = await listPackageCorpusFiles(rootPath);
  const entries = await Promise.all(
    files.map(async (filePath) => ({
      path: relative(rootPath, filePath).replaceAll('\\', '/'),
      sha256: await sha256File(filePath),
    }))
  );
  return createHash('sha256')
    .update(JSON.stringify(entries.sort((left, right) => left.path.localeCompare(right.path))))
    .digest('hex');
}

async function versionBytes(version: PackageCorpusLogicalVersion): Promise<number> {
  const measurements = await Promise.all(version.files.map((file) => stat(file.path)));
  return measurements.reduce((total, measurement) => total + measurement.size, 0);
}

function percentile95(values: number[]): number {
  if (values.length === 0) {
    throw new Error('Cannot calculate a percentile without values');
  }
  const sorted = [...values].sort((left, right) => left - right);
  return sorted[Math.ceil(sorted.length * 0.95) - 1] ?? sorted[sorted.length - 1];
}

describe('real Longtail package corpus evaluation', () => {
  let scratchPath: string;

  beforeAll(async () => {
    scratchPath = await mkdtemp(join(tmpdir(), 'yucp-longtail-corpus-'));
  });

  afterAll(async () => {
    if (scratchPath && process.env.YUCP_STORAGE_KEEP_SCRATCH !== 'true') {
      await rm(scratchPath, { force: true, recursive: true });
    }
  });

  test(
    'measures physical cost and verifies exact logical-tree reconstruction',
    async () => {
      const executable = process.env.YUCP_LONGTAIL_PATH?.trim();
      const corpusPath = process.env.YUCP_STORAGE_CORPUS_DIR?.trim();
      const desyncResultsPath = process.env.YUCP_STORAGE_FILE_PROFILE_RESULTS_PATH?.trim();
      if (!executable || !corpusPath || !desyncResultsPath) {
        throw new Error(
          'YUCP_LONGTAIL_PATH, YUCP_STORAGE_CORPUS_DIR, and ' +
            'YUCP_STORAGE_FILE_PROFILE_RESULTS_PATH are required'
        );
      }

      const corpusCases = await discoverPackageCorpusCases(corpusPath);
      if (corpusCases.length === 0) {
        throw new Error('No multi-version package sequences matched the Longtail corpus');
      }

      const storePath = join(scratchPath, 'store');
      const indexesPath = join(scratchPath, 'indexes');
      const versions: Array<{
        addedStoreBytes: number;
        downsync: MeasuredCommand;
        format: string;
        inputBytes: number;
        name: string;
        upsync: MeasuredCommand;
        versionIndex: number;
      }> = [];
      let priorStoreBytes = 0;

      for (const [caseIndex, corpusCase] of corpusCases.entries()) {
        const logicalCaseRoot = join(
          scratchPath,
          'logical',
          `case-${caseIndex.toString().padStart(3, '0')}`
        );
        const logicalVersions = await materializePackageCorpusCase(corpusCase, logicalCaseRoot);
        for (const [versionIndex, version] of logicalVersions.entries()) {
          const sourceRoot = join(logicalCaseRoot, `v${versionIndex}`);
          const indexPath = join(
            indexesPath,
            `case-${caseIndex.toString().padStart(3, '0')}-v${versionIndex}.lvi`
          );
          const upsync = await runMeasuredLongtail(executable, [
            'upsync',
            '--storage-uri',
            storePath,
            '--source-path',
            sourceRoot,
            '--target-path',
            indexPath,
            '--target-chunk-size',
            String(TARGET_CHUNK_BYTES),
            '--target-block-size',
            String(TARGET_BLOCK_BYTES),
            '--max-chunks-per-block',
            '1024',
            '--compression-algorithm',
            'none',
            '--hash-algorithm',
            'blake3',
          ]);
          const storeMeasurement = await measureDirectory(storePath);
          const reconstructedPath = join(
            scratchPath,
            'reconstructed',
            `case-${caseIndex.toString().padStart(3, '0')}-v${versionIndex}`
          );
          const downsync = await runMeasuredLongtail(executable, [
            'downsync',
            '--storage-uri',
            storePath,
            '--source-path',
            indexPath,
            '--target-path',
            reconstructedPath,
            '--no-retain-permissions',
          ]);
          expect(await logicalTreeDigest(reconstructedPath)).toBe(
            await logicalTreeDigest(sourceRoot)
          );
          versions.push({
            addedStoreBytes: storeMeasurement.bytes - priorStoreBytes,
            downsync,
            format: corpusCase.format,
            inputBytes: await versionBytes(version),
            name: corpusCase.name,
            upsync,
            versionIndex,
          });
          priorStoreBytes = storeMeasurement.bytes;
        }
      }

      const storeMeasurement = await measureDirectory(storePath);
      const indexMeasurement = await measureDirectory(indexesPath);
      const desyncResults = JSON.parse(await readFile(desyncResultsPath, 'utf8')) as Array<{
        indexBytes: number;
        profile: string;
        storeBytes: number;
      }>;
      const desync = desyncResults.find((result) => result.profile === '64:256:1024');
      if (!desync) {
        throw new Error('The selected desync profile result is missing');
      }
      const longtailPhysicalBytes = storeMeasurement.bytes + indexMeasurement.bytes;
      const desyncPhysicalBytes = desync.storeBytes + desync.indexBytes;
      const costReductionPercent =
        ((desyncPhysicalBytes - longtailPhysicalBytes) / desyncPhysicalBytes) * 100;
      const rejectionReasons = [
        ...(costReductionPercent < MINIMUM_COST_REDUCTION_PERCENT
          ? [
              `Physical byte reduction is ${costReductionPercent.toFixed(2)} percent. ` +
                `${MINIMUM_COST_REDUCTION_PERCENT} percent is required.`,
            ]
          : []),
        'Longtail does not keep each small file as one exact content-addressed object.',
      ];
      const result = {
        adoptionDecision: rejectionReasons.length === 0 ? 'eligible' : 'reject',
        coldInstallP95Ms: percentile95(versions.map((version) => version.downsync.elapsedMs)),
        costReductionPercent,
        desyncPhysicalBytes,
        exactReconstruction: true,
        indexBytes: indexMeasurement.bytes,
        indexObjects: indexMeasurement.files,
        inputBytes: versions.reduce((total, version) => total + version.inputBytes, 0),
        longtailPhysicalBytes,
        maxDownsyncPeakMemoryBytes: Math.max(
          ...versions.map((version) => version.downsync.peakMemoryBytes)
        ),
        maxUpsyncPeakMemoryBytes: Math.max(
          ...versions.map((version) => version.upsync.peakMemoryBytes)
        ),
        rejectionReasons,
        schemaVersion: 1,
        storeBytes: storeMeasurement.bytes,
        storeObjects: storeMeasurement.files,
        targetBlockBytes: TARGET_BLOCK_BYTES,
        targetChunkBytes: TARGET_CHUNK_BYTES,
        versions,
      };

      expect(result.exactReconstruction).toBe(true);
      expect(result.storeObjects).toBeGreaterThan(0);
      expect(result.adoptionDecision).toBe('reject');
      const resultsPath = process.env.YUCP_LONGTAIL_RESULTS_PATH?.trim();
      if (resultsPath) {
        await writeFile(resolve(resultsPath), `${JSON.stringify(result, null, 2)}\n`, 'utf8');
      }
      console.info(`LONGTAIL_CORPUS_RESULTS=${JSON.stringify(result)}`);
    },
    3 * 60 * 60 * 1000
  );
});
