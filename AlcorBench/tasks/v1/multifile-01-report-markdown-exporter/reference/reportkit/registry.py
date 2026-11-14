"""Format name -> exporter class."""
from .config import DEFAULTS, resolve_options
from .exporters import CsvExporter, JsonExporter, MarkdownExporter

EXPORTERS = {
    "csv": CsvExporter,
    "json": JsonExporter,
    "markdown": MarkdownExporter,
}


def available_formats():
    return sorted(EXPORTERS)


def export(rows, fmt, **options):
    """Render `rows` (a list of dicts) in format `fmt`."""
    if fmt not in EXPORTERS or fmt not in DEFAULTS:
        raise ValueError("unknown export format: %r" % (fmt,))
    return EXPORTERS[fmt](**resolve_options(fmt, options)).render(rows)
