
import json
import os
import uuid

import boto3
from botocore.exceptions import ClientError


class WorkflowExecutionAlreadyExistsError(Exception):
    """The execution name is already in use."""


def start_discharge_workflow(
    job_id: str,
    sfn_client=None,
) -> str:
    """
    Start an AWS Step Functions execution.

    The execution name equals the discharge job ID.
    Returns the execution ARN.
    """

    # 1. Validate the job ID.
    try:
        if str(uuid.UUID(job_id)) != job_id:
            raise ValueError
    except (ValueError, TypeError, AttributeError):
        raise ValueError("Invalid discharge job ID") from None

    # 2. Get the configured state machine ARN.
    workflow_arn = os.getenv("DISCHARGE_WORKFLOW_ARN")

    if not workflow_arn:
        raise RuntimeError(
            "Discharge workflow is not configured"
        )

    # 3. Build a deterministic workflow input.
    # The workflow will use this ID to retrieve
    # the authoritative job record from DynamoDB.
    workflow_input = json.dumps(
        {"job_id": job_id},
        sort_keys=True,
        separators=(",", ":"),
    )

    # 4. Create the AWS Step Functions client.
    client = (
        sfn_client
        if sfn_client is not None
        else boto3.client("stepfunctions")
    )

    # 5. Start the background execution.
    try:
        response = client.start_execution(
            stateMachineArn=workflow_arn,
            name=job_id,
            input=workflow_input,
        )

    except ClientError as exc:
        error_code = exc.response.get(
            "Error", {}
        ).get("Code")

        if error_code == "ExecutionAlreadyExists":
            raise WorkflowExecutionAlreadyExistsError(
                "Workflow execution name already exists"
            ) from None

        raise

    return response["executionArn"]
