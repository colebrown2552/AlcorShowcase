"""Unit tests for the Flask API endpoints. Seed the database first: `python seed.py`, then `python unit_tests.py`."""
import app
import unittest

class unit_tets(unittest.TestCase):
    """API smoke tests; require a seeded database (run seed.py first)."""
    def setUp(self):
        app.app.config["TESTING"] = True
        self.client = app.app.test_client()

    def testGetSingleDisorder(self):
        with self.client:
            response = self.client.get("/get_disorder/?name=Vaginismus")
            self.assertEqual(response.status_code, 200)
            self.assertIsNotNone(response.data)
            data = response.json
            self.assertEqual(data[0]["name"], "Vaginismus")
    
    def testGetAllDisorders(self) :
        with self.client:
            response = self.client.get("/get_all_disorders/")
            self.assertEqual(response.status_code, 200)
            self.assertIsNotNone(response.data)

            data = response.json
            self.assertLessEqual(len(data), 65)

    def testGetSingleTreatment(self):
        with self.client:
            response = self.client.get("/get_treatment/?name=Doxepin")
            self.assertEqual(response.status_code, 200)
            self.assertIsNotNone(response.data)
            data = response.json
            self.assertEqual(data[0]["name"], "Doxepin")

    def testGetAllTreatment(self) :
        with self.client:
            response = self.client.get("/get_all_treatments/")
            self.assertEqual(response.status_code, 200)
            self.assertIsNotNone(response.data)

            data = response.json
            self.assertLessEqual(len(data), 375)

    def testGetSingleLocation(self):
        with self.client:
            response = self.client.get("/get_location/?name=Bright%20Light%20Counseling%20Center")
            self.assertEqual(response.status_code, 200)
            self.assertIsNotNone(response.data)
            data = response.json
            self.assertEqual(data[0]["name"], "Bright Light Counseling Center")

    def testGetAllLocations(self) :
        with self.client:
            response = self.client.get("/get_all_locations/")
            self.assertEqual(response.status_code, 200)
            self.assertIsNotNone(response.data)

            data = response.json
            self.assertLessEqual(len(data), 275)

        


if __name__ == "__main__":
    unittest.main()
