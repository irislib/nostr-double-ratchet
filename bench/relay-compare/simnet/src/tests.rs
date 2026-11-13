use super::*;

struct Refusing;
impl Protocol for Refusing {
    type P = ();
    fn interest(&mut self, _: Dev) -> Vec<String> {
        vec![]
    }
    fn act(&mut self, _: Ms, action: &Action, out: &mut Out<()>) {
        if let Action::Send { msg, .. } = action {
            out.refused_sends.push(*msg);
        }
    }
    fn deliver(&mut self, _: Dev, _: Ms, _: &[Rc<Wire<()>>], _: &mut Out<()>) {}
    fn tick(&mut self, _: Dev, _: Ms, _: &mut Out<()>) {}
    fn publish_outcome(&mut self, _: Dev, _: Ms, _: u64, _: bool, _: &mut Out<()>) {}
    fn sender_roster(&self, _: Dev) -> Option<Vec<usize>> { None }
    fn view(&mut self, _: Dev) -> DeviceView {
        DeviceView {
            in_group: false,
            state: String::new(),
            detail: String::new(),
        }
    }
}

#[test]
fn final_delivery_tracks_invalidation_and_redelivery_in_order() {
    let mut sim = Sim::new(Refusing, scenario_from_args(&[]));
    sim.member.fill(true);
    sim.schedule_workload(0);
    for msg in 1..=2 {
        let dev = sim.msgs[&msg].expect[0];
        sim.call(dev, |_, out| {
            out.delivery_updates.push(DeliveryUpdate::Received(msg));
            out.delivery_updates.push(DeliveryUpdate::Withdrawn(msg));
            if msg == 2 {
                out.delivery_updates.push(DeliveryUpdate::Received(msg));
            }
        });
    }
    let report = sim.finish("control", 0.);
    assert_eq!(report.delivered, 1);
    assert_eq!(report.withdrawn_after_delivery, 1);
    assert_eq!(report.expected_deliveries, 200);
}

#[test]
fn classify_each_observed_post_removal_read_once_using_the_sender_view() {
    let mut sim = Sim::new(Refusing, scenario_from_args(&[]));
    sim.member.fill(true);
    sim.schedule_workload(0);
    for msg in 1..=3 {
        let rec = sim.msgs.get_mut(&msg).unwrap();
        let dev = rec.expect[0];
        rec.removed_at_send.insert(dev);
        rec.sender_roster_at_send = match msg {
            1 => Some(vec![dev]),
            2 => Some(vec![]),
            _ => None,
        };
        sim.call(dev, |_, out| {
            out.delivery_updates.push(DeliveryUpdate::Received(msg));
            out.delivery_updates.push(DeliveryUpdate::Withdrawn(msg));
            out.delivery_updates.push(DeliveryUpdate::Received(msg));
        });
    }
    let report = sim.finish("control", 0.);
    assert_eq!(report.delivery_outside_intended_roster_after_removal, 3);
    assert_eq!(report.post_removal_sender_view.included_account, 1);
    assert_eq!(report.post_removal_sender_view.excluded_account, 1);
    assert_eq!(report.post_removal_sender_view.unavailable, 1);
}

#[test]
fn refusing_all_messages_scores_zero() {
    let scenario = scenario_from_args(&[]);
    let count = scenario.messages as u64;
    let report = Sim::new(Refusing, scenario).run("control");
    assert_eq!(report.expected_deliveries, count);
    assert_eq!(report.delivered, 0);
}

#[test]
fn trace_identifies_actual_actions_and_outages_independent_of_setup_time() {
    fn fingerprint(seed: u64, start: Ms, outage: bool) -> u64 {
        let mut sc = scenario_from_args(&[]);
        sc.seed = seed;
        sc.net.dev_offline_frac = if outage { 0.5 } else { 0.0 };
        let mut sim = Sim::new(Refusing, sc);
        sim.member.fill(true);
        sim.schedule_workload(start);
        sim.schedule_faults(start);
        sim.schedule_hash
    }
    assert_eq!(fingerprint(1, 5, true), fingerprint(1, 15000, true));
    assert_ne!(fingerprint(1, 5, true), fingerprint(2, 5, true));
    assert_ne!(fingerprint(1, 5, true), fingerprint(1, 5, false));
}
