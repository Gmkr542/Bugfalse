import json
import os
import re
from typing import Any

import requests
from fastapi import APIRouter, HTTPException
from pydantic import BaseModel, Field

from services.groq_service import (
    GROQ_MODEL,
    GROQ_URL,
    _session,
    analyze_code as groq_analyze,
    resolve_model,
)

router = APIRouter()
MAX_CODE_CHARS = 100_000
ALLOWED_MODES = {"analyze", "fix", "improve", "update", "refactor", "optimize", "security", "tests", "custom"}
ALLOWED_REPO_MODES = {"overview", "audit", "update"}


class DebugRequest(BaseModel):
    code: str = Field(..., min_length=1, max_length=MAX_CODE_CHARS)
    filename: str = Field(default="main.py", max_length=160)
    language: str | None = None
    framework: str | None = None
    mode: str = "analyze"
    instruction: str | None = Field(default=None, max_length=3000)
    apiKey: str | None = None


class RepoDebugRequest(BaseModel):
    files: dict[str, str] = Field(..., min_length=1)
    mode: str = Field(default="overview")
    instruction: str | None = Field(default=None, max_length=3000)
    repo_name: str | None = Field(default=None, max_length=200)
    apiKey: str | None = None


def local_python_hint(code: str, filename: str):
    if not filename.lower().endswith(".py"):
        return []
    try:
        compile(code, filename, "exec")
        return []
    except SyntaxError as exc:
        return [{
            "severity": "error",
            "type": "SyntaxError",
            "message": exc.msg,
            "line": exc.lineno,
            "column": exc.offset,
        }]


def _build_repo_bundle(files: dict[str, str], max_total_chars: int = 48_000) -> tuple[str, list[str]]:
    priority_names = {"readme.md", "app.py", "main.py", "index.py", "package.json", "requirements.txt", "index.html"}
    ordered = sorted(
        files.items(),
        key=lambda kv: (0 if kv[0].split("/")[-1].lower() in priority_names else 1, kv[0].count("/"), kv[0]),
    )
    manifest = [f"- {path} ({len(content)} chars)" for path, content in ordered]
    chunks = ["REPOSITORY FILE MANIFEST:\n" + "\n".join(manifest)]
    used = len(chunks[0])
    included_paths: list[str] = []

    for path, content in ordered:
        per_file_cap = 9_000
        snippet = content if len(content) <= per_file_cap else content[:per_file_cap] + "\n# ... [truncated] ..."
        block = f"\n=== FILE: {path} ===\n{snippet}"
        if used + len(block) > max_total_chars:
            continue
        chunks.append(block)
        used += len(block)
        included_paths.append(path)

    return "\n".join(chunks), included_paths


def _parse_json_object(raw_text: str) -> dict[str, Any]:
    cleaned = raw_text.strip()
    if cleaned.startswith("```"):
        cleaned = re.sub(r"^```(?:json)?\s*|\s*```$", "", cleaned, flags=re.IGNORECASE | re.DOTALL).strip()
    try:
        parsed = json.loads(cleaned)
        if isinstance(parsed, dict):
            return parsed
    except Exception:
        pass
    match = re.search(r"\{.*\}", cleaned, flags=re.DOTALL)
    if match:
        try:
            parsed = json.loads(match.group(0))
            if isinstance(parsed, dict):
                return parsed
        except Exception:
            pass
    return {"summary": cleaned}


@router.post("/")
async def debug(payload: DebugRequest):
    if not payload.code.strip():
        raise HTTPException(status_code=422, detail="Field 'code' must not be empty.")
    mode = payload.mode if payload.mode in ALLOWED_MODES else "analyze"
    api_key = payload.apiKey or os.getenv("GROQ_API_KEY") or os.getenv("GROQ_TOKEN")

    if not api_key:
        return {
            "provider": "local",
            "mode": mode,
            "issues": local_python_hint(payload.code, payload.filename),
            "fixed_code": None,
            "improvements": ["Configure GROQ_API_KEY in environment or AI -> Settings to enable AI fixes and updates."],
            "analysis": "AI provider is not configured. Returned local Python syntax diagnostics only.",
            "ai_available": False,
        }

    result = groq_analyze(
        code=payload.code,
        api_key=api_key,
        mode=mode,
        filename=payload.filename,
        language=payload.language,
        framework=payload.framework,
        instruction=payload.instruction,
    )
    if "error" in result:
        return {
            "provider": "groq",
            "mode": mode,
            "error": result["error"],
            "hint": result.get("hint"),
            "issues": local_python_hint(payload.code, payload.filename),
            "ai_available": False,
        }

    result.setdefault("issues", [])
    result.setdefault("improvements", [])
    result.setdefault("fixed_code", None)
    result.update({"provider": "groq", "mode": mode, "ai_available": True})
    return result


@router.post("/repo")
async def debug_repo(payload: RepoDebugRequest):
    mode = payload.mode if payload.mode in ALLOWED_REPO_MODES else "overview"
    api_key = (payload.apiKey or os.getenv("GROQ_API_KEY") or os.getenv("GROQ_TOKEN") or "").strip()

    local_issues = []
    for path, content in payload.files.items():
        for hint in local_python_hint(content, path):
            hint["file"] = path
            local_issues.append(hint)

    if not api_key:
        return {
            "provider": "local",
            "mode": mode,
            "ai_available": False,
            "summary": f"Repository has {len(payload.files)} loaded file(s). Configure GROQ_API_KEY for full AI repo analysis and multi-file updates.",
            "architecture": [f"Loaded {len(payload.files)} workspace files."],
            "issues": local_issues,
            "updated_files": {},
        }

    bundle, included = _build_repo_bundle(payload.files)
    repo_label = payload.repo_name or "Workspace Repository"

    if mode == "overview":
        task_prompt = (
            f"Analyze the entire repository '{repo_label}'. Return a valid JSON object with keys: "
            '"summary" (concise project overview), '
            '"architecture" (list of strings describing entry points, tech stack, and module interactions), '
            '"recommendations" (list of high-value repo-wide improvements).'
        )
    elif mode == "audit":
        task_prompt = (
            f"Perform a cross-file bug, broken-import, configuration, and security audit across repository '{repo_label}'. "
            "Return a valid JSON object with keys: "
            '"summary" (overall audit conclusion), '
            '"issues" (list of objects with "file", "severity", "line", "message"), '
            '"recommendations" (list of actionable fixes).'
        )
    else:
        user_goal = (payload.instruction or "Improve cross-file consistency, error handling, and code quality across the repository.").strip()
        task_prompt = (
            f"Apply a coordinated multi-file update to repository '{repo_label}' for this goal: {user_goal}\n"
            "Only include files that genuinely need changes, and provide the COMPLETE updated content for each modified file. "
            "Return a valid JSON object with keys: "
            '"summary" (what was changed across the repo), '
            '"updated_files" (object mapping exact relative file path -> complete updated file content string), '
            '"notes" (list of follow-up verification notes).'
        )

    session = _session()
    try:
        model = resolve_model(session, api_key, configured=GROQ_MODEL or None)
        res = session.post(
            GROQ_URL,
            headers={"Authorization": f"Bearer {api_key}", "Content-Type": "application/json"},
            json={
                "model": model,
                "messages": [
                    {
                        "role": "system",
                        "content": "You are a principal software architect analyzing and updating multi-file repositories. Always respond with valid JSON only.",
                    },
                    {"role": "user", "content": f"{task_prompt}\n\n{bundle}"},
                ],
                "temperature": 0.15,
                "max_tokens": 4096,
            },
            timeout=60,
        )
        if not res.ok:
            return {
                "provider": "groq",
                "mode": mode,
                "ai_available": False,
                "error": f"AI provider returned HTTP {res.status_code}.",
                "issues": local_issues,
                "updated_files": {},
            }

        raw_content = res.json()["choices"][0]["message"]["content"]
        parsed = _parse_json_object(raw_content)

        raw_updates = parsed.get("updated_files") if isinstance(parsed.get("updated_files"), dict) else {}
        valid_updates = {
            path: str(code)
            for path, code in raw_updates.items()
            if path in payload.files and isinstance(code, str) and code.strip() and code.strip() != payload.files[path].strip()
        }

        ai_issues = parsed.get("issues") if isinstance(parsed.get("issues"), list) else []
        merged_issues = local_issues + [i for i in ai_issues if isinstance(i, dict)]

        return {
            "provider": "groq",
            "mode": mode,
            "ai_available": True,
            "analyzed_files": included,
            "summary": parsed.get("summary") or f"Completed repository {mode}.",
            "architecture": parsed.get("architecture") if isinstance(parsed.get("architecture"), list) else [],
            "recommendations": parsed.get("recommendations") if isinstance(parsed.get("recommendations"), list) else [],
            "notes": parsed.get("notes") if isinstance(parsed.get("notes"), list) else [],
            "issues": merged_issues,
            "updated_files": valid_updates,
        }
    except requests.RequestException:
        return {
            "provider": "groq",
            "mode": mode,
            "ai_available": False,
            "error": "AI repository request timed out or failed.",
            "issues": local_issues,
            "updated_files": {},
        }


@router.get("/status")
async def debug_status():
    configured = bool(os.getenv("GROQ_API_KEY") or os.getenv("GROQ_TOKEN"))
    return {
        "provider": "groq",
        "configured": configured,
        "model": os.getenv("GROQ_MODEL") or "auto-discover",
    }
