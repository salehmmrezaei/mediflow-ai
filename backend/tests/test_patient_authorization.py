
from fastapi.testclient import TestClient

from app.main import app, get_current_doctor
from app.repositories import patient_repository as repo


client = TestClient(app)

PATIENT = {
    "patient_id": "TEST-002",
    "first_name": "Alice",
    "last_name": "Example",
    "age": 30,
    "diagnosis": {
        "diagnosis": "Synthetic test diagnosis"
    },
    "admission_date": "2026-11-13",
    "status": "admitted",
}


def test_request_without_authentication():
    response = client.get("/patients")

    assert response.status_code == 401


def test_doctor_can_list_own_patients(monkeypatch):
    app.dependency_overrides[get_current_doctor] = (
        lambda: "doctor-A"
    )

    def fake_list_patients(doctor_sub):
        assert doctor_sub == "doctor-A"
        return [PATIENT]

    monkeypatch.setattr(
        repo, "list_patients", fake_list_patients
    )

    try:
        response = client.get("/patients")

        assert response.status_code == 200
        assert len(response.json()) == 1
        assert response.json()[0]["patient_id"] == "TEST-002"
    finally:
        app.dependency_overrides.clear()


def test_doctor_cannot_access_another_doctors_patient(
    monkeypatch,
):
    app.dependency_overrides[get_current_doctor] = (
        lambda: "doctor-B"
    )

    def fake_get_patient(patient_id, doctor_sub):
        assert patient_id == "TEST-002"
        assert doctor_sub == "doctor-B"
        return None

    monkeypatch.setattr(
        repo, "get_patient", fake_get_patient
    )

    try:
        response = client.get("/patients/TEST-002")

        assert response.status_code == 404
    finally:
        app.dependency_overrides.clear()


def test_patient_created_for_authenticated_doctor(
    monkeypatch,
):
    app.dependency_overrides[get_current_doctor] = (
        lambda: "doctor-A"
    )

    def fake_create_patient(patient, doctor_sub):
        assert doctor_sub == "doctor-A"
        return patient.model_dump(mode="json")

    monkeypatch.setattr(
        repo, "create_patient", fake_create_patient
    )

    try:
        response = client.post("/patients", json=PATIENT)

        assert response.status_code == 201
        assert response.json()["patient_id"] == "TEST-002"
    finally:
        app.dependency_overrides.clear()
