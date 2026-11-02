"""Seed the local database from backend/data.

Usage (from backend/API): ``python seed.py``. Creates ``mha.db`` (SQLite) unless
``DATABASE_URL`` points somewhere else. Reuses the loading logic in upload_data.py.
"""
import upload_data


def main():
    """Drop and recreate all tables, then load disorders, locations and treatments."""
    upload_data.seed()


if __name__ == '__main__':
    main()