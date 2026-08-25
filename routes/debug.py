from typing import Optional

from fastapi import APIRouter, HTTPException
from pydantic import BaseModel, Field
import services.groq_service as groq_service

router = APIRouter()


class DebugRequest(BaseModel):
    code: str = Field(..., max_length=300_000)
    apiKey: Optional[str] = None
    api_key: Optional[str] = None
    key: Optional[str] = None
    mode: str = "analyze"


def safe_json_text(value):
    if value is None:
        return ""
    if not isinstance(value, str):
        value = str(value)
    return value.encode("ascii", errors="backslashreplace").decode("ascii")


@router.post("/")
async def debug(payload: DebugRequest):
    code = payload.code
    if not code or not code.strip():
        raise HTTPException(status_code=422, detail="Field 'code' must not be empty.")

    api_key = payload.apiKey or payload.api_key or payload.key
    mode = payload.mode if payload.mode in {"analyze", "fix", "improve", "refactor", "optimize", "security", "tests"} else "analyze"

    try:
        result = groq_service.analyze_code(code, api_key) if mode == "analyze" else groq_service.analyze_code(code, api_key, mode=mode)
    except Exception as exc:
        raise HTTPException(status_code=500, detail=safe_json_text(f"Server error: {exc}"))

    if isinstance(result, dict):
        result.setdefault("provider", "groq")
        if "errors" in result and "issues" not in result:
            result["issues"] = result.pop("errors")
        if "explanation" in result and "analysis" not in result:
            result["analysis"] = result.pop("explanation")
        result.setdefault("mode", mode)
    return result


@router.get("/status")
async def status():
    return groq_service.check_connectivity()
