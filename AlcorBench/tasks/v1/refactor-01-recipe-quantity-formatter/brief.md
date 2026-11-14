# One quantity formatter for the recipe tools

The recipe scaler prints amounts like `1 ½ cup` or `⅔ tsp`. That formatting
code was copy-pasted: `recipes/scale.py` (used by `scale_recipe`) and
`recipes/shopping.py` (used by `shopping_list`) each have their own private
copy. Last month a rounding fix had to be made twice, once in each copy,
and the second one was nearly forgotten.

Please move the formatting into `recipes/units.py` (which already holds the
shared unit helpers) as a public function `format_quantity(value)`, and make
both `scale.py` and `shopping.py` import and call it, removing their private
copies. No behaviour change: for
every input, `scale_recipe` and `shopping_list` must return exactly what they
return today. `recipes/parse.py` does not need to change.

Done means: `recipes/units.py` provides `format_quantity`, neither
`scale.py` nor `shopping.py` contains its own formatting logic any more and
both go through `units.format_quantity`, and the output of the public
functions is unchanged. `tests/test_recipes.py` must keep passing
(`python3 -m unittest discover -s tests -t .`).
