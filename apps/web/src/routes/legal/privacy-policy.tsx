import { createFileRoute } from '@tanstack/react-router';
import { useEffect, useState } from 'react';
import { BackgroundCanvasRoot } from '@/components/page/BackgroundCanvasRoot';
import { routeStyleHrefs, routeStylesheetLinks } from '@/lib/routeStyles';

export const Route = createFileRoute('/legal/privacy-policy')({
  head: () => ({
    meta: [{ title: 'Privacy Policy | Creator Assistant' }],
    links: routeStylesheetLinks(routeStyleHrefs.legal),
  }),
  component: PrivacyPolicyPage,
});

function PrivacyPolicyPage() {
  const [isVisible, setIsVisible] = useState(false);

  useEffect(() => {
    setIsVisible(true);
  }, []);

  return (
    <div className={`legal-page${isVisible ? ' is-visible' : ''}`}>
      <BackgroundCanvasRoot position="fixed" />
      <main className="max-w-3xl mx-auto px-4 sm:px-6 pb-10 sm:pb-16 md:pb-20">
        <header className="mb-10 sm:mb-16">
          <p className="text-[#0ea5e9] font-bold uppercase tracking-[0.3em] text-xs mb-8">
            Legal &amp; Compliance
          </p>
          <div className="flex flex-col items-center gap-8 mb-8">
            <img
              src="/Icons/MainLogo.png"
              alt="Creator Assistant logo"
              className="h-12 sm:h-14 md:h-16 object-contain max-w-full w-auto flex-shrink-0"
            />
            <h1 className="text-4xl sm:text-5xl lg:text-6xl text-center">Privacy Policy</h1>
          </div>
          <p className="text-base sm:text-xl opacity-70 leading-relaxed font-medium">
            <strong>Effective date:</strong> March 6, 2026 &nbsp;|&nbsp;{' '}
            <strong>Last updated:</strong> July 26, 2026
          </p>
        </header>

        <div className="space-y-6 custom-scrollbar">
          <div id="intro" className="legal-card rounded-2xl p-5 sm:p-8">
            <p className="leading-relaxed mb-4">
              This Privacy Policy explains how <strong>Creator Assistant</strong> (&quot;we&quot;,
              &quot;us&quot;, or &quot;our&quot;) collects, uses, discloses, stores, and protects
              personal data when you use the Creator Assistant services, including our websites,
              setup pages, dashboards, APIs, webhook endpoints, Discord® bot, verification flows,
              Liened Downloads, collaborator sharing flows, package storage and delivery, device
              attestation, attribution review, Unity® importer integration, and related features
              (collectively, the &quot;Service&quot;).
            </p>
            <h4 className="mt-6">Who is responsible for your data</h4>
            <p className="leading-relaxed">
              <strong>Creator Assistant</strong> acts as a controller for purposes and essential
              means that we determine. A Creator can act as a controller for product mappings,
              access rules, and their use of verification results. We can act as a processor when we
              follow a Creator&apos;s documented instructions. The role depends on the facts of each
              processing activity.
            </p>
            <p className="leading-relaxed mt-4">
              Legal source:{' '}
              <a
                href="https://www.edpb.europa.eu/documents/guideline/guidelines-072020-on-the-concepts-of-controller-and-processor-in-the-gdpr_en"
                target="_blank"
                rel="noreferrer"
              >
                EDPB Guidelines 07/2020
              </a>
              .
            </p>
            <p className="leading-relaxed mt-4">
              This Privacy Policy should be read together with our Terms of Service. If you do not
              agree with this Privacy Policy, do not use the Service.
            </p>
            <p className="leading-relaxed mt-4">
              Creators can link buyers to our{' '}
              <a href="/legal/verification-and-attestation">Verification and Attestation Notice</a>{' '}
              for a shorter explanation of package verification.
            </p>
            <p className="leading-relaxed mt-4">
              That notice explains YUCP processing. It does not replace a Creator&apos;s privacy
              notice, processing agreement, or legal review.
            </p>
            <p
              className="leading-relaxed mt-4 p-4 rounded-xl"
              style={{
                background: 'rgba(255,255,255,0.06)',
                border: '1px solid rgba(255,255,255,0.1)',
              }}
            >
              <strong>Third-Party Disclaimer:</strong> Gumroad®; Discord®; VRChat®; Unity®; Jinxxy™;
              PostHog®; and other product or company names mentioned herein are trademarks or
              registered trademarks of their respective owners. Creator Assistant is not connected
              with, endorsed by, sponsored by, collaborating with, or otherwise associated with any
              of these companies.
            </p>
          </div>

          <div id="section-01" className="legal-card rounded-2xl p-5 sm:p-8">
            <div className="section-header">
              <span className="section-tag bg-white/10 text-white">Section 01</span>
              <h2 className="text-2xl">Who This Policy Covers</h2>
            </div>
            <p>This Privacy Policy applies to people who interact with the Service, including:</p>
            <ul>
              <li>
                creators, sellers, studios, collaborators, moderators, and community operators who
                install or configure the Service
              </li>
              <li>
                Discord® server owners, administrators, and staff members who manage verification,
                downloads, settings, moderation, or analytics
              </li>
              <li>
                end users who link accounts, submit license keys, verify purchases, receive Discord®
                roles, or access liened downloads
              </li>
              <li>
                developers or operators who access our APIs, setup pages, or webhook endpoints
              </li>
            </ul>
            <p>
              In some cases, a Creator or community operator may act as the primary decision maker
              for how the Service is configured in their server. In those cases, that Creator or
              operator may have separate privacy obligations to their own community.
            </p>
          </div>

          <div id="section-02" className="legal-card rounded-2xl p-5 sm:p-8">
            <div className="section-header">
              <span className="section-tag bg-[#0ea5e9]/10 text-[#0ea5e9]">Section 02</span>
              <h2 className="text-2xl">The Data We Collect</h2>
            </div>
            <h4>2.1 Data you provide directly</h4>
            <ul>
              <li>account linking and setup information</li>
              <li>license keys, license claims, or other verification inputs</li>
              <li>
                provider credentials such as API keys, access tokens, refresh tokens, webhook
                secrets, and setup tokens
              </li>
              <li>
                product mappings, role rules, settings, moderation inputs, and download route
                configuration
              </li>
              <li>support messages, feedback, and communications you send to us</li>
            </ul>
            <h4>2.2 Data we receive from connected providers</h4>
            <ul>
              <li>
                Discord® data such as user IDs, guild IDs, role IDs, channel IDs, usernames, display
                names, and profile metadata
              </li>
              <li>
                Gumroad® data such as product IDs, order IDs, sale identifiers, customer
                identifiers, timestamps, refund status, and related purchase records
              </li>
              <li>
                Jinxxy™ data such as store identifiers, product identifiers, sale records, license
                references, and webhook payload data
              </li>
            </ul>
            <h4>2.3 Data generated through use of the Service</h4>
            <ul>
              <li>
                verification session records, OAuth state records, entitlement records, and subject
                identity records
              </li>
              <li>event logs, audit logs, security logs, sync logs, and troubleshooting records</li>
              <li>
                analytics and operational metrics such as command usage, setup progress, and
                workflow outcomes
              </li>
              <li>download route and download artifact metadata for Liened Downloads</li>
              <li>
                Unity® runtime assertion and installation-related records when that feature is
                enabled
              </li>
            </ul>
          </div>

          <div id="section-03" className="legal-card rounded-2xl p-5 sm:p-8">
            <div className="section-header">
              <span className="section-tag bg-[#00e676]/10 text-[#00e676]">Section 03</span>
              <h2 className="text-2xl">How We Collect Data</h2>
            </div>
            <ul>
              <li>when you install, connect, configure, or use the Service</li>
              <li>when you authenticate with Discord®, Gumroad®, or Jinxxy™</li>
              <li>when providers send us webhooks or API responses</li>
              <li>
                when Creators trigger manual sync, backfill, moderation, or download management
                actions
              </li>
              <li>
                when end users run verification commands, complete connect flows, or request
                protected downloads
              </li>
              <li>
                when Unity® installations request runtime assertions or related validation data
              </li>
            </ul>
          </div>

          <div id="section-04" className="legal-card rounded-2xl p-5 sm:p-8">
            <div className="section-header">
              <span className="section-tag bg-[#ffeb3b]/10 text-[#ffeb3b]">Section 04</span>
              <h2 className="text-2xl">How We Use Data</h2>
            </div>
            <p>
              We use data to operate, secure, improve, and support the Service. This includes using
              data to:
            </p>
            <ul>
              <li>install, authenticate, and maintain provider connections</li>
              <li>complete verification flows and purchase or license matching</li>
              <li>create, update, revoke, or sync entitlements and Discord® roles</li>
              <li>deliver and protect Liened Downloads</li>
              <li>support collaborator sharing flows and shared-store verification</li>
              <li>issue Unity® runtime assertions and validate Unity® integrations</li>
              <li>
                maintain audit trails, detect abuse, investigate suspicious activity, and enforce
                Service policies
              </li>
              <li>measure reliability, debug errors, and improve features</li>
              <li>
                communicate about the Service, support requests, incidents, updates, or legal
                notices
              </li>
            </ul>
          </div>

          <div id="section-05" className="legal-card rounded-2xl p-5 sm:p-8">
            <div className="section-header">
              <span className="section-tag bg-white/10 text-white">Section 05</span>
              <h2 className="text-2xl">Liened Downloads</h2>
            </div>
            <p>
              Liened Downloads is designed to protect qualifying attachments in Discord® while
              keeping creators in control of their own communities.
            </p>
            <ul>
              <li>
                we may process source message metadata, author IDs, channel IDs, role requirements,
                and file metadata
              </li>
              <li>
                we may create private forwarded delivery or review records inside Discord® to
                support protected delivery workflows
              </li>
              <li>
                we store file metadata and Discord® message references needed to operate the feature
              </li>
              <li>
                we do not intentionally store protected file contents in our own external storage as
                part of the standard Liened Downloads flow
              </li>
              <li>
                download access is checked against the role requirements configured by the Creator
              </li>
            </ul>
            <p>
              Creators remain responsible for how they configure download routes, who can access
              review channels, and whether their communities receive the notices required for their
              own use cases.
            </p>
          </div>

          <div id="section-06" className="legal-card rounded-2xl p-5 sm:p-8">
            <div className="section-header">
              <span className="section-tag bg-[#0ea5e9]/10 text-[#0ea5e9]">Section 06</span>
              <h2 className="text-2xl">Credentials and Sensitive Data</h2>
            </div>
            <p>
              Some Service features require sensitive credentials or verification inputs. Depending
              on the feature, we may process:
            </p>
            <ul>
              <li>OAuth access tokens and refresh tokens</li>
              <li>API keys and webhook secrets</li>
              <li>license keys or hashed versions of license keys</li>
              <li>
                session cookies, CSRF-related values, setup tokens, and one-time invite tokens
              </li>
            </ul>
            <p>
              We use these values only as needed to operate the related feature, maintain the
              connection, validate requests, or enforce security.
            </p>
          </div>

          <div id="section-07" className="legal-card rounded-2xl p-5 sm:p-8">
            <div className="section-header">
              <span className="section-tag bg-[#00e676]/10 text-[#00e676]">Section 07</span>
              <h2 className="text-2xl">Collaborator Sharing and Shared Stores</h2>
            </div>
            <p>
              If a Creator uses collaborator sharing, we may process invite tokens, collaborator
              account information, shared store identifiers, API key access status, webhook routing
              information, and related audit records.
            </p>
            <p>
              We use this data only to support the collaborator relationship requested by the
              Creator and Collaborator, operate the selected integration mode, and keep appropriate
              records of that connection.
            </p>
          </div>

          <div id="package-delivery" className="legal-card rounded-2xl p-5 sm:p-8">
            <div className="section-header">
              <span className="section-tag bg-[#ffeb3b]/10 text-[#ffeb3b]">Section 08</span>
              <h2 className="text-2xl">Package Delivery, Attestation, and Attribution</h2>
            </div>
            <p>
              The package delivery flow checks an entitlement before it grants access. Depending on
              the selected method, we process the following records:
            </p>
            <ul>
              <li>
                account, creator, product, edition, provider, order, license, entitlement, release,
                and installation references
              </li>
              <li>
                short-lived verification and installation sessions, delivery authorization records,
                security proof records, replay-prevention values, and expiration times
              </li>
              <li>
                cryptographic hashes derived from supported device, operating system, network,
                payment, license, and linked-account signals
              </li>
              <li>
                device attestation results, security flags, confidence values, correlation
                identifiers, and review decisions
              </li>
              <li>
                buyer pseudonyms, attribution identifiers, attribution token hashes, signed package
                preparation records, and protected-file integrity hashes
              </li>
              <li>
                package source uploads, prepared package files, shared file parts, protected source
                files, signed release records, and short-lived buyer-specific packages
              </li>
            </ul>
            <p>
              We use these records to verify access, bind a grant to a buyer and device, deliver a
              release, detect replay, investigate tampering, and support authorized attribution
              review.
            </p>
            <p>
              Creators can receive verification status, matched product context, delivery status,
              and authorized attribution matches. They do not receive YUCP master or derivation
              keys.
            </p>
            <p>
              We treat a hash as personal data when it can be linked to a person, account, device,
              or purchase. The GDPR defines personal data and pseudonymisation in Article 4.
            </p>
            <p>
              Legal source:{' '}
              <a
                href="https://eur-lex.europa.eu/eli/reg/2016/679/oj/eng"
                target="_blank"
                rel="noreferrer"
              >
                GDPR Articles 4, 12, 13, and 14
              </a>
              . Plain-language product notice:{' '}
              <a href="/legal/verification-and-attestation">Verification and Attestation Notice</a>.
            </p>
          </div>

          <div id="section-09" className="legal-card rounded-2xl p-5 sm:p-8">
            <div className="section-header">
              <span className="section-tag bg-white/10 text-white">Section 09</span>
              <h2 className="text-2xl">Cookies, Browser Storage, and Similar Technologies</h2>
            </div>
            <p>
              Our setup pages, connect flows, and dashboards use cookies and similar storage. We use
              only first-party cookies; we do not set third-party advertising cookies. The following
              categories apply:
            </p>
            <ul>
              <li>
                <strong>Essential / strictly necessary:</strong> Session cookies for authentication,
                CSRF tokens, and state needed for OAuth, setup, and verification flows. These are
                required for the Service to function. Duration: session or short-lived (typically up
                to 24 hours).
              </li>
              <li>
                <strong>Security / session:</strong> Cookies that maintain login state, protect
                against forgery, and keep connect or verification flows working. Duration: session
                or a few hours.
              </li>
              <li>
                <strong>Optional diagnostics:</strong> If you opt in to helpful diagnostics, we may
                use first-party cookies or similar browser storage to remember that choice and
                enable anonymous diagnostics tooling, including HyperDX-powered error, performance,
                and session-replay debugging. These diagnostics are used to investigate bugs and
                slow pages, not for advertising, resale, or cross-site profiling. You can change
                this at any time from account privacy settings.
              </li>
            </ul>
            <p>
              We do not use support chat widgets or embedded third-party tools that set cookies on
              our setup pages. If we add such tools in the future, we will update this section.
            </p>
            <p>
              <strong>How to manage cookies:</strong> Your browser settings let you block or clear
              cookies. Blocking essential or session cookies will prevent setup, connect, and
              verification flows from working. Where consent is required by law, we will obtain it
              before setting non-essential cookies.
            </p>
          </div>

          <div id="section-10" className="legal-card rounded-2xl p-5 sm:p-8">
            <div className="section-header">
              <span className="section-tag bg-[#0ea5e9]/10 text-[#0ea5e9]">Section 10</span>
              <h2 className="text-2xl">When We Share Data</h2>
            </div>
            <p>We may share or disclose data in the following circumstances:</p>
            <ul>
              <li>
                with Connected Providers (Discord®, Gumroad®, Jinxxy™) when needed to complete the
                feature you requested
              </li>
              <li>
                with service providers that supply database, authentication, object storage, content
                delivery, infrastructure, observability, email, and secret-management functions
              </li>
              <li>
                with a Creator, Admin, or server operator when the Service is being used on their
                behalf and the disclosure is necessary for that workflow
              </li>
              <li>to comply with law, legal process, or lawful requests from public authorities</li>
              <li>
                to protect the rights, property, security, or integrity of the Service, our users,
                or others
              </li>
              <li>
                in connection with a merger, acquisition, financing, reorganization, or sale of
                assets
              </li>
            </ul>
            <p>
              The provider list depends on the active deployment and selected feature. Request the
              current list at <a href="mailto:privacy@yucp.club">privacy@yucp.club</a>.
            </p>
            <p>We do not sell personal data in exchange for money.</p>
          </div>

          <div id="section-11" className="legal-card rounded-2xl p-5 sm:p-8">
            <div className="section-header">
              <span className="section-tag bg-[#00e676]/10 text-[#00e676]">Section 11</span>
              <h2 className="text-2xl">Legal Bases</h2>
            </div>
            <p>
              Where required by law, we rely on one or more legal bases to process personal data,
              including:
            </p>
            <ul>
              <li>performance of a contract or steps requested before entering one</li>
              <li>our legitimate interests in operating, securing, and improving the Service</li>
              <li>consent, where a feature or jurisdiction requires it</li>
              <li>compliance with legal obligations</li>
            </ul>
            <p>
              Legal source:{' '}
              <a
                href="https://commission.europa.eu/law/law-topic/data-protection/information-business-and-organisations/legal-grounds-processing-data_en"
                target="_blank"
                rel="noreferrer"
              >
                European Commission legal grounds guide
              </a>
              .
            </p>
          </div>

          <div id="section-12" className="legal-card rounded-2xl p-5 sm:p-8">
            <div className="section-header">
              <span className="section-tag bg-[#ffeb3b]/10 text-[#ffeb3b]">Section 12</span>
              <h2 className="text-2xl">International Transfers</h2>
            </div>
            <p>
              The Service may use infrastructure, providers, or support operations located in more
              than one country. As a result, your data may be transferred to or processed in
              jurisdictions other than your own.
            </p>
            <p>
              Where required by law, we use appropriate transfer mechanisms, which may include:
              adequacy decisions (where the destination country is recognized as providing adequate
              protection), standard contractual clauses (SCCs) approved by the European Commission
              or equivalent authorities, and supplementary measures where necessary. You may request
              details of the safeguards we use for specific transfers by contacting us.
            </p>
            <p>
              Legal source:{' '}
              <a
                href="https://commission.europa.eu/law/law-topic/data-protection/international-dimension-data-protection_en"
                target="_blank"
                rel="noreferrer"
              >
                European Commission international transfer guide
              </a>
              .
            </p>
          </div>

          <div id="retention" className="legal-card rounded-2xl p-5 sm:p-8">
            <div className="section-header">
              <span className="section-tag bg-white/10 text-white">Section 13</span>
              <h2 className="text-2xl">Data Retention</h2>
            </div>
            <p>We apply criteria for each record type. We do not use one period for all records.</p>
            <ul>
              <li>
                <strong>Sessions and access records:</strong> We use their recorded expiry and
                completion state.
              </li>
              <li>
                <strong>Provider credentials:</strong> We use connection status, revocation,
                replacement, and provider expiry.
              </li>
              <li>
                <strong>Package source and release records:</strong> We use upload status, release
                status, dependency references, recovery needs, and active retention controls.
              </li>
              <li>
                <strong>Temporary delivery files:</strong> We use their recorded expiry, access
                qualification, and cleanup state.
              </li>
              <li>
                <strong>Entitlement and attribution evidence:</strong> We use license status,
                dispute needs, creator policy, security review, and applicable legal duties.
              </li>
              <li>
                <strong>Security and audit records:</strong> We use incident, abuse, fraud, support,
                accounting, legal-claim, and system-integrity needs.
              </li>
            </ul>
            <p>
              We review or delete records when their criteria no longer apply. A legal hold,
              unresolved dispute, or mandatory duty can delay deletion.
            </p>
            <p>
              Legal source:{' '}
              <a
                href="https://commission.europa.eu/law/law-topic/data-protection/rules-business-and-organisations/principles-gdpr/how-long-can-data-be-kept-and-it-necessary-update-it_en"
                target="_blank"
                rel="noreferrer"
              >
                European Commission retention guidance
              </a>
              .
            </p>
          </div>

          <div id="section-14" className="legal-card rounded-2xl p-5 sm:p-8">
            <div className="section-header">
              <span className="section-tag bg-[#0ea5e9]/10 text-[#0ea5e9]">Section 14</span>
              <h2 className="text-2xl">Security</h2>
            </div>
            <p>
              We use reasonable technical and organizational safeguards designed to protect the
              Service and the data we process. These measures may include access controls,
              encryption or hashing where appropriate, scoped credentials, audit trails, and abuse
              prevention measures.
            </p>
            <p>No system is perfectly secure, and we cannot guarantee absolute security.</p>
            <h4>14.1 Security incidents</h4>
            <p>
              If a security incident occurs that affects your personal data, we will provide notice
              where required by law and where operationally feasible. We will describe the nature of
              the incident, the data affected, and the steps we are taking. Contact us if you have
              concerns about a potential incident.
            </p>
          </div>

          <div id="section-15" className="legal-card rounded-2xl p-5 sm:p-8">
            <div className="section-header">
              <span className="section-tag bg-[#00e676]/10 text-[#00e676]">Section 15</span>
              <h2 className="text-2xl">Your Choices and Rights</h2>
            </div>
            <p>
              Depending on where you live, you may have rights relating to your personal data, such
              as rights to:
            </p>
            <ul>
              <li>request access to certain personal data we hold about you</li>
              <li>request correction of inaccurate or incomplete data</li>
              <li>request deletion of certain data, subject to legal and operational limits</li>
              <li>request restriction of certain processing</li>
              <li>object to certain processing</li>
              <li>request data portability where applicable</li>
              <li>withdraw consent where processing depends on consent</li>
            </ul>
            <h4>15.1 How to submit a request</h4>
            <p>
              Send your request to <a href="mailto:privacy@yucp.club">privacy@yucp.club</a> with the
              subject line &quot;Privacy Request.&quot; Include your Discord® user ID, the server or
              tenant involved (if applicable), and a clear description of the right you wish to
              exercise. For access or portability requests, we may ask you to verify your identity
              (e.g., by confirming control of the linked Discord® account or providing additional
              information we can match to our records). We respond within the period required by the
              law that applies to the request.
            </p>
            <h4>15.2 Directing requests to Creators</h4>
            <p>
              Some requests may need to be directed to the Creator or server operator who configured
              the Service for their community-for example, when the data was processed on their
              behalf or when they control access decisions. We will tell you if your request should
              go to a Creator instead.
            </p>
            <h4>15.3 EEA, UK, California, and Colombia rights</h4>
            <p>
              <strong>EEA and UK:</strong> If you are in the European Economic Area or the United
              Kingdom, you have rights under the GDPR (and UK GDPR), including access,
              rectification, erasure, restriction, portability, and objection. If you are in the EEA
              or UK, you also have the right to lodge a complaint with your local data protection
              authority.
            </p>
            <p>
              Official sources:{' '}
              <a
                href="https://commission.europa.eu/law/law-topic/data-protection/information-individuals_en"
                target="_blank"
                rel="noreferrer"
              >
                European Commission rights guide
              </a>{' '}
              and{' '}
              <a
                href="https://www.gov.uk/data-protection/the-data-protection-act"
                target="_blank"
                rel="noreferrer"
              >
                GOV.UK data protection guide
              </a>
              .
            </p>
            <p>
              United Kingdom primary texts:{' '}
              <a
                href="https://www.legislation.gov.uk/eur/2016/679/contents"
                target="_blank"
                rel="noreferrer"
              >
                UK GDPR
              </a>{' '}
              and{' '}
              <a
                href="https://www.legislation.gov.uk/ukpga/2018/12/contents"
                target="_blank"
                rel="noreferrer"
              >
                Data Protection Act 2018
              </a>
              .
            </p>
            <p>
              <strong>California:</strong> California residents can have rights to know, delete,
              correct, limit, opt out, and receive equal treatment. Conditions and exceptions can
              apply. We do not sell personal data. Use the process in 15.1 to submit a request.
            </p>
            <p>
              California source:{' '}
              <a href="https://cppa.ca.gov/faq.html" target="_blank" rel="noreferrer">
                California Privacy Protection Agency FAQ
              </a>
              . Primary text:{' '}
              <a
                href="https://leginfo.legislature.ca.gov/faces/codes_displayText.xhtml?article=&chapter=&division=3.&lawCode=CIV&part=4.&title=1.81.5."
                target="_blank"
                rel="noreferrer"
              >
                California Civil Code
              </a>
              .
            </p>
            <p>
              <strong>Colombia:</strong> Law 1581 can provide rights to know, update, correct,
              request information, complain, revoke authorization, request deletion, and access
              personal data.
            </p>
            <p>
              Colombia source:{' '}
              <a
                href="https://www1.funcionpublica.gov.co/eva/gestornormativo/norma.php?i=49981"
                target="_blank"
                rel="noreferrer"
              >
                Colombia Law 1581 of 2012
              </a>
              .
            </p>
          </div>

          <div id="section-16" className="legal-card rounded-2xl p-5 sm:p-8">
            <div className="section-header">
              <span className="section-tag bg-[#ffeb3b]/10 text-[#ffeb3b]">Section 16</span>
              <h2 className="text-2xl">Children</h2>
            </div>
            <p>
              The Service is not directed to children under 13 or under the age required by
              applicable local law in your jurisdiction, whichever is higher. If you believe a child
              has provided personal data in violation of applicable law, contact us and we will
              review the request.
            </p>
          </div>

          <div id="section-17" className="legal-card rounded-2xl p-5 sm:p-8">
            <div className="section-header">
              <span className="section-tag bg-white/10 text-white">Section 17</span>
              <h2 className="text-2xl">Third-Party Services</h2>
            </div>
            <p>
              The Service depends on third-party platforms and providers, including Discord®,
              Gumroad®, Jinxxy™, Unity®, infrastructure providers, hosting providers, and analytics
              or support tools. Their privacy practices are governed by their own terms and
              policies.
            </p>
            <p>
              We are not responsible for the privacy or security practices of third-party services.
            </p>
          </div>

          <div id="section-18" className="legal-card rounded-2xl p-5 sm:p-8">
            <div className="section-header">
              <span className="section-tag bg-[#0ea5e9]/10 text-[#0ea5e9]">Section 18</span>
              <h2 className="text-2xl">Changes to This Policy</h2>
            </div>
            <p>
              We may update this Privacy Policy from time to time. If we make a material change, we
              may provide notice through the Service, by email, through a setup page, in a
              dashboard, or by other reasonable means. The updated Privacy Policy will become
              effective on the stated effective date.
            </p>
          </div>

          <div id="contact" className="legal-card rounded-2xl p-5 sm:p-8">
            <div className="section-header">
              <span className="section-tag bg-[#0ea5e9]/10 text-[#0ea5e9]">Contact</span>
              <h2 className="text-2xl">How to Contact Us</h2>
            </div>
            <p>
              Creator Assistant acts as a controller when it determines a processing purpose and its
              essential means. It can act as a processor for a Creator&apos;s documented
              instructions.
            </p>
            <p>
              <strong>Creator Assistant</strong>
            </p>
            <p>
              Privacy email: <a href="mailto:privacy@yucp.club">privacy@yucp.club</a>
            </p>
            <p>
              General contact: <a href="mailto:contact@yucp.club">contact@yucp.club</a>
            </p>
            <p>
              If your request relates to a specific Creator, Server, or verification flow, include
              enough detail for us to identify the relevant account, server, or transaction.
            </p>
            <p>
              Role guidance:{' '}
              <a
                href="https://www.edpb.europa.eu/documents/guideline/guidelines-072020-on-the-concepts-of-controller-and-processor-in-the-gdpr_en"
                target="_blank"
                rel="noreferrer"
              >
                EDPB Guidelines 07/2020
              </a>
              .
            </p>
          </div>
        </div>
      </main>
    </div>
  );
}
