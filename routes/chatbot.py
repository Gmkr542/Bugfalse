import logging
from fastapi import APIRouter
from pydantic import BaseModel, Field
from chat_history import append_message, load_history, clear_history
from config import GROQ_TOKEN, GROQ_URL, GROQ_MODEL, GROQ_VERIFY_SSL
import requests

logger = logging.getLogger(__name__)
router = APIRouter()

class ChatRequest(BaseModel):
    message: str = Field(default="", max_length=12000)
    code: str = Field(default="", max_length=120000)
    filename: str = ""
    language: str = ""
    framework: str = ""

@router.post("/")
def chat(payload: ChatRequest):
    message = payload.message.strip()
    if not message:
        return {"reply":"Please type something so I can respond.","history":load_history()}
    reply = None
    if GROQ_TOKEN and GROQ_URL:
        context = f"Current file: {payload.filename or 'none'}\nLanguage: {payload.language or 'unknown'}\nFramework: {payload.framework or 'none'}\n\nCode:\n{payload.code[:50000]}"
        history = load_history()[-8:]
        messages = [{"role":"system","content":"You are BugFalse AI, a concise, senior software-engineering assistant. Answer the user's question using the supplied code context. Do not claim code was executed unless execution evidence is provided. Give practical, direct answers. Use markdown when useful."}]
        messages.extend({"role":"user" if x.get("role")=="user" else "assistant","content":x.get("text","")} for x in history)
        messages.append({"role":"user","content":context+"\n\nUser request:\n"+message})
        try:
            session=requests.Session();session.trust_env=False;session.verify=GROQ_VERIFY_SSL
            res=session.post(GROQ_URL,headers={"Authorization":f"Bearer {GROQ_TOKEN}","Content-Type":"application/json"},json={"model":GROQ_MODEL,"messages":messages,"temperature":0.2,"max_tokens":1200},timeout=45)
            if res.ok:
                data=res.json(); reply=data.get("choices",[{}])[0].get("message",{}).get("content")
        except Exception as exc:
            logger.warning("AI chat failed: %s",exc)
    if not reply:
        reply="I can help with this file, but the AI provider is not available right now. Set GROQ_TOKEN on the server and try again."
    append_message("user", message)
    append_message("bot", reply)
    return {"reply":reply,"history":load_history()}

@router.post("/clear")
def clear():
    return {"history":clear_history()}

@router.get("/history")
def history():
    return {"history":load_history()}
