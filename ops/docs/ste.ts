import { existsSync, readdirSync, readFileSync, statSync } from 'node:fs';
import { relative, resolve } from 'node:path';

export type DocumentationRule =
  | 'STE-CONTRACTION'
  | 'STE-DESCRIPTIVE-LENGTH'
  | 'STE-EM-DASH'
  | 'STE-PROCEDURAL-LENGTH'
  | 'STE-SEMICOLON'
  | 'WORK-ITEM-DUPLICATE'
  | 'WORK-ITEM-EXTRA'
  | 'WORK-ITEM-MISSING'
  | 'WORK-ITEM-SOURCE-MISSING';

export interface DocumentationViolation {
  readonly file: string;
  readonly line: number;
  readonly rule: DocumentationRule;
  readonly message: string;
  readonly action: string;
}

const FIXED_DOCUMENTS = [
  'docs/package-storage-delivery-architecture.md',
  'docs/package-storage-delivery-implementation-plan.md',
  'docs/package-storage-delivery-progress.md',
  'docs/package-storage-research-ledger.md',
] as const;

const PROGRAM_DIRECTORY = 'docs/package-storage-delivery';

const CONTRACTION_PATTERN =
  /\b(?:aren't|can't|couldn't|didn't|doesn't|don't|hadn't|hasn't|haven't|isn't|it's|let's|mustn't|shan't|shouldn't|that's|there's|they're|wasn't|we're|weren't|what's|won't|wouldn't|you're)\b/iu;

const PROCEDURAL_VERBS = new Set([
  'accept',
  'add',
  'admit',
  'adopt',
  'apply',
  'approve',
  'attach',
  'bind',
  'build',
  'call',
  'capture',
  'check',
  'classify',
  'commit',
  'compare',
  'complete',
  'compute',
  'configure',
  'confirm',
  'construct',
  'create',
  'define',
  'delete',
  'detect',
  'disable',
  'do',
  'document',
  'emit',
  'enable',
  'enforce',
  'expose',
  'fail',
  'generate',
  'give',
  'include',
  'install',
  'inventory',
  'keep',
  'limit',
  'load',
  'make',
  'mark',
  'measure',
  'move',
  'never',
  'open',
  'persist',
  'pin',
  'preapprove',
  'preserve',
  'prevent',
  'produce',
  'protect',
  'publish',
  'read',
  'record',
  'register',
  'reject',
  'remove',
  'require',
  'reserve',
  'resolve',
  'restore',
  'retain',
  'return',
  'reuse',
  'review',
  'run',
  'schedule',
  'select',
  'set',
  'sign',
  'split',
  'start',
  'stop',
  'store',
  'stream',
  'suppress',
  'test',
  'track',
  'treat',
  'trigger',
  'unregister',
  'update',
  'use',
  'validate',
  'verify',
  'wait',
  'wipe',
  'write',
]);

function toProgramPath(root: string, filePath: string): string {
  return relative(root, filePath).replaceAll('\\', '/');
}

function collectMarkdownFiles(directory: string): string[] {
  if (!existsSync(directory)) {
    return [];
  }

  const files: string[] = [];
  for (const entry of readdirSync(directory, { withFileTypes: true })) {
    const entryPath = resolve(directory, entry.name);
    if (entry.isDirectory()) {
      files.push(...collectMarkdownFiles(entryPath));
    } else if (entry.isFile() && entry.name.toLowerCase().endsWith('.md')) {
      files.push(entryPath);
    }
  }
  return files;
}

export function collectProgramDocumentPaths(root: string): string[] {
  const absoluteRoot = resolve(root);
  const paths = new Set<string>();

  for (const document of FIXED_DOCUMENTS) {
    const documentPath = resolve(absoluteRoot, document);
    if (existsSync(documentPath) && statSync(documentPath).isFile()) {
      paths.add(documentPath);
    }
  }

  for (const documentPath of collectMarkdownFiles(resolve(absoluteRoot, PROGRAM_DIRECTORY))) {
    paths.add(documentPath);
  }

  return [...paths].sort((left, right) => left.localeCompare(right));
}

function stripMarkdown(text: string): string {
  return text
    .replace(/<!--.*?-->/gu, ' ')
    .replace(/!\[([^\]]*)\]\([^)]*\)/gu, '$1')
    .replace(/\[([^\]]+)\]\([^)]*\)/gu, '$1')
    .replace(/<https?:\/\/[^>]+>/giu, ' ')
    .replace(/https?:\/\/\S+/giu, ' ')
    .replace(/`[^`]*`/gu, ' term ')
    .replace(/^\s*(?:>\s*)?(?:[-*+]\s+|\d+[.)]\s+)?/u, '')
    .replace(/[*_~]/gu, '')
    .trim();
}

function countWords(text: string): number {
  return text.match(/[\p{L}\p{N}]+(?:[-'][\p{L}\p{N}]+)*/gu)?.length ?? 0;
}

function firstWord(text: string): string | undefined {
  return text.match(/[\p{L}]+/u)?.[0]?.toLowerCase();
}

function isProceduralSentence(sentence: string): boolean {
  const directWord = firstWord(sentence);
  if (directWord && PROCEDURAL_VERBS.has(directWord)) {
    return true;
  }

  const conditional = /^(?:after|before|if|once|unless|when|while)\b[^,]*,\s*(.+)$/iu.exec(
    sentence
  );
  const conditionalWord = conditional?.[1] ? firstWord(conditional[1]) : undefined;
  return Boolean(conditionalWord && PROCEDURAL_VERBS.has(conditionalWord));
}

function markdownCells(line: string): string[] {
  if (!line.trimStart().startsWith('|')) {
    return [line];
  }
  return line.trim().replace(/^\|/u, '').replace(/\|$/u, '').split('|');
}

function isTableDivider(text: string): boolean {
  return /^\s*:?-{3,}:?\s*$/u.test(text);
}

function sentences(text: string): string[] {
  return text
    .split(/(?<=[.!?])\s+/u)
    .map((sentence) => sentence.trim())
    .filter(Boolean);
}

function pushPunctuationViolations(
  violations: DocumentationViolation[],
  file: string,
  line: number,
  prose: string
): void {
  if (prose.includes('—')) {
    violations.push({
      file,
      line,
      rule: 'STE-EM-DASH',
      message: 'Prose contains an em dash.',
      action: 'Replace the em dash with two short sentences or approved punctuation.',
    });
  }
  if (prose.includes(';')) {
    violations.push({
      file,
      line,
      rule: 'STE-SEMICOLON',
      message: 'Prose contains a semicolon.',
      action: 'Replace the semicolon with a period or a vertical list.',
    });
  }
  const contraction = CONTRACTION_PATTERN.exec(prose)?.[0];
  if (contraction) {
    violations.push({
      file,
      line,
      rule: 'STE-CONTRACTION',
      message: `Prose contains the contraction "${contraction}".`,
      action: 'Write the complete words.',
    });
  }
}

export function lintMarkdown(file: string, markdown: string): DocumentationViolation[] {
  const violations: DocumentationViolation[] = [];
  const lines = markdown.split(/\r?\n/u);
  let codeFence: '`' | '~' | undefined;

  for (const [index, sourceLine] of lines.entries()) {
    const lineNumber = index + 1;
    const fence = /^\s*(`{3,}|~{3,})/u.exec(sourceLine)?.[1]?.[0] as '`' | '~' | undefined;
    if (fence) {
      if (!codeFence) {
        codeFence = fence;
      } else if (codeFence === fence) {
        codeFence = undefined;
      }
      continue;
    }
    if (codeFence || !sourceLine.trim()) {
      continue;
    }

    const proseLine = sourceLine.replace(/`[^`]*`/gu, ' term ');
    pushPunctuationViolations(violations, file, lineNumber, proseLine);

    if (/^\s*#/u.test(sourceLine)) {
      continue;
    }

    for (const cell of markdownCells(sourceLine)) {
      if (isTableDivider(cell)) {
        continue;
      }
      const prose = stripMarkdown(cell);
      if (!prose) {
        continue;
      }

      for (const sentence of sentences(prose)) {
        const wordCount = countWords(sentence);
        if (wordCount === 0) {
          continue;
        }
        const procedural = isProceduralSentence(sentence);
        const limit = procedural ? 20 : 25;
        if (wordCount <= limit) {
          continue;
        }
        violations.push({
          file,
          line: lineNumber,
          rule: procedural ? 'STE-PROCEDURAL-LENGTH' : 'STE-DESCRIPTIVE-LENGTH',
          message: `${procedural ? 'Procedural' : 'Descriptive'} sentence has ${wordCount} words. The limit is ${limit}.`,
          action: 'Split the sentence and keep one topic or instruction in each sentence.',
        });
      }
    }
  }

  return violations;
}

interface WorkItemOccurrence {
  readonly id: string;
  readonly line: number;
}

function collectWorkItems(markdown: string, pattern: RegExp): WorkItemOccurrence[] {
  const occurrences: WorkItemOccurrence[] = [];
  for (const [index, line] of markdown.split(/\r?\n/u).entries()) {
    const id = pattern.exec(line)?.[1];
    if (id) {
      occurrences.push({ id, line: index + 1 });
    }
  }
  return occurrences;
}

function duplicateViolations(
  file: string,
  occurrences: readonly WorkItemOccurrence[]
): DocumentationViolation[] {
  const firstLines = new Map<string, number>();
  const violations: DocumentationViolation[] = [];
  for (const occurrence of occurrences) {
    const firstLine = firstLines.get(occurrence.id);
    if (firstLine === undefined) {
      firstLines.set(occurrence.id, occurrence.line);
      continue;
    }
    violations.push({
      file,
      line: occurrence.line,
      rule: 'WORK-ITEM-DUPLICATE',
      message: `${occurrence.id} duplicates its definition on line ${firstLine}.`,
      action: 'Keep one authoritative occurrence of each work item.',
    });
  }
  return violations;
}

export function compareWorkItems(
  planFile: string,
  planMarkdown: string,
  progressFile: string,
  progressMarkdown: string
): DocumentationViolation[] {
  const planItems = collectWorkItems(planMarkdown, /^####\s+(P\d+-\d+):/u);
  const progressItems = collectWorkItems(progressMarkdown, /^\|\s*(P\d+-\d+)\s*\|/u);
  const violations = [
    ...duplicateViolations(planFile, planItems),
    ...duplicateViolations(progressFile, progressItems),
  ];
  const planIds = new Set(planItems.map(({ id }) => id));
  const progressIds = new Set(progressItems.map(({ id }) => id));

  for (const occurrence of planItems) {
    if (!progressIds.has(occurrence.id)) {
      violations.push({
        file: planFile,
        line: occurrence.line,
        rule: 'WORK-ITEM-MISSING',
        message: `${occurrence.id} is missing from the progress board.`,
        action: 'Add the work item to the progress board.',
      });
    }
  }
  for (const occurrence of progressItems) {
    if (!planIds.has(occurrence.id)) {
      violations.push({
        file: progressFile,
        line: occurrence.line,
        rule: 'WORK-ITEM-EXTRA',
        message: `${occurrence.id} has no definition in the implementation plan.`,
        action: 'Define the work item in the plan or remove it from the board.',
      });
    }
  }

  return violations;
}

export function runDocumentationGate(root: string): DocumentationViolation[] {
  const absoluteRoot = resolve(root);
  const violations: DocumentationViolation[] = [];
  const documents = collectProgramDocumentPaths(absoluteRoot);

  for (const document of FIXED_DOCUMENTS) {
    const documentPath = resolve(absoluteRoot, document);
    if (!existsSync(documentPath)) {
      violations.push({
        file: document,
        line: 1,
        rule: 'WORK-ITEM-SOURCE-MISSING',
        message: 'Required package-program document is missing.',
        action: 'Restore the required document before running the gate.',
      });
    }
  }

  for (const documentPath of documents) {
    const file = toProgramPath(absoluteRoot, documentPath);
    violations.push(...lintMarkdown(file, readFileSync(documentPath, 'utf8')));
  }

  const planFile = FIXED_DOCUMENTS[1];
  const progressFile = FIXED_DOCUMENTS[2];
  const planPath = resolve(absoluteRoot, planFile);
  const progressPath = resolve(absoluteRoot, progressFile);
  if (existsSync(planPath) && existsSync(progressPath)) {
    violations.push(
      ...compareWorkItems(
        planFile,
        readFileSync(planPath, 'utf8'),
        progressFile,
        readFileSync(progressPath, 'utf8')
      )
    );
  }

  return violations.sort(
    (left, right) =>
      left.file.localeCompare(right.file) ||
      left.line - right.line ||
      left.rule.localeCompare(right.rule)
  );
}

export function formatViolation(violation: DocumentationViolation): string {
  return `${violation.file}:${violation.line} [${violation.rule}] ${violation.message} Review action: ${violation.action}`;
}

if (import.meta.main) {
  const root = resolve(import.meta.dir, '..', '..');
  const violations = runDocumentationGate(root);
  if (violations.length === 0) {
    console.log('Package documentation gate passed.');
  } else {
    for (const violation of violations) {
      console.error(formatViolation(violation));
    }
    console.error(`Package documentation gate failed with ${violations.length} violation(s).`);
    process.exitCode = 1;
  }
}
