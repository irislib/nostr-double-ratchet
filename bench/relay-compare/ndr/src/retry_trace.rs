use super::*;
use std::io::{BufWriter, Write};
use std::path::PathBuf;

pub(super) struct RetryTrace {
    file: BufWriter<std::fs::File>,
    streams: HashMap<String, usize>,
    signatures: HashMap<[u8; 32], usize>,
    seen: HashSet<(usize, usize, usize)>,
    pub(super) sender: Dev,
    pub(super) workload: bool,
}

impl RetryTrace {
    pub(super) fn open(label: &str) -> Option<Self> {
        let dir = PathBuf::from(std::env::var_os("NDR_RETRY_AUDIT")?);
        let file = std::fs::OpenOptions::new()
            .write(true)
            .create_new(true)
            .open(dir.join(format!("{label}.tsv")))
            .expect("new retry trace");
        let mut file = BufWriter::new(file);
        writeln!(file,"phase\tms\tfrom\tto\tclass\tstage\tpayload\tstream\tkey\tposition\trevision\tshape\tdigest\tseen\tbytes").unwrap();
        Some(Self {
            file,
            streams: HashMap::new(),
            signatures: HashMap::new(),
            seen: HashSet::new(),
            sender: 0,
            workload: false,
        })
    }

    fn stream(&mut self, author: String) -> usize {
        let next = self.streams.len() + 1;
        *self.streams.entry(author).or_insert(next)
    }

    pub(super) fn record(
        &mut self,
        now: Ms,
        publish: &iris_chat_protocol::ProtocolPublish,
        devices: &[Keys],
        class: &str,
        wire_bytes: usize,
    ) {
        let event = &publish.event;
        let (raw, stage) = nostr_double_ratchet::sim_clock::take_seal(&event.content);
        let data = publish.carrier == iris_chat_protocol::ProtocolCarrier::SharedGroup;
        if !data && event.kind.as_u16() as u32 != MESSAGE_EVENT_KIND {
            return;
        }
        let to = publish.carrier.pairwise_device().map(|pk| {
            devices
                .iter()
                .position(|keys| keys.public_key() == pk)
                .expect("simulated target")
        });
        let mut stream = 0;
        let mut kid = None;
        let mut pos = None;
        let mut rev = None;
        let mut shape = "plain";
        let mut digest = None;
        let payload = if data {
            stream = self.stream(event.pubkey.to_hex());
            "shared_data"
        } else if let Some(raw) = raw {
            let inner = iris_chat_protocol::sim_inner_payload(&raw);
            if inner.is_some() {
                shape = "sibling_copy";
            }
            let bytes = inner.as_deref().unwrap_or(&raw);
            let value = JsonGroupPayloadCodecV1
                .decode_pairwise_command(bytes)
                .expect("decode synthetic command");
            let (kind, logical) = match value {
                Some(GroupPairwiseCommand::MetadataSnapshot { snapshot }) => {
                    rev = Some(snapshot.revision);
                    ("roster", serde_json::to_vec(&snapshot).unwrap())
                }
                Some(GroupPairwiseCommand::SenderKeyDistribution { distribution }) => {
                    stream = self.stream(distribution.sender_event_pubkey.to_hex());
                    kid = Some(distribution.key_id);
                    pos = Some(distribution.iteration);
                    // Distinguish chain contents without exporting keys; ignore envelope time.
                    (
                        "key",
                        serde_json::to_vec(&(stream, kid, pos, distribution.chain_key)).unwrap(),
                    )
                }
                Some(GroupPairwiseCommand::SenderKeyRepairRequest { request }) => {
                    stream = self.stream(request.sender_event_pubkey.to_hex());
                    kid = request.key_id;
                    pos = request.message_number;
                    rev = request.required_revision;
                    (
                        "request",
                        serde_json::to_vec(&(stream, kid, pos, rev)).unwrap(),
                    )
                }
                Some(GroupPairwiseCommand::GroupMessage { .. }) => ("app", bytes.to_vec()),
                None => ("other", bytes.to_vec()),
            };
            let tag: [u8; 32] = Sha256::digest([kind.as_bytes(), &logical].concat()).into();
            let next = self.signatures.len() + 1;
            digest = Some(*self.signatures.entry(tag).or_insert(next));
            kind
        } else {
            // An already sealed event can be re-offered. Count it without guessing the payload.
            "unclassified"
        };
        let repeated = match (digest, to) {
            (Some(d), Some(t)) => !self.seen.insert((self.sender, t, d)),
            _ => false,
        };
        let val = |v: Option<u64>| v.map(|n| n.to_string()).unwrap_or_default();
        writeln!(self.file, "{}\t{now}\t{}\t{}\t{class}\t{}\t{payload}\t{stream}\t{}\t{}\t{}\t{shape}\t{}\t{}\t{wire_bytes}",
                 if self.workload { "work" } else { "setup" },self.sender,val(to.map(|n|n as u64)),
                 stage.unwrap_or("immediate"),val(kid.map(u64::from)),val(pos.map(u64::from)),val(rev),
                 val(digest.map(|n|n as u64)),u8::from(repeated)).unwrap();
    }
}
