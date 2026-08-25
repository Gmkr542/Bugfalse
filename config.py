import os

# ─────────────────────────────────────────────
#  GROQ  (free tier — https://console.groq.com)
# ─────────────────────────────────────────────
# Set GROQ_TOKEN in your environment or .env file — never hardcode keys here.
import os

GROQ_API_KEY = os.getenv("GROQ_API_KEY")
GROQ_TOKEN    = os.getenv("GROQ_TOKEN") or os.getenv("GROQ_API_KEY")
GROQ_URL      = os.getenv("GROQ_URL",   "https://api.groq.com/openai/v1/chat/completions")
GROQ_MODEL    = os.getenv("GROQ_MODEL", "llama-3.3-70b-versatile").strip()
GROQ_VERIFY_SSL = os.getenv("GROQ_VERIFY_SSL", "true").strip().lower() not in ("0", "false", "no")

# ─────────────────────────────────────────────
#  GEMINI  (optional — https://aistudio.google.com)
# ─────────────────────────────────────────────
# Set GEMINI_API_KEY in your environment — never hardcode keys here.
GEMINI_API_KEY = os.getenv("GEMINI_API_KEY", "")
GEMINI_URL     = os.getenv("GEMINI_URL", "https://generativelanguage.googleapis.com/v1beta/models/gemini-1.5-flash:generateContent")
