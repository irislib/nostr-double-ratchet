//! Adapter that drives real `cgka-engine` clients (through `HarnessClient`
//! and the real Nostr peeler) from the protocol-agnostic `simnet` simulator.
//!
//! Added only to a scratch clone for a protocol comparison; not upstream code.
//! What it models on top of the engine, because that logic lives in
//! `marmot-session` / `marmot-app` and is not part of the engine:
//!   * commit first, Welcome only after a relay accepted the commit;
//!   * publish failure of a commit rolls the pending state back;
//!   * the post-join self-update (60 s quiet + up to 30 s jitter).
//!   * re-issuing an own commit that lost a same-epoch race
//!     (`reissue_superseded_own_commit`), including a fresh-KeyPackage
//!     re-invite when the engine reports `ReinviteRequired`, and re-arming a
//!     superseded post-join self-update.
//! KeyPackages are treated as always fetchable (pre-published).

use crate::bus::TransportBus;
use crate::client::{ClientBuilder, HarnessClient, HarnessStorageMode, decode_harness_app_payload};
use crate::subject::engine_harness_feature_registry;
use cgka_engine::convergence_clock::ManualConvergenceClock;
use cgka_traits::CgkaEngine;
use cgka_traits::engine::{GroupEvent, SupersededIntentOutcome};
use cgka_traits::engine_state::PendingStateRef;
use cgka_traits::group::ProtocolProfile;
use cgka_traits::storage::GroupStorage;
use cgka_traits::transport::{TransportEnvelope, TransportMessage};
use cgka_traits::types::{GroupId, MessageId};
use rand::rngs::StdRng;
use rand::{Rng, SeedableRng};
use simnet::{Action, DeliveryUpdate, Dev, DeviceView, Ms, Out, Protocol, Scenario, Wire};
use std::collections::{HashMap, HashSet};
use std::rc::Rc;
use std::sync::Arc;

const POST_JOIN_QUIET_MS: Ms = 60_000;
/// marmot-session waits for relay catch-up (EOSE) plus this grace after a
/// (re)connect before a maintenance rotation may count quiet time.
const POST_EOSE_GRACE_MS: Ms = 15_000;
/// A tick gap longer than this means the device was offline in between.
const RECONNECT_GAP_MS: Ms = 5_000;
const POST_JOIN_JITTER_MS: Ms = cgka_traits::maintenance::POST_JOIN_CONTENTION_JITTER_MAX_MS;

struct WireRec {
    pending: Option<PendingStateRef>,
    confirms: bool,
    queued_intent: Option<(GroupId, MessageId)>,
    message_id: MessageId,
}

pub struct MdkSim {
    rt: tokio::runtime::Runtime,
    bus: TransportBus,
    clock: ManualConvergenceClock,
    clock_ms: Ms,
    clients: Vec<HarnessClient>,
    cursors: Vec<Option<u64>>,
    sc: Scenario,
    next_wire: u64,
    wires: HashMap<u64, WireRec>,
    held: HashMap<(Dev, PendingStateRef), Vec<Wire<Option<TransportMessage>>>>,
    resolved: HashSet<(Dev, PendingStateRef)>,
    joined: Vec<bool>,
    post_join_jitter: Vec<Option<Ms>>,
    last_state_input: Vec<Ms>,
    received_ids: Vec<HashMap<MessageId, u64>>,
    rng: StdRng,
    errors_logged: usize,
    pub post_join_updates: bool,
    /// Membership the admins asked for (account -> member), for re-invites.
    intended: Vec<bool>,
    issued_adds: Vec<Vec<usize>>,
    reinvite_due: Vec<bool>,
    self_update_pending: Vec<Option<PendingStateRef>>,
    self_update_commits: Vec<HashSet<MessageId>>,
    last_tick: Vec<Ms>,
}

impl MdkSim {
    pub fn new(sc: &Scenario) -> Self {
        let rt = tokio::runtime::Builder::new_current_thread()
            .enable_all()
            .build()
            .expect("runtime");
        let bus = TransportBus::ordered();
        let clock = ManualConvergenceClock::new(0, 0);
        let n = sc.devices();
        let mut clients = Vec::with_capacity(n);
        for dev in 0..n {
            // Devices of one account share the account identity seed; each is
            // its own MLS leaf with its own storage.
            let account = sc.account_of(dev);
            let mut seed = vec![0u8; 32];
            let label = format!("acct-{account:06}");
            seed[..label.len()].copy_from_slice(label.as_bytes());
            let mut client = ClientBuilder::new(seed)
                .registry(engine_harness_feature_registry())
                .protocol_profile(ProtocolProfile::Current)
                .storage_mode(HarnessStorageMode::InMemorySqlite)
                .account_devices_supported(sc.devices_per_account > 1)
                .convergence_clock(Arc::new(clock.clone()))
                .attach(&bus);
            client.enable_virtual_time_tick();
            clients.push(client);
        }
        Self {
            rt,
            bus,
            clock,
            clock_ms: 0,
            clients,
            cursors: vec![None; n],
            next_wire: 1,
            wires: HashMap::new(),
            held: HashMap::new(),
            resolved: HashSet::new(),
            joined: vec![false; n],
            post_join_jitter: vec![None; n],
            last_state_input: vec![0; n],
            received_ids: vec![HashMap::new(); n],
            rng: StdRng::seed_from_u64(sc.seed ^ 0x4D44_4B),
            errors_logged: 0,
            post_join_updates: true,
            intended: vec![false; sc.accounts + sc.spare_accounts],
            issued_adds: vec![Vec::new(); n],
            reinvite_due: vec![false; n],
            self_update_pending: vec![None; n],
            self_update_commits: vec![HashSet::new(); n],
            last_tick: vec![0; n],
            sc: sc.clone(),
        }
    }

    fn set_time(&mut self, now: Ms) {
        if now > self.clock_ms {
            self.clock.advance_ms(now - self.clock_ms);
            self.clock_ms = now;
        }
    }

    fn log_err(&mut self, what: &str, err: &dyn std::fmt::Display) {
        if self.errors_logged < 40 || std::env::var("MDK_TRACE").is_ok() {
            self.errors_logged += 1;
            eprintln!("[mdk] {what}: {err}");
        }
    }

    /// Turn everything `dev` emitted since the last call into wires.
    fn collect(&mut self, dev: Dev, out: &mut Out<Option<TransportMessage>>) {
        let bus_id = self.clients[dev].bus_id;
        let emissions = self.bus.outbound_since(bus_id, self.cursors[dev]);
        if emissions.is_empty() {
            return;
        }
        let mut ids = Vec::with_capacity(emissions.len());
        for emission in emissions {
            self.cursors[dev] = Some(emission.sequence);
            let msg = emission.msg;
            ids.push(msg.id.clone());
            let client = &self.clients[dev];
            let pending = client.pending_publication_for_message(&msg.id);
            let confirms = pending.is_some_and(|p| client.message_confirms_pending(p, &msg.id));
            let queued_intent = client.regenerated_queued_intent_for_message(&msg.id);
            let (class, key) = match &msg.envelope {
                TransportEnvelope::GroupMessage { transport_group_id } => {
                    let key = format!("h:{}", hex::encode(transport_group_id));
                    (
                        if pending.is_some() {
                            "mls_commit_445"
                        } else {
                            "mls_message_445"
                        },
                        key,
                    )
                }
                TransportEnvelope::Welcome { recipient } => (
                    "mls_welcome_1059",
                    format!("p:{}", hex::encode(recipient.as_slice())),
                ),
            };
            let id = self.next_wire;
            self.next_wire += 1;
            if confirms && pending.is_some() && pending == self.self_update_pending[dev] {
                self.self_update_pending[dev] = None;
                self.self_update_commits[dev].insert(msg.id.clone());
            }
            self.wires.insert(
                id,
                WireRec {
                    pending,
                    confirms,
                    queued_intent,
                    message_id: msg.id.clone(),
                },
            );
            let wire = Wire {
                id,
                class,
                bytes: msg.payload.len(),
                keys: vec![key],
                payload: Some(msg),
            };
            match pending {
                // A Welcome tied to a commit that no relay has accepted yet.
                Some(p) if !confirms && !self.resolved.contains(&(dev, p)) => {
                    self.held.entry((dev, p)).or_default().push(wire);
                }
                _ => out.publishes.push(wire),
            }
        }
        self.bus.discard_queued_messages(&ids);
    }

    fn harvest(&mut self, dev: Dev, now: Ms, out: &mut Out<Option<TransportMessage>>) {
        for event in self.clients[dev].drain_events() {
            match event {
                GroupEvent::MessageReceived {
                    payload, message_id, ..
                } => {
                    let bytes = decode_harness_app_payload(&payload);
                    if let Some(id) = simnet::decode_msg(&String::from_utf8_lossy(&bytes)) {
                        self.received_ids[dev].insert(message_id, id);
                        out.delivery_updates.push(DeliveryUpdate::Received(id));
                    }
                }
                GroupEvent::AppMessageInvalidated { message_id, .. } => {
                    out.count("mls_app_message_invalidated", 1);
                    if let Some(id) = self.received_ids[dev].get(&message_id) {
                        out.delivery_updates.push(DeliveryUpdate::Withdrawn(*id));
                    }
                }
                GroupEvent::GroupJoined { .. } => {
                    self.joined[dev] = true;
                    self.last_state_input[dev] = now;
                    if self.post_join_updates {
                        self.post_join_jitter[dev] = Some(self.rng.gen_range(0..=POST_JOIN_JITTER_MS));
                    }
                    out.count("mls_joined", 1);
                }
                GroupEvent::EpochChanged { .. } => {
                    if std::env::var("MDK_TRACE").is_ok() {
                        eprintln!(
                            "[mdk-trace] t={} dev {dev} epoch -> {:?}",
                            now / 1000,
                            self.clients[dev].epoch()
                        );
                    }
                    self.last_state_input[dev] = now;
                    out.count("mls_epoch_changes_observed", 1);
                }
                GroupEvent::CommitRolledBack {
                    invalidated_commit_id,
                    ..
                } => {
                    out.count("mls_commit_rolled_back", 1);
                    self.own_commit_superseded(dev, now, &invalidated_commit_id, out);
                }
                GroupEvent::GroupStateInvalidated { .. } => out.count("mls_group_state_invalidated", 1),
                GroupEvent::GroupStateRevalidated { .. } => out.count("mls_group_state_revalidated", 1),
                GroupEvent::GroupUnrecoverable { .. } => out.count("mls_group_unrecoverable", 1),
                GroupEvent::QueuedIntentRefused { .. } => out.count("mls_queued_intent_refused", 1),
                GroupEvent::LocalGroupCopyTerminated { .. } => {
                    self.joined[dev] = false;
                    self.post_join_jitter[dev] = None;
                    out.count("mls_local_copy_terminated", 1);
                }
                GroupEvent::TransportObjectResourceRefused { .. } => out.count("mls_resource_refused", 1),
                _ => {}
            }
        }
    }

    /// What `marmot-session` does when convergence withdraws one of this
    /// device's own commits.
    fn own_commit_superseded(
        &mut self,
        dev: Dev,
        now: Ms,
        commit_id: &MessageId,
        out: &mut Out<Option<TransportMessage>>,
    ) {
        if self.self_update_commits[dev].remove(commit_id) && self.post_join_updates {
            // The rotation this device owed did not land; it stays owed.
            self.post_join_jitter[dev] = Some(self.rng.gen_range(0..=POST_JOIN_JITTER_MS));
            self.last_state_input[dev] = now;
            out.count("mls_own_self_update_superseded_rearmed", 1);
        }
        match self.clients[dev]
            .engine_mut()
            .reissue_superseded_own_commit(commit_id)
        {
            Ok(Some(report)) => match report.outcome {
                SupersededIntentOutcome::Reissued => out.count("mls_own_commit_superseded_reissued", 1),
                SupersededIntentOutcome::ReinviteRequired => {
                    self.reinvite_due[dev] = true;
                    out.count("mls_own_commit_superseded_reinvite_required", 1);
                }
                SupersededIntentOutcome::AlreadySatisfied => {
                    out.count("mls_own_commit_superseded_already_satisfied", 1)
                }
                SupersededIntentOutcome::Conflict => out.count("mls_own_commit_superseded_conflict", 1),
                SupersededIntentOutcome::Abandoned => out.count("mls_own_commit_superseded_abandoned", 1),
                SupersededIntentOutcome::NotMember => out.count("mls_own_commit_superseded_not_member", 1),
            },
            Ok(None) => {}
            Err(error) => {
                out.count("mls_reissue_errors", 1);
                self.log_err("reissue superseded", &error);
            }
        }
    }

    /// Re-invite, with fresh KeyPackages, the accounts whose invite was lost.
    fn reinvite(&mut self, dev: Dev, now: Ms, out: &mut Out<Option<TransportMessage>>) {
        if !self.clients[dev].has_active_group() {
            self.reinvite_due[dev] = false;
            return;
        }
        let members: HashSet<Vec<u8>> = self.clients[dev]
            .members()
            .into_iter()
            .map(|m| m.id.as_slice().to_vec())
            .collect();
        let dpa = self.sc.devices_per_account;
        let missing: Vec<usize> = self.issued_adds[dev]
            .iter()
            .copied()
            .filter(|a| self.intended[*a] && !members.contains(self.clients[a * dpa].member_id().as_slice()))
            .collect();
        if missing.is_empty() {
            self.reinvite_due[dev] = false;
            return;
        }
        let kps = self.key_packages(&missing, None, out);
        match self.rt.block_on(self.clients[dev].try_invite(kps)) {
            Ok(_) => {
                self.reinvite_due[dev] = false;
                out.count("mls_reinvite_issued", 1);
            }
            Err(_) => out.count("mls_reinvite_deferred_busy", 1),
        }
        self.harvest(dev, now, out);
        self.collect(dev, out);
    }

    fn run_tick(&mut self, dev: Dev, now: Ms, out: &mut Out<Option<TransportMessage>>) {
        let outcomes = self.rt.block_on(self.clients[dev].tick());
        let mut errors = Vec::new();
        let trace = std::env::var("MDK_TRACE").is_ok();
        for outcome in outcomes {
            if trace {
                let text = format!("{outcome:?}");
                let short: String = text.chars().take(150).collect();
                eprintln!("[mdk-trace] t={} dev {dev} ingest {short}", now / 1000);
            }
            if let Err(error) = outcome {
                errors.push(error.to_string());
            }
        }
        if !errors.is_empty() {
            out.count("mls_ingest_errors", errors.len() as u64);
            for e in errors.iter().take(2) {
                self.log_err("ingest", e);
            }
        }
        self.harvest(dev, now, out);
        self.collect(dev, out);
    }

    fn key_packages(
        &mut self,
        accounts: &[usize],
        skip: Option<Dev>,
        out: &mut Out<Option<TransportMessage>>,
    ) -> Vec<cgka_traits::engine::KeyPackage> {
        let mut kps = Vec::new();
        for account in accounts {
            for dev in self.sc.devices_of(*account) {
                if Some(dev) == skip {
                    continue;
                }
                match self.rt.block_on(self.clients[dev].try_fresh_key_package()) {
                    Ok(kp) => {
                        // Accounting only: a kind-30443 event carrying this KeyPackage.
                        let bytes = serde_json::to_vec(&kp).map(|b| b.len()).unwrap_or(0) + 300;
                        let id = self.next_wire;
                        self.next_wire += 1;
                        out.publishes.push(Wire {
                            id,
                            class: "mls_key_package_30443",
                            bytes,
                            keys: Vec::new(),
                            payload: None,
                        });
                        kps.push(kp);
                    }
                    Err(error) => {
                        out.count("mls_key_package_errors", 1);
                        self.log_err("key package", &error);
                    }
                }
            }
        }
        kps
    }
}

impl Protocol for MdkSim {
    type P = Option<TransportMessage>;

    fn interest(&mut self, dev: Dev) -> Vec<String> {
        let mut keys = vec![format!(
            "p:{}",
            hex::encode(self.clients[dev].member_id().as_slice())
        )];
        if self.joined[dev] || self.clients[dev].has_active_group() {
            let routes = self.clients[dev]
                .storage()
                .list_transport_group_routes()
                .expect("read this device's group subscriptions");
            keys.extend(
                routes
                    .into_iter()
                    .map(|route| format!("h:{}", hex::encode(route.transport_group_id))),
            );
        }
        keys
    }

    fn act(&mut self, now: Ms, action: &Action, out: &mut Out<Self::P>) {
        self.set_time(now);
        match action {
            Action::Create { creator, accounts } => {
                let kps = self.key_packages(accounts, Some(*creator), out);
                let creator_account = self.sc.account_of(*creator);
                let dpa = self.sc.devices_per_account;
                let admins = (0..self.sc.admins)
                    .filter(|a| *a != creator_account && accounts.contains(a))
                    .map(|a| self.clients[a * dpa].member_id())
                    .collect::<Vec<_>>();
                let result =
                    self.rt
                        .block_on(self.clients[*creator].try_create_group_with_admins_maybe_pending(
                            "sim",
                            kps,
                            vec![],
                            admins,
                        ));
                match result {
                    Ok((_gid, pending)) => {
                        self.joined[*creator] = true;
                        self.collect(*creator, out);
                        if let Some(pending) = pending {
                            match self
                                .rt
                                .block_on(self.clients[*creator].confirm_empty_publication(pending))
                            {
                                Ok(true) => {
                                    self.resolved.insert((*creator, pending));
                                }
                                Ok(false) => {}
                                Err(error) => self.log_err("confirm empty create", &error),
                            }
                        }
                        self.harvest(*creator, now, out);
                        self.collect(*creator, out);
                    }
                    Err(error) => {
                        out.count("mls_create_failed", 1);
                        self.log_err("create", &error);
                    }
                }
            }
            Action::Send { dev, msg, size } => {
                let text = simnet::encode_msg(*msg, *size);
                match self
                    .rt
                    .block_on(self.clients[*dev].try_send_app(text.into_bytes()))
                {
                    Ok(_) => self.collect(*dev, out),
                    Err(error) => {
                        out.refused_sends.push(*msg);
                        out.count("send_refused", 1);
                        self.log_err("send", &error);
                    }
                }
                self.harvest(*dev, now, out);
            }
            Action::Add { admin, account } => {
                let kps = self.key_packages(&[*account], None, out);
                match self.rt.block_on(self.clients[*admin].try_invite(kps)) {
                    Ok(_) => {
                        self.intended[*account] = true;
                        if !self.issued_adds[*admin].contains(account) {
                            self.issued_adds[*admin].push(*account);
                        }
                        out.count("admin_add_issued", 1)
                    }
                    Err(error) if error.to_string().contains("got Queued") => {
                        // Accepted; the engine issues it after its current pass.
                        self.intended[*account] = true;
                        if !self.issued_adds[*admin].contains(account) {
                            self.issued_adds[*admin].push(*account);
                        }
                        out.count("admin_add_queued", 1)
                    }
                    Err(error) if error.to_string().contains("already in the group") => {
                        self.intended[*account] = true;
                        out.count("admin_add_noop_already_member", 1)
                    }
                    Err(error) => {
                        out.count("admin_op_refused", 1);
                        out.action_refused = true;
                        self.log_err("invite", &error);
                    }
                }
                self.harvest(*admin, now, out);
                self.collect(*admin, out);
            }
            Action::Remove { admin, account } => {
                let member = self.clients[account * self.sc.devices_per_account].member_id();
                match self
                    .rt
                    .block_on(self.clients[*admin].try_remove_members(vec![member]))
                {
                    Ok(_) => {
                        self.intended[*account] = false;
                        out.count("admin_remove_issued", 1)
                    }
                    Err(error) if error.to_string().contains("got Queued") => {
                        self.intended[*account] = false;
                        out.count("admin_remove_queued", 1)
                    }
                    Err(error) if error.to_string().contains("is not in the group") => {
                        self.intended[*account] = false;
                        out.count("admin_remove_noop_not_member", 1)
                    }
                    Err(error) => {
                        out.count("admin_op_refused", 1);
                        out.action_refused = true;
                        self.log_err("remove", &error);
                    }
                }
                self.harvest(*admin, now, out);
                self.collect(*admin, out);
            }
        }
    }

    fn deliver(&mut self, dev: Dev, now: Ms, wires: &[Rc<Wire<Self::P>>], out: &mut Out<Self::P>) {
        self.set_time(now);
        let bus_id = self.clients[dev].bus_id;
        for wire in wires {
            if let Some(msg) = &wire.payload {
                self.bus.inject(bus_id, msg.clone());
            }
        }
        self.run_tick(dev, now, out);
    }

    fn tick(&mut self, dev: Dev, now: Ms, out: &mut Out<Self::P>) {
        self.set_time(now);
        if now > self.last_tick[dev] + RECONNECT_GAP_MS {
            // Back from an offline stretch: nothing counts as quiet until the
            // catch-up fetch has drained and the grace period has passed.
            self.last_state_input[dev] = self.last_state_input[dev].max(now + POST_EOSE_GRACE_MS);
        }
        self.last_tick[dev] = now;
        self.run_tick(dev, now, out);
        if self.reinvite_due[dev] {
            self.reinvite(dev, now, out);
        }
        if let Some(jitter) = self.post_join_jitter[dev]
            && self.joined[dev]
            && now >= self.last_state_input[dev] + POST_JOIN_QUIET_MS + jitter
        {
            match self.rt.block_on(self.clients[dev].try_self_update()) {
                Ok(pending) => {
                    self.self_update_pending[dev] = Some(pending);
                    self.post_join_jitter[dev] = None;
                    out.count("mls_post_join_self_update_issued", 1);
                }
                Err(error) if error.to_string().contains("got Queued") => {
                    // The engine accepted the intent and will issue it itself
                    // once its current convergence pass settles.
                    self.post_join_jitter[dev] = None;
                    out.count("mls_post_join_self_update_queued", 1);
                }
                Err(error) => {
                    self.last_state_input[dev] = now;
                    out.count("mls_post_join_self_update_refused", 1);
                    self.log_err("self update", &error);
                }
            }
            self.harvest(dev, now, out);
            self.collect(dev, out);
        }
    }

    fn publish_outcome(&mut self, dev: Dev, now: Ms, wire: u64, accepted: bool, out: &mut Out<Self::P>) {
        self.set_time(now);
        let Some(rec) = self.wires.remove(&wire) else {
            return;
        };
        if let Some(pending) = rec.pending
            && rec.confirms
            && !self.resolved.contains(&(dev, pending))
        {
            self.resolved.insert((dev, pending));
            if accepted {
                match self.rt.block_on(self.clients[dev].try_confirm(pending)) {
                    Ok(()) => out.count("mls_commit_confirmed", 1),
                    Err(error) => {
                        out.count("mls_confirm_errors", 1);
                        self.log_err("confirm", &error);
                    }
                }
                for held in self.held.remove(&(dev, pending)).unwrap_or_default() {
                    out.publishes.push(held);
                }
            } else {
                self.held.remove(&(dev, pending));
                match self.rt.block_on(self.clients[dev].try_fail_publication(pending)) {
                    Ok(()) => out.count("mls_commit_publish_failed_rolled_back", 1),
                    Err(_) => out.count("mls_commit_publish_fail_errors", 1),
                }
            }
        }
        if let Some((group_id, intent_id)) = rec.queued_intent {
            if accepted {
                if let Err(error) = self.clients[dev].confirm_regenerated_queued_intent(&intent_id) {
                    self.log_err("confirm queued intent", &error);
                }
            } else {
                self.clients[dev].retry_regenerated_queued_intent(&group_id, &intent_id);
            }
            self.clients[dev].forget_regenerated_queued_intent(&rec.message_id);
        }
        self.harvest(dev, now, out);
        self.collect(dev, out);
    }

    fn sender_roster(&self, dev: Dev) -> Option<Vec<usize>> {
        let client = &self.clients[dev];
        if !client.has_active_group() {
            return None;
        }
        let members = client.engine().members(&client.group_id()).ok()?;
        Some(self.clients.chunks(self.sc.devices_per_account).enumerate()
            .filter(|(_, devices)| members.iter().any(|member| member.id == devices[0].member_id()))
            .map(|(account, _)| account).collect())
    }

    fn view(&mut self, dev: Dev) -> DeviceView {
        if !self.joined[dev] || !self.clients[dev].has_active_group() {
            return DeviceView {
                in_group: false,
                state: String::new(),
                detail: "no group".into(),
            };
        }
        let group_id = self.clients[dev].group_id();
        let snapshot = match self.clients[dev].engine().conformance_group_snapshot(&group_id) {
            Ok(snapshot) => snapshot,
            Err(error) => {
                return DeviceView {
                    in_group: false,
                    state: String::new(),
                    detail: format!("no usable state: {error}"),
                };
            }
        };
        DeviceView {
            in_group: true,
            state: format!(
                "epoch {} ctx {}",
                snapshot.epoch,
                &snapshot.group_context_sha256[..12]
            ),
            detail: format!(
                "leaves {} accounts {} status {:?}",
                snapshot.leaves.len(),
                snapshot.sorted_member_identities_hex.len(),
                snapshot.convergence_status
            ),
        }
    }

    fn storage_bytes(&mut self, dev: Dev) -> Option<u64> {
        let _ = dev;
        None
    }
}
