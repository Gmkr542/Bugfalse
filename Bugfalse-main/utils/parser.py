import json
import re


def clean_json(text):
    """Extract and parse JSON from text, handling both JSON blocks and raw JSON.
    
    Uses brace-counting to correctly extract nested JSON objects
    instead of a greedy regex that can grab too little or too much.
    """
    # Strip markdown fences first
    text = text.replace("```json", "").replace("```", "").strip()

    # Find the first '{' and walk to its matching '}'
    start = text.find("{")
    if start == -1:
        raise ValueError("No JSON object found in text")

    depth = 0
    in_string = False
    escape_next = False
    end = -1

    for i, ch in enumerate(text[start:], start):
        if escape_next:
            escape_next = False
            continue
        if ch == "\\" and in_string:
            escape_next = True
            continue
        if ch == '"':
            in_string = not in_string
            continue
        if in_string:
            continue
        if ch == "{":
            depth += 1
        elif ch == "}":
            depth -= 1
            if depth == 0:
                end = i
                break

    if end == -1:
        raise ValueError("Unmatched braces — no valid JSON found in text")

    json_str = text[start:end + 1]
    return json.loads(json_str)
