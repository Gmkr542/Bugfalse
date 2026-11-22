import os
from fastapi import APIRouter, HTTPException
from pydantic import BaseModel, Field

from services.groq_service import analyze_code as groq_analyze

router = APIRouter()
MAX_CODE_CHARS = 100_000
ALLOWED_MODES = {"analyze", "fix", "improve", "update", "refactor", "optimize", "security", "tests", "custom"}


class DebugRequest(BaseModel):
    code: str = Field(..., min_length=1, max_length=MAX_CODE_CHARS)
    filename: str = Field(default="main.py", max_length=160)
    language: str | None = None
    framework: str | None = None
    mode: str = "analyze"
    instruction: str | None = Field(default=None, max_length=3000)
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
            "improvements": ["Configure GROQ_API_KEY in environment or AI → Settings to enable AI fixes and updates."],
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


@router.get("/status")
async def debug_status():
    configured = bool(os.getenv("GROQ_API_KEY") or os.getenv("GROQ_TOKEN"))
    return {
        "provider": "groq",
        "configured": configured,
        "model": os.getenv("GROQ_MODEL") or "auto-discover",
    }
