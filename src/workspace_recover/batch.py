"""WR's existing all-settled boundary for independent resource transfers."""
from concurrent.futures import ThreadPoolExecutor


def all_settled(calls):
    if not calls: return []
    with ThreadPoolExecutor(max_workers=min(32, len(calls))) as pool:
        futures = [pool.submit(call) for call in calls]
        results, failures = [], []
        for future in futures:
            try: results.append(future.result())
            except Exception as error:
                failures.append(error)
                results.append(None)
    if failures: raise failures[0]
    return results
