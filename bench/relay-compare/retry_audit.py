"""Install measurement hooks in the pinned simulation-only build."""
from pathlib import Path


def instrument(bench: Path, dest: Path, replace):
    library = dest / "ndr/rust/crates/nostr-double-ratchet/src"
    engine = dest / "iris/chat-protocol/src/protocol_engine"
    clock = library / "sim_clock.rs"
    with clock.open("a") as f:
        f.write((bench / "retry_audit_hooks.rs").read_text())

    replace(library / "session.rs", "        Ok(SendPlan {", """        crate::sim_clock::observe_seal(&ciphertext, payload);
        Ok(SendPlan {""")
    with (engine / "free_functions.rs").open("a") as f:
        f.write("""
pub(super) fn audit_retry_source(effects: &[ProtocolEffect], source: &'static str) {
    if !nostr_double_ratchet::sim_clock::audit_enabled() { return; }
    for ProtocolEffect::Publish(publish) in effects {
        nostr_double_ratchet::sim_clock::observe_source(&publish.event.content, source);
    }
}
""")
    with (engine.parent / "protocol_engine.rs").open("a") as f:
        f.write("""
pub fn sim_inner_payload(payload: &[u8]) -> Option<Vec<u8>> {
    decode_local_sibling_payload(payload).map(|(_, _, bytes)| bytes)
}
""")
    path = engine / "engine_incoming_retry.rs"
    replace(path, "        let mut group_result = group_result;\n        group_result.effects.extend(group_fanout_result.effects);", """        audit_retry_source(&group_result.effects, "group_inputs");
        audit_retry_source(&group_fanout_result.effects, "deferred_fanout");
        let mut group_result = group_result;
        group_result.effects.extend(group_fanout_result.effects);""")
    replace(path, '            effects.extend(self.retry_pending_local_sibling_sends(now)?);', '''            audit_retry_source(&effects, "deferred_remote_send");
            let sibling = self.retry_pending_local_sibling_sends(now)?;
            audit_retry_source(&sibling, "deferred_sibling_send");
            effects.extend(sibling);''')
    line = "        let repair_effects = self.retry_pending_group_sender_key_repairs(now)?;"
    replace(path, line, line + '\n        audit_retry_source(&repair_effects, "scheduled_key_repair");')
    replace(path, "        result.effects.extend(sender_keys.effects);", """        audit_retry_source(&sender_keys.effects, "pending_group_ciphertext");
        result.effects.extend(sender_keys.effects);""")
    replace(path, "                        result.effects.extend(effects);", """                        audit_retry_source(&effects, "queued_repair_response");
                        result.effects.extend(effects);""")
