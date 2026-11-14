"""The link service used by the web handlers."""
from shortener.cache import LRUCache
from shortener.codes import encode, normalize, validate
from shortener.store import LinkStore


class LinkService:
    def __init__(self, store=None, cache_size=1024):
        self.store = store if store is not None else LinkStore()
        self.cache = LRUCache(cache_size)
        self._counter = 0

    def shorten(self, url, code=None):
        """Store ``url`` under ``code`` (or a generated code); return the code."""
        if not url.startswith(("http://", "https://")):
            raise ValueError(f"not an http(s) URL: {url!r}")
        if code is None:
            while True:
                self._counter += 1
                code = encode(self._counter)
                if code not in self.store:
                    break
        else:
            code = validate(normalize(code))
        self.store.insert(code, url)
        return code

    def resolve(self, code):
        """Target URL for ``code``; raises KeyError if there is none."""
        key = normalize(code)
        url = self.cache.get(key)
        if url is not None:
            return url
        url = self.store.get(key)
        if url is None:
            raise KeyError(code)
        self.cache.put(key, url)
        return url

    def update_target(self, code, url):
        if not url.startswith(("http://", "https://")):
            raise ValueError(f"not an http(s) URL: {url!r}")
        key = normalize(code)
        self.store.update(key, url)
        if self.cache.get(code) is not None:
            self.cache.invalidate(code)

    def delete(self, code):
        self.store.remove(normalize(code))
