# BugFalse — ErrorHunter AI Coding Workspace

BugFalse is a multi-file, browser-based AI coding and debugging workspace powered by Monaco Editor, FastAPI, and Groq. Write code, import local files/folders, or paste a public GitHub repository link to inspect, preview, and fix code with AI.

## Key Features

- **Multi-Source Code Loading**: Write code from scratch, drag & drop local files/folders, or import source files directly from any public GitHub repository URL (`https://github.com/owner/repo`, branch URLs, or `owner/repo`) via a single zipball download.
- **Monaco Editor & Live Web Preview**: Syntax-highlighted multi-tab editor with file explorer, live HTML/CSS/JS split preview (Desktop/Tablet/Mobile viewports), and console error bridge.
- **CodeAI Assistant**: One-click AI analysis, bug fixing, refactoring, security auditing, test generation, and custom instructions—plus local Python syntax diagnostics when offline or unconfigured.
- **Explicit Execution Controls**: Subprocess execution disabled by default (`BUGFALSE_ENABLE_LOCAL_EXECUTION=false`), request IDs, security headers, rate limiting, and non-root Docker support.

## Run Locally

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

Open `http://127.0.0.1:8000`.

## Run Tests

```bash
pytest -q
```
