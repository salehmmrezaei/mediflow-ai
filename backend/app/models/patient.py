from pydantic import BaseModel, Field

class Product(BaseModel):
    product_id: str
    name: str
    price: float = Field(gt=0)