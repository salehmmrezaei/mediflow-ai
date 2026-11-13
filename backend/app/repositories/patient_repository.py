
import os

import boto3
from botocore.exceptions import ClientError

from app.models.patient import Patient


class PatientAlreadyExistsError(Exception):
    pass


def get_table():
    table_name = os.environ["PATIENTS_TABLE"]
    return boto3.resource("dynamodb").Table(table_name)


def list_patients() -> list[dict]:
    table = get_table()
    patients = []
    scan_kwargs = {}

    while True:
        response = table.scan(**scan_kwargs)
        patients.extend(response.get("Items", []))

        if "LastEvaluatedKey" not in response:
            break

        scan_kwargs["ExclusiveStartKey"] = response["LastEvaluatedKey"]

    return patients


def get_patient(patient_id: str) -> dict | None:
    table = get_table()

    response = table.get_item(
        Key={"patient_id": patient_id}
    )

    return response.get("Item")


def create_patient(patient: Patient) -> dict:
    table = get_table()
    item = patient.model_dump(mode="json")

    try:
        table.put_item(
            Item=item,
            ConditionExpression="attribute_not_exists(patient_id)"
        )
    except ClientError as error:
        if (
            error.response["Error"]["Code"]
            == "ConditionalCheckFailedException"
        ):
            raise PatientAlreadyExistsError(
                "Patient ID already exists"
            ) from error

        raise

    return item
