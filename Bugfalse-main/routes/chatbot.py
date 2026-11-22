import logging
from fastapi import APIRouter
from pydantic import BaseModel, Field
from chat_history import append_message, load_history, clear_history
from services.groq_service import chat as groq_chat

logger = logging.getLogger(__name__)
router = APIRouter()

class ChatRequest(BaseModel):
    message: str = Field(default="", max_length=12000)
    code: str = Field(default="", max_length=120000)
    filename: str = ""
    language: str = ""
    framework: str = ""
    apiKey: str | None = None
    api_key: str | None = None
    key: str | None = None

@router.post("/")
def chat(payload: ChatRequest):
    message = payload.message.strip()
    if not message:
        return {"reply": "Please type something so I can respond.", "history": load_history()}

    history = load_history()[-8:]
    result = groq_chat(
        message=message,
        code=payload.code,
        filename=payload.filename,
        language=payload.language,
        framework=payload.framework,
        history=history,
        api_key=payload.apiKey or payload.api_key or payload.key,
    )
    reply = result.get("reply") or result.get("error") or "I couldn't generate a response."
    append_message("user", message)
    append_message("bot", reply)
    return {"reply": reply, "history": load_history(), "provider": result.get("provider", "groq")}

@router.post("/clear")
def clear():
    return {"history": clear_history()}

@router.get("/history")
def history():
    return {"history": load_history()}
