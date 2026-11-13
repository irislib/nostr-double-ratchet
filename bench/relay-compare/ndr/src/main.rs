//! Drives real `nostr-double-ratchet` through iris-chat's `ProtocolEngine`
//! (the layer that owns retries, queues and sender-key repair) from the
//! protocol-agnostic `simnet` simulator.
//!
//! App-level glue that lives in iris-chat's `core` crate rather than in the
//! engine is ported here in simplified form: decrypted-payload dispatch,
//! the private group-wake unwrap, and the group-context recovery request
//! (kind 21114, 60 s rate limit). AppKeys and device invites are treated as
//! always fetchable (pre-published), like KeyPackages on the MLS side.
//!
//! `sim_ndr <label> <accounts> <devices> <net> <seed> [key=value ...]`

use iris_chat_protocol::{
    AppKeys, DeviceEntry, InMemoryStorage, NdrUnixSeconds, ProtocolDecryptedMessage,
    ProtocolEffect, ProtocolEngine, ProtocolRetryBatch, StorageAdapter, UnixSeconds, INVITE_RESPONSE_KIND,
    MESSAGE_EVENT_KIND,
};
use nostr::{Event, JsonUtil, Keys, Kind, PublicKey, SecretKey, Tag, Timestamp, UnsignedEvent};
use nostr_double_ratchet::{
    parse_group_sender_key_message_event_unchecked, GroupIncomingEvent, GroupPairwiseCommand,
    GroupPayloadCodec, JsonGroupPayloadCodecV1,
};
use serde::{Deserialize, Serialize};
use sha2::{Digest, Sha256};
use simnet::{Action, DeliveryUpdate, Dev, DeviceView, Ms, Out, Protocol, Scenario, Wire};
use std::collections::{HashMap, HashSet};
use std::rc::Rc;
use std::sync::Arc;

const BASE_UNIX_MS: u64 = 1_800_000_000_000;
const GROUP_WAKE_KIND: u64 = 21_113;
const GROUP_CONTEXT_REQUEST_KIND: u64 = 21_114;
const RECOVERY_INTERVAL_MS: Ms = 60_000;

#[derive(Clone, Serialize, Deserialize)]
#[serde(deny_unknown_fields)]
struct ContextRequest {
    v: u8,
    #[serde(default, skip_serializing_if = "Option::is_none")]
    group_id: Option<String>,
    #[serde(default, skip_serializing_if = "Option::is_none")]
    author: Option<PublicKey>,
    #[serde(default, skip_serializing_if = "Option::is_none")]
    requester: Option<PublicKey>,
}

#[derive(Deserialize)]
#[serde(deny_unknown_fields)]
struct GroupWake {
    v: u8,
    #[serde(rename = "type")]
    kind: String,
    event: Event,
}

#[derive(Clone, Copy, PartialEq)]
enum PubState {
    Pending,
    Accepted,
    Failed,
}

struct NdrSim {
    sc: Scenario,
    direct: bool,
    engines: Vec<ProtocolEngine>,
    stores: Vec<Arc<InMemoryStorage>>,
    owner_keys: Vec<Keys>,
    device_keys: Vec<Keys>,
    group_id: Option<String>,
    next_wire: u64,
    wire_by_event: HashMap<String, u64>,
    wire_state: HashMap<u64, (PubState, ProtocolEffect)>,
    recovery: HashMap<(Dev, String), Ms>,
    now: Ms,
    errors_logged: usize,
    trace: bool,
    /// Per-delivery diagnostics (NDR_DIAG): which carrier belongs to which
    /// simulated message, and what became of it.
    diag: bool,
    wire_meta: HashMap<u64, String>,
    cur_wire: Option<u64>,
    outer_inner: HashMap<String, String>,
}

fn keys_from(seed: u64, tag: &str, index: usize) -> Keys {
    let mut counter = 0u32;
    loop {
        let digest = Sha256::digest(format!("ndr-sim:{seed}:{tag}:{index}:{counter}").as_bytes());
        if let Ok(secret) = SecretKey::from_slice(&digest) {
            return Keys::new(secret);
        }
        counter += 1;
    }
}

fn secs(now: Ms) -> u64 {
    (BASE_UNIX_MS + now) / 1000
}

impl NdrSim {
    fn new(sc: &Scenario) -> anyhow::Result<Self> {
        nostr_double_ratchet::sim_clock::set_ms(BASE_UNIX_MS);
        let accounts = sc.accounts + sc.spare_accounts;
        let n = sc.devices();
        let owner_keys: Vec<Keys> = (0..accounts).map(|a| keys_from(sc.seed, "owner", a)).collect();
        let device_keys: Vec<Keys> = (0..n).map(|d| keys_from(sc.seed, "device", d)).collect();
        let mut engines = Vec::with_capacity(n);
        let mut stores = Vec::with_capacity(n);
        for dev in 0..n {
            let store = Arc::new(InMemoryStorage::new());
            let owner = &owner_keys[sc.account_of(dev)];
            let mut engine = ProtocolEngine::load_or_create_for_local_device(
                store.clone() as Arc<dyn StorageAdapter>,
                owner.public_key(),
                &device_keys[dev],
            )?;
            engine.authenticate_local_owner_for_sending(owner)?;
            engines.push(engine);
            stores.push(store);
        }
        Ok(Self {
            direct: sc.accounts == 2 && sc.spare_accounts == 0 && sc.churn_ops == 0,
            sc: sc.clone(),
            engines,
            stores,
            owner_keys,
            device_keys,
            group_id: None,
            next_wire: 1,
            wire_by_event: HashMap::new(),
            wire_state: HashMap::new(),
            recovery: HashMap::new(),
            now: 0,
            errors_logged: 0,
            trace: std::env::var("NDR_TRACE").is_ok(),
            diag: std::env::var("NDR_DIAG").is_ok(),
            wire_meta: HashMap::new(),
            cur_wire: None,
            outer_inner: HashMap::new(),
        })
    }

    fn set_time(&mut self, now: Ms) {
        self.now = now;
        nostr_double_ratchet::sim_clock::set_ms(BASE_UNIX_MS + now);
    }

    fn account_index(&self, owner: PublicKey) -> usize {
        self.owner_keys
            .iter()
            .position(|k| k.public_key() == owner)
            .unwrap_or(usize::MAX)
    }

    fn owner_of(&self, dev: Dev) -> PublicKey {
        self.owner_keys[self.sc.account_of(dev)].public_key()
    }

    fn log_err(&mut self, what: &str, err: &dyn std::fmt::Display) {
        if self.errors_logged < 40 {
            self.errors_logged += 1;
            eprintln!("[ndr] {what}: {err}");
        }
    }

    fn publish(&mut self, effects: Vec<ProtocolEffect>, class: &'static str, out: &mut Out<Event>) {
        for effect in effects {
            let ProtocolEffect::Publish(publish) = &effect;
            let event = publish.event.clone();
            let shared_data = publish.carrier == iris_chat_protocol::ProtocolCarrier::SharedGroup;
            if shared_data {
                assert!(cfg!(feature = "group-broadcast") && publish.is_publishable());
                assert!(event.verify().is_ok() && event.kind.as_u16() as u32 == MESSAGE_EVENT_KIND);
                assert!(self.owner_keys.iter().chain(&self.device_keys)
                    .all(|key| key.public_key() != event.pubkey));
            }
            if event.kind.as_u16() as u32 == MESSAGE_EVENT_KIND {
                assert!(
                    event.tags.public_keys().next().is_none(),
                    "kind 1060 named a recipient"
                );
            }
            let event_id = event.id.to_hex();
            let id = match self.wire_by_event.get(&event_id) {
                Some(id) => {
                    // Already handed to the transport; only a failed one is offered again.
                    match self.wire_state.get(id) {
                        Some((PubState::Failed, _)) => {
                            out.count("ndr_republish_after_failure", 1);
                            *id
                        }
                        _ => continue,
                    }
                }
                None => {
                    let id = self.next_wire;
                    self.next_wire += 1;
                    self.wire_by_event.insert(event_id, id);
                    id
                }
            };
            self.wire_state.insert(id, (PubState::Pending, effect.clone()));
            if self.diag && event.kind.as_u16() as u32 == MESSAGE_EVENT_KIND {
                let inner = publish.inner_event_id.clone().unwrap_or_default();
                eprintln!(
                    "[diag] pub t={} wire={id} class={class} inner={inner} author={}",
                    self.now / 1000,
                    event.pubkey
                );
                self.wire_meta.insert(id, inner);
            }
            let mut keys = vec![format!("a:{}", event.pubkey.to_hex())];
            for pk in event.tags.public_keys() {
                keys.push(format!("p:{}", pk.to_hex()));
            }
            let kind = event.kind.as_u16() as u32;
            let class = if kind == INVITE_RESPONSE_KIND {
                "ndr_invite_response_1059"
            } else if shared_data {
                "ndr_shared_data_1060"
            } else if kind == MESSAGE_EVENT_KIND {
                class
            } else {
                "ndr_other_kind"
            };
            out.publishes.push(Wire {
                id,
                class,
                bytes: event.as_json().len(),
                keys,
                payload: event,
            });
        }
    }

    fn reserve(&mut self, dev: Dev, key: String) -> bool {
        let now = self.now;
        match self.recovery.get(&(dev, key.clone())) {
            Some(last) if now < last + RECOVERY_INTERVAL_MS => false,
            _ => {
                self.recovery.insert((dev, key), now);
                true
            }
        }
    }

    fn send_context_request(
        &mut self,
        dev: Dev,
        peer: PublicKey,
        request: &ContextRequest,
        out: &mut Out<Event>,
    ) {
        let now_s = secs(self.now);
        let rumor = UnsignedEvent::new(
            self.owner_of(dev),
            Timestamp::from(now_s),
            Kind::Custom(GROUP_CONTEXT_REQUEST_KIND as u16),
            [Tag::expiration(Timestamp::from(now_s + 120))],
            serde_json::to_string(request).unwrap_or_default(),
        );
        match self.engines[dev].send_direct_unsigned_event_to_peer_only(
            peer,
            &peer.to_hex(),
            rumor,
            UnixSeconds(now_s),
        ) {
            Ok(sent) => {
                out.count("ndr_context_requests_sent", 1);
                self.publish(sent.effects, "ndr_recovery_1060", out);
            }
            Err(error) => self.log_err("context request", &error),
        }
    }

    fn request_missing_group_context(
        &mut self,
        dev: Dev,
        sender: PublicKey,
        group_id: Option<String>,
        author: Option<PublicKey>,
        out: &mut Out<Event>,
    ) {
        if !cfg!(feature = "context-recovery") || sender == self.owner_of(dev) {
            return;
        }
        let Some(selector) = author.map(|key| key.to_hex()).or_else(|| group_id.clone()) else {
            return;
        };
        if !self.reserve(dev, format!("ask:{sender}:{selector}")) {
            return;
        }
        self.send_context_request(
            dev,
            sender,
            &ContextRequest {
                v: 1,
                group_id,
                author,
                requester: None,
            },
            out,
        );
    }

    #[cfg(not(feature = "context-recovery"))]
    fn receive_context_request(
        &mut self,
        _dev: Dev,
        _sender: PublicKey,
        _content: &str,
        _out: &mut Out<Event>,
    ) {
    }

    #[cfg(feature = "context-recovery")]
    fn receive_context_request(&mut self, dev: Dev, sender: PublicKey, content: &str, out: &mut Out<Event>) {
        let Ok(request) = serde_json::from_str::<ContextRequest>(content) else {
            return;
        };
        if request.v != 1 {
            return;
        }
        let engine = &self.engines[dev];
        let mapped = request
            .author
            .and_then(|author| engine.group_id_for_sender_event_author(author));
        if let (Some(id), Some(mapped)) = (&request.group_id, &mapped) {
            if id != mapped {
                return;
            }
        }
        let Some(group_id) = request.group_id.clone().or(mapped) else {
            return;
        };
        let Some(group) = engine.group_snapshot(&group_id) else {
            return;
        };
        let local = self.owner_of(dev);
        let requester = request.requester.unwrap_or(sender);
        let member = |key: PublicKey| group.members.iter().any(|m| m.to_bytes() == key.to_bytes());
        if requester == local || !member(local) || !member(sender) || !member(requester) {
            return;
        }
        let is_admin = group
            .admins
            .iter()
            .any(|admin| admin.to_bytes() == local.to_bytes());
        if request.requester.is_some() && !is_admin {
            return;
        }
        if !self.reserve(dev, format!("reply:{requester}:{group_id}")) {
            return;
        }
        match self.engines[dev].resend_private_group_context(&group_id, requester, request.author) {
            Ok(effects) => {
                out.count("ndr_context_replies", 1);
                self.publish(effects, "ndr_recovery_1060", out);
            }
            Err(error) => self.log_err("context reply", &error),
        }
        if !is_admin {
            let admins: Vec<PublicKey> = group
                .admins
                .iter()
                .filter_map(|admin| PublicKey::from_slice(&admin.to_bytes()).ok())
                .filter(|admin| *admin != requester && member(*admin))
                .collect();
            for admin in admins {
                let forward = ContextRequest {
                    v: 1,
                    group_id: Some(group_id.clone()),
                    author: None,
                    requester: Some(requester),
                };
                self.send_context_request(dev, admin, &forward, out);
            }
        }
    }

    fn handle_group_events(&mut self, dev: Dev, events: Vec<GroupIncomingEvent>, out: &mut Out<Event>) {
        for event in events {
            match event {
                GroupIncomingEvent::Message(message) => {
                    if let Some(id) = simnet::decode_msg(&String::from_utf8_lossy(&message.body)) {
                        if self.diag {
                            eprintln!("[diag] got t={} dev={dev} msg={id}", self.now / 1000);
                        }
                        out.delivery_updates.push(DeliveryUpdate::Received(id));
                    }
                }
                GroupIncomingEvent::MetadataUpdated(_) => out.count("ndr_metadata_updates_applied", 1),
                GroupIncomingEvent::SenderKeyRepairRequested(_) => out.count("ndr_repair_requests_seen", 1),
            }
        }
    }

    /// Port of iris-chat core's dispatch of one decrypted pairwise payload.
    /// Returns whether the delivery was applied (and may be acknowledged).
    fn handle_decrypted(&mut self, dev: Dev, message: ProtocolDecryptedMessage, out: &mut Out<Event>) -> bool {
        let content = message.content.as_str();
        let sender = message.sender;
        let from_sibling = message.conversation_owner.is_some();
        let rumor = serde_json::from_str::<serde_json::Value>(content)
            .ok()
            .filter(|value| {
                value.get("kind").is_some()
                    && value.get("content").is_some()
                    && value.get("created_at").is_some()
                    && value.get("pubkey").is_some()
            });
        let codec = JsonGroupPayloadCodecV1;
        let command = codec.decode_pairwise_command(content.as_bytes()).ok().flatten();
        let supported = matches!(
            &command,
            Some(
                GroupPairwiseCommand::MetadataSnapshot { .. }
                    | GroupPairwiseCommand::SenderKeyDistribution { .. }
                    | GroupPairwiseCommand::SenderKeyRepairRequest { .. }
            )
        );
        let sibling_group_rumor = from_sibling
            && rumor.as_ref().is_some_and(|value| {
                value["tags"]
                    .as_array()
                    .is_some_and(|tags| tags.iter().any(|tag| tag[0].as_str() == Some("l")))
            });
        if rumor.is_none() || supported || sibling_group_rumor {
            let result = if from_sibling {
                self.engines[dev].process_local_sibling_group_pairwise_payload(
                    content.as_bytes(),
                    sender,
                    message.sender_device,
                )
            } else {
                self.engines[dev].process_group_pairwise_payload(
                    content.as_bytes(),
                    sender,
                    message.sender_device,
                )
            };
            if self.trace {
                let what = match &command {
                    Some(GroupPairwiseCommand::MetadataSnapshot { snapshot }) => {
                        format!(
                            "metadata rev {} members {}",
                            snapshot.revision,
                            snapshot.members.len()
                        )
                    }
                    Some(GroupPairwiseCommand::SenderKeyDistribution { distribution }) => {
                        format!(
                            "distribution key {} author {}",
                            distribution.key_id,
                            &hex::encode(distribution.sender_event_pubkey.to_bytes())[..8]
                        )
                    }
                    Some(GroupPairwiseCommand::SenderKeyRepairRequest { .. }) => "repair-request".to_string(),
                    Some(_) => "other-command".to_string(),
                    None => "non-command".to_string(),
                };
                let summary = match &result {
                    Ok(o) => format!(
                        "consumed={} pending={} events={} effects={}",
                        o.consumed,
                        o.pending,
                        o.events.len(),
                        o.effects.len()
                    ),
                    Err(e) => format!("ERR {e}"),
                };
                eprintln!(
                    "[ndr-trace] t={} dev {dev} <- acct {} sibling={from_sibling} {what}: {summary}",
                    self.now / 1000,
                    self.account_index(sender)
                );
            }
            match result {
                Ok(outcome) => {
                    if outcome.consumed || !outcome.events.is_empty() || !outcome.effects.is_empty() {
                        self.handle_group_events(dev, outcome.events, out);
                        self.publish(outcome.effects, "ndr_group_control_1060", out);
                        if !from_sibling {
                            if let Some(GroupPairwiseCommand::SenderKeyDistribution { distribution }) = command
                            {
                                if self.engines[dev].group_snapshot(&distribution.group_id).is_none() {
                                    let author =
                                        PublicKey::from_slice(&distribution.sender_event_pubkey.to_bytes())
                                            .ok();
                                    self.request_missing_group_context(
                                        dev,
                                        sender,
                                        Some(distribution.group_id),
                                        author,
                                        out,
                                    );
                                }
                            }
                        }
                        return true;
                    }
                }
                Err(error) => {
                    out.count("ndr_group_payload_errors", 1);
                    self.log_err("group payload", &error);
                    return true;
                }
            }
        }
        let Some(rumor) = rumor else { return true };
        let kind = rumor["kind"].as_u64().unwrap_or(0);
        let body = rumor["content"].as_str().unwrap_or("");
        if kind == GROUP_WAKE_KIND {
            let Some(event) = serde_json::from_str::<GroupWake>(body).ok().and_then(|wake| {
                (wake.v == 1
                    && wake.kind == "group-wake"
                    && wake.event.tags.public_keys().next().is_none()
                    && parse_group_sender_key_message_event_unchecked(&wake.event).is_ok())
                .then_some(wake.event)
            }) else {
                return true;
            };
            let engine = &self.engines[dev];
            if !engine
                .group_sender_event_pubkeys_for_owner(sender)
                .contains(&event.pubkey)
            {
                if engine.is_known_group_sender_event_author(event.pubkey) {
                    self.diag_wake(dev, &event, "author_of_other_owner", 0);
                    return true;
                }
                // The distribution has not arrived yet: keep this delivery
                // retryable and ask the sender for the group context.
                out.count("ndr_wake_before_key", 1);
                self.diag_wake(dev, &event, "before_key", 0);
                self.request_missing_group_context(dev, sender, None, Some(event.pubkey), out);
                return false;
            }
            return match self.engines[dev].process_group_outer_event(&event) {
                Ok(result) => {
                    if result.pending {
                        out.count("ndr_group_outer_pending", 1);
                    }
                    let state = if result.pending {
                        "pending"
                    } else if result.consumed {
                        "consumed"
                    } else {
                        "ignored"
                    };
                    self.diag_wake(dev, &event, state, result.events.len());
                    if self.trace {
                        let parsed = parse_group_sender_key_message_event_unchecked(&event).ok();
                        eprintln!(
                            "[ndr-trace] t={} dev {dev} <- acct {} wake key {:?} n {:?} author {}: pending={} consumed={} events={} effects={}",
                            self.now / 1000,
                            self.account_index(sender),
                            parsed.as_ref().map(|p| p.key_id),
                            parsed.as_ref().map(|p| p.message_number),
                            &event.pubkey.to_hex()[..8],
                            result.pending,
                            result.consumed,
                            result.events.len(),
                            result.effects.len()
                        );
                    }
                    self.handle_group_events(dev, result.events, out);
                    self.publish(result.effects, "ndr_recovery_1060", out);
                    true
                }
                Err(error) => {
                    self.diag_wake(dev, &event, "error", 0);
                    out.count("ndr_group_outer_errors", 1);
                    self.log_err("group outer", &error);
                    true
                }
            };
        }
        if kind == GROUP_CONTEXT_REQUEST_KIND {
            self.receive_context_request(dev, sender, body, out);
            return true;
        }
        if let Some(id) = simnet::decode_msg(body) {
            out.delivery_updates.push(DeliveryUpdate::Received(id));
        }
        true
    }

    fn handle_direct(&mut self, dev: Dev, messages: Vec<ProtocolDecryptedMessage>, out: &mut Out<Event>) {
        let mut acks = HashSet::new();
        for message in messages {
            let event_id = message.event_id.clone();
            // A group message the engine recovered on retry comes back through
            // its authenticated delivery journal, not as a pairwise payload.
            let journal = event_id
                .as_deref()
                .filter(|id| id.starts_with("group-delivery:"))
                .map(|id| self.engines[dev].pending_group_decrypted_delivery(id));
            let applied = match journal {
                Some(Ok(Some(event))) => {
                    out.count("ndr_group_messages_recovered_on_retry", 1);
                    self.handle_group_events(dev, vec![event], out);
                    true
                }
                Some(Err(error)) => {
                    self.log_err("group delivery journal", &error);
                    false
                }
                _ => self.handle_decrypted(dev, message, out),
            };
            if applied {
                if let Some(id) = event_id {
                    acks.insert(id);
                }
            }
        }
        if !acks.is_empty() {
            if let Err(error) = self.engines[dev].ack_decrypted_delivery_ids(&acks) {
                self.log_err("ack decrypted", &error);
            }
        }
    }

    fn handle_batch(&mut self, dev: Dev, batch: ProtocolRetryBatch, out: &mut Out<Event>) {
        self.handle_group_events(dev, batch.group_result.events, out);
        self.publish(batch.group_result.effects, "ndr_retry_1060", out);
        self.publish(batch.effects, "ndr_retry_1060", out);
        self.handle_direct(dev, batch.direct_messages, out);
    }

    fn diag_wake(&mut self, dev: Dev, outer: &Event, state: &str, events: usize) {
        if !self.diag {
            return;
        }
        let outer_id = outer.id.to_hex();
        if let Some(inner) = self.cur_wire.and_then(|wire| self.wire_meta.get(&wire)) {
            self.outer_inner
                .entry(outer_id.clone())
                .or_insert_with(|| inner.clone());
        }
        let inner = self.outer_inner.get(&outer_id).cloned().unwrap_or_default();
        let parsed = parse_group_sender_key_message_event_unchecked(outer).ok();
        eprintln!(
            "[diag] wake t={} dev={dev} inner={inner} outer={} author={} wire={:?} state={state} events={events}",
            self.now / 1000,
            &outer_id[..8],
            &outer.pubkey.to_hex()[..8],
            self.cur_wire,
        );
        let _ = parsed;
    }

    /// iris-chat's core re-enters the engine about every 25 ms while ready
    /// retry work remains; one simulator tick stands for a burst of those.
    fn retry(&mut self, dev: Dev, out: &mut Out<Event>) {
        let now = NdrUnixSeconds(secs(self.now));
        for _ in 0..40 {
            if !self.engines[dev].has_due_pending_retry_work(now) {
                return;
            }
            match self.engines[dev].retry_pending_protocol(now) {
                Ok(batch) => self.handle_batch(dev, batch, out),
                Err(error) => {
                    out.count("ndr_retry_errors", 1);
                    self.log_err("retry", &error);
                    return;
                }
            }
            if !self.engines[dev].has_ready_group_sender_key_retry_work() {
                return;
            }
        }
    }
}

impl Protocol for NdrSim {
    type P = Event;

    fn interest(&mut self, dev: Dev) -> Vec<String> {
        let authors = self.engines[dev].known_message_author_pubkeys();
        let plan = nostr_double_ratchet::build_message_author_subscription_filters(
            authors,
            nostr_double_ratchet::MESSAGE_AUTHOR_FILTER_CHUNK_SIZE,
            nostr_double_ratchet::MESSAGE_AUTHOR_SUBSCRIPTION_LIMIT,
        );
        let mut keys: Vec<_> = plan
            .filters
            .into_iter()
            .flat_map(|f| f.authors.into_iter().flatten())
            .map(|pk| format!("a:{}", pk.to_hex()))
            .collect();
        #[cfg(feature = "group-broadcast")]
        {
            let authors = self.engines[dev].subscribable_group_sender_event_pubkeys();
            let group_plan = nostr_double_ratchet::build_message_author_subscription_filters(
                authors,
                nostr_double_ratchet::MESSAGE_AUTHOR_FILTER_CHUNK_SIZE,
                nostr_double_ratchet::MESSAGE_AUTHOR_SUBSCRIPTION_LIMIT,
            );
            keys.extend(group_plan.filters.into_iter().flat_map(|f| f.authors.into_iter().flatten())
                .map(|pk| format!("a:{}", pk.to_hex())));
        }
        if let Some(pk) = self.engines[dev].local_invite_response_pubkey() {
            keys.push(format!("p:{}", pk.to_hex()));
        }
        keys
    }

    fn act(&mut self, now: Ms, action: &Action, out: &mut Out<Event>) {
        self.set_time(now);
        match action {
            Action::Create { creator, accounts } => {
                if let Err(error) = self.bootstrap(out) {
                    self.log_err("bootstrap", &error);
                    out.count("ndr_create_failed", 1);
                    return;
                }
                if self.direct {
                    return;
                }
                let creator_account = self.sc.account_of(*creator);
                let members: Vec<PublicKey> = accounts
                    .iter()
                    .filter(|a| **a != creator_account)
                    .map(|a| self.owner_keys[*a].public_key())
                    .collect();
                match self.engines[*creator].create_group("sim".into(), members, UnixSeconds(secs(now))) {
                    Ok(result) => {
                        self.group_id = result.snapshot.as_ref().map(|s| s.group_id.clone());
                        self.publish(result.effects, "ndr_group_control_1060", out);
                    }
                    Err(error) => {
                        out.count("ndr_create_failed", 1);
                        self.log_err("create group", &error);
                        return;
                    }
                }
                let Some(group_id) = self.group_id.clone() else {
                    return;
                };
                for account in 0..self.sc.admins {
                    if account == creator_account || !accounts.contains(&account) {
                        continue;
                    }
                    let member = self.owner_keys[account].public_key();
                    match self.engines[*creator].set_group_admin(&group_id, member, true) {
                        Ok(result) => self.publish(result.effects, "ndr_group_control_1060", out),
                        Err(error) => self.log_err("set admin", &error),
                    }
                }
            }
            Action::Send { dev, msg, size } => {
                let text = simnet::encode_msg(*msg, *size);
                let effects = if self.direct {
                    let peer = self.owner_keys[1 - self.sc.account_of(*dev)].public_key();
                    self.engines[*dev]
                        .send_direct_text(peer, &peer.to_hex(), &text, None, UnixSeconds(secs(now)))
                        .map(|sent| (sent.effects, "ndr_direct_1060"))
                } else {
                    match self.group_id.clone() {
                        Some(group_id) => self.engines[*dev]
                            .send_group_payload(&group_id, text.into_bytes(), Some(format!("sim-{msg}")))
                            .map(|sent| (sent.effects, "ndr_group_message_1060")),
                        None => Err(anyhow::anyhow!("no group")),
                    }
                };
                match effects {
                    Ok((effects, class)) => {
                        #[cfg(feature = "group-broadcast")]
                        if !self.direct {
                            let data_events = effects.iter().filter(|effect| {
                                let ProtocolEffect::Publish(publish) = effect;
                                publish.carrier == iris_chat_protocol::ProtocolCarrier::SharedGroup
                            }).count();
                            assert_eq!(data_events, 1, "one data publication per successful group send");
                            out.count("shared_group_sends", 1);
                        }
                        self.publish(effects, class, out);
                    }
                    Err(error) => {
                        out.refused_sends.push(*msg);
                        out.count("send_refused", 1);
                        self.log_err("send", &error);
                    }
                }
            }
            Action::Add { admin, account } => {
                let Some(group_id) = self.group_id.clone() else {
                    return;
                };
                let member = self.owner_keys[*account].public_key();
                match self.engines[*admin].add_group_members(&group_id, vec![member]) {
                    Ok(result) => {
                        out.count("admin_add_issued", 1);
                        self.publish(result.effects, "ndr_group_control_1060", out);
                    }
                    Err(error) if error.to_string().contains("is already a member") => {
                        out.count("admin_add_noop_already_member", 1)
                    }
                    Err(error) => {
                        out.count("admin_op_refused", 1);
                        out.action_refused = true;
                        self.log_err("add member", &error);
                    }
                }
            }
            Action::Remove { admin, account } => {
                let Some(group_id) = self.group_id.clone() else {
                    return;
                };
                let member = self.owner_keys[*account].public_key();
                match self.engines[*admin].remove_group_member(&group_id, member) {
                    Ok(result) => {
                        out.count("admin_remove_issued", 1);
                        self.publish(result.effects, "ndr_group_control_1060", out);
                    }
                    Err(error) if error.to_string().contains("is not a member") => {
                        out.count("admin_remove_noop_not_member", 1)
                    }
                    Err(error) => {
                        out.count("admin_op_refused", 1);
                        out.action_refused = true;
                        self.log_err("remove member", &error);
                    }
                }
            }
        }
    }

    fn deliver(&mut self, dev: Dev, now: Ms, wires: &[Rc<Wire<Event>>], out: &mut Out<Event>) {
        self.set_time(now);
        for wire in wires {
            let event = &wire.payload;
            let kind = event.kind.as_u16() as u32;
            if kind == INVITE_RESPONSE_KIND {
                match self.engines[dev].observe_invite_response_event(event) {
                    Ok(batch) => self.handle_batch(dev, batch, out),
                    Err(error) => {
                        out.count("ndr_invite_response_errors", 1);
                        self.log_err("invite response", &error);
                    }
                }
            } else if kind == MESSAGE_EVENT_KIND {
                self.cur_wire = Some(wire.id);
                #[cfg(feature = "group-broadcast")]
                if self.engines[dev].subscribable_group_sender_event_pubkeys().contains(&event.pubkey) {
                    if event.verify().is_ok() {
                        match self.engines[dev].process_group_outer_event(event) {
                            Ok(result) => {
                                self.handle_group_events(dev, result.events, out);
                                self.publish(result.effects, "ndr_recovery_1060", out);
                            }
                            Err(error) => self.log_err("shared group data", &error),
                        }
                    }
                    continue;
                }
                let result = self.engines[dev].process_direct_message_event(event);
                if self.diag {
                    let what = match &result {
                        Ok(Some(_)) => "decrypted",
                        Ok(None) => "none",
                        Err(_) => "err",
                    };
                    eprintln!(
                        "[diag] rx t={} dev={dev} wire={} result={what}",
                        self.now / 1000,
                        wire.id
                    );
                }
                match result {
                    Ok(Some(message)) => self.handle_direct(dev, vec![message], out),
                    Ok(None) => out.count("ndr_inbound_queued_or_ignored", 1),
                    Err(error) => {
                        out.count("ndr_inbound_errors", 1);
                        self.log_err("inbound", &error);
                    }
                }
            }
        }
        self.cur_wire = None;
        self.retry(dev, out);
    }

    fn tick(&mut self, dev: Dev, now: Ms, out: &mut Out<Event>) {
        self.set_time(now);
        self.retry(dev, out);
        #[cfg(feature = "context-recovery")]
        if self.engines[dev].has_pending_group_pairwise_payloads() && self.reserve(dev, "scan".into()) {
            for (sender, group_id, author) in self.engines[dev].missing_group_metadata_sources() {
                self.request_missing_group_context(dev, sender, Some(group_id), Some(author), out);
            }
        }
    }

    fn publish_outcome(&mut self, dev: Dev, now: Ms, wire: u64, accepted: bool, out: &mut Out<Event>) {
        self.set_time(now);
        let Some((state, effect)) = self.wire_state.get_mut(&wire) else {
            return;
        };
        if self.diag {
            eprintln!("[diag] outcome wire={wire} accepted={accepted}");
        }
        if accepted {
            *state = PubState::Accepted;
            let effect = effect.clone();
            if let Err(error) = self.engines[dev].ack_group_publish_effects(std::slice::from_ref(&effect)) {
                self.log_err("ack publish", &error);
            }
        } else {
            *state = PubState::Failed;
            out.count("ndr_publish_failed", 1);
        }
    }

    fn sender_roster(&self, dev: Dev) -> Option<Vec<usize>> {
        let group = self.engines[dev].group_snapshot(self.group_id.as_ref()?)?;
        Some(self.owner_keys.iter().enumerate()
            .filter(|(_, key)| group.members.iter().any(|m| m.to_bytes() == key.public_key().to_bytes()))
            .map(|(account, _)| account).collect())
    }

    fn view(&mut self, dev: Dev) -> DeviceView {
        if self.direct {
            return DeviceView {
                in_group: true,
                state: "direct".into(),
                detail: String::new(),
            };
        }
        let Some(group) = self
            .group_id
            .as_ref()
            .and_then(|id| self.engines[dev].group_snapshot(id))
        else {
            return DeviceView {
                in_group: false,
                state: String::new(),
                detail: "no group".into(),
            };
        };
        let me = self.owner_of(dev);
        if !group.members.iter().any(|m| m.to_bytes() == me.to_bytes()) {
            return DeviceView {
                in_group: false,
                state: String::new(),
                detail: "not a member".into(),
            };
        }
        let mut members: Vec<String> = group.members.iter().map(|m| hex::encode(m.to_bytes())).collect();
        members.sort();
        let mut admins: Vec<String> = group.admins.iter().map(|m| hex::encode(m.to_bytes())).collect();
        admins.sort();
        let digest = Sha256::digest(format!("{members:?}{admins:?}").as_bytes());
        DeviceView {
            in_group: true,
            state: format!("rev {} roster {}", group.revision, &hex::encode(digest)[..12]),
            detail: format!("members {} admins {}", members.len(), admins.len()),
        }
    }

    fn storage_bytes(&mut self, dev: Dev) -> Option<u64> {
        let store = &self.stores[dev];
        let mut total = 0u64;
        for key in store.list("").ok()? {
            total += key.len() as u64;
            if let Ok(Some(value)) = store.get(&key) {
                total += value.len() as u64;
            }
        }
        Some(total)
    }
}

fn main() {
    let args: Vec<String> = std::env::args().skip(1).collect();
    let scenario = simnet::scenario_from_args(&args);
    let proto = NdrSim::new(&scenario).expect("engines");
    let report = simnet::Sim::new(proto, scenario).run("ndr-author-routing");
    println!("{}", serde_json::to_string(&report).expect("report"));
}

mod discovery;
