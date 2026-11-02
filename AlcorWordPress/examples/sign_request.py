"""Sign a request for the alcor-s2s-auth WordPress plugin.

The server side is mu-plugins/alcor-s2s-auth.php, whose file header specifies the wire format.
This script is a client for it. It builds the canonical string, signs it with HMAC-SHA256 and
either prints the three authentication headers as JSON or sends the request itself.

The secret is read from an environment variable and never from the command line, where other
users of the machine could see it in a process list. Standard library only.

Print the headers for a GET (first set ALCOR_S2S_KEY to the value of the constant in wp-config.php):

    python examples/sign_request.py --url "https://example.com/wp-json/acme/v1/status?region=eu"

Send a signed POST with a body, reading the key from another variable (one command, wrapped here):

    python examples/sign_request.py --method POST --body '{"sku": "A-1"}' --send
        --key-env MY_KEY --url https://example.com/wp-json/acme/v1/orders
"""

from __future__ import annotations

import argparse
import hashlib
import hmac
import json
import os
import secrets
import sys
import time
import urllib.error
import urllib.parse
import urllib.request

CANONICAL_VERSION = "alcor-s2s-v1"
# The server treats a shorter key as "not configured" and answers 404, so refuse to sign with one.
MIN_KEY_LENGTH = 32
# PHP turns these characters in a query parameter name into "_" (or an array), so the name the
# server signs would not be the name sent. Refuse them rather than make a signature that can
# never verify.
UNSIGNABLE_NAME_CHARS = set(" .[]")


def canonical_string(
    method: str,
    route: str,
    query: dict[str, str],
    timestamp: int,
    nonce: str,
    body: bytes,
) -> str:
    """Builds the string that is signed and that the server recomputes.

    Args:
        method: HTTP method.
        route: REST route as WordPress reports it: no /wp-json prefix, no trailing slash.
        query: Query parameters, without rest_route.
        timestamp: Unix seconds.
        nonce: 32 lower-case hex characters, unique per request.
        body: Raw request body; empty for a GET.

    Returns:
        Seven lines joined with a line feed.
    """
    # quote(safe="") percent-encodes all but letters, digits and "_.-~", like PHP's rawurlencode().
    pairs = "&".join(
        f"{urllib.parse.quote(name, safe='')}={urllib.parse.quote(value, safe='')}"
        for name, value in sorted(query.items())
    )
    return "\n".join(
        [
            CANONICAL_VERSION,
            method.upper(),
            route,
            pairs,
            str(timestamp),
            nonce,
            hashlib.sha256(body).hexdigest(),
        ]
    )


def sign(
    key: str,
    method: str,
    route: str,
    query: dict[str, str],
    body: bytes,
    timestamp: int | None = None,
    nonce: str | None = None,
) -> dict[str, str]:
    """Produces the three authentication headers for a request.

    Args:
        key: The shared secret.
        method: HTTP method.
        route: REST route, as for canonical_string().
        query: Query parameters, without rest_route.
        body: Raw request body.
        timestamp: Unix seconds; defaults to now.
        nonce: Defaults to 16 random bytes as hex.

    Returns:
        Header name to value, ready to send.
    """
    timestamp = int(time.time()) if timestamp is None else timestamp
    nonce = secrets.token_hex(16) if nonce is None else nonce
    canonical = canonical_string(method, route, query, timestamp, nonce, body)
    signature = hmac.new(key.encode("utf-8"), canonical.encode("utf-8"), hashlib.sha256).hexdigest()
    return {
        "x-alcor-timestamp": str(timestamp),
        "x-alcor-nonce": nonce,
        "x-alcor-signature": signature,
    }


def split_rest_url(url: str) -> tuple[str, dict[str, str]]:
    """Splits a WordPress REST URL into the route and query that the server will see.

    Args:
        url: Either https://host/wp-json/ns/v1/thing?a=1 or https://host/index.php?rest_route=/ns/v1/thing&a=1.

    Returns:
        The route (/ns/v1/thing) and the query parameters without rest_route.

    Raises:
        ValueError: When the URL is not a REST URL or a query parameter cannot be signed faithfully.
    """
    parts = urllib.parse.urlsplit(url)
    query: dict[str, str] = {}
    for name, value in urllib.parse.parse_qsl(parts.query, keep_blank_values=True):
        if name in query:
            raise ValueError(f"query parameter {name!r} appears twice; PHP keeps only the last one")
        if UNSIGNABLE_NAME_CHARS & set(name):
            raise ValueError(
                f"query parameter name {name!r} contains a character that PHP rewrites"
            )
        query[name] = value
    if "rest_route" in query:
        route = query.pop("rest_route")
    elif "/wp-json" in parts.path:
        route = urllib.parse.unquote(parts.path.split("/wp-json", 1)[1])
    else:
        raise ValueError("not a REST URL: expected /wp-json/... or ?rest_route=...")
    # WordPress removes a trailing slash from the route before it signs and routes.
    return route.rstrip("/") or "/", query


def send(url: str, method: str, body: bytes, headers: dict[str, str]) -> int:
    """Sends the request and prints the status line and body.

    Args:
        url: Full request URL.
        method: HTTP method.
        body: Raw request body.
        headers: Authentication headers from sign().

    Returns:
        0 for a 2xx answer, 1 otherwise.
    """
    request = urllib.request.Request(url, data=body or None, method=method.upper(), headers=headers)
    if body:
        request.add_header("Content-Type", "application/json")
    try:
        with urllib.request.urlopen(request, timeout=30) as response:  # noqa: S310 - URL is the caller's own.
            status, text = response.status, response.read().decode("utf-8", "replace")
    except urllib.error.HTTPError as error:
        status, text = error.code, error.read().decode("utf-8", "replace")
    print(f"HTTP {status}\n{text}")
    return 0 if 200 <= status < 300 else 1


def main(argv: list[str] | None = None) -> int:
    """Parses the command line, signs, and prints the headers or sends the request.

    Args:
        argv: Arguments without the program name; defaults to sys.argv.

    Returns:
        Process exit code: 0 on success, 1 when the server refused, 2 for a usage error.
    """
    parser = argparse.ArgumentParser(description="Sign a request for alcor-s2s-auth.")
    parser.add_argument("--url", required=True, help="Full REST URL of the route.")
    parser.add_argument("--method", default="GET", help="HTTP method (default GET).")
    parser.add_argument("--body", default="", help="Request body, sent as UTF-8.")
    parser.add_argument(
        "--key-env", default="ALCOR_S2S_KEY", help="Environment variable that holds the key."
    )
    parser.add_argument(
        "--send", action="store_true", help="Send the request instead of printing the headers."
    )
    args = parser.parse_args(argv)

    key = os.environ.get(args.key_env, "")
    if len(key) < MIN_KEY_LENGTH:
        print(
            f"error: set {args.key_env} to the shared key ({MIN_KEY_LENGTH}+ characters)",
            file=sys.stderr,
        )
        return 2
    try:
        route, query = split_rest_url(args.url)
    except ValueError as error:
        print(f"error: {error}", file=sys.stderr)
        return 2

    body = args.body.encode("utf-8")
    headers = sign(key, args.method, route, query, body)
    if args.send:
        return send(args.url, args.method, body, headers)
    print(json.dumps(headers, indent=2))
    return 0


if __name__ == "__main__":
    sys.exit(main())
