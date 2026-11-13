//! `sim_mdk <label> <accounts> <devices> <net> <seed> [key=value ...]`
use cgka_conformance_simulator::ndr_compare::MdkSim;

fn main() {
    let args: Vec<String> = std::env::args().skip(1).collect();
    let mut sim_args = Vec::new();
    let mut post_join = true;
    for arg in args {
        if arg == "post_join=0" {
            post_join = false;
        } else {
            sim_args.push(arg);
        }
    }
    let scenario = simnet::scenario_from_args(&sim_args);
    let mut proto = MdkSim::new(&scenario);
    proto.post_join_updates = post_join;
    let report = simnet::Sim::new(proto, scenario).run("mdk");
    println!("{}", serde_json::to_string(&report).expect("report"));
}
