
import importlib.util
import uuid
from pathlib import Path
from unittest.mock import MagicMock

import pytest
from botocore.exceptions import ClientError


@pytest.fixture
def worker():
    path = (
        Path(__file__).resolve().parents[2]
        / "infrastructure"
        / "discharge_worker"
        / "handler.py"
    )

    spec = importlib.util.spec_from_file_location(
        "discharge_worker_handler",
        path,
    )
    module = importlib.util.module_from_spec(spec)
    spec.loader.exec_module(module)

    return module


def conditional_failure():
    return ClientError(
        {
            "Error": {
                "Code": "ConditionalCheckFailedException",
                "Message": "Condition failed",
            }
        },
        "UpdateItem",
    )


def test_queued_job_becomes_processing(worker, monkeypatch):
    table = MagicMock()
    table.update_item.return_value = {
        "Attributes": {"status": "PROCESSING"}
    }

    monkeypatch.setattr(worker, "get_jobs_table", lambda: table)

    job_id = str(uuid.uuid4())
    result = worker.lambda_handler({"job_id": job_id}, None)

    assert result == {
        "job_id": job_id,
        "status": "PROCESSING",
        "transitioned": True,
    }

    kwargs = table.update_item.call_args.kwargs

    assert kwargs["Key"] == {"job_id": job_id}
    assert "#status = :queued" in kwargs["ConditionExpression"]
    assert kwargs["ExpressionAttributeValues"][":queued"] == "QUEUED"
    assert kwargs["ExpressionAttributeValues"][":processing"] == "PROCESSING"


def test_already_processing_is_safe(worker, monkeypatch):
    table = MagicMock()
    table.update_item.side_effect = conditional_failure()
    table.get_item.return_value = {
        "Item": {"status": "PROCESSING"}
    }

    monkeypatch.setattr(worker, "get_jobs_table", lambda: table)

    result = worker.lambda_handler(
        {"job_id": str(uuid.uuid4())},
        None,
    )

    assert result["status"] == "PROCESSING"
    assert result["transitioned"] is False


def test_missing_job_is_rejected(worker, monkeypatch):
    table = MagicMock()
    table.update_item.side_effect = conditional_failure()
    table.get_item.return_value = {}

    monkeypatch.setattr(worker, "get_jobs_table", lambda: table)

    with pytest.raises(ValueError, match="not eligible"):
        worker.lambda_handler(
            {"job_id": str(uuid.uuid4())},
            None,
        )


def test_completed_job_cannot_reenter_processing(worker, monkeypatch):
    table = MagicMock()
    table.update_item.side_effect = conditional_failure()
    table.get_item.return_value = {
        "Item": {"status": "APPROVED"}
    }

    monkeypatch.setattr(worker, "get_jobs_table", lambda: table)

    with pytest.raises(ValueError, match="not eligible"):
        worker.lambda_handler(
            {"job_id": str(uuid.uuid4())},
            None,
        )


@pytest.mark.parametrize(
    "event",
    [
        {},
        {"job_id": "invalid"},
        {"job_id": ""},
        None,
    ],
)
def test_invalid_job_id(worker, monkeypatch, event):
    table = MagicMock()
    monkeypatch.setattr(worker, "get_jobs_table", lambda: table)

    with pytest.raises(ValueError, match="Invalid job ID"):
        worker.lambda_handler(event, None)

    table.update_item.assert_not_called()


def test_database_failure_propagates(worker, monkeypatch):
    table = MagicMock()

    table.update_item.side_effect = ClientError(
        {
            "Error": {
                "Code": "InternalServerError",
                "Message": "Simulated failure",
            }
        },
        "UpdateItem",
    )

    monkeypatch.setattr(worker, "get_jobs_table", lambda: table)

    with pytest.raises(ClientError):
        worker.lambda_handler(
            {"job_id": str(uuid.uuid4())},
            None,
        )