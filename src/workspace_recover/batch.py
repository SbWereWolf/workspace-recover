"""WR's existing all-settled boundary for independent resource transfers."""
from command_execution import CallListRunner


def all_settled(calls):
    result = CallListRunner().run(calls)
    if result.first_error is not None:
        raise result.first_error
    return [row.value for row in result.outcomes]
