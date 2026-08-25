# BugFalse

BugFalse is a focused browser-based coding workspace with a clean editor, live execution/output, a specialized live web workspace, and CodeAI for direct code changes.

## Product principles

- Editor first: most of the viewport belongs to code or the live web result.
- Minimal UI: secondary operations live in File, Explorer, or contextual controls.
- CodeAI is a tool, not a chat application: Fix, Improve, or a user-directed Change operate on the current file.
- Web files use a live side-by-side browser workspace instead of server-side execution.
- Live Output records meaningful execution, validation, CodeAI, and web-render events.

## Main workflows

### Files

`File` provides New File, Open File, Open Folder, Save, Rename, Download, and Delete. New files default to `untitled.txt`. Files can also be dragged into the workspace.

### Normal code

For executable languages, edit the current file, use Run or `Ctrl/Cmd+Enter`, and inspect Live Output and Problems. Live execution is debounced and newer editor revisions cannot be overwritten by stale execution responses.

### Web development

When an HTML file is active (or a web file is opened in a project containing HTML), BugFalse switches to a side-by-side editor/web workspace. HTML, CSS, and JavaScript are assembled into an isolated iframe. Changes refresh automatically and are recorded in Live Output. Console/error messages from the preview are forwarded to Live Output and Problems.

### CodeAI

The single `CodeAI` control offers:

- **Fix** — repair likely problems using current code and diagnostics.
- **Improve** — improve the current code while preserving intended behavior.
- **Change…** — wait for a specific user instruction, then apply the requested change.

AI changes are written into the editor and immediately validated/rendered. No AI chat UI is required.

## Supported language detection

Python, JavaScript, TypeScript, Java, C, C++, C#, Go, Rust, PHP, Ruby, Swift, Kotlin, HTML, CSS, JSON, SQL, Markdown, YAML, and plain text are recognized. Runtime availability is detected separately from editor support.

## Backend

FastAPI routes live in `routes/` and runtime/AI behavior is separated into services where appropriate.

Important endpoints:

- `GET /health`
- `GET /status`
- `GET /runtime/catalog`
- `POST /runtime/detect`
- `POST /execute/`
- `POST /debug/`

The legacy chatbot API remains available for backward compatibility, but the main workspace does not expose an AI chat interface.

## Environment

Set `GROQ_TOKEN` or `GROQ_API_KEY` for CodeAI. Never commit API keys.

Optional:

- `GROQ_MODEL`
- `GROQ_URL`
- `GROQ_VERIFY_SSL`
- `LOG_LEVEL`

## Local development

```bash
pip install -r requirements.txt
uvicorn app:app --reload
```

Open `http://localhost:8000`.

## Tests

```bash
pytest -q
```

The suite covers health, debug normalization, chatbot API compatibility, runtime detection, and Python execution.

## Deployment

`Dockerfile`, `Procfile`, and `render.yaml` are included. For public arbitrary-code execution, use stronger isolation than a single shared application process (container-per-job or another sandbox boundary with CPU, memory, process, filesystem, network, timeout, and output limits).
