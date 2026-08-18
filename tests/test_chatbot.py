def test_chatbot_validation(client):
    response = client.post("/chatbot/", json={"message": "hello"})
    assert response.status_code == 200
    data = response.json()
    assert isinstance(data["reply"], str)
    assert isinstance(data["history"], list)

def test_chatbot_empty_message(client):
    response = client.post("/chatbot/", json={"message": ""})
    assert response.status_code == 200
    assert response.json()["reply"] == "Please type something so I can respond."

def test_chatbot_history(client):
    response = client.get("/chatbot/history")
    assert response.status_code == 200
    assert isinstance(response.json()["history"], list)

def test_chatbot_clear(client):
    response = client.post("/chatbot/clear")
    assert response.status_code == 200
    assert response.json()["history"] == []
