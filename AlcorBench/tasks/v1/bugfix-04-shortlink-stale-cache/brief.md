# Short links serve stale targets after edits and deletes

Two related reports from support about the link shortener:

1. A marketing user changed the target of `go/Spring-Sale` from the old
   landing page to the new one. The dashboard shows the new URL, but visitors
   kept landing on the old page for hours. Editing other links "sometimes
   works straight away and sometimes doesn't"; nobody has spotted a pattern.
2. Deleted links keep redirecting. A link removed this morning still resolves
   to its old target, although it no longer shows up anywhere.

Codes are case-insensitive (`Spring-Sale` and `spring-sale` are the same
link). Lookups go through an in-memory LRU cache in front of the store
because the production store is slow; that cache has to stay, and a link that
is resolved repeatedly should still hit the store only once.

Relevant files: `shortener/service.py` (`LinkService`: `shorten`, `resolve`,
`update_target`, `delete`), `shortener/cache.py`, `shortener/codes.py` and
`shortener/store.py`.

Done means: right after `update_target` the link resolves to the new URL, and
right after `delete` resolving it raises `KeyError`, whatever capitalisation
or surrounding whitespace was used for the code in any of the calls, whether
or not the link had been resolved before. Deleting a link that was never
resolved must work too, and a deleted code can be created again with a new
target. `tests/test_service.py` must keep passing
(`python3 -m unittest discover -s tests -t .`).
