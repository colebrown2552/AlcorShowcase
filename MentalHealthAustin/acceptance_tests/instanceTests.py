# Selenium acceptance tests: the model list pages load and navigate correctly.
# Set SITE_URL to test a site other than the local dev server.
import os
import unittest
from selenium import webdriver
from selenium.webdriver.chrome.service import Service
from webdriver_manager.chrome import ChromeDriverManager
from selenium.webdriver.common.by import By


# Adapted from a public example by another student team.

URL = os.environ.get("SITE_URL", "http://127.0.0.1:3000/")  # site under test; must end with "/"


class Test(unittest.TestCase):
    @classmethod
    def setUpClass(self) -> None:
        options = webdriver.ChromeOptions()
        options.add_experimental_option("excludeSwitches", ["enable-logging"])
        options.add_argument("--headless")
        options.add_argument("--no-sandbox")
        options.add_argument("--disable-dev-shm-usage")
        chrome_prefs = {}
        options.experimental_options["prefs"] = chrome_prefs
        # Disable images
        chrome_prefs["profile.default_content_settings"] = {"images": 2}
        self.driver = webdriver.Chrome(
            options=options, service=Service(ChromeDriverManager().install())
        )
        self.driver.get(URL)

    @classmethod
    def tearDownClass(self):
        self.driver.quit()

    def test_disorders(self):
        self.driver.get(URL + "disorders")
        self.assertEqual(self.driver.current_url, URL + "disorders")

    def test_locations(self):
        self.driver.get(URL + "locations")
        self.assertEqual(self.driver.current_url, URL + "locations")

    def test_treatments(self):
        self.driver.get(URL + "treatments")
        self.assertEqual(self.driver.current_url, URL + "treatments")


if __name__ == "__main__":
    unittest.main()
