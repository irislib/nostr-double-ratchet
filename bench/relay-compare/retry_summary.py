"""Summarize per-publication retry traces from NDR_RETRY_AUDIT without retaining any wire secrets."""
import argparse
from collections import Counter
import csv
import json
from pathlib import Path


def summarize(trace, report):
    with trace.open() as source:
        rows = list(csv.DictReader(source, delimiter="\t"))
    writers = {}
    for row in rows:
        if row["payload"] == "shared_data":
            author = row["stream"]
            writer = int(row["from"])
            if writers.setdefault(author, writer) != writer:
                raise ValueError("two writers for one sender stream")

    cats = {name: Counter() for name in ("stages", "payloads", "targets", "directions", "selectors")}
    pairs = Counter()
    repeated = events = total = 0
    per_device = report["scenario"]["devices_per_account"]
    for row in rows:
        if row["phase"] != "work" or row["class"] != "ndr_retry_1060":
            continue
        size = int(row["bytes"])
        sender, target = int(row["from"]), int(row["to"])
        writer = writers.get(row["stream"])
        target_role = ("unknown" if writer is None else "source_device" if target == writer
                       else "source_account_other_device" if target // per_device == writer // per_device
                       else "other_account")
        direction = "own_linked_device" if sender // per_device == target // per_device else "other_account"
        shape = "".join(k[0] for k in ("key", "position", "revision") if row[k]) or "hidden"
        dimensions = {"stages": row["stage"], "payloads": row["payload"], "targets": target_role,
                      "directions": direction, "selectors": shape if row["payload"] == "request" else "n/a"}
        for k, value in dimensions.items():
            cats[k][value] += size
        pairs[(sender, target)] += size
        repeated += int(row["seen"]) * size
        total += size
        events += 1
    wire = report["steady"]["by_class"].get("ndr_retry_1060", {"bytes": 0, "events": 0})
    if (total, events) != (wire["bytes"], wire["events"]):
        raise ValueError(f"{trace.name}: trace does not balance with benchmark report")
    return {"label": report["scenario"]["label"], "sends": report["sends_scheduled"],
            "fingerprint": report["schedule_fingerprint"], "retry_events": events, "retry_bytes": total,
            "repeat_recipient_bytes": repeated, **cats,
            "device_pair_bytes": {f"{s}>{t}": n for (s,t),n in sorted(pairs.items())}}


def main():
    parser = argparse.ArgumentParser(description=__doc__)
    parser.add_argument("traces", type=Path)
    parser.add_argument("reports", type=Path)
    parser.add_argument("case")
    parser.add_argument("--seeds", type=int, nargs="+", default=[1, 2, 3, 4, 5])
    args = parser.parse_args()
    for seed in args.seeds:
        label = f"{args.case}-{seed}"
        report = json.loads((args.reports / f"{label}.json").read_text())
        if report["scenario"]["label"] != label:
            parser.error(f"incorrect scenario: {label}")
        print(json.dumps(summarize(args.traces / f"{label}.tsv", report), separators=(",", ":")))


if __name__ == "__main__":
    main()
