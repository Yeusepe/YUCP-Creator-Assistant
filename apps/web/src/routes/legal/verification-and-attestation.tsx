import { createFileRoute } from '@tanstack/react-router';
import { routeStyleHrefs, routeStylesheetLinks } from '@/lib/routeStyles';

export const Route = createFileRoute('/legal/verification-and-attestation')({
  head: () => ({
    meta: [
      { title: 'Package Access and Privacy | Creator Assistant' },
      {
        name: 'description',
        content:
          'A clear explanation of the data Creator Assistant uses when you verify access to a creator package.',
      },
    ],
    links: routeStylesheetLinks(routeStyleHrefs.legal),
  }),
  component: VerificationAndAttestationPage,
});

function VerificationAndAttestationPage() {
  return (
    <div className="creator-notice-page">
      <header className="creator-notice-utility">
        <a href="/" className="creator-notice-brand" aria-label="Creator Assistant home">
          <img src="/Icons/MainLogo.png" alt="Creator Assistant" />
        </a>
        <nav aria-label="Legal pages">
          <a href="/legal/privacy-policy">Privacy Policy</a>
          <a href="#help">Get help</a>
        </nav>
      </header>

      <main className="creator-notice-main" aria-labelledby="creator-notice-title">
        <section className="creator-notice-hero">
          <p className="creator-notice-kicker">Package access and privacy</p>
          <h1 id="creator-notice-title">What happens when you verify access</h1>
          <p className="creator-notice-lede">
            Before YUCP verifies access to a creator&apos;s package, we use the information needed
            to check your purchase or license, protect the service, and deliver the right package.
          </p>
        </section>

        <section className="creator-notice-at-a-glance" aria-labelledby="glance-title">
          <div>
            <p className="creator-notice-section-number" aria-hidden="true">
              At a glance
            </p>
            <h2 id="glance-title">Your verification, explained</h2>
          </div>
          <ul>
            <li>
              <strong>You choose the method.</strong> You can sign in, connect a supported store, or
              use the license method offered for the product.
            </li>
            <li>
              <strong>We check access.</strong> YUCP compares the information provided with the
              creator&apos;s configured access rule.
            </li>
            <li>
              <strong>The creator receives the result.</strong> They can use it to provide package
              access and support their product.
            </li>
          </ul>
        </section>

        <section className="creator-notice-disclosure" aria-labelledby="data-title">
          <div className="creator-notice-section-heading">
            <p className="creator-notice-section-number" aria-hidden="true">
              01
            </p>
            <div>
              <h2 id="data-title">What data YUCP uses</h2>
              <p>We use only the information needed for the verification flow you choose.</p>
            </div>
          </div>

          <dl className="creator-notice-detail-grid">
            <div>
              <dt>Information you provide</dt>
              <dd>Account-linking details, purchase or license evidence, and support messages.</dd>
            </div>
            <div>
              <dt>Information from a connected provider</dt>
              <dd>
                Store or account identifiers, product and order references, license status, and
                related verification records. Credential values used to make those connections are
                encrypted at rest and decrypted only when it is needed for a provider request.
              </dd>
            </div>
            <div>
              <dt>Information created during verification</dt>
              <dd>
                Verification-session, delivery, security, and audit records. Supported clients can
                also submit hashed device-security evidence.
              </dd>
            </div>
          </dl>
        </section>

        <section className="creator-notice-disclosure" aria-labelledby="purpose-title">
          <div className="creator-notice-section-heading">
            <p className="creator-notice-section-number" aria-hidden="true">
              02
            </p>
            <div>
              <h2 id="purpose-title">Why we use it</h2>
              <p>Each use supports access, delivery, security, or the operation of the service.</p>
            </div>
          </div>

          <dl className="creator-notice-detail-grid">
            <div>
              <dt>Verify and deliver</dt>
              <dd>
                Match a purchase or license to the selected product and prepare package access.
              </dd>
            </div>
            <div>
              <dt>Keep access secure</dt>
              <dd>Detect misuse, replay, tampering, fraud, and account-sharing attempts.</dd>
            </div>
            <div>
              <dt>Run and improve the service</dt>
              <dd>
                Maintain reliable operations, resolve support requests, and investigate errors.
              </dd>
            </div>
          </dl>
        </section>

        <section className="creator-notice-disclosure" aria-labelledby="sharing-title">
          <div className="creator-notice-section-heading">
            <p className="creator-notice-section-number" aria-hidden="true">
              03
            </p>
            <div>
              <h2 id="sharing-title">Who sees this data</h2>
              <p>We share information only when it is needed for the selected verification flow.</p>
            </div>
          </div>

          <dl className="creator-notice-detail-grid">
            <div>
              <dt>The creator</dt>
              <dd>
                The verification result, matched product or tier, and information needed to support
                access or investigate misuse.
              </dd>
            </div>
            <div>
              <dt>Connected providers</dt>
              <dd>
                The provider you choose, when needed to complete the verification you requested.
              </dd>
            </div>
            <div>
              <dt>Service providers</dt>
              <dd>
                Providers that operate authentication, storage, delivery, infrastructure, and
                support functions for YUCP.
              </dd>
            </div>
          </dl>
          <p className="creator-notice-inline-note">We do not sell personal data.</p>
        </section>

        <section className="creator-notice-disclosure" aria-labelledby="basis-title">
          <div className="creator-notice-section-heading">
            <p className="creator-notice-section-number" aria-hidden="true">
              04
            </p>
            <div>
              <h2 id="basis-title">Legal basis and safeguards</h2>
              <p>These are the grounds and protections that support YUCP&apos;s processing.</p>
            </div>
          </div>

          <dl className="creator-notice-detail-grid">
            <div>
              <dt>Legal basis</dt>
              <dd>
                Depending on the activity, YUCP relies on a service request or contract, legitimate
                interests in security and operations, consent where required, or a legal obligation.
              </dd>
            </div>
            <div>
              <dt>International transfers</dt>
              <dd>
                YUCP can use providers in more than one country. Where required, we use appropriate
                transfer safeguards and can provide details on request.
              </dd>
            </div>
            <div>
              <dt>Retention</dt>
              <dd>
                Records are kept only while their access, security, support, dispute, or legal
                purpose applies. The Privacy Policy explains the criteria by record type.
              </dd>
            </div>
          </dl>
        </section>

        <section className="creator-notice-disclosure" aria-labelledby="automation-title">
          <div className="creator-notice-section-heading">
            <p className="creator-notice-section-number" aria-hidden="true">
              05
            </p>
            <div>
              <h2 id="automation-title">Automated access checks</h2>
              <p>
                Verification can use an automated comparison between your evidence and an access
                rule.
              </p>
            </div>
          </div>

          <div className="creator-notice-automation">
            <p>
              A successful or unsuccessful comparison can affect package access. The creator decides
              how their product uses the result. If you think an access result is wrong, ask the
              creator to review it. You can also contact YUCP about our processing of your data.
            </p>
          </div>
        </section>

        <section id="help" className="creator-notice-help" aria-labelledby="help-title">
          <div>
            <p className="creator-notice-section-number" aria-hidden="true">
              06
            </p>
            <h2 id="help-title">Your privacy choices</h2>
          </div>
          <div className="creator-notice-help-content">
            <p>
              You may have rights to access, correct, delete, restrict, object to, or receive a copy
              of your personal data, depending on the law that applies to you. You can also withdraw
              consent where processing depends on it and lodge a complaint with your local data
              protection authority.
            </p>
            <p>
              The <a href="/legal/privacy-policy">Privacy Policy</a> is the complete privacy notice.
              It explains rights, provider categories, transfer safeguards, retention criteria, and
              how we handle a privacy request.
            </p>
            <div id="contact" className="creator-notice-contact">
              <div>
                <h3>Ask about your data</h3>
                <p>
                  Email <a href="mailto:contact@yucp.club">contact@yucp.club</a> with the subject
                  “Privacy Request.” Include your creator, product, and verification method when
                  relevant.
                </p>
              </div>
              <a href="mailto:contact@yucp.club?subject=Privacy%20Request">
                Send a privacy request
              </a>
            </div>
          </div>
        </section>

        <footer className="creator-notice-footer">
          <p>Last updated: July 26, 2026</p>
          <p>
            <a href="/legal/privacy-policy">Privacy Policy</a>
            <span aria-hidden="true"> · </span>
            <a href="/legal/terms-of-service">Terms of Service</a>
          </p>
        </footer>
      </main>
    </div>
  );
}
