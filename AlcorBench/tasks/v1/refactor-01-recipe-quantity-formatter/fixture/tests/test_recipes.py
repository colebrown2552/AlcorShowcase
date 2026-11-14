import unittest
from fractions import Fraction

from recipes.scale import scale_recipe
from recipes.shopping import shopping_list

PANCAKES = ["1 1/2 cup flour", "2 eggs", "1 tbsp sugar", "1/2 tsp salt", "300 ml milk"]


class ScaleTests(unittest.TestCase):
    def test_double(self):
        self.assertEqual(scale_recipe(PANCAKES, 4, 8),
                         ["3 cup flour", "4 eggs", "2 tbsp sugar", "1 tsp salt", "600 ml milk"])

    def test_third(self):
        self.assertEqual(scale_recipe(["1 cup rice", "1/2 tsp salt"], 3, 1), ["⅓ cup rice", "⅛ tsp salt"])

    def test_bad_servings(self):
        with self.assertRaises(ValueError):
            scale_recipe(PANCAKES, 0, 2)


class ShoppingTests(unittest.TestCase):
    def test_merges_units_and_names(self):
        got = shopping_list([(["2 cups flour", "1 clove garlic"], 1), (["1/2 cup Flour", "2 cloves garlic"], Fraction(1, 2))])
        self.assertEqual(got, ["flour: 2 ¼ cup", "garlic: 2 clove"])


if __name__ == "__main__":
    unittest.main()
