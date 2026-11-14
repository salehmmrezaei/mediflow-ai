
import json
import uuid
from unittest.mock import MagicMock

import pytest
from botocore.exceptions import ClientError

from app.services.discharge_workflow import (
    WorkflowExecutionAlreadyExistsError,
    start_discharge_workflow,
)


WORKFLOW_ARN = (
    "arn:aws:states:eu-south-1:123456789012:"
    "stateMachine:test-workflow"
)


def test_start_workflow(monkeypatch):
    monkeypatch.setenv(
        "DISCHARGE_WORKFLOW_ARN",
        WORKFLOW_ARN,
    )

    job_id = str(uuid.uuid4())
    client = MagicMock()

    client.start_execution.return_value = {
        "executionArn": "test-execution-arn"
    }

    result = start_discharge_workflow(
        job_id,
        sfn_client=client,
    )

    assert result == "test-execution-arn"

    client.start_execution.assert_called_once_with(
        stateMachineArn=WORKFLOW_ARN,
        name=job_id,
        input=json.dumps(
            {"job_id": job_id},
            sort_keys=True,
            separators=(",", ":"),
        ),
    )


def test_retry_uses_identical_input(monkeypatch):
    monkeypatch.setenv(
        "DISCHARGE_WORKFLOW_ARN",
        WORKFLOW_ARN,
    )

    client = MagicMock()
    client.start_execution.return_value = {
        "executionArn": "same-execution"
    }

    job_id = str(uuid.uuid4())

    first = start_discharge_workflow(job_id, client)
    second = start_discharge_workflow(job_id, client)

    assert first == second

    calls = client.start_execution.call_args_list

    assert calls[0].kwargs == calls[1].kwargs


def test_missing_workflow_configuration(monkeypatch):
    monkeypatch.delenv(
        "DISCHARGE_WORKFLOW_ARN",
        raising=False,
    )

    client = MagicMock()

    with pytest.raises(
        RuntimeError,
        match="not configured",
    ):
        start_discharge_workflow(
            str(uuid.uuid4()),
            client,
        )

    client.start_execution.assert_not_called()


def test_invalid_job_id(monkeypatch):
    monkeypatch.setenv(
        "DISCHARGE_WORKFLOW_ARN",
        WORKFLOW_ARN,
    )

    client = MagicMock()

    with pytest.raises(
        ValueError,
        match="Invalid discharge job ID",
    ):
        start_discharge_workflow(
            "invalid-job-id",
            client,
        )

    client.start_execution.assert_not_called()


def test_execution_already_exists(monkeypatch):
    monkeypatch.setenv(
        "DISCHARGE_WORKFLOW_ARN",
        WORKFLOW_ARN,
    )

    client = MagicMock()

    client.start_execution.side_effect = ClientError(
        {
            "Error": {
                "Code": "ExecutionAlreadyExists",
                "Message": "Execution already exists",
            }
        },
        "StartExecution",
    )

    with pytest.raises(
        WorkflowExecutionAlreadyExistsError,
    ):
        start_discharge_workflow(
            str(uuid.uuid4()),
            client,
        )
