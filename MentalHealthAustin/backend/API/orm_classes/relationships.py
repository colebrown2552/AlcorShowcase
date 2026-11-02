"""Association tables describing the many-to-many links between the three models (currently unused: links are stored as ~-joined strings)."""
import sqlalchemy as sqla
from orm_classes import Base

treatment_disorder_association = sqla.Table(
    'Treatment_Disorder',
    Base.metadata,
    sqla.Column('treatment_id', sqla.Integer, sqla.ForeignKey('Treatments.id'), primary_key=True),
    sqla.Column('disorder_id', sqla.Integer, sqla.ForeignKey('Disorders.id'), primary_key=True)
)

location_disorder_association = sqla.Table(
    'Location_Disorder',
    Base.metadata,
    sqla.Column('location_id', sqla.Integer, sqla.ForeignKey('Locations.id'), primary_key=True),
    sqla.Column('disorder_id', sqla.Integer, sqla.ForeignKey('Disorders.id'), primary_key=True)
)

treatment_location_association = sqla.Table(
    'Treatment_Location',
    Base.metadata,
    sqla.Column('treatment_id', sqla.Integer, sqla.ForeignKey('Treatments.id'), primary_key=True),
    sqla.Column('location_id', sqla.Integer, sqla.ForeignKey('Locations.id'), primary_key=True)
)