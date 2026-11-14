
import importlib.util
from datetime import datetime, timedelta, timezone
from pathlib import Path
from unittest.mock import MagicMock

import pytest


WORKFLOW_ARN = (
    "arn:aws:states:eu-south-1:123456789012:"
    "stateMachine:mediflow-ai-dev-DischargeLetterWorkflow"
)

JOB_ID = "523ea4f8-733f-597f-924d-b069b6b46b35"


@pytest.fixture
def recovery(monkeypatch):
    path = (
        Path(__file__).resolve().parents[2]
        / "infrastructure"
        / "discharge_worker"
        / "reconcile.py"
    )

    spec = importlib.util.spec_from_file_location(
        "discharge_reconcile", path
    )
    module = importlib.util.module_from_spec(spec)
    spec.loader.exec_module(module)

    monkeypatch.setenv("DISCHARGE_WORKFLOW_ARN", WORKFLOW_ARN)
    monkeypatch.setenv("STALE_JOB_MINUTES", "30")

    return module


def configure(recovery, monkeypatch, *, age_minutes=60,
              execution_status="FAILED", dry_run=False):
    table = MagicMock()
    sfn = MagicMock()

    timestamp = (
        datetime.now(timezone.utc)
        - timedelta(minutes=age_minutes)
    ).isoformat()

    table.scan.return_value = {
        "Items": [
            {
                "job_id": JOB_ID,
                "status": "PROCESSING",
                "updated_at": timestamp,
            }
        ]
    }

    sfn.describe_execution.return_value = {
        "status": execution_status
    }

    monkeypatch.setenv(
        "RECONCILER_DRY_RUN",
        "true" if dry_run else "false",
    )
    monkeypatch.setattr(
        recovery, "get_jobs_table", lambda: table
    )
    monkeypatch.setattr(
        recovery, "get_sfn_client", lambda: sfn
    )

    return table, sfn


def test_failed_execution_is_reconciled(
    recovery, monkeypatch
):
    table, _ = configure(
        recovery, monkeypatch,
        execution_status="FAILED",
    )

    result = recovery.lambda_handler({}, None)

    assert result["marked_failed"] == 1
    table.update_item.assert_called_once()

    values = table.update_item.call_args.kwargs[
        "ExpressionAttributeValues"
    ]
    assert values[":failed"] == "FAILED"
    assert values[":code"] == "STALE_WORKFLOW"


def test_running_execution_not_modified(
    recovery, monkeypatch
):
    table, _ = configure(
        recovery, monkeypatch,
        execution_status="RUNNING",
    )

    result = recovery.lambda_handler({}, None)

    assert result["still_running"] == 1
    table.update_item.assert_not_called()


def test_recent_job_not_modified(
    recovery, monkeypatch
):
    table, sfn = configure(
        recovery, monkeypatch,
        age_minutes=2,
    )

    result = recovery.lambda_handler({}, None)

    assert result["stale"] == 0
    sfn.describe_execution.assert_not_called()
    table.update_item.assert_not_called()


def test_dry_run_never_modifies_jobs(
    recovery, monkeypatch
):
    table, _ = configure(
        recovery, monkeypatch,
        dry_run=True,
    )

    result = recovery.lambda_handler({}, None)

    assert result["dry_run"] is True
    assert result["eligible_for_failure"] == 1
    assert result["marked_failed"] == 0
    table.update_item.assert_not_called()


def test_successful_execution_with_stuck_job(
    recovery, monkeypatch
):
    table, _ = configure(
        recovery, monkeypatch,
        execution_status="SUCCEEDED",
    )

    result = recovery.lambda_handler({}, None)

    assert result["marked_failed"] == 1
    table.update_item.assert_called_once()
