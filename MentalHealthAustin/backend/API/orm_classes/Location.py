"""ORM model for a place of treatment (table Locations)."""
import sqlalchemy as sqla
from orm_classes import Base
import sqlalchemy.orm as orm
from . import relationships as rs
from typing import List
import orm_classes as oc

class Location(Base):
    #name of 
    __tablename__ = 'Locations'

    # A property because we are working with SQL
    id = sqla.orm.mapped_column(sqla.Integer, primary_key=True)

    # The 'real' attributes/columns of a Disorder object
    name = sqla.orm.mapped_column(sqla.String(oc.max_str_length), nullable=False)
    address = sqla.orm.mapped_column(sqla.String(oc.max_str_length), nullable=False)
    rating = sqla.orm.mapped_column(sqla.Double, unique=False, nullable=True)
    num_ratings = sqla.orm.mapped_column(sqla.Integer, unique=False, nullable=True)
    phone_number = sqla.orm.mapped_column(sqla.String(14), nullable=True)
    hours = sqla.orm.mapped_column(sqla.String(oc.max_str_length), nullable = True)

    latitude = sqla.orm.mapped_column(sqla.Float, unique=False, nullable=True)
    longitude  = sqla.orm.mapped_column(sqla.Float, unique=False, nullable=False)

    photo_info = sqla.orm.mapped_column(sqla.String(oc.max_str_length), nullable = True)
    

    # Relationships
    # treatments_list : sqla.orm.Mapped[List["Treatment"]] = sqla.orm.relationship(secondary=rs.treatment_location_association, back_populates='locations_list')
    # disorders_list : sqla.orm.Mapped[List["Disorder"]] = sqla.orm.relationship(secondary=rs.location_disorder_association, back_populates='locations_list')
    treatments_list = orm.mapped_column(sqla.String(oc.max_str_length), unique=False, nullable=False)
    disorders_list = orm.mapped_column(sqla.String(oc.max_str_length), unique = False, nullable = False)
