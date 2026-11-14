"""Link storage. In production this is a remote table; here it is a dict."""


class LinkStore:
    def __init__(self):
        self._rows = {}

    def get(self, code):
        return self._rows.get(code)

    def insert(self, code, url):
        if code in self._rows:
            raise KeyError(f"code already exists: {code}")
        self._rows[code] = url

    def update(self, code, url):
        if code not in self._rows:
            raise KeyError(code)
        self._rows[code] = url

    def remove(self, code):
        if code not in self._rows:
            raise KeyError(code)
        del self._rows[code]

    def __contains__(self, code):
        return code in self._rows
