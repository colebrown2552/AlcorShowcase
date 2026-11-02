"""ORM model for a mental-health disorder (table Disorders)."""
import sqlalchemy as sqla
import sqlalchemy.orm as orm
from orm_classes import Base
from . import relationships as rs
from typing import List
import orm_classes as oc
# from . import Treatment

class Disorder(Base):
    #name of 
    __tablename__ = 'Disorders'

    # A property because we are working with SQL
    id = orm.mapped_column(sqla.Integer, primary_key=True)

    # The 'real' attributes/columns of a Disorder object
    name = orm.mapped_column(sqla.String(oc.max_str_length), nullable=False)
    description = orm.mapped_column(sqla.String(oc.max_str_length), unique=False, nullable=False)
    image_url = orm.mapped_column(sqla.String(oc.max_str_length), unique=False, nullable=True)
    symptoms = orm.mapped_column(sqla.String(oc.max_str_length), unique=False, nullable=True)
    causes = orm.mapped_column(sqla.String(oc.max_str_length), unique=False, nullable=True)
    diagnosis = orm.mapped_column(sqla.String(oc.max_str_length), unique=False, nullable=True)
    treatment_attr = orm.mapped_column(sqla.String(oc.max_str_length), unique=False, nullable=True)
    population_affected = orm.mapped_column(sqla.Float(), unique = False, nullable = False)

    # Relationships between Disorders and Treatments & Locations
    # treatments_list : orm.Mapped[List["Treatment"]] = sqla.orm.relationship( secondary=rs.treatment_disorder_association, back_populates='disorders_list')
    # locations_list : orm.Mapped[List["Location"]] = sqla.orm.relationship(secondary=rs.location_disorder_association, back_populates='disorders_list')
    treatments_list = orm.mapped_column(sqla.String(oc.max_str_length), unique=False, nullable=False)
    locations_list = orm.mapped_column(sqla.String(oc.max_str_length), unique = False, nullable = False)

    def __repr__(self):
        return f'Disorder: {self.name}\n\tDescription:{self.description}'
