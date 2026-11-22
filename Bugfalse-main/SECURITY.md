# Security policy

## Reporting

Please do not publish credentials, tokens, or exploitable details in public issues. Rotate any credential accidentally committed to source control.

## Known limitations

- Local code execution is disabled by default. The optional subprocess path is not a secure multi-tenant sandbox.
- The built-in rate limiter is per process and memory-based.
- AI-generated suggestions may be incorrect and require review.
- Configure an allowlist for CORS if browser clients are hosted on another origin before enabling cross-origin access.

## Before public deployment

- Keep execution disabled or integrate an isolated container-per-job runner.
- Configure secrets in the hosting provider, not in Git.
- Use HTTPS and a shared rate-limit service or gateway.
- Review dependencies and enable automated security updates.
