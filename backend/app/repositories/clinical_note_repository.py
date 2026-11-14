
import os

import boto3
from boto3.dynamodb.conditions import Key

from app.repositories import patient_repository


MAX_NOTES = 20


class PatientAccessDeniedError(Exception):
    pass


def get_notes_table():
    table_name = os.environ["CLINICAL_NOTES_TABLE"]
    return boto3.resource("dynamodb").Table(table_name)


def list_clinical_notes(
    patient_id: str,
    doctor_sub: str,
) -> list[dict]:

    # 1. Check that the doctor can access this patient.
    patient = patient_repository.get_patient(
        patient_id,
        doctor_sub,
    )

    if patient is None:
        raise PatientAccessDeniedError(
            "Patient not found or access denied"
        )

    # 2. Only now access the clinical notes table.
    table = get_notes_table()

    response = table.query(
        KeyConditionExpression=Key("patient_id").eq(patient_id),
        Limit=MAX_NOTES,
        ConsistentRead=True,
    )

    return response.get("Items", [])
