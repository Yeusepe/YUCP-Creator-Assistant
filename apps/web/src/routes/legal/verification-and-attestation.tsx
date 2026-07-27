import { createFileRoute } from '@tanstack/react-router';
import { type ReactNode, useEffect, useState } from 'react';
import { BackgroundCanvasRoot } from '@/components/page/BackgroundCanvasRoot';
import { routeStyleHrefs, routeStylesheetLinks } from '@/lib/routeStyles';

const OFFICIAL_SOURCES = [
  {
    label: 'EU General Data Protection Regulation',
    href: 'https://eur-lex.europa.eu/eli/reg/2016/679/oj/eng',
    detail: 'Binding EU text for principles, notices, lawful bases, rights, and security.',
  },
  {
    label: 'European Data Protection Board role guidance',
    href: 'https://www.edpb.europa.eu/documents/guideline/guidelines-072020-on-the-concepts-of-controller-and-processor-in-the-gdpr_en',
    detail: 'Official guidance about controller and processor roles.',
  },
  {
    label: 'European Commission rights guide',
    href: 'https://commission.europa.eu/law/law-topic/data-protection/information-individuals_en',
    detail: 'Official summary of individual rights under the GDPR.',
  },
  {
    label: 'European Commission retention guide',
    href: 'https://commission.europa.eu/law/law-topic/data-protection/rules-business-and-organisations/principles-gdpr/how-long-can-data-be-kept-and-it-necessary-update-it_en',
    detail: 'Official guidance about retention periods and review criteria.',
  },
  {
    label: 'European Commission transparency guide',
    href: 'https://commission.europa.eu/law/law-topic/data-protection/information-business-and-organisations/principles-gdpr/what-information-must-be-given-individuals-whose-data-collected_en',
    detail: 'Official guidance about information that controllers must provide.',
  },
  {
    label: 'United Kingdom data protection guide',
    href: 'https://www.gov.uk/data-protection/the-data-protection-act',
    detail: 'Official summary of UK data protection principles and rights.',
  },
  {
    label: 'United Kingdom data protection legislation',
    href: 'https://www.legislation.gov.uk/eur/2016/679/contents',
    detail: 'Official UK GDPR text.',
  },
  {
    label: 'United Kingdom Data Protection Act 2018',
    href: 'https://www.legislation.gov.uk/ukpga/2018/12/contents',
    detail: 'Official Data Protection Act 2018 text.',
  },
  {
    label: 'California Privacy Protection Agency FAQ',
    href: 'https://cppa.ca.gov/faq.html',
    detail: 'Official summary of California consumer privacy rights.',
  },
  {
    label: 'California Consumer Privacy Act',
    href: 'https://leginfo.legislature.ca.gov/faces/codes_displayText.xhtml?article=&chapter=&division=3.&lawCode=CIV&part=4.&title=1.81.5.',
    detail: 'Official California Civil Code text.',
  },
  {
    label: 'Colombia Law 1581 of 2012',
    href: 'https://www1.funcionpublica.gov.co/eva/gestornormativo/norma.php?i=49981',
    detail: 'Official publication of Colombia personal data protection law.',
  },
  {
    label: 'Colombia Decree 1377 of 2013',
    href: 'https://www1.funcionpublica.gov.co/eva/gestornormativo/norma.php?i=53646',
    detail: 'Official rules for policy contents and controller contact information.',
  },
] as const;

export const Route = createFileRoute('/legal/verification-and-attestation')({
  head: () => ({
    meta: [
      { title: 'Verification and Attestation Notice | Creator Assistant' },
      {
        name: 'description',
        content:
          'A plain-language notice about YUCP purchase verification, device attestation, package delivery, and buyer privacy.',
      },
    ],
    links: routeStylesheetLinks(routeStyleHrefs.legal),
  }),
  component: VerificationAndAttestationPage,
});

function SourceLink({ href, children }: { href: string; children: ReactNode }) {
  return (
    <a href={href} target="_blank" rel="noreferrer" className="creator-notice-source-link">
      {children}
      <span className="sr-only"> (opens in a new tab)</span>
    </a>
  );
}

function VerificationAndAttestationPage() {
  const [isVisible, setIsVisible] = useState(false);

  useEffect(() => {
    setIsVisible(true);
  }, []);

  return (
    <div className={`creator-notice-page${isVisible ? ' is-visible' : ''}`}>
      <BackgroundCanvasRoot position="fixed" />

      <main className="creator-notice-main" aria-labelledby="creator-notice-title">
        <nav className="creator-notice-nav" aria-label="Legal pages">
          <a href="/legal/privacy-policy">Privacy policy</a>
          <a href="/legal/terms-of-service">Terms of service</a>
          <a href="#rights">Privacy rights</a>
        </nav>

        <header className="creator-notice-hero">
          <img src="/Icons/MainLogo.png" alt="Creator Assistant" className="creator-notice-logo" />
          <div>
            <p className="creator-notice-kicker">Buyer verification notice</p>
            <h1 id="creator-notice-title">How YUCP verifies package access</h1>
            <p className="creator-notice-lede">
              Creators can link this page from a product listing. It explains verification,
              attestation, delivery, and privacy in plain language.
            </p>
          </div>
        </header>

        <section className="creator-notice-summary" aria-labelledby="summary-title">
          <div>
            <p className="creator-notice-section-number" aria-hidden="true">
              01
            </p>
            <h2 id="summary-title">The short version</h2>
          </div>
          <div className="creator-notice-prose">
            <p>
              YUCP checks purchase evidence before it grants package access. Supported flows can
              also check device security and create attribution evidence.
            </p>
            <p>
              The creator receives the verification result and relevant product context. YUCP keeps
              the service records described in our{' '}
              <a href="/legal/privacy-policy">Privacy Policy</a>.
            </p>
            <p>
              This page explains YUCP processing. It is not legal advice. It does not replace a
              creator&apos;s privacy notice, controller-processor agreement, or legal review.
            </p>
          </div>
        </section>

        <section className="creator-notice-flow" aria-labelledby="flow-title">
          <div className="creator-notice-section-heading">
            <p className="creator-notice-section-number" aria-hidden="true">
              02
            </p>
            <div>
              <h2 id="flow-title">What happens during access</h2>
              <p>Each step has one purpose and one clear data boundary.</p>
            </div>
          </div>

          <ol className="creator-notice-steps">
            <li>
              <span>1</span>
              <div>
                <h3>Prove access</h3>
                <p>
                  You sign in and use a supported store account or license method. YUCP checks the
                  evidence for the selected product.
                </p>
              </div>
            </li>
            <li>
              <span>2</span>
              <div>
                <h3>Check the device</h3>
                <p>
                  Supported clients can submit hashed device security evidence. YUCP uses it to
                  detect replay, sharing, and tampering.
                </p>
              </div>
            </li>
            <li>
              <span>3</span>
              <div>
                <h3>Prepare the package</h3>
                <p>
                  YUCP connects the verified purchase to the product and installation. The importer
                  requests only the package files needed for that installation.
                </p>
              </div>
            </li>
            <li>
              <span>4</span>
              <div>
                <h3>Record the result</h3>
                <p>
                  Files prepared for a specific buyer can carry buyer attribution. YUCP keeps
                  delivery records that can support a later review.
                </p>
              </div>
            </li>
          </ol>

          <p className="creator-notice-evidence">
            Product behavior source:{' '}
            <a href="/legal/privacy-policy#package-delivery">
              Privacy Policy, package delivery and attestation
            </a>
            .
          </p>
        </section>

        <div className="creator-notice-audience-grid">
          <section aria-labelledby="buyers-title">
            <p className="creator-notice-section-number" aria-hidden="true">
              03
            </p>
            <h2 id="buyers-title">For buyers</h2>
            <h3>What YUCP records</h3>
            <ul>
              <li>your YUCP account and verification session identifiers</li>
              <li>
                the store, product, order, license, or entitlement references used for a check
              </li>
              <li>hashed or encrypted verification inputs where the flow supports them</li>
              <li>hashed device security evidence from supported clients</li>
              <li>package delivery results and the records needed to investigate misuse</li>
              <li>security, audit, and troubleshooting events for the flow</li>
            </ul>
            <p className="creator-notice-evidence">
              Product behavior source:{' '}
              <a href="/legal/privacy-policy#package-delivery">Privacy Policy</a>.
            </p>
          </section>

          <section aria-labelledby="creators-title">
            <p className="creator-notice-section-number" aria-hidden="true">
              04
            </p>
            <h2 id="creators-title">For creators</h2>
            <h3>What creators can see</h3>
            <ul>
              <li>the verification status and the matched product or access tier</li>
              <li>the store and purchase evidence needed to support the result</li>
              <li>package release, delivery, and install status</li>
              <li>attribution matches returned through authorized review tools</li>
              <li>audit events that support access or abuse decisions</li>
            </ul>
            <p>
              Creators must use these results only for their stated product, support, security, and
              license purposes.
            </p>
            <p className="creator-notice-evidence">
              YUCP contract source:{' '}
              <a href="/legal/terms-of-service#creator-package-terms">
                Terms of Service, creator package terms
              </a>
              . This is a YUCP contract requirement. Applicable law can impose other duties.
            </p>
          </section>
        </div>

        <section className="creator-notice-roles" aria-labelledby="roles-title">
          <div className="creator-notice-section-heading">
            <p className="creator-notice-section-number" aria-hidden="true">
              05
            </p>
            <div>
              <h2 id="roles-title">Who decides what</h2>
              <p>Privacy roles depend on the real decisions made for each activity.</p>
            </div>
          </div>

          <dl>
            <div>
              <dt>The creator decides</dt>
              <dd>
                which products, tiers, and access rules use YUCP, and how the creator acts on a
                result.
              </dd>
            </div>
            <div>
              <dt>YUCP decides</dt>
              <dd>
                how the service authenticates users, secures systems, prevents abuse, and operates
                package delivery.
              </dd>
            </div>
            <div>
              <dt>The legal role follows the facts</dt>
              <dd>
                Controller and processor labels depend on who determines each purpose and its
                essential means.
              </dd>
            </div>
          </dl>

          <p className="creator-notice-evidence">
            Legal source:{' '}
            <SourceLink href="https://www.edpb.europa.eu/documents/guideline/guidelines-072020-on-the-concepts-of-controller-and-processor-in-the-gdpr_en">
              EDPB Guidelines 07/2020
            </SourceLink>
            . Applicable processor relationships also require the terms specified by GDPR Article
            28. See the{' '}
            <SourceLink href="https://eur-lex.europa.eu/eli/reg/2016/679/oj/eng">
              official GDPR text
            </SourceLink>
            .
          </p>
        </section>

        <section className="creator-notice-retention" aria-labelledby="retention-title">
          <div>
            <p className="creator-notice-section-number" aria-hidden="true">
              06
            </p>
            <h2 id="retention-title">Retention and control</h2>
          </div>
          <div className="creator-notice-prose">
            <p>
              YUCP uses record-specific retention criteria. The criteria include account status,
              release status, security needs, disputes, and applicable legal duties.
            </p>
            <p>
              Short-lived verification and delivery records can include expiration times. Release
              and attribution records can remain while their stated purpose continues.
            </p>
            <p>
              EU guidance says organizations should set erasure or review limits. It also says
              storage should last no longer than the processing purpose requires.
            </p>
            <p className="creator-notice-evidence">
              Legal source:{' '}
              <SourceLink href="https://commission.europa.eu/law/law-topic/data-protection/rules-business-and-organisations/principles-gdpr/how-long-can-data-be-kept-and-it-necessary-update-it_en">
                European Commission retention guidance
              </SourceLink>
              . Product criteria: <a href="/legal/privacy-policy#retention">Privacy Policy</a>.
            </p>
          </div>
        </section>

        <section id="rights" className="creator-notice-rights" aria-labelledby="rights-title">
          <div className="creator-notice-section-heading">
            <p className="creator-notice-section-number" aria-hidden="true">
              07
            </p>
            <div>
              <h2 id="rights-title">Your privacy rights</h2>
              <p>Applicable rights depend on your location and the processing activity.</p>
            </div>
          </div>

          <div className="creator-notice-rights-grid">
            <div>
              <h3>European Union</h3>
              <p>
                GDPR rights can include information, access, correction, erasure, restriction,
                portability, objection, and safeguards for automated decisions.
              </p>
              <SourceLink href="https://commission.europa.eu/law/law-topic/data-protection/information-individuals_en">
                European Commission rights guide
              </SourceLink>
            </div>
            <div>
              <h3>United Kingdom</h3>
              <p>
                UK law provides data protection principles and individual rights, subject to
                applicable conditions and exceptions.
              </p>
              <SourceLink href="https://www.gov.uk/data-protection/the-data-protection-act">
                GOV.UK data protection guide
              </SourceLink>
              . Primary texts:{' '}
              <SourceLink href="https://www.legislation.gov.uk/eur/2016/679/contents">
                UK GDPR
              </SourceLink>{' '}
              and{' '}
              <SourceLink href="https://www.legislation.gov.uk/ukpga/2018/12/contents">
                Data Protection Act 2018
              </SourceLink>
            </div>
            <div>
              <h3>California</h3>
              <p>
                The CCPA can provide rights to know, delete, correct, limit, opt out, and receive
                equal treatment.
              </p>
              <SourceLink href="https://cppa.ca.gov/faq.html">
                California Privacy Protection Agency FAQ
              </SourceLink>
              . Primary text:{' '}
              <SourceLink href="https://leginfo.legislature.ca.gov/faces/codes_displayText.xhtml?article=&chapter=&division=3.&lawCode=CIV&part=4.&title=1.81.5.">
                California Civil Code
              </SourceLink>
            </div>
            <div>
              <h3>Colombia</h3>
              <p>
                Law 1581 provides rights concerning access, correction, information, complaints,
                authorization, revocation, and deletion.
              </p>
              <SourceLink href="https://www1.funcionpublica.gov.co/eva/gestornormativo/norma.php?i=49981">
                Colombia Law 1581 of 2012
              </SourceLink>
            </div>
          </div>

          <div className="creator-notice-contact">
            <div>
              <h3>Ask about your data</h3>
              <p>
                Email <a href="mailto:privacy@yucp.club">privacy@yucp.club</a>. Include the creator,
                product, and verification method when relevant.
              </p>
            </div>
            <a href="mailto:privacy@yucp.club?subject=Privacy%20request">Send a privacy request</a>
          </div>
        </section>

        <section className="creator-notice-sources" aria-labelledby="sources-title">
          <div className="creator-notice-section-heading">
            <p className="creator-notice-section-number" aria-hidden="true">
              08
            </p>
            <div>
              <h2 id="sources-title">Official legal sources</h2>
              <p>Only official authorities and primary legal texts support this notice.</p>
            </div>
          </div>

          <ol>
            {OFFICIAL_SOURCES.map((source) => (
              <li key={source.href}>
                <SourceLink href={source.href}>{source.label}</SourceLink>
                <p>{source.detail}</p>
              </li>
            ))}
          </ol>
        </section>

        <footer className="creator-notice-footer">
          <p>Last updated: July 26, 2026</p>
          <p>
            <a href="/legal/privacy-policy">Privacy policy</a>
            <span aria-hidden="true"> · </span>
            <a href="/legal/terms-of-service">Terms of service</a>
          </p>
        </footer>
      </main>
    </div>
  );
}
