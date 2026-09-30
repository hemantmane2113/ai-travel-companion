async def test_health(anon):
    response = await anon.get("/health")
    assert response.status_code == 200
    assert response.json() == {"status": "ok", "database": "ok", "llm_configured": True}


async def test_home_redirects_to_login_when_signed_out(anon):
    response = await anon.get("/")
    assert response.status_code == 303
    assert response.headers["location"] == "/login"


async def test_api_requires_sign_in(anon):
    assert (await anon.get("/api/conversations")).status_code == 401
    assert (await anon.post("/api/conversations")).status_code == 401


async def test_register_signs_in_and_shows_chat(client):
    response = await client.get("/")
    assert response.status_code == 200
    assert "asha@example.com" in response.text


async def test_register_rejects_short_password_bad_email_and_duplicate(anon, client):
    short = await anon.post("/register", data={"email": "new@example.com", "password": "short"})
    assert short.status_code == 400

    bad = await anon.post("/register", data={"email": "not-an-email", "password": "correct-horse"})
    assert bad.status_code == 400

    duplicate = await anon.post("/register", data={"email": "Asha@Example.com", "password": "correct-horse"})
    assert duplicate.status_code == 409


async def test_login_and_logout(anon, client):
    wrong = await anon.post("/login", data={"email": "asha@example.com", "password": "wrong-password"})
    assert wrong.status_code == 401
    unknown = await anon.post("/login", data={"email": "nobody@example.com", "password": "correct-horse"})
    assert unknown.status_code == 401
    assert (await anon.get("/api/conversations")).status_code == 401

    ok = await anon.post("/login", data={"email": "asha@example.com", "password": "correct-horse"})
    assert ok.status_code == 303
    assert (await anon.get("/api/conversations")).status_code == 200

    await anon.post("/logout")
    assert (await anon.get("/api/conversations")).status_code == 401
