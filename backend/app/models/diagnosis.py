from pydantic import BaseModel, Field


class Diagnosis(BaseModel):
    diagnosis: str = Field(min_length=1)

