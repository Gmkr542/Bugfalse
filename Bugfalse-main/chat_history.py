import json
import os
from datetime import datetime, timezone

BASE_DIR = os.path.dirname(__file__)
HISTORY_FILE = os.path.join(BASE_DIR, "chat_history.json")


def _ensure_history_file():
    if not os.path.exists(HISTORY_FILE):
        with open(HISTORY_FILE, "w", encoding="utf-8") as f:
            json.dump([], f, indent=2)


def load_history():
    _ensure_history_file()
    with open(HISTORY_FILE, "r", encoding="utf-8") as f:
        return json.load(f)


def save_history(messages):
    with open(HISTORY_FILE, "w", encoding="utf-8") as f:
        json.dump(messages, f, indent=2)


def append_message(role, text):
    messages = load_history()
    messages.append({
        "role": role,
        "text": text,
        "timestamp": datetime.now(timezone.utc).isoformat().replace("+00:00", "Z")
    })
    save_history(messages)
    return messages


def clear_history():
    save_history([])
    return []
