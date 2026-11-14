"""A deliberately small template renderer for notification e-mails.

    render("Hi {{ user.name }}!", {"user": {"name": "Ada"}})  ->  "Hi Ada!"
    render("{{ title | upper | truncate:10 }}", {...})
"""
import re

from .errors import TemplateError

_TAG = re.compile(r"\{\{(.*?)\}\}")
_NAME = re.compile(r"^[A-Za-z_][A-Za-z0-9_]*(\.[A-Za-z_][A-Za-z0-9_]*)*$")
_FILTER = re.compile(r'^([a-z]+)(?::(?:"([^"|]*)"|(\d+)))?$')

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


def _parse_filter(text):
    match = _FILTER.match(text.strip())
    if not match:
        raise TemplateError("bad filter: %r" % text)
    name, quoted, number = match.groups()
    if name in ("upper", "lower") and quoted is None and number is None:
        return name, None
    if name == "default" and quoted is not None:
        return name, quoted
    if name == "truncate" and number is not None:
        return name, int(number)
    raise TemplateError("unknown filter or bad argument: %r" % text)


def _apply(name, arg, value):
    if name == "upper":
        return value.upper()
    if name == "lower":
        return value.lower()
    if name == "default":
        return value if value != "" else arg
    if len(value) > arg:  # truncate
        return value[:arg] + "..."
    return value


def _evaluate(expression, context):
    head, *filter_texts = expression.split("|")
    name = head.strip()
    if not _NAME.match(name):
        raise TemplateError("bad expression: %r" % expression)
    filters = [_parse_filter(text) for text in filter_texts]
    value = lookup(context, name)
    if value is _MISSING:
        if not any(f == "default" for f, _ in filters):
            raise TemplateError("undefined variable: %s" % name)
        value = ""
    value = "" if value is None else str(value)
    for filter_name, arg in filters:
        value = _apply(filter_name, arg, value)
    return value


def render(template, context):
    return _TAG.sub(lambda m: _evaluate(m.group(1), context), template)
