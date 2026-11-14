# mdtoc

Generates a Markdown table of contents for our docs pages.

```python
from mdtoc import build_toc
print(build_toc(open("guide.md").read()))
```

Anchors follow GitHub's heading-anchor style (see `mdtoc/slug.py`).
