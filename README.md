# BugFalse — AI-Assisted Coding Workspace

BugFalse is a browser-based Python coding workspace with an editor, execution endpoint, runtime detection, and AI-assisted code review. This strengthened package emphasizes explicit execution controls, input validation, predictable API errors, security headers, automated tests, Docker, and CI.

## Features

- Browser-based editor with sample code, output panel, and AI review actions.
- FastAPI backend with OpenAPI documentation at `/docs` (can be disabled).
- Runtime catalog and language detection.
- AI review modes: analyze, fix, improve, refactor, optimize, security, and test suggestions.
- Groq integration through environment variables; deterministic local Python syntax diagnostics when no AI key is configured.
- Request IDs, security headers, bounded request sizes, timeout for outbound AI calls, and a simple per-process rate limit.
- Pytest suite and GitHub Actions CI.
- Non-root Docker image.

## Important security boundary

**Arbitrary code execution is disabled by default.** The local execution route starts a Python subprocess and applies time/output/input limits, but this is not a complete security sandbox. Do not enable `BUGFALSE_ENABLE_LOCAL_EXECUTION=true` on a public service. Python code can potentially access host resources available to the process. For public execution, implement a dedicated container-per-job runner or a sandbox service with CPU, memory, PID, filesystem, network, wall-clock, and output limits, with no host secrets and no shared writable volumes.

## Run locally

```bash
python -m venv .venv
# Windows:
.venv\Scripts\activate
# macOS/Linux:
source .venv/bin/activate

pip install -r requirements.txt
cp .env.example .env
uvicorn app:app --reload
```

Open http://127.0.0.1:8000. Copy `.env.example` to `.env` and set `GROQ_API_KEY` for provider-backed AI review. Never commit the real `.env` file.

## Docker

```bash
cp .env.example .env
docker compose up --build
```

Open http://localhost:8000. Execution remains disabled in the container by default.

## Tests

```bash
pytest -q
```

The test suite covers health/readiness, security headers, runtime detection, execution-disabled behavior, request validation, and AI-provider failure fallback. CI runs on pushes and pull requests.

## API overview

| Method | Endpoint | Purpose |
|---|---|---|
| GET | `/health` | Health check |
| GET | `/ready` | Readiness and AI configuration status |
| GET | `/status` | Service status and execution flag |
| GET | `/runtime/catalog` | Runtime availability catalog |
| POST | `/runtime/detect` | Detect file language |
| POST | `/execute/` | Execute Python only when explicitly enabled |
| POST | `/debug/` | AI/local code review |
| GET | `/debug/status` | AI provider configuration status |

## Environment variables

- `GROQ_API_KEY` or `GROQ_TOKEN`: provider credential.
- `GROQ_MODEL`: model name accepted by your provider account.
- `GROQ_URL`: API-compatible chat-completions endpoint.
- `BUGFALSE_ENABLE_LOCAL_EXECUTION`: false by default.
- `EXECUTION_TIMEOUT_SECONDS`: local process timeout (1–10 seconds).
- `RATE_LIMIT_PER_MINUTE`: simple per-process rate limit.
- `ENABLE_API_DOCS`: show `/docs` when true.
- `LOG_LEVEL`: logging level.

## Deployment notes

- Configure environment variables in the hosting provider; never place secrets in source code.
- The included Dockerfile runs as a non-root user.
- The built-in rate limiter is process-local and not a substitute for an API gateway or shared rate-limit store.
- Configure HTTPS, trusted-host policy, centralized logging, and an external rate limiter before production use.
- AI review output is advisory; it is not proof that code is correct or safe.
