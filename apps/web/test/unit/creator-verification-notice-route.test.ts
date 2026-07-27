import { existsSync, readFileSync } from 'node:fs';
import { resolve } from 'node:path';
import { describe, expect, it } from 'vitest';

const ROUTE_PATH = resolve(__dirname, '../../src/routes/legal/verification-and-attestation.tsx');
const LEGAL_STYLES_PATH = resolve(__dirname, '../../src/styles/legal.css');
const PRIVACY_PATH = resolve(__dirname, '../../src/routes/legal/privacy-policy.tsx');
const TERMS_PATH = resolve(__dirname, '../../src/routes/legal/terms-of-service.tsx');

function readRoute() {
  expect(existsSync(ROUTE_PATH), 'The public creator disclosure route must exist').toBe(true);
  return readFileSync(ROUTE_PATH, 'utf8');
}

function compact(source: string) {
  return source.replace(/\s+/g, ' ');
}

describe('creator verification and attestation notice', () => {
  it('publishes a stable public legal route', () => {
    const source = readRoute();

    expect(source).toContain("createFileRoute('/legal/verification-and-attestation')");
    expect(source).not.toContain('beforeLoad');
  });

  it('explains the buyer, creator, and YUCP data relationship in plain language', () => {
    const source = readRoute();
    const content = compact(source);

    expect(content).toContain('For buyers');
    expect(content).toContain('For creators');
    expect(content).toContain('What YUCP records');
    expect(content).toContain('What creators can see');
    expect(content).toContain('not legal advice');
    expect(content).toContain('does not replace a creator');
    expect(content).toContain('controller-processor agreement');
  });

  it('explains delivery records without implementation-only package terms', () => {
    const source = readRoute();

    expect(source).toContain(
      'package delivery results and the records needed to investigate misuse'
    );
    expect(source).not.toMatch(/\bdelivery grants?\b/i);
    expect(source).not.toMatch(/\bsigned receipts?\b/i);
    expect(source).not.toMatch(/\bmaterialization\b/i);
    expect(source).not.toMatch(/\bprovider\b/i);
  });

  it('links every legal disclosure area to current official authorities', () => {
    const source = readRoute();

    expect(source).toContain('https://eur-lex.europa.eu/eli/reg/2016/679/oj/eng');
    expect(source).toContain(
      'https://www.edpb.europa.eu/documents/guideline/guidelines-072020-on-the-concepts-of-controller-and-processor-in-the-gdpr_en'
    );
    expect(source).toContain(
      'https://commission.europa.eu/law/law-topic/data-protection/information-individuals_en'
    );
    expect(source).toContain('https://www.legislation.gov.uk/eur/2016/679/contents');
    expect(source).toContain('https://www.legislation.gov.uk/ukpga/2018/12/contents');
    expect(source).toContain('https://cppa.ca.gov/faq.html');
    expect(source).toContain(
      'https://leginfo.legislature.ca.gov/faces/codes_displayText.xhtml?article=&chapter=&division=3.&lawCode=CIV&part=4.&title=1.81.5.'
    );
    expect(source).toContain(
      'https://www1.funcionpublica.gov.co/eva/gestornormativo/norma.php?i=49981'
    );
    expect(source).toContain(
      'https://www1.funcionpublica.gov.co/eva/gestornormativo/norma.php?i=53646'
    );
  });

  it('provides direct policy, rights, and contact paths', () => {
    const source = readRoute();

    expect(source).toContain('href="/legal/privacy-policy"');
    expect(source).toContain('href="/legal/terms-of-service"');
    expect(source).toContain('mailto:privacy@yucp.club');
  });

  it('uses one current revision date across the legal pages', () => {
    const notice = readRoute();
    const privacy = readFileSync(PRIVACY_PATH, 'utf8');
    const terms = readFileSync(TERMS_PATH, 'utf8');

    expect(notice).toContain('Last updated: July 26, 2026');
    expect(privacy).toContain('<strong>Last updated:</strong> July 26, 2026');
    expect(terms).toContain('<strong>Last updated:</strong> July 26, 2026');
  });

  it('contains no mojibake in the updated legal pages', () => {
    const legalSource = [
      readRoute(),
      readFileSync(PRIVACY_PATH, 'utf8'),
      readFileSync(TERMS_PATH, 'utf8'),
    ].join('\n');

    expect(legalSource).not.toMatch(/(?:Â|â€|â€™|ï¿½)/);
  });

  it('does not promise compliance or use unsourced fixed retention periods', () => {
    const source = readRoute();

    expect(source).not.toMatch(/\b(?:guarantees?|ensures?) (?:GDPR|CCPA|compliance)\b/i);
    expect(source).not.toMatch(/\b(?:30|60|90|180|365) days?\b/i);
    expect(source).not.toContain('—');
  });

  it('defines responsive and dark theme styles for the notice', () => {
    const styles = readFileSync(LEGAL_STYLES_PATH, 'utf8');

    expect(styles).toContain('.creator-notice-page');
    expect(styles).toContain('.dark .creator-notice-page');
    expect(styles).toContain('@container');
    expect(styles).toContain('@media (prefers-reduced-motion: reduce)');
  });

  it('documents package data and uses retention criteria instead of invented ranges', () => {
    const privacy = readFileSync(PRIVACY_PATH, 'utf8');

    expect(privacy).toContain('Package Delivery, Attestation, and Attribution');
    expect(privacy).toContain('buyer pseudonyms');
    expect(privacy).toContain('attribution token hashes');
    expect(privacy).toContain('short-lived buyer-specific packages');
    expect(privacy).toContain('We apply criteria for each record type');
    expect(privacy).toContain('mailto:privacy@yucp.club');
    expect(privacy).toContain('when you use the Creator Assistant services');
    expect(privacy).not.toContain('Creator Assistant Assistant');
    expect(privacy).not.toContain('Typically 30-90 days');
    expect(privacy).not.toContain('Typically 12-24 months');
    expect(privacy).not.toContain('up to 12 months');
    expect(privacy).not.toMatch(/\bdelivery grants?\b/i);
    expect(privacy).not.toMatch(/\bmaterialization\b/i);
    expect(privacy).not.toMatch(/\breusable chunks?\b/i);
  });

  it('supports privacy law statements with official primary sources', () => {
    const privacy = readFileSync(PRIVACY_PATH, 'utf8');

    expect(privacy).toContain(
      'https://commission.europa.eu/law/law-topic/data-protection/information-business-and-organisations/legal-grounds-processing-data_en'
    );
    expect(privacy).toContain(
      'https://commission.europa.eu/law/law-topic/data-protection/international-dimension-data-protection_en'
    );
    expect(privacy).toContain('https://www.gov.uk/data-protection/the-data-protection-act');
    expect(privacy).toContain('https://www.legislation.gov.uk/eur/2016/679/contents');
    expect(privacy).toContain('https://www.legislation.gov.uk/ukpga/2018/12/contents');
    expect(privacy).toContain('https://cppa.ca.gov/faq.html');
    expect(privacy).toContain(
      'https://leginfo.legislature.ca.gov/faces/codes_displayText.xhtml?article=&chapter=&division=3.&lawCode=CIV&part=4.&title=1.81.5.'
    );
    expect(privacy).toContain(
      'https://www1.funcionpublica.gov.co/eva/gestornormativo/norma.php?i=49981'
    );
  });

  it('does not attribute unsourced state rights to the California authority', () => {
    const privacy = readFileSync(PRIVACY_PATH, 'utf8');

    expect(privacy).toContain('EEA, UK, California, and Colombia rights');
    expect(privacy).not.toContain('Virginia, Colorado, Connecticut');
  });

  it('adds package delivery and attribution duties to the terms', () => {
    const terms = readFileSync(TERMS_PATH, 'utf8');
    const content = compact(terms);

    expect(content).toContain('id="creator-package-terms"');
    expect(content).toContain('Package Delivery and Attribution');
    expect(content).toContain('Protected Outputs can contain verifiable buyer attribution');
    expect(content).toContain('Unreferenced content can become eligible for permanent cleanup');
    expect(content).toContain('href="/legal/verification-and-attestation"');
    expect(content).toContain('YUCP contract requirements');
    expect(content).toContain('does not replace a Creator');
    expect(content).toContain('Creator responsibilities are YUCP contract requirements');
    expect(content).toContain(
      'https://commission.europa.eu/law/law-topic/data-protection/information-business-and-organisations/legal-grounds-processing-data_en'
    );
    expect(content).not.toMatch(/\bdelivery grants?\b/i);
    expect(content).not.toMatch(/\bexact-version garbage collection\b/i);
  });

  it('does not use colored side borders on updated legal surfaces', () => {
    const privacy = readFileSync(PRIVACY_PATH, 'utf8');
    const terms = readFileSync(TERMS_PATH, 'utf8');

    expect(privacy).not.toContain('border-l-4');
    expect(terms).not.toContain('border-l-4');
  });
});
