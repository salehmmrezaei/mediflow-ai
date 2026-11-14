
import os

import boto3
from boto3.dynamodb.conditions import Attr
from botocore.exceptions import ClientError

from app.models.patient import Patient


class PatientAlreadyExistsError(Exception):
    pass


def get_table():
    table_name = os.environ["PATIENTS_TABLE"]
    return boto3.resource("dynamodb").Table(table_name)


def list_patients(doctor_sub: str) -> list[dict]:
    table = get_table()
    patients = []
    scan_kwargs = {
        "FilterExpression": Attr("doctor_sub").eq(doctor_sub)
    }

    while True:
        response = table.scan(**scan_kwargs)
        patients.extend(response.get("Items", []))

        if "LastEvaluatedKey" not in response:
            break

        scan_kwargs["ExclusiveStartKey"] = response["LastEvaluatedKey"]

    return patients


def get_patient(patient_id: str, doctor_sub: str) -> dict | None:
    table = get_table()

    response = table.get_item(
        Key={"patient_id": patient_id}
    )

    patient = response.get("Item")

    if patient is None:
        return None

    if patient.get("doctor_sub") != doctor_sub:
        return None

    return patient


def create_patient(patient: Patient, doctor_sub: str) -> dict:
    table = get_table()

    item = patient.model_dump(mode="json")
    item["doctor_sub"] = doctor_sub

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
