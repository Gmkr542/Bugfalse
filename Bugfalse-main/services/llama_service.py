"""
llama_service.py — thin wrapper around groq_service for Llama-model calls.
The Groq API hosts Llama models, so this delegates directly to groq_service.
"""
import services.groq_service as groq_service


def analyze_code(code: str, api_key: str = None) -> dict:
    """Analyze code using Groq-hosted Llama model."""
    return groq_service.analyze_code(code, api_key)
