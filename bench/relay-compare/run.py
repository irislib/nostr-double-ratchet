"""Run matching scenarios on either engine. One complete JSON file per successful run."""
import argparse
import json
from pathlib import Path
import subprocess

CASES = {
    "direct": (2, 1, "harsh", []),
    "direct2": (2, 2, "harsh", []),
    "small": (5, 2, "flaky", ["spare=0", "churn=0"]),
    "small-edits": (5, 2, "flaky", ["spare=1", "churn=2", "concurrent=0"]),
    "static": (10, 1, "flaky", ["spare=0", "churn=0"]),
    "seq": (10, 1, "harsh", ["concurrent=0", "churn=6"]),
    "race": (10, 2, "flaky", ["concurrent=1", "churn=6"]),
    "busy": (10, 1, "flaky", ["spare=0", "churn=0", "messages=1000"]),
    "static2": (10, 2, "flaky", ["spare=0", "churn=0"]),
    "seq2": (10, 2, "flaky", ["concurrent=0", "churn=6"]),
    "partition": (10, 2, "flaky", ["concurrent=1", "churn=6", "partition=900:900",
                                     "churn_window=900:900"]),
    "large": (100, 1, "ideal", ["churn=0", "spare=0", "duration=1800", "heal=600", "messages=100"]),
    "cap": (100, 1, "ideal", ["churn=0", "spare=0", "relay_max_bytes=65536", "duration=1800",
                              "heal=600", "messages=100"]),
}


def main():
    parser = argparse.ArgumentParser(description=__doc__)
    parser.add_argument("binary", type=Path)
    parser.add_argument("output", type=Path)
    parser.add_argument("cases", nargs="+", choices=CASES)
    parser.add_argument("--seeds", type=int, nargs="+", default=[1, 2, 3])
    args = parser.parse_args()
    args.output.mkdir(exist_ok=True, parents=True)
    for case in args.cases:
        accounts, devices, net, options = CASES[case]
        for seed in args.seeds:
            label = f"{case}-{seed}"
            path = args.output / f"{label}.json"
            if path.exists():
                parser.error(f"result already exists: {path}")
            command = [args.binary.resolve(), label, str(accounts), str(devices), net, str(seed), *options]
            result = subprocess.run(command, stdout=subprocess.PIPE, check=True)
            report = json.loads(result.stdout)
            if (report["scenario"]["label"] != label or report["scenario"]["seed"] != seed
                    or report["sends_scheduled"] != report["scenario"]["messages"]):
                raise ValueError(f"{label}: engine returned an incomplete or different workload")
            print(f"{label}  {report['delivered']}/{report['expected_deliveries']} retained", flush=True)
            path.write_bytes(result.stdout)


if __name__ == "__main__":
    main()
