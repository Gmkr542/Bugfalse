from typing import Optional
from fastapi import APIRouter, HTTPException
from pydantic import BaseModel, Field
import services.groq_service as groq_service

router = APIRouter()

class DebugRequest(BaseModel):
    code: str = Field(..., max_length=300_000)
    filename: str = "main.py"
    language: Optional[str] = None
    framework: Optional[str] = None
    apiKey: Optional[str] = None
    api_key: Optional[str] = None
    key: Optional[str] = None
    mode: str = "analyze"

def safe_json_text(value):
    return str(value or "").encode("ascii", errors="backslashreplace").decode("ascii")

@router.post("/")
async def debug(payload: DebugRequest):
    if not payload.code.strip():
        raise HTTPException(status_code=422, detail="Field 'code' must not be empty.")
    api_key = payload.apiKey or payload.api_key or payload.key
    mode = payload.mode if payload.mode in {"analyze","fix","improve","refactor","optimize","security","tests"} else "analyze"
    try:
        if mode == "analyze" and payload.filename == "main.py" and not payload.language and not payload.framework:
            result = groq_service.analyze_code(payload.code, api_key)
        else:
            result = groq_service.analyze_code(
                payload.code, api_key, mode=mode, filename=payload.filename,
                language=payload.language, framework=payload.framework,
            )
    except Exception as exc:
        raise HTTPException(status_code=500, detail=safe_json_text(f"Server error: {exc}"))
    if isinstance(result, dict):
        result.setdefault("provider", "groq")
        if "errors" in result and "issues" not in result: result["issues"] = result.pop("errors")
        if "explanation" in result and "analysis" not in result: result["analysis"] = result.pop("explanation")
        result.setdefault("mode", mode)
    return result

@router.get("/status")
async def status():
    return groq_service.check_connectivity()
