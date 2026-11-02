"""ORM model for a treatment or medication (table Treatments)."""
import sqlalchemy as sqla
from orm_classes import Base
import sqlalchemy.orm as orm
from . import relationships as rs
from typing import List
import orm_classes as oc


class Treatment(Base):
    #name of 
    __tablename__ = 'Treatments'

    # A property because we are working with SQL
    id = sqla.orm.mapped_column(sqla.Integer, primary_key=True)

    # The 'real' attributes/columns of a Disorder object
    name = sqla.orm.mapped_column(sqla.String(oc.max_str_length), nullable=False)
    title = sqla.orm.mapped_column(sqla.String(oc.max_str_length), nullable = False)
    media = sqla.orm.mapped_column(sqla.String(oc.max_str_length), nullable = True)
    url = sqla.orm.mapped_column(sqla.String(oc.max_str_length), nullable = True)
    treatment_type = sqla.orm.mapped_column(sqla.String(oc.max_str_length), nullable = True)
    description = sqla.orm.mapped_column(sqla.String(oc.max_str_length), nullable=True)
    # side_effects = sqla.orm.mapped_column(sqla.String(oc.max_str_length), unique=False, nullable=True)
    # category = sqla.orm.mapped_column(sqla.String(oc.max_str_length), unique=False, nullable=True)
    # We can't store lists in a SQL database (Designed this way). So, instead we store the list as
    #   one big string, separating each item with commas. We can decompress this attribute whenever we fetch.
    # disorders_list_id = sqla.orm.mapped_column(sqla.String(oc.max_str_length), unique=False, nullable=True)

    # Relationships between Disorders and Treatments & Locations
    # disorders_list : sqla.orm.Mapped[List["Disorder"]] = sqla.orm.relationship(secondary=rs.treatment_disorder_association, back_populates='treatments_list')
    # locations_list :sqla.orm.Mapped[List["Location"]] = sqla.orm.relationship(secondary=rs.treatment_location_association, back_populates='treatments_list')
    disorders_list = orm.mapped_column(sqla.String(oc.max_str_length), unique=False, nullable=False)
    locations_list = orm.mapped_column(sqla.String(oc.max_str_length), unique = False, nullable = False)
