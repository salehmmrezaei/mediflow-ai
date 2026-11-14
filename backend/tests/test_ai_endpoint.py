
from unittest.mock import MagicMock

import pytest
from fastapi.testclient import TestClient
from botocore.exceptions import ClientError

from app.main import app, get_current_doctor
from app.ai import clinical_assistant
from app.repositories import clinical_note_repository


client = TestClient(app)

URL = "/patients/TEST-A-0940b91ac8/ask"
QUESTION = {"question": "Why was this patient admitted?"}

NOTES = [
    {
        "note_id": "N001",
        "note_type": "admission",
        "note_text": "Patient admitted with fever and cough.",
    }
]


@pytest.fixture(autouse=True)
def reset_dependencies():
    app.dependency_overrides.clear()
    yield
    app.dependency_overrides.clear()


def authenticate_as(doctor_sub):
    app.dependency_overrides[get_current_doctor] = (
        lambda: doctor_sub
    )


def test_unauthenticated_request(monkeypatch):
    notes_mock = MagicMock()
    ai_mock = MagicMock()

    monkeypatch.setattr(
        clinical_note_repository,
        "list_clinical_notes",
        notes_mock,
    )
    monkeypatch.setattr(
        clinical_assistant,
        "answer_question",
        ai_mock,
    )

    response = client.post(URL, json=QUESTION)

    assert response.status_code == 401
    notes_mock.assert_not_called()
    ai_mock.assert_not_called()


def test_unauthorized_doctor_never_calls_ai(monkeypatch):
    authenticate_as("doctor-B")

    def deny_access(patient_id, doctor_sub):
        raise clinical_note_repository.PatientAccessDeniedError(
            "Access denied"
        )

    ai_mock = MagicMock()

    monkeypatch.setattr(
        clinical_note_repository,
        "list_clinical_notes",
        deny_access,
    )
    monkeypatch.setattr(
        clinical_assistant,
        "answer_question",
        ai_mock,
    )

    response = client.post(URL, json=QUESTION)

    assert response.status_code == 404
    ai_mock.assert_not_called()


def test_authorized_doctor_receives_ai_answer(monkeypatch):
    authenticate_as("doctor-A")

    notes_mock = MagicMock(return_value=NOTES)
    ai_mock = MagicMock(return_value={
        "answer": "The patient had fever and cough.",
        "supporting_note_ids": ["N001"],
        "insufficient_evidence": False,
    })

    monkeypatch.setattr(
        clinical_note_repository,
        "list_clinical_notes",
        notes_mock,
    )
    monkeypatch.setattr(
        clinical_assistant,
        "answer_question",
        ai_mock,
    )

    response = client.post(URL, json=QUESTION)

    assert response.status_code == 200
    assert response.json()["supporting_note_ids"] == ["N001"]

    notes_mock.assert_called_once_with(
        patient_id="TEST-A-0940b91ac8",
        doctor_sub="doctor-A",
    )
    ai_mock.assert_called_once()


def test_no_evidence_returns_safe_response(monkeypatch):
    authenticate_as("doctor-A")

    monkeypatch.setattr(
        clinical_note_repository,
        "list_clinical_notes",
        lambda **kwargs: [],
    )

    response = client.post(URL, json=QUESTION)

    assert response.status_code == 200
    assert response.json()["insufficient_evidence"] is True
    assert response.json()["supporting_note_ids"] == []


def test_invalid_question_rejected(monkeypatch):
    authenticate_as("doctor-A")

    notes_mock = MagicMock()
    monkeypatch.setattr(
        clinical_note_repository,
        "list_clinical_notes",
        notes_mock,
    )

    response = client.post(
        URL,
        json={"question": ""},
    )

    assert response.status_code == 422
    notes_mock.assert_not_called()


def test_ai_timeout_returns_504(monkeypatch):
    authenticate_as("doctor-A")

    monkeypatch.setattr(
        clinical_note_repository,
        "list_clinical_notes",
        lambda **kwargs: NOTES,
    )

    ai_mock = MagicMock(
        side_effect=TimeoutError("Simulated timeout")
    )
    monkeypatch.setattr(
        clinical_assistant,
        "answer_question",
        ai_mock,
    )

    response = client.post(URL, json=QUESTION)

    assert response.status_code == 504


def test_database_error_returns_503(monkeypatch):
    authenticate_as("doctor-A")

    error = ClientError(
        {
            "Error": {
                "Code": "InternalServerError",
                "Message": "Simulated database error",
            }
        },
        "Query",
    )

    notes_mock = MagicMock(side_effect=error)
    ai_mock = MagicMock()

    monkeypatch.setattr(
        clinical_note_repository,
        "list_clinical_notes",
        notes_mock,
    )
    monkeypatch.setattr(
        clinical_assistant,
        "answer_question",
        ai_mock,
    )

    response = client.post(URL, json=QUESTION)

    assert response.status_code == 503
    ai_mock.assert_not_called()


def test_invalid_ai_response_returns_502(monkeypatch):
    authenticate_as("doctor-A")

    monkeypatch.setattr(
        clinical_note_repository,
        "list_clinical_notes",
        lambda **kwargs: NOTES,
    )

    monkeypatch.setattr(
        clinical_assistant,
        "answer_question",
        MagicMock(
            side_effect=RuntimeError("Invalid AI response")
        ),
    )

    response = client.post(URL, json=QUESTION)

    assert response.status_code == 502
