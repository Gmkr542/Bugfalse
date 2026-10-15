def test_catalog(client):
    response = client.get("/runtime/catalog")
    assert response.status_code == 200
    assert any(item["id"] == "python" for item in response.json()["runtimes"])

def test_detect_python(client):
    response = client.post("/runtime/detect", json={"filename": "main.py"})
    assert response.status_code == 200
    assert response.json()["language"] == "python"
