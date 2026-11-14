
from copy import deepcopy

import pytest
from botocore.exceptions import ClientError
from fastapi.testclient import TestClient

from app.main import app, get_current_doctor
from app.ai.discharge_letter import SECTION_NAMES, MISSING_TEXT
from app.repositories import discharge_review_repository as repo


client = TestClient(app)

JOB_ID = "synthetic-review-job"
URL = f"/discharge-jobs/{JOB_ID}"
TIMESTAMP = "2026-11-14T16:00:00+00:00"


def example_draft():
    draft = {
        name: {
            "text": MISSING_TEXT,
            "documented": False,
            "supporting_note_ids": [],
        }
        for name in SECTION_NAMES
    }
    draft["admission_reason"] = {
        "text": "Fever and persistent cough.",
        "documented": True,
        "supporting_note_ids": ["N001"],
    }
    return draft


class FakeJobsTable:
    def __init__(self):
        self.item = {
            "job_id": JOB_ID,
            "patient_id": "PATIENT-A",
            "doctor_sub": "DOCTOR-A",
            "status": "PENDING_REVIEW",
            "updated_at": TIMESTAMP,
            "document_state": "UNSIGNED_DRAFT",
            "draft": example_draft(),
            "missing_sections": [
                name for name in SECTION_NAMES
                if name != "admission_reason"
            ],
            "supporting_note_ids": ["N001"],
        }

    def get_item(self, Key, ConsistentRead=False):
        if Key["job_id"] != JOB_ID:
            return {}
        return {"Item": deepcopy(self.item)}

    def update_item(self, **kwargs):
        values = kwargs["ExpressionAttributeValues"]

        if (
            kwargs["Key"]["job_id"] != JOB_ID
            or self.item["doctor_sub"] != values[":doctor"]
            or self.item["status"] != values[":pending"]
            or self.item["updated_at"] != values[":expected"]
        ):
            raise ClientError(
                {"Error": {
                    "Code": "ConditionalCheckFailedException",
                    "Message": "Conflict",
                }},
                "UpdateItem",
            )

        if ":draft" in values:
            self.item["draft"] = values[":draft"]
            self.item["missing_sections"] = values[":missing"]
            self.item["supporting_note_ids"] = values[":evidence"]
        else:
            self.item["status"] = values[":next_status"]
            self.item["document_state"] = values[":document_state"]
            self.item["review_note"] = values[":note"]

        self.item["updated_at"] = values[":now"]
        return {"Attributes": deepcopy(self.item)}


@pytest.fixture(autouse=True)
def fake_storage(monkeypatch):
    table = FakeJobsTable()

    monkeypatch.setattr(
        repo.jobs_repo,
        "get_jobs_table",
        lambda: table,
    )
    monkeypatch.setattr(
        repo.clinical_note_repository,
        "list_clinical_notes",
        lambda **kwargs: [{"note_id": "N001"}],
    )

    app.dependency_overrides.clear()
    yield table
    app.dependency_overrides.clear()


def authenticate(doctor="DOCTOR-A"):
    app.dependency_overrides[get_current_doctor] = (
        lambda: doctor
    )


def edit_payload():
    draft = example_draft()
    draft["admission_reason"]["text"] = (
        "Edited: fever and persistent cough."
    )
    return {
        "expected_updated_at": TIMESTAMP,
        "draft": draft,
    }


def review_payload(action, **extra):
    return {
        "action": action,
        "expected_updated_at": TIMESTAMP,
        **extra,
    }


def test_owner_can_read_draft():
    authenticate()
    response = client.get(f"{URL}/draft")
    assert response.status_code == 200
    assert response.json()["draft"]["admission_reason"][
        "documented"
    ] is True


def test_other_doctor_cannot_read_draft():
    authenticate("DOCTOR-B")
    assert client.get(f"{URL}/draft").status_code == 404


def test_draft_not_ready(fake_storage):
    authenticate()
    fake_storage.item.pop("draft")
    assert client.get(f"{URL}/draft").status_code == 409


def test_doctor_can_edit_draft(fake_storage):
    authenticate()
    response = client.put(
        f"{URL}/draft", json=edit_payload()
    )
    assert response.status_code == 200
    assert "Edited:" in response.json()["draft"][
        "admission_reason"
    ]["text"]


def test_unknown_citation_rejected():
    authenticate()
    payload = edit_payload()
    payload["draft"]["admission_reason"][
        "supporting_note_ids"
    ] = ["N999"]
    assert client.put(
        f"{URL}/draft", json=payload
    ).status_code == 422


def test_stale_edit_rejected():
    authenticate()
    payload = edit_payload()
    payload["expected_updated_at"] = "outdated-version"
    assert client.put(
        f"{URL}/draft", json=payload
    ).status_code == 409


def test_other_doctor_cannot_edit():
    authenticate("DOCTOR-B")
    assert client.put(
        f"{URL}/draft",
        json=edit_payload(),
    ).status_code == 404


def test_approval_requires_missing_section_acknowledgment():
    authenticate()
    response = client.post(
        f"{URL}/review",
        json=review_payload("APPROVE"),
    )
    assert response.status_code == 422


def test_explicit_approval(fake_storage):
    authenticate()
    response = client.post(
        f"{URL}/review",
        json=review_payload(
            "APPROVE",
            acknowledge_missing_sections=True,
        ),
    )
    assert response.status_code == 200
    assert response.json()["status"] == "APPROVED"
    assert response.json()[
        "document_state"
    ] == "REVIEW_APPROVED_UNSIGNED"


def test_rejection_requires_reason():
    authenticate()
    response = client.post(
        f"{URL}/review",
        json=review_payload("REJECT"),
    )
    assert response.status_code == 422


def test_rejection_with_reason():
    authenticate()
    response = client.post(
        f"{URL}/review",
        json=review_payload(
            "REJECT",
            note="Requires additional clinical evidence.",
        ),
    )
    assert response.status_code == 200
    assert response.json()["status"] == "REJECTED"


def test_terminal_job_cannot_be_reviewed_again():
    authenticate()
    first = client.post(
        f"{URL}/review",
        json=review_payload(
            "APPROVE",
            acknowledge_missing_sections=True,
        ),
    )
    assert first.status_code == 200

    second = client.post(
        f"{URL}/review",
        json=review_payload(
            "REJECT",
            note="Changed my mind.",
        ),
    )
    assert second.status_code == 409


def test_unauthenticated_draft_access():
    assert client.get(f"{URL}/draft").status_code == 401
