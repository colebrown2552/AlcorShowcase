from dataclasses import dataclass, fields


@dataclass
class Contact:
    name: str
    email: str = ""
    company: str = ""
    phone: str = ""
    notes: str = ""


FIELD_NAMES = [f.name for f in fields(Contact)]
