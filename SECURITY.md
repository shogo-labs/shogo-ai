# Security Policy

## Supported Versions

Security updates are provided for the latest `main` branch and the most recent
stable release tag.

If you are running an older fork or deployment, upgrade to the latest release
before reporting a security issue unless the issue prevents upgrade.

## Reporting a Vulnerability

Please do not open a public GitHub issue for security vulnerabilities.

Instead, report vulnerabilities privately by emailing:

- `security@shogo.ai`

Please include:

- A clear description of the issue
- Steps to reproduce or a proof of concept
- The affected version, commit SHA, or deployment details
- Any suggested mitigation if known

We will acknowledge receipt within 3 business days and aim to provide an
initial assessment within 7 business days.

## Scope

This repository includes open source Shogo components such as the API,
application clients, runtimes, templates, and SDK. Reports may include:

- Authentication or authorization bypasses
- Secret handling or token validation flaws
- Remote code execution or container escape risks
- Multi-tenant isolation issues
- Data exposure or privilege escalation
- Supply-chain or dependency vulnerabilities in shipped code

## Out of Scope

The following are generally out of scope unless they create a concrete security
impact:

- Requests for security best practices without a specific vulnerability
- Missing HTTP headers on local development environments
- Denial of service findings that require unrealistic resource levels
- Vulnerabilities in third-party services that are not caused by Shogo code
- Issues in unsupported or heavily modified forks

## Disclosure Process

After validating a report, we will:

1. Confirm the severity and affected versions.
2. Prepare and test a fix.
3. Coordinate a release and disclosure timeline.
4. Credit the reporter if they want public acknowledgment.

## Self-Hosted Deployments

Self-hosted operators are responsible for:

- Setting strong values for `BETTER_AUTH_SECRET`, `AI_PROXY_SECRET`, and related secrets
- Rotating leaked credentials
- Keeping dependencies and infrastructure patched
- Configuring network access, TLS, backups, and monitoring appropriately

## Safe Harbor

We support good-faith security research intended to improve the safety of the
project. Please avoid privacy violations, destructive testing, or service
disruption while investigating.
