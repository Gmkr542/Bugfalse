import os
import pytest
from fastapi.testclient import TestClient
from app import app

@pytest.fixture
def client(monkeypatch):
    monkeypatch.setenv("BUGFALSE_ENABLE_LOCAL_EXECUTION", "false")
    with TestClient(app) as test_client:
        yield test_client
