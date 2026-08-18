# BugFalse CI / Developer Upgrade

This package adds a real automated test suite and aligns GitHub Actions with the
current FastAPI repository structure.

## What changed

- Added `pytest` and `httpx` to `requirements.txt`.
- Added `tests/` for health, status, homepage, chatbot, and debug-route behavior.
- Updated CI to compile the actual Python modules instead of nonexistent `app/` and `tests/` paths.
- CI runs tests with `python -m pytest`.
- JavaScript syntax checking safely handles an empty glob.
- Added `.gitignore` rules for caches, logs, virtual environments, and secrets.
- Added `.env.example` without real credentials.
- Kept Groq calls mocked in tests so CI never requires a real API key.

## Run locally

```bash
python -m pip install -r requirements.txt
python -m pytest -q
```

## Important

Never commit a real Groq/Gemini API key. Configure production secrets through
Render environment variables or GitHub Actions secrets.
