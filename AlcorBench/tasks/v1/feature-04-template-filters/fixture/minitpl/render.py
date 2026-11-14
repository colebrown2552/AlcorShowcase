"""A deliberately small template renderer for notification e-mails.

    render("Hi {{ user.name }}!", {"user": {"name": "Ada"}})  ->  "Hi Ada!"
"""
import re

from .errors import TemplateError

_TAG = re.compile(r"\{\{(.*?)\}\}")
_NAME = re.compile(r"^[A-Za-z_][A-Za-z0-9_]*(\.[A-Za-z_][A-Za-z0-9_]*)*$")

_MISSING = object()


def lookup(context, dotted):
    """Resolve "a.b.c" through dict keys or attributes; _MISSING if absent."""
    value = context
    for part in dotted.split("."):
        if isinstance(value, dict):
            value = value.get(part, _MISSING)
        else:
            value = getattr(value, part, _MISSING)
        if value is _MISSING:
            return _MISSING
    return value


def _evaluate(expression, context):
    name = expression.strip()
    if not _NAME.match(name):
        raise TemplateError("bad expression: %r" % expression)
    value = lookup(context, name)
    if value is _MISSING:
        raise TemplateError("undefined variable: %s" % name)
    return "" if value is None else str(value)


def render(template, context):
    return _TAG.sub(lambda m: _evaluate(m.group(1), context), template)
