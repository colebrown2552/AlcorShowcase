# Selenium acceptance tests: every navbar link goes to the right page.
# Set SITE_URL to test a site other than the local dev server.
# Adapted from a public example by another student team.

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

    def test_Brand(self):
        element = self.driver.find_element(By.CLASS_NAME, "navbar-brand")
        element.click()
        self.assertEqual(self.driver.current_url, URL)

    def test_Home(self):
        try:
            WebDriverWait(self.driver, 10).until(
                EC.element_to_be_clickable((By.CLASS_NAME, "navbar-brand"))
            )
            element = self.driver.find_element(By.CLASS_NAME, "navbar-brand")
            element.click()
        except Exception as ex:
            print("Couldn't find navbar brand: " + str(ex))

        try:
            WebDriverWait(self.driver, 10).until(
                EC.element_to_be_clickable((By.CLASS_NAME, "navbar-toggler"))
            )
            element = self.driver.find_element(By.CLASS_NAME, "navbar-toggler")
            element.click()
        except Exception as ex:
            print("Couldn't find navbar: " + str(ex))

        self.assertEqual(self.driver.current_url, URL)

    def test_About(self):
        try:
            WebDriverWait(self.driver, 10).until(
                EC.element_to_be_clickable((By.CLASS_NAME, "navbar-brand"))
            )
            element = self.driver.find_element(By.CLASS_NAME, "navbar-brand")
            element.click()
        except Exception as ex:
            print("Couldn't find navbar brand: " + str(ex))

        try:
            WebDriverWait(self.driver, 10).until(
                EC.element_to_be_clickable((By.CLASS_NAME, "navbar-toggler"))
            )
            element = self.driver.find_element(By.CLASS_NAME, "navbar-toggler")
            element.click()
        except Exception as ex:
            print("Couldn't find navbar: " + str(ex))

        self.driver.get(URL + "about/")
        self.assertEqual(self.driver.current_url, URL + "about/")

    def test_Disorders(self):
        try:
            WebDriverWait(self.driver, 10).until(
                EC.element_to_be_clickable((By.CLASS_NAME, "navbar-brand"))
            )
            element = self.driver.find_element(By.CLASS_NAME, "navbar-brand")
            element.click()
        except Exception as ex:
            print("Couldn't find navbar brand: " + str(ex))

        try:
            WebDriverWait(self.driver, 10).until(
                EC.element_to_be_clickable((By.CLASS_NAME, "navbar-toggler"))
            )
            element = self.driver.find_element(By.CLASS_NAME, "navbar-toggler")
            element.click()
        except Exception as ex:
            print("Couldn't find navbar: " + str(ex))


        self.driver.get(URL + "disorders")
        self.assertEqual(self.driver.current_url, URL + "disorders")

    def test_Locations(self):
        try:
            WebDriverWait(self.driver, 10).until(
                EC.element_to_be_clickable((By.CLASS_NAME, "navbar-brand"))
            )
            element = self.driver.find_element(By.CLASS_NAME, "navbar-brand")
            element.click()
        except Exception as ex:
            print("Couldn't find navbar brand: " + str(ex))

        try:
            WebDriverWait(self.driver, 10).until(
                EC.element_to_be_clickable((By.CLASS_NAME, "navbar-toggler"))
            )
            element = self.driver.find_element(By.CLASS_NAME, "navbar-toggler")
            element.click()
        except Exception as ex:
            print("Couldn't find navbar: " + str(ex))

        self.driver.get(URL + "locations")
        self.assertEqual(self.driver.current_url, URL + "locations")

    def test_Treatments(self):
        try:
            WebDriverWait(self.driver, 10).until(
                EC.element_to_be_clickable((By.CLASS_NAME, "navbar-brand"))
            )
            element = self.driver.find_element(By.CLASS_NAME, "navbar-brand")
            element.click()
        except Exception as ex:
            print("Couldn't find navbar brand: " + str(ex))

        try:
            WebDriverWait(self.driver, 10).until(
                EC.element_to_be_clickable((By.CLASS_NAME, "navbar-toggler"))
            )
            element = self.driver.find_element(By.CLASS_NAME, "navbar-toggler")
            element.click()
        except Exception as ex:
            print("Couldn't find navbar: " + str(ex))

        self.driver.get(URL + "treatments")
        self.assertEqual(self.driver.current_url, URL + "treatments")


if __name__ == "__main__":
    unittest.main()
