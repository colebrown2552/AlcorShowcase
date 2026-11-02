# Runs the Selenium acceptance tests in acceptance_tests/ one after another (used by the CI pipeline).
import os
from sys import platform

# Adapted from a public example by another student team.

if __name__ == "__main__":
    # Use chromedriver based on OS
    if platform == "win32":
        PATH = "./acceptance_tests/chromedriver.exe"
    elif platform == "linux":
        PATH = "./acceptance_tests/chromedriver_linux"
    else:
        print("Unsupported OS")
        exit(-1)

    # Run all of the gui tests
    os.system("python3 ./acceptance_tests/instanceTests.py")
    os.system("python3 ./acceptance_tests/navbarTests.py")
    os.system("python3 ./acceptance_tests/instancePageTests.py")
