First run 'python3 -m venv .venv' to create a virtual environment in a new 
directory named '.venv' . Then, we activate the virtual environment.

On windows, you can activate virtual environment by running '.\venv\Scripts\activate' .
You can deactivate by typing 'deactivate'.
If you run into the error '....\.venv\Scripts\Activate.ps1 cannot be loaded because
running scripts is disabled on this system. ...'
    Open windows powershell in administrator mode. You can then type the command:
    'set-executionpolicy remotesigned'
    to allow this script to be run. Then re run the activation command.

Finally, we can install the dependencies in the virtual environment by 
running 'pip install -r requirements.txt'.

Now we should be ready to run any python scripts in the backend folder in 
the virtual environment.

If you want to add any packages to the virtual environment, activate the environment,
'pip install ' any package you wish, then run 'pip freeze > requirements.txt'.
This will put all the current libraries used into the requirements file for the next 
person/session.