
from fastapi import FastAPI, HTTPException, status
from mangum import Mangum
from fastapi import Depends, Request
from app.models.patient import Patient
from app.repositories import patient_repository as repo
from app.repositories.patient_repository import PatientAlreadyExistsError

app = FastAPI(
    title="MediFlow AI",
    version="0.1.0",
)


def get_current_doctor(request: Request) -> str:
    event = request.scope.get("aws.event", {})

    claims = (
        event.get("requestContext", {})
        .get("authorizer", {})
        .get("jwt", {})
        .get("claims", {})
    )

    if (
        claims.get("token_use") != "access"
        or not claims.get("sub")
    ):
        raise HTTPException(
            status_code=status.HTTP_401_UNAUTHORIZED,
            detail="Unauthorized",
        )

    return claims["sub"]


@app.get("/patients", response_model=list[Patient])
def list_patients(
    doctor_sub: str = Depends(get_current_doctor),
) -> list[Patient]:
    return repo.list_patients(doctor_sub)


@app.get("/patients/{patient_id}", response_model=Patient)
def get_patient(
    patient_id: str,
    doctor_sub: str = Depends(get_current_doctor),
) -> Patient:
    patient = repo.get_patient(patient_id, doctor_sub)

    if patient is None:
        raise HTTPException(
            status_code=status.HTTP_404_NOT_FOUND,
            detail="Patient not found",
        )

    return patient


@app.post(
    "/patients",
    response_model=Patient,
    status_code=status.HTTP_201_CREATED,
)
def create_patient(
    patient: Patient,
    doctor_sub: str = Depends(get_current_doctor),
) -> Patient:
    try:
        return repo.create_patient(patient, doctor_sub)
    except PatientAlreadyExistsError:
        raise HTTPException(
            status_code=status.HTTP_409_CONFLICT,
            detail="Patient ID already exists",
        )



handler = Mangum(app)
