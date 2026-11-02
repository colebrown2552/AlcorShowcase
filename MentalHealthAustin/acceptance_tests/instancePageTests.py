# Selenium acceptance tests: model instance detail pages open from the list pages.
# Set SITE_URL to test a site other than the local dev server.
import os
import unittest
from selenium import webdriver
from selenium.webdriver.chrome.service import Service
from webdriver_manager.chrome import ChromeDriverManager
from selenium.webdriver.common.by import By
from selenium.webdriver.support.ui import WebDriverWait
from selenium.webdriver.support import expected_conditions as EC

URL = os.environ.get("SITE_URL", "http://127.0.0.1:3000/")  # site under test; must end with "/"

class Test(unittest.TestCase):
    @classmethod
    def setUpClass(cls):
        options = webdriver.ChromeOptions()
        options.add_experimental_option("excludeSwitches", ["enable-logging"])
        options.add_argument("--headless")
        options.add_argument("--no-sandbox")
        options.add_argument("--disable-dev-shm-usage")
        options.add_argument("--window-size=1920,1080")
        chrome_prefs = {}
        options.experimental_options["prefs"] = chrome_prefs
        # Disable images
        chrome_prefs["profile.default_content_settings"] = {"images": 2}
        cls.driver = webdriver.Chrome(
            options=options, service=Service(ChromeDriverManager().install())
        )
        cls.driver.get(URL)

    @classmethod
    def tearDownClass(cls):
        cls.driver.quit()

    def test_disorder_instance(self):
        self.driver.get(URL + "disorders")

        try:
            WebDriverWait(self.driver, 50, 1).until(
                EC.element_to_be_clickable(
                    (By.XPATH, '//*[@id="root"]/div/div/div[3]/div/div[1]/div/div/div[3]/a')
                )
            )
            element = self.driver.find_element(
                By.XPATH, '//*[@id="root"]/div/div/div[3]/div/div[1]/div/div/div[3]/a'
            )
            element.click()
        except Exception as ex:
            print("Couldn't find Disorder button: " + str(ex))

        try:
            WebDriverWait(self.driver, 10).until(
                EC.presence_of_element_located((By.CLASS_NAME, "card-body"))
            )
        except Exception as ex:
            print("Couldn't find card-body element: " + str(ex))

        card_body = self.driver.find_element(By.CLASS_NAME, "list-group")
        self.assertIn("Description:", card_body.text)

if __name__ == "__main__":
    unittest.main()
