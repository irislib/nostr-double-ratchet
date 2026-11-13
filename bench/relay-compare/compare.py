"""Validate paired engine reports and print the measured tradeoffs per scenario."""
import argparse
import json
from pathlib import Path

from run import CASES


def read_reports(path):
    rows = {}
    if path.is_dir():
        reports = (json.loads(p.read_text()) for p in sorted(path.glob("*.json")))
    else:
        reports = (json.loads(line) for line in path.read_text().splitlines() if line.strip())
    for row in reports:
        label = row["scenario"]["label"]
        if label in rows:
            raise ValueError(f"duplicate run: {label}")
        rows[label] = row
    return rows


def validate(ndr, other, case, seed, *, previous_ndr=False):
    name = f"{case}-{seed}"
    expected_peer = "ndr-author-routing" if previous_ndr else "mdk"
    if ndr["protocol"] != "ndr-author-routing" or other["protocol"] != expected_peer:
        raise ValueError(f"{name}: incorrect engines")
    scenario = ndr["scenario"]
    if (scenario["seed"] != seed or scenario["label"] != name or scenario != other["scenario"]
            or not ndr["schedule_fingerprint"] or ndr["schedule_fingerprint"] != other["schedule_fingerprint"]
            or ndr["expected_deliveries"] != other["expected_deliveries"]
            or ndr["online_expected"] != other["online_expected"]):
        raise ValueError(f"{name}: different workloads, outages or delivery obligations")
    for row in (ndr, other):
        sent = row["sends_scheduled"]
        owed = row["expected_deliveries"]
        if not (0 <= row["sends_refused"] <= row["sends_attempted"] <= sent == scenario["messages"]
                and 0 < owed and 0 <= row["delivered_before_heal"] <= row["delivered"] <= owed
                and 0 <= row["online_expected"] <= owed
                and sum(row["post_removal_sender_view"].values()) == row["delivery_outside_intended_roster_after_removal"]):
            raise ValueError(f"{name}: inconsistent counters")


def main():
    parser = argparse.ArgumentParser(description=__doc__)
    parser.add_argument("ndr", type=Path, help="NDR results (new results in a before/after comparison)")
    parser.add_argument("peer", type=Path, help="MDK results or the previous NDR results")
    parser.add_argument("--previous-ndr", action="store_true", help="compare NDR against a previous NDR build")
    parser.add_argument("case", choices=[*CASES, "all"])
    parser.add_argument("--seeds", type=int, nargs="+")
    args = parser.parse_args()
    left, right = read_reports(args.ndr), read_reports(args.peer)
    cases = CASES if args.case == "all" else [args.case]
    print("case engine seeds retained/owed retained% seed-range% online-in-60s% "
          "published-KiB/send relay-upload-KiB/send shared-data-events/send post-removal(included/excluded/unknown)")
    for case in cases:
        seeds = args.seeds or ([1] if case in ("cap", "large") else list(range(1, 6)))
        if len(set(seeds)) != len(seeds):
            parser.error("duplicate seeds")
        labels = [f"{case}-{seed}" for seed in seeds]
        for seed, key in zip(seeds, labels):
            if key not in left or key not in right:
                parser.error(f"missing pair: {key}")
            validate(left[key], right[key], case, seed, previous_ndr=args.previous_ndr)
        names = ("NDR-after", "NDR-before") if args.previous_ndr else ("NDR", "MDK")
        for name, reports in zip(names, (left, right)):
            rows = [reports[key] for key in labels]
            delivered = sum(r["delivered"] for r in rows)
            owed = sum(r["expected_deliveries"] for r in rows)
            sent = sum(r["sends_scheduled"] for r in rows)
            pct = [100 * r["delivered"] / r["expected_deliveries"] for r in rows]
            online = sum(r["online_expected"] for r in rows)
            within = sum(round(r["online_within_60s"] * r["online_expected"]) for r in rows)
            prompt = f"{100 * within / online:.1f}" if online else "n/a"
            cost = [sum(r["steady"][field] for r in rows) / 1024 / sent
                    for field in ("bytes", "relay_upload_bytes")]
            reads = [sum(r["post_removal_sender_view"][field] for r in rows)
                     for field in ("included_account", "excluded_account", "unavailable")]
            shared = sum(r["steady"]["by_class"].get("ndr_shared_data_1060", {}).get("events", 0) for r in rows)
            print(case, name, len(rows), f"{delivered}/{owed}", f"{100*delivered/owed:.2f}",
                  f"{min(pct):.1f}-{max(pct):.1f}", prompt, *(f"{v:.2f}" for v in cost),
                  f"{shared/sent:.2f}" if name != "MDK" else "n/a", "/".join(map(str, reads)))


if __name__ == "__main__":
    main()
