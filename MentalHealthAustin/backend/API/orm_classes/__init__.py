"""Database setup for the Mental Health Austin API.

Creates the SQLAlchemy engine, the declarative ``Base`` and the session factory.
The connection string comes from the ``DATABASE_URL`` environment variable and
defaults to a local SQLite file, so the project runs with no cloud services.
"""
import os

import sqlalchemy as sqla
import sqlalchemy.orm as orm

global full_db_url, engine, Base, session

full_db_url = os.environ.get('DATABASE_URL', 'sqlite:///mha.db')

engine = sqla.create_engine(full_db_url, echo=False)

class Base(orm.DeclarativeBase):
    """Declarative base shared by every ORM model."""
    pass
Base.metadata.bind = engine

session_maker = orm.sessionmaker(engine)
# session = session_maker()

max_str_length = 65535

# Makes it so that all files in orm_classes are imported when calling 'import orm_classes'
from os.path import dirname, basename, isfile, join
import glob
modules = glob.glob(join(dirname(__file__), "*.py"))
__all__ = [ basename(f)[:-3] for f in modules if isfile(f) and not f.endswith('__init__.py')]
from . import *

# Create any missing tables now that every model module has been imported.
Base.metadata.create_all(engine)
