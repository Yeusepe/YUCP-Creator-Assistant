# Security Policy

## Supported Versions

This repository is actively supported on the latest commits in the following branches:

| Branch | Supported |
| --- | --- |
| `main` | Yes |
| `develop` | Yes |
| Older branches, tags, or commits | No |

If you are running a self-hosted deployment, update to the latest supported branch before requesting a security review.

## Reporting a Vulnerability

Please report suspected vulnerabilities privately to **[contact@yucp.club](mailto:contact@yucp.club?subject=%5BSecurity%20Report%5D%20%3Cshort%20summary%3E&body=Hello%20YUCP%20Security%20Team%2C%0A%0AI%20am%20reporting%20a%20suspected%20security%20vulnerability%20in%20YUCP%20Creator%20Assistant.%0A%0AReporter%20details%0A-%20Name%20or%20handle%3A%0A-%20Preferred%20reply%20email%3A%0A-%20Public%20credit%20name%2C%20if%20different%20(optional)%3A%0A-%20Time%20zone%20%2F%20best%20time%20to%20reach%20you%20(optional)%3A%0A%0AVulnerability%20summary%0A-%20Affected%20product%2C%20component%2C%20route%2C%20job%2C%20or%20provider%20integration%3A%0A-%20Environment%20(production%2C%20staging%2C%20self-hosted%2C%20local%2C%20unknown)%3A%0A-%20Branch%2C%20commit%20SHA%2C%20version%2C%20or%20deployment%20URL%3A%0A-%20Vulnerability%20type%3A%0A-%20Short%20summary%3A%0A%0AReproduction%20details%0A-%20Preconditions%2C%20required%20roles%2C%20or%20required%20configuration%3A%0A-%20Step-by-step%20reproduction%3A%0A%20%201.%0A%20%202.%0A%20%203.%0A-%20Expected%20result%3A%0A-%20Actual%20result%3A%0A%0AImpact%0A-%20Security%20impact%3A%0A-%20Accounts%2C%20data%2C%20creators%2C%20customers%2C%20tenants%2C%20or%20integrations%20affected%3A%0A-%20Is%20the%20issue%20reproducible%20consistently%3F%3A%0A-%20Is%20there%20evidence%20of%20active%20exploitation%3F%3A%0A%0AEvidence%0A-%20Proof%20of%20concept%20or%20exploit%20steps%3A%0A-%20Relevant%20requests%2C%20responses%2C%20logs%2C%20screenshots%2C%20traces%2C%20or%20payloads%3A%0A-%20Have%20secrets%20and%20personal%20data%20been%20redacted%3F%3A%0A-%20Were%20any%20exposed%20credentials%20or%20session%20values%20rotated%3F%3A%0A%0AOptional%20context%0A-%20Suspected%20root%20cause%20or%20suggested%20remediation%3A%0A-%20Related%20standards%20or%20references%3A%0A-%20Disclosure%20preferences%20or%20requested%20coordination%20timeline%3A%0A-%20Anything%20else%20we%20should%20know%3A%0A%0AThank%20you%2C%0A%3Cname%20or%20handle%3E)**, or through our [security advisory](https://github.com/Yeusepe/YUCP-Creator-Assistant/security/advisories/new). 


Do **not** open a public GitHub issue, pull request, discussion, or Discord post for security reports. Public disclosure before a fix is available can put users, creators, and connected integrations at risk.

When possible, include:

1. A short summary of the issue and the affected component or integration.
2. Clear reproduction steps, including required configuration or permissions.
3. The potential impact, such as credential exposure, account takeover, privilege escalation, data disclosure, or webhook abuse.
4. The relevant branch, commit SHA, or deployment details.
5. A proof of concept, logs, screenshots, or request samples with secrets redacted.

If the report involves exposed credentials, tokens, or session material, rotate them first if you safely can and note that in the report.
### Vulnerability report email template

```text
To: contact@yucp.club
Subject: [Security Report] <short summary>

Hello YUCP Security Team,

I am reporting a suspected security vulnerability in YUCP Creator Assistant.

Reporter details
- Name or handle:
- Preferred reply email:
- Public credit name, if different (optional):
- Time zone / best time to reach you (optional):

Vulnerability summary
- Affected product, component, route, job, or provider integration:
- Environment (production, staging, self-hosted, local, unknown):
- Branch, commit SHA, version, or deployment URL:
- Vulnerability type:
- Short summary:

Reproduction details
- Preconditions, required roles, or required configuration:
- Step-by-step reproduction:
  1.
  2.
  3.
- Expected result:
- Actual result:

Impact
- Security impact:
- Accounts, data, creators, customers, tenants, or integrations affected:
- Is the issue reproducible consistently?:
- Is there evidence of active exploitation?:

Evidence
- Proof of concept or exploit steps:
- Relevant requests, responses, logs, screenshots, traces, or payloads:
- Have secrets and personal data been redacted?:
- Were any exposed credentials or session values rotated?:

Optional context
- Suspected root cause or suggested remediation:
- Related standards or references:
- Disclosure preferences or requested coordination timeline:
- Anything else we should know:

Thank you,
<name or handle>
```

## What to Expect

We aim to:

1. Acknowledge receipt within 5 business days.
2. Triage the report and determine severity and impact.
3. Work on a fix and coordinate disclosure once users can reasonably protect themselves.

Response and remediation time will vary based on severity, exploitability, and whether the issue affects third-party providers or infrastructure outside this repository.

## Disclosure Guidelines

Please use coordinated disclosure:

1. Give us a reasonable opportunity to investigate and remediate the issue before public disclosure.
2. Avoid accessing, modifying, or deleting data that does not belong to you.
3. Avoid disrupting production systems, degrading service, or sending excessive traffic.
4. Avoid social engineering, phishing, or physical attacks.

We appreciate well-researched reports that help protect creators, customers, and connected platforms.
