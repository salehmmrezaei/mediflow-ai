
import uuid
from unittest.mock import MagicMock
from app.ai.discharge_letter import SECTION_NAMES, MISSING_TEXT
import pytest

from app.workers import generate_discharge_letter as worker


JOB_ID = str(uuid.uuid4())

JOB = {
    "job_id": JOB_ID,
    "patient_id": "PATIENT-A",
    "doctor_sub": "DOCTOR-A",
    "status": "PROCESSING",
}

NOTES = [
    {
        "note_id": "N001",
        "note_text": "Admitted with fever and cough.",
    }
]


# Start with all seven clinical sections marked as missing.
DRAFT = {
    name: {
        "text": MISSING_TEXT,
        "documented": False,
        "supporting_note_ids": [],
    }
    for name in SECTION_NAMES
}

# The admission reason is supported by clinical note N001.
DRAFT["admission_reason"] = {
    "text": "Fever and cough.",
    "documented": True,
    "supporting_note_ids": ["N001"],
}

# Derive the missing sections consistently.
DRAFT["missing_sections"] = [
    name
    for name in SECTION_NAMES
    if not DRAFT[name]["documented"]
]



@pytest.fixture
def setup_worker(monkeypatch):
    table = MagicMock()
    table.get_item.return_value = {"Item": JOB.copy()}

    monkeypatch.setattr(
        worker, "get_jobs_table", lambda: table
    )

    monkeypatch.setattr(
        worker.patient_repository,
        "get_patient",
        lambda patient_id, doctor_sub: {
            "patient_id": patient_id,
            "doctor_sub": doctor_sub,
        },
    )

    monkeypatch.setattr(
        worker.clinical_note_repository,
        "list_clinical_notes",
        lambda **kwargs: NOTES,
    )

    generate = MagicMock(return_value=DRAFT)

    monkeypatch.setattr(
        worker,
        "generate_discharge_draft",
        generate,
    )

    return table, generate


def test_generate_and_save_draft(setup_worker):
    table, generate = setup_worker

    result = worker.lambda_handler(
        {"job_id": JOB_ID}, None
    )

    assert result["status"] == "PENDING_REVIEW"
    assert result["already_generated"] is False

    generate.assert_called_once_with(NOTES)
    table.update_item.assert_called_once()

    values = table.update_item.call_args.kwargs[
        "ExpressionAttributeValues"
    ]

    assert values[":pending"] == "PENDING_REVIEW"
    assert values[":draft"] == {
        key: value
        for key, value in DRAFT.items()
        if key != "missing_sections"
    }
    assert values[":evidence"] == ["N001"]
    assert values[":unsigned"] == "UNSIGNED_DRAFT"


def test_patient_access_denied(
    setup_worker,
    monkeypatch,
):
    table, generate = setup_worker

    monkeypatch.setattr(
        worker.patient_repository,
        "get_patient",
        lambda *args: None,
    )

    with pytest.raises(ValueError, match="authorization"):
        worker.lambda_handler(
            {"job_id": JOB_ID}, None
        )

    generate.assert_not_called()
    table.update_item.assert_not_called()


def test_no_notes_prevents_generation(
    setup_worker,
    monkeypatch,
):
    table, generate = setup_worker

    monkeypatch.setattr(
        worker.clinical_note_repository,
        "list_clinical_notes",
        lambda **kwargs: [],
    )

    with pytest.raises(ValueError, match="No clinical evidence"):
        worker.lambda_handler(
            {"job_id": JOB_ID}, None
        )

    generate.assert_not_called()
    table.update_item.assert_not_called()


def test_already_generated_is_not_regenerated(
    setup_worker,
):
    table, generate = setup_worker

    table.get_item.return_value = {
        "Item": {
            **JOB,
            "status": "PENDING_REVIEW",
            "draft": DRAFT,
        }
    }

    result = worker.lambda_handler(
        {"job_id": JOB_ID}, None
    )

    assert result["already_generated"] is True
    generate.assert_not_called()
    table.update_item.assert_not_called()


def test_invalid_status_rejected(setup_worker):
    table, generate = setup_worker

    table.get_item.return_value = {
        "Item": {
            **JOB,
            "status": "APPROVED",
        }
    }

    with pytest.raises(ValueError, match="not ready"):
        worker.lambda_handler(
            {"job_id": JOB_ID}, None
        )

    generate.assert_not_called()
    table.update_item.assert_not_called()


def test_invalid_job_id_rejected(setup_worker):
    table, generate = setup_worker

    with pytest.raises(ValueError, match="Invalid job ID"):
        worker.lambda_handler(
            {"job_id": "invalid"}, None
        )

    generate.assert_not_called()
    table.get_item.assert_not_called()
