//! Protocol-agnostic discrete-event simulation of Nostr-style delivery:
//! several independent relays, lossy publishes, relay outages, devices that
//! go offline and catch up by re-querying, and a seeded workload.
//!
//! A protocol adapter implements [`Protocol`]. Both adapters get exactly the
//! same transport client: publish to every relay, retry while no relay
//! accepted, live subscriptions keyed by opaque routing keys, backfill on
//! reconnect / new key / periodic resync, de-duplication by wire id.

use rand::rngs::StdRng;
use rand::{Rng, SeedableRng};
use serde::Serialize;
use std::cmp::Reverse;
use std::collections::{BTreeMap, BinaryHeap, HashMap, HashSet};
use std::rc::Rc;
use std::time::Instant;

pub type Dev = usize;
pub type Ms = u64;

/// One transport object (a signed Nostr event in both stacks).
pub struct Wire<P> {
    /// Unique per distinct event; a retry of the same event keeps its id.
    pub id: u64,
    /// Label for accounting only.
    pub class: &'static str,
    pub bytes: usize,
    /// Routing keys a relay filter could match (`a:<author>`, `p:<tag>`, `h:<tag>`).
    pub keys: Vec<String>,
    pub payload: P,
}

#[derive(Clone, Debug)]
pub enum Action {
    /// Form the conversation. `accounts[0]` owns `creator`.
    Create {
        creator: Dev,
        accounts: Vec<usize>,
    },
    Send {
        dev: Dev,
        msg: u64,
        size: usize,
    },
    Add {
        admin: Dev,
        account: usize,
    },
    Remove {
        admin: Dev,
        account: usize,
    },
}

impl Action {
    fn dev(&self) -> Dev {
        match self {
            Action::Create { creator, .. } => *creator,
            Action::Send { dev, .. } => *dev,
            Action::Add { admin, .. } | Action::Remove { admin, .. } => *admin,
        }
    }
}

#[derive(Clone, Copy)]
pub enum DeliveryUpdate {
    Received(u64),
    Withdrawn(u64),
}

/// Everything an adapter call can ask the transport to do or report.
pub struct Out<P> {
    pub publishes: Vec<Wire<P>>,
    pub delivery_updates: Vec<DeliveryUpdate>,
    pub refused_sends: Vec<u64>,
    /// An admin operation the stack refused right now (busy); retried later.
    pub action_refused: bool,
    pub counters: Vec<(&'static str, u64)>,
}

impl<P> Default for Out<P> {
    fn default() -> Self {
        Self {
            publishes: Vec::new(),
            delivery_updates: Vec::new(),
            refused_sends: Vec::new(),
            action_refused: false,
            counters: Vec::new(),
        }
    }
}

impl<P> Out<P> {
    pub fn count(&mut self, name: &'static str, n: u64) {
        self.counters.push((name, n));
    }
}

#[derive(Clone, Debug, Serialize)]
pub struct DeviceView {
    /// Whether this device believes it is in the conversation.
    pub in_group: bool,
    /// Fingerprint of the shared state this device holds (epoch + tree hash
    /// for MLS, roster revision + members for sender keys).
    pub state: String,
    pub detail: String,
}

pub trait Protocol {
    type P;
    fn interest(&mut self, dev: Dev) -> Vec<String>;
    fn act(&mut self, now: Ms, action: &Action, out: &mut Out<Self::P>);
    fn deliver(&mut self, dev: Dev, now: Ms, wires: &[Rc<Wire<Self::P>>], out: &mut Out<Self::P>);
    fn tick(&mut self, dev: Dev, now: Ms, out: &mut Out<Self::P>);
    fn publish_outcome(&mut self, dev: Dev, now: Ms, wire: u64, accepted: bool, out: &mut Out<Self::P>);
    /// Account indices in this sender's local group view immediately before a send.
    fn sender_roster(&self, dev: Dev) -> Option<Vec<usize>>;
    fn view(&mut self, dev: Dev) -> DeviceView;
    fn storage_bytes(&mut self, _dev: Dev) -> Option<u64> {
        None
    }
}

enum Ev<P> {
    Act(usize),
    Attempt {
        dev: Dev,
        wire: Rc<Wire<P>>,
        attempt: u32,
    },
    Store {
        relay: usize,
        wire: Rc<Wire<P>>,
    },
    Outcome {
        dev: Dev,
        wire: u64,
        accepted: bool,
    },
    Arrive {
        dev: Dev,
        wire: Rc<Wire<P>>,
    },
    Drain {
        dev: Dev,
    },
    Tick {
        dev: Dev,
    },
    Resync {
        dev: Dev,
    },
    DevOnline {
        dev: Dev,
        online: bool,
    },
    RelayUp {
        relay: usize,
        up: bool,
    },
    FaultsOn,
    Heal,
}

struct Timed<P> {
    at: Ms,
    seq: u64,
    ev: Ev<P>,
}
impl<P> PartialEq for Timed<P> {
    fn eq(&self, o: &Self) -> bool {
        (self.at, self.seq) == (o.at, o.seq)
    }
}
impl<P> Eq for Timed<P> {}
impl<P> PartialOrd for Timed<P> {
    fn partial_cmp(&self, o: &Self) -> Option<std::cmp::Ordering> {
        Some(self.cmp(o))
    }
}
impl<P> Ord for Timed<P> {
    fn cmp(&self, o: &Self) -> std::cmp::Ordering {
        (self.at, self.seq).cmp(&(o.at, o.seq))
    }
}

struct Relay<P> {
    up: bool,
    has: HashSet<u64>,
    by_key: HashMap<String, Vec<(Ms, Rc<Wire<P>>)>>,
}

struct Device<P> {
    online: bool,
    interest: HashSet<String>,
    seen: HashSet<u64>,
    inbox: Vec<Rc<Wire<P>>>,
    drain_scheduled: bool,
    outbox: Vec<Rc<Wire<P>>>,
    deferred_actions: Vec<usize>,
    offline_since: Ms,
    /// Per relay: the time up to which this device has fully queried it.
    cursor: Vec<Ms>,
    rx_bytes: u64,
    rx_wires: u64,
    rx_dup_bytes: u64,
    tx_bytes: u64,
    tx_wires: u64,
    adapter_wall_ns: u128,
}

#[derive(Default, Clone, Serialize)]
pub struct ClassStat {
    pub events: u64,
    pub bytes: u64,
}

struct MsgRec {
    sent_at: Ms,
    sender: Dev,
    /// Devices that should end up with the plaintext.
    expect: Vec<Dev>,
    removed_at_send: HashSet<usize>,
    sender_roster_at_send: Option<Vec<usize>>,
    got: HashMap<Dev, Ms>,
    refused: bool,
    withdrawn: HashSet<Dev>,
    online_at_send: HashSet<Dev>,
}

#[derive(Default, Serialize)]
pub struct PostRemovalSenderView {
    included_account: u64,
    excluded_account: u64,
    unavailable: u64,
}

#[derive(Serialize)]
pub struct Report {
    pub protocol: String,
    pub scenario: Scenario,
    pub setup: PhaseCost,
    pub steady: PhaseCost,
    pub sends_scheduled: usize,
    pub sends_attempted: usize,
    pub sends_refused: usize,
    pub expected_deliveries: u64,
    pub delivered: u64,
    pub delivered_before_heal: u64,
    pub delivery_ratio: f64,
    pub delivery_ratio_before_heal: f64,
    pub undelivered_messages: usize,
    pub latency_ms_p50: u64,
    pub latency_ms_p95: u64,
    pub latency_ms_p99: u64,
    /// Same, restricted to recipients that were online when the message was sent.
    pub online_expected: u64,
    pub online_latency_ms_p50: u64,
    pub online_latency_ms_p95: u64,
    pub online_latency_ms_p99: u64,
    pub online_within_10s: f64,
    pub online_within_60s: f64,
    pub withdrawn_after_delivery: u64,
    /// Distinct message/device pairs read after a scheduled removal, before a scheduled rejoin.
    pub delivery_outside_intended_roster_after_removal: u64,
    pub post_removal_sender_view: PostRemovalSenderView,
    pub schedule_fingerprint: String,
    pub state_clusters: Vec<(String, usize)>,
    pub members_expected: usize,
    pub members_in_largest_cluster: usize,
    pub members_not_in_group: usize,
    pub removed_still_in_group: usize,
    pub counters: BTreeMap<String, u64>,
    pub storage_bytes_avg: Option<u64>,
    pub storage_bytes_max: Option<u64>,
    pub wall_s: f64,
    pub virtual_s: u64,
}

#[derive(Default, Clone, Serialize)]
pub struct PhaseCost {
    pub by_class: BTreeMap<String, ClassStat>,
    pub events: u64,
    pub bytes: u64,
    pub relay_upload_bytes: u64,
    /// Bytes a device downloaded once (duplicates from other relays excluded).
    pub rx_bytes_avg_per_device: u64,
    pub rx_bytes_max_per_device: u64,
    pub rx_events_avg_per_device: u64,
    pub adapter_wall_ms_total: u64,
    pub adapter_wall_ms_avg_per_device: f64,
    pub adapter_wall_ms_max_per_device: f64,
    pub publish_gave_up: u64,
}

const RETRY_MS: [Ms; 6] = [1_000, 3_000, 8_000, 20_000, 45_000, 90_000];
const DRAIN_MS: Ms = 25;
const SETUP_LIMIT_MS: Ms = 3_600_000;

pub struct Sim<Pr: Protocol> {
    pub proto: Pr,
    sc: Scenario,
    rng: StdRng,
    now: Ms,
    seq: u64,
    queue: BinaryHeap<Reverse<Timed<Pr::P>>>,
    relays: Vec<Relay<Pr::P>>,
    devs: Vec<Device<Pr::P>>,
    subs: HashMap<String, HashSet<Dev>>,
    actions: Vec<Action>,
    faults: bool,
    heal_at: Ms,
    faults_at: Ms,
    msgs: HashMap<u64, MsgRec>,
    /// account -> currently intended member.
    member: Vec<bool>,
    removed_at: Vec<Option<Ms>>,
    added_at: Vec<Ms>,
    tick_ms: Ms,
    cur: PhaseCost,
    setup_cost: Option<PhaseCost>,
    counters: BTreeMap<String, u64>,
    post_removal: PostRemovalSenderView,
    schedule_hash: u64,
    planned_roster: Vec<bool>,
    attempted: usize,
    action_attempts: HashMap<usize, u32>,
    last_refused: bool,
}

impl<Pr: Protocol> Sim<Pr> {
    pub fn new(proto: Pr, sc: Scenario) -> Self {
        let n = sc.devices();
        let rng = StdRng::seed_from_u64(sc.seed ^ 0x51ED_C0DE);
        let relays = (0..sc.net.relays)
            .map(|_| Relay {
                up: true,
                has: HashSet::new(),
                by_key: HashMap::new(),
            })
            .collect();
        let devs = (0..n)
            .map(|_| Device {
                online: true,
                interest: HashSet::new(),
                seen: HashSet::new(),
                inbox: Vec::new(),
                drain_scheduled: false,
                outbox: Vec::new(),
                deferred_actions: Vec::new(),
                offline_since: 0,
                cursor: vec![0; sc.net.relays],
                rx_bytes: 0,
                rx_wires: 0,
                rx_dup_bytes: 0,
                tx_bytes: 0,
                tx_wires: 0,
                adapter_wall_ns: 0,
            })
            .collect();
        let accounts_total = sc.accounts + sc.spare_accounts;
        let tick_ms = if n > 120 { 2_000 } else { 1_000 };
        Self {
            proto,
            rng,
            now: 0,
            seq: 0,
            queue: BinaryHeap::new(),
            relays,
            devs,
            subs: HashMap::new(),
            actions: Vec::new(),
            faults: false,
            heal_at: 0,
            faults_at: 0,
            msgs: HashMap::new(),
            member: vec![false; accounts_total],
            removed_at: vec![None; accounts_total],
            added_at: vec![0; accounts_total],
            tick_ms,
            cur: PhaseCost::default(),
            setup_cost: None,
            counters: BTreeMap::new(),
            post_removal: PostRemovalSenderView::default(),
            schedule_hash: 0xcbf29ce484222325,
            planned_roster: vec![],
            attempted: 0,
            action_attempts: HashMap::new(),
            last_refused: false,
            sc,
        }
    }

    fn push(&mut self, at: Ms, ev: Ev<Pr::P>) {
        self.seq += 1;
        self.queue.push(Reverse(Timed {
            at,
            seq: self.seq,
            ev,
        }));
    }

    /// Whether `dev` can talk to `relay` right now.
    fn reach(&self, dev: Dev, relay: usize) -> bool {
        if !self.relays[relay].up {
            return false;
        }
        match self.sc.partition_s {
            Some((start, len))
                if self.faults && self.now >= self.faults_at + start * 1000
                    && self.now < self.faults_at + (start + len) * 1000 =>
            {
                relay == self.sc.account_of(dev) % 2
            }
            _ => true,
        }
    }

    fn lat(&mut self) -> Ms {
        let (a, b) = self.sc.net.latency_ms;
        self.rng.gen_range(a..=b)
    }

    fn bump(&mut self, name: &str, n: u64) {
        *self.counters.entry(name.to_string()).or_default() += n;
    }

    /// Run the whole scenario and produce the report.
    pub fn run(mut self, protocol: &str) -> Report {
        let wall = Instant::now();
        let n = self.sc.devices();
        for dev in 0..n {
            self.refresh_interest(dev);
            let jitter = self.rng.gen_range(0..self.tick_ms);
            self.push(jitter, Ev::Tick { dev });
        }
        // Phase 0: form the conversation on a perfect network.
        let initial: Vec<usize> = (0..self.sc.accounts).collect();
        self.actions.push(Action::Create {
            creator: 0,
            accounts: initial.clone(),
        });
        for a in &initial {
            self.member[*a] = true;
        }
        self.push(1_000, Ev::Act(0));
        self.run_until_quiet(SETUP_LIMIT_MS);
        let setup_end = self.now;
        self.snapshot_phase();
        self.setup_cost = Some(std::mem::take(&mut self.cur));
        for d in &mut self.devs {
            d.rx_bytes = 0;
            d.rx_wires = 0;
            d.rx_dup_bytes = 0;
            d.tx_bytes = 0;
            d.tx_wires = 0;
            d.adapter_wall_ns = 0;
        }
        // Phase 1: faulty network + workload.
        let t0 = setup_end + 5_000;
        self.faults_at = t0;
        self.heal_at = t0 + self.sc.duration_s * 1000;
        let end = self.heal_at + self.sc.heal_s * 1000;
        self.push(t0, Ev::FaultsOn);
        self.push(self.heal_at, Ev::Heal);
        self.schedule_workload(t0);
        self.schedule_faults(t0);
        for dev in 0..n {
            let j = self.rng.gen_range(0..self.sc.net.resync_s.max(1) * 1000);
            self.push(t0 + j, Ev::Resync { dev });
        }
        self.run_to(end);
        self.snapshot_phase();
        self.finish(protocol, wall.elapsed().as_secs_f64())
    }

    fn run_until_quiet(&mut self, limit: Ms) {
        // Quiet = nothing but ticks pending for 20 virtual seconds.
        let mut last_activity = self.now;
        while let Some(Reverse(t)) = self.queue.pop() {
            if t.at > limit {
                self.queue.push(Reverse(t));
                break;
            }
            self.now = t.at;
            let is_tick = matches!(t.ev, Ev::Tick { .. });
            let before = self.cur.events;
            self.handle(t.ev);
            if !is_tick || self.cur.events != before {
                last_activity = self.now;
            }
            if self.now > last_activity + 20_000 {
                break;
            }
        }
    }

    fn run_to(&mut self, end: Ms) {
        while let Some(Reverse(t)) = self.queue.pop() {
            if t.at > end {
                break;
            }
            self.now = t.at;
            self.handle(t.ev);
        }
        self.now = end;
    }

    fn handle(&mut self, ev: Ev<Pr::P>) {
        match ev {
            Ev::Act(idx) => self.do_action(idx),
            Ev::Attempt { dev, wire, attempt } => self.attempt(dev, wire, attempt),
            Ev::Store { relay, wire } => self.store(relay, wire),
            Ev::Outcome { dev, wire, accepted } => {
                if !accepted {
                    self.cur.publish_gave_up += 1;
                }
                let now = self.now;
                self.call(dev, |p, out| p.publish_outcome(dev, now, wire, accepted, out));
            }
            Ev::Arrive { dev, wire } => {
                let d = &mut self.devs[dev];
                if !d.online {
                    return;
                }
                if !d.seen.insert(wire.id) {
                    d.rx_dup_bytes += wire.bytes as u64;
                    return;
                }
                d.rx_bytes += wire.bytes as u64;
                d.rx_wires += 1;
                d.inbox.push(wire);
                if !d.drain_scheduled {
                    d.drain_scheduled = true;
                    let at = self.now + DRAIN_MS;
                    self.push(at, Ev::Drain { dev });
                }
            }
            Ev::Drain { dev } => {
                self.devs[dev].drain_scheduled = false;
                let wires = std::mem::take(&mut self.devs[dev].inbox);
                if wires.is_empty() {
                    return;
                }
                let now = self.now;
                self.call(dev, |p, out| p.deliver(dev, now, &wires, out));
            }
            Ev::Tick { dev } => {
                if self.devs[dev].online {
                    let now = self.now;
                    self.call_inner(dev, false, |p, out| p.tick(dev, now, out));
                }
                let at = self.now + self.tick_ms;
                self.push(at, Ev::Tick { dev });
            }
            Ev::Resync { dev } => {
                if self.devs[dev].online {
                    self.backfill(dev, None, None);
                }
                let at = self.now + self.sc.net.resync_s.max(1) * 1000;
                self.push(at, Ev::Resync { dev });
            }
            Ev::DevOnline { dev, online } => self.set_online(dev, online),
            Ev::RelayUp { relay, up } => {
                if self.faults || up {
                    self.relays[relay].up = up;
                }
            }
            Ev::FaultsOn => self.faults = true,
            Ev::Heal => {
                self.faults = false;
                for r in &mut self.relays {
                    r.up = true;
                }
                for dev in 0..self.devs.len() {
                    self.set_online(dev, true);
                }
            }
        }
    }

    fn set_online(&mut self, dev: Dev, online: bool) {
        if !self.faults && !online {
            return;
        }
        if self.devs[dev].online == online {
            return;
        }
        self.devs[dev].online = online;
        if !online {
            self.devs[dev].offline_since = self.now;
            return;
        }
        self.backfill(dev, None, None);
        for wire in std::mem::take(&mut self.devs[dev].outbox) {
            let at = self.now + 500;
            self.push(
                at,
                Ev::Attempt {
                    dev,
                    wire,
                    attempt: 0,
                },
            );
        }
        for idx in std::mem::take(&mut self.devs[dev].deferred_actions) {
            // Only once the catch-up fetch has drained and been processed:
            // a client syncs before it flushes what it queued while offline.
            let at = self.now + 15_000;
            self.push(at, Ev::Act(idx));
        }
    }

    fn do_action(&mut self, idx: usize) {
        let action = self.actions[idx].clone();
        let dev = action.dev();
        if let Action::Send { msg, .. } = &action {
            let rec = self.msgs.get_mut(msg).expect("scheduled message");
            if self.now == rec.sent_at {
                rec.online_at_send
                    .extend(rec.expect.iter().filter(|d| self.devs[**d].online));
            }
        }
        if !self.devs[dev].online {
            self.devs[dev].deferred_actions.push(idx);
            self.bump("actions_deferred_offline", 1);
            return;
        }
        let now = self.now;
        if std::env::var("SIM_TRACE").is_ok() && !matches!(action, Action::Send { .. }) {
            eprintln!("[trace] t={}s exec {action:?}", now / 1000);
        }
        if let Action::Send { dev, msg, .. } = &action {
            let sender_acct = self.sc.account_of(*dev);
            // The plan was drawn before deferrals and refusals were known:
            // only accounts that really are settled members send.
            if !self.member[sender_acct]
                || (self.added_at[sender_acct] != 0 && self.added_at[sender_acct] + 60_000 > now)
            {
                self.bump("sends_skipped_sender_not_settled_member", 1);
                return;
            }
            let rec = self.msgs.get_mut(msg).expect("scheduled send");
            if !rec.removed_at_send.is_empty() {
                rec.sender_roster_at_send = self.proto.sender_roster(*dev);
            }
            self.attempted += 1;
        }
        self.last_refused = false;
        self.call(dev, |p, out| p.act(now, &action, out));
        let refused = self.last_refused;
        match &action {
            Action::Add { account, .. } | Action::Remove { account, .. } if refused => {
                let _ = account;
                let attempts = self.action_attempts.entry(idx).or_default();
                *attempts += 1;
                if *attempts < 12 {
                    let at = now + 5_000;
                    self.push(at, Ev::Act(idx));
                    self.bump("admin_ops_retried_after_refusal", 1);
                } else {
                    self.bump("admin_ops_abandoned", 1);
                }
            }
            Action::Add { account, .. } => {
                self.member[*account] = true;
                self.added_at[*account] = now;
                self.removed_at[*account] = None;
            }
            Action::Remove { account, .. } => {
                self.member[*account] = false;
                self.removed_at[*account] = Some(now);
            }
            _ => {}
        }
    }

    /// Invoke the adapter for `dev`, then apply what it asked for.
    fn call(&mut self, dev: Dev, f: impl FnOnce(&mut Pr, &mut Out<Pr::P>)) {
        self.call_inner(dev, true, f)
    }

    fn call_inner(&mut self, dev: Dev, always_refresh: bool, f: impl FnOnce(&mut Pr, &mut Out<Pr::P>)) {
        let mut out = Out::default();
        let started = Instant::now();
        f(&mut self.proto, &mut out);
        self.devs[dev].adapter_wall_ns += started.elapsed().as_nanos();
        let now = self.now;
        if out.action_refused {
            self.last_refused = true;
        }
        let active = always_refresh
            || !out.publishes.is_empty()
            || !out.delivery_updates.is_empty()
            || !out.counters.is_empty();
        for (name, n) in std::mem::take(&mut out.counters) {
            self.bump(name, n);
        }
        for msg in out.refused_sends {
            if let Some(rec) = self.msgs.get_mut(&msg) {
                rec.refused = true;
            }
        }
        for update in out.delivery_updates {
            match update {
                DeliveryUpdate::Received(msg) => {
                    if let Some(rec) = self.msgs.get_mut(&msg) {
                        if !rec.got.contains_key(&dev) && rec.removed_at_send.contains(&self.sc.account_of(dev))
                        {
                            let account = self.sc.account_of(dev);
                            match &rec.sender_roster_at_send {
                                Some(members) if members.contains(&account) => self.post_removal.included_account += 1,
                                Some(_) => self.post_removal.excluded_account += 1,
                                None => self.post_removal.unavailable += 1,
                            }
                        }
                        if rec.withdrawn.remove(&dev) {
                            rec.got.insert(dev, now);
                        } else {
                            rec.got.entry(dev).or_insert(now);
                        }
                    }
                }
                DeliveryUpdate::Withdrawn(msg) => {
                    if let Some(rec) = self.msgs.get_mut(&msg) {
                        rec.withdrawn.insert(dev);
                    }
                }
            }
        }
        let publishes = std::mem::take(&mut out.publishes);
        for wire in publishes {
            let stat = self.cur.by_class.entry(wire.class.to_string()).or_default();
            stat.events += 1;
            stat.bytes += wire.bytes as u64;
            self.cur.events += 1;
            self.cur.bytes += wire.bytes as u64;
            self.devs[dev].tx_bytes += wire.bytes as u64;
            self.devs[dev].tx_wires += 1;
            // The publisher already has its own event.
            self.devs[dev].seen.insert(wire.id);
            let wire = Rc::new(wire);
            if self.devs[dev].online {
                self.push(
                    now,
                    Ev::Attempt {
                        dev,
                        wire,
                        attempt: 0,
                    },
                );
            } else {
                self.devs[dev].outbox.push(wire);
            }
        }
        if active {
            self.refresh_interest(dev);
        }
    }

    fn refresh_interest(&mut self, dev: Dev) {
        let keys = self.proto.interest(dev);
        let desired: HashSet<_> = keys.iter().cloned().collect();
        for key in self.devs[dev].interest.difference(&desired) {
            if let Some(devices) = self.subs.get_mut(key) {
                devices.remove(&dev);
                if devices.is_empty() {
                    self.subs.remove(key);
                }
            }
        }
        self.devs[dev].interest.retain(|key| desired.contains(key));
        let mut fresh = Vec::new();
        for key in keys {
            if self.devs[dev].interest.insert(key.clone()) {
                self.subs.entry(key.clone()).or_default().insert(dev);
                fresh.push(key);
            }
        }
        if !fresh.is_empty() && self.devs[dev].online {
            // A newly learned key is queried for its whole retained history.
            self.backfill(dev, Some(&fresh), Some(0));
        }
    }

    /// Query every reachable relay. With `floor == None` each relay is asked
    /// for everything since this device last completed a query against it
    /// (a per-relay cursor with a 30 s overlap), so an event a relay holds is
    /// eventually fetched no matter how long that relay or the device was away.
    fn backfill(&mut self, dev: Dev, keys: Option<&[String]>, floor: Option<Ms>) {
        let mut owned: Vec<String>;
        let all_keys = keys.is_none();
        let keys: &[String] = match keys {
            Some(k) => k,
            None => {
                owned = self.devs[dev].interest.iter().cloned().collect();
                owned.sort();
                &owned
            }
        };
        let now = self.now;
        let mut found: Vec<Rc<Wire<Pr::P>>> = Vec::new();
        let mut picked: HashSet<u64> = HashSet::new();
        for r in 0..self.relays.len() {
            if !self.reach(dev, r) {
                continue;
            }
            let relay = &self.relays[r];
            let floor = floor.unwrap_or_else(|| self.devs[dev].cursor[r].saturating_sub(30_000));
            let retention = self.sc.net.relay_retention_s * 1000;
            let floor = if retention > 0 {
                floor.max(now.saturating_sub(retention))
            } else {
                floor
            };
            for key in keys {
                let Some(list) = relay.by_key.get(key) else {
                    continue;
                };
                let start = list.partition_point(|(at, _)| *at < floor);
                for (_, wire) in &list[start..] {
                    if !self.devs[dev].seen.contains(&wire.id) && picked.insert(wire.id) {
                        found.push(wire.clone());
                    }
                }
            }
            if all_keys {
                self.devs[dev].cursor[r] = now;
            }
        }
        for wire in found {
            let at = self.now + self.lat();
            self.push(at, Ev::Arrive { dev, wire });
        }
    }

    fn attempt(&mut self, dev: Dev, wire: Rc<Wire<Pr::P>>, attempt: u32) {
        if !self.devs[dev].online {
            self.devs[dev].outbox.push(wire);
            return;
        }
        let net = &self.sc.net;
        let (loss, max_bytes, n) = (net.publish_loss, net.relay_max_bytes, net.relays);
        let mut accepted = false;
        let mut too_big = false;
        for relay in 0..n {
            if !self.reach(dev, relay) {
                continue;
            }
            self.cur.relay_upload_bytes += wire.bytes as u64;
            if max_bytes > 0 && wire.bytes > max_bytes {
                too_big = true;
                continue;
            }
            if self.faults && self.rng.gen_bool(loss) {
                continue;
            }
            accepted = true;
            let at = self.now + self.lat();
            self.push(
                at,
                Ev::Store {
                    relay,
                    wire: wire.clone(),
                },
            );
        }
        if too_big {
            self.bump("relay_rejected_too_large", 1);
        }
        let at = self.now + self.lat() * 2;
        if accepted {
            self.push(
                at,
                Ev::Outcome {
                    dev,
                    wire: wire.id,
                    accepted: true,
                },
            );
        } else if (attempt as usize) < RETRY_MS.len() && !too_big {
            let at = self.now + RETRY_MS[attempt as usize];
            self.push(
                at,
                Ev::Attempt {
                    dev,
                    wire,
                    attempt: attempt + 1,
                },
            );
        } else {
            self.push(
                at,
                Ev::Outcome {
                    dev,
                    wire: wire.id,
                    accepted: false,
                },
            );
        }
    }

    fn store(&mut self, relay: usize, wire: Rc<Wire<Pr::P>>) {
        if !self.relays[relay].up || !self.relays[relay].has.insert(wire.id) {
            return;
        }
        let now = self.now;
        let retention = self.sc.net.relay_retention_s * 1000;
        let mut targets: Vec<Dev> = Vec::new();
        for key in &wire.keys {
            let list = self.relays[relay].by_key.entry(key.clone()).or_default();
            if retention > 0 {
                let cut = list.partition_point(|(at, _)| *at + retention < now);
                list.drain(..cut);
            }
            list.push((now, wire.clone()));
            if let Some(devs) = self.subs.get(key) {
                targets.extend(devs.iter().copied());
            }
        }
        targets.sort_unstable();
        targets.dedup();
        let live_loss = self.sc.net.live_loss;
        for dev in targets {
            if !self.devs[dev].online || self.devs[dev].seen.contains(&wire.id) || !self.reach(dev, relay) {
                continue;
            }
            if self.faults && self.rng.gen_bool(live_loss) {
                continue;
            }
            let at = now + self.lat();
            self.push(
                at,
                Ev::Arrive {
                    dev,
                    wire: wire.clone(),
                },
            );
        }
    }
}

mod metrics;
mod scenario;
mod workload;
pub use scenario::{decode_msg, encode_msg, scenario_from_args, NetProfile, Scenario};

#[cfg(test)]
mod tests;
