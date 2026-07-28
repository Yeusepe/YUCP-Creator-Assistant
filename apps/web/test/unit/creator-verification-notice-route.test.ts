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

  it('keeps the buyer notice practical and routes detailed privacy questions to the full policy', () => {
    const source = readRoute();
    const content = compact(source);

    expect(content).toContain('What happens when you verify access');
    expect(content).toContain('The creator receives the result.');
    expect(content).toContain('Ask about your data');
    expect(content).toContain('complete privacy notice');
    expect(content).not.toContain('The legal role follows the facts');
  });

  it('presents the information people need at verification time', () => {
    const content = compact(readRoute());

    expect(content).toContain('What data YUCP uses');
    expect(content).toContain('Why we use it');
    expect(content).toContain('Who sees this data');
    expect(content).toContain('Legal basis');
    expect(content).toContain('Automated access checks');
    expect(content).toContain('Your privacy choices');
    expect(content).toContain('We do not sell personal data.');
    expect(content).toContain('encrypted at rest');
    expect(content).toContain('only when it is needed for a provider request');
  });

  it('uses the complete dashboard wordmark rather than a constrained decorative logo', () => {
    const source = readRoute();
    const styles = readFileSync(LEGAL_STYLES_PATH, 'utf8');

    expect(source).toContain('alt="Creator Assistant"');
    expect(styles).toMatch(/\.creator-notice-brand img\s*\{[\s\S]*?width:\s*auto;/);
    expect(styles).toMatch(/\.creator-notice-brand img\s*\{[\s\S]*?height:\s*26px;/);
  });

  it('explains verification and delivery without implementation-only package terms', () => {
    const source = readRoute();

    expect(source).toContain('prepare package access');
    expect(source).not.toMatch(/\bdelivery grants?\b/i);
    expect(source).not.toMatch(/\bsigned receipts?\b/i);
    expect(source).not.toMatch(/\bmaterialization\b/i);
  });

  it('keeps the buyer notice concise and directs readers to the complete privacy disclosure', () => {
    const source = readRoute();
    const content = compact(source);

    expect(content).toContain('complete privacy notice');
    expect(content).toContain(
      'rights, provider categories, transfer safeguards, retention criteria'
    );
    expect(source).not.toContain('OFFICIAL_SOURCES');
    expect(source).not.toContain('Official legal sources');
  });

  it('provides direct policy, rights, and contact paths', () => {
    const source = readRoute();

    expect(source).toContain('href="/legal/privacy-policy"');
    expect(source).toContain('href="/legal/terms-of-service"');
    expect(source).toContain('mailto:contact@yucp.club');
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
    expect(privacy).toContain('mailto:contact@yucp.club');
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
