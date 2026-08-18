def test_health(client):
    response = client.get("/health")
    assert response.status_code == 200
    data = response.json()
    assert data["status"] == "healthy"
    assert data["service"] == "BugFalse AI Debugger"

def test_status(client):
    response = client.get("/status")
    assert response.status_code == 200
    assert response.json() == {"status": "ok"}

def test_status_head(client):
    response = client.head("/status")
    assert response.status_code == 200

def test_home(client):
    response = client.get("/")
    assert response.status_code == 200
    assert "BugFalse" in response.text
