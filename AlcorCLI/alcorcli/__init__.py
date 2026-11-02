"""AlcorCLI: the single gate between an agent and the world.

Every model call and every side effect an agent makes passes through this package. The package
routes a model call to a provider that is reachable only over loopback, asks a finite ``.alcor``
program whether an effect may happen, performs the effect only when the answer is yes, and
appends a hash-chained receipt for each step.

Start with ``alcorcli.cli`` (command dispatch), ``alcorcli.policy`` (how a program is consulted),
``alcorcli.tools`` (the effect gate) and ``alcorcli.ask`` (the model-call path).
"""

__version__ = "0.1.0"
