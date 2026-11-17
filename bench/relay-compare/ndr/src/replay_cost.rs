use super::*;
use nostr_double_ratchet::{DevicePubkey, GroupPayloadEncodeContext, SenderKeyDistribution};

// Enter at Iris's authenticated pairwise dispatch boundary. Same writer,
// same group, one linked receiver. Publish effects are real signed envelopes.
#[test]
fn historical_key_replay_traffic() -> anyhow::Result<()> {
    let args = ["replay", "2", "2"].map(String::from);
    let mut sim = NdrSim::new(&simnet::scenario_from_args(&args))?;
    sim.bootstrap(&mut Out::default())?;
    let writer = sim.owner_of(0);
    let writer_device = sim.device_keys[0].public_key();
    let peer = sim.owner_of(2);
    let sibling = sim.device_keys[3].public_key();
    let group = sim.engines[0]
        .create_group("replay".into(), vec![peer], UnixSeconds(secs(0)))?
        .snapshot
        .expect("created group");
    let ctx = GroupPayloadEncodeContext {
        local_device_pubkey: DevicePubkey::from_bytes(writer_device.to_bytes()),
        created_at: NdrUnixSeconds(secs(0)),
    };
    let encode = |command| JsonGroupPayloadCodecV1.encode_pairwise_command(ctx, &command);
    let group_id = group.group_id.clone();
    let metadata = encode(GroupPairwiseCommand::MetadataSnapshot { snapshot: group })?;
    let receiver = &mut sim.engines[2];
    let mut receive = |payload: &[u8]| {
        receiver.process_group_pairwise_payload(payload, writer, Some(writer_device))
    };
    assert!(receive(&metadata)?.consumed);
    let author = keys_from(1, "group writer", 0).public_key();
    let distribution = |id: u8| {
        encode(GroupPairwiseCommand::SenderKeyDistribution {
            distribution: SenderKeyDistribution {
                group_id: group_id.clone(),
                key_id: u32::from(id),
                chain_key: [id; 32],
                sender_event_pubkey: DevicePubkey::from_bytes(author.to_bytes()),
                iteration: 0,
                created_at: ctx.created_at,
            },
        })
    };
    let old = distribution(1)?;
    let current = distribution(2)?;
    let mut events = 0;
    let mut bytes = 0;
    for (payload, fresh) in [
        (&old, true),
        (&current, true),
        (&old, false),
        (&current, false),
    ] {
        let outcome = receive(payload)?;
        assert!(outcome.consumed);
        if fresh {
            assert_eq!(outcome.effects.len(), 1, "forward each newly learned key");
        }
        for ProtocolEffect::Publish(publish) in outcome.effects {
            assert_eq!(publish.carrier.pairwise_device(), Some(sibling));
            assert_eq!(publish.event.kind.as_u16() as u32, MESSAGE_EVENT_KIND);
            assert!(publish.is_publishable() && publish.event.verify().is_ok());
            if !fresh {
                events += 1;
                bytes += publish.event.as_json().len();
            }
        }
    }
    println!("Replay produced {events} envelopes, {bytes} bytes");
    Ok(())
}
