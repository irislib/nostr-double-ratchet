use super::*;

#[derive(Clone, Debug, Serialize)]
pub struct NetProfile {
    pub name: String,
    pub relays: usize,
    /// Probability one relay silently drops one publish attempt.
    pub publish_loss: f64,
    /// Probability a live push from one relay to one subscriber is lost.
    pub live_loss: f64,
    pub relay_down_frac: f64,
    pub relay_down_mean_s: f64,
    pub dev_offline_frac: f64,
    pub dev_offline_mean_s: f64,
    /// Number of devices that additionally vanish for one long stretch.
    pub long_offline_devs: usize,
    pub long_offline_s: f64,
    pub latency_ms: (u64, u64),
    pub resync_s: u64,
    /// Relay rejects events larger than this (0 = unlimited).
    pub relay_max_bytes: usize,
    /// Relay forgets events older than this (0 = keeps forever).
    pub relay_retention_s: u64,
}

impl NetProfile {
    pub fn named(name: &str) -> Self {
        let base = NetProfile {
            name: name.to_string(),
            relays: 3,
            publish_loss: 0.0,
            live_loss: 0.0,
            relay_down_frac: 0.0,
            relay_down_mean_s: 60.0,
            dev_offline_frac: 0.0,
            dev_offline_mean_s: 300.0,
            long_offline_devs: 0,
            long_offline_s: 0.0,
            latency_ms: (40, 250),
            resync_s: 120,
            relay_max_bytes: 0,
            relay_retention_s: 0,
        };
        match name {
            "ideal" => base,
            "flaky" => NetProfile {
                publish_loss: 0.05,
                live_loss: 0.03,
                relay_down_frac: 0.05,
                dev_offline_frac: 0.2,
                ..base
            },
            "harsh" => NetProfile {
                publish_loss: 0.15,
                live_loss: 0.10,
                relay_down_frac: 0.15,
                relay_down_mean_s: 180.0,
                dev_offline_frac: 0.4,
                dev_offline_mean_s: 900.0,
                long_offline_devs: 2,
                long_offline_s: 2400.0,
                ..base
            },
            other => panic!("unknown net profile {other}"),
        }
    }
}

#[derive(Clone, Debug, Serialize)]
pub struct Scenario {
    pub label: String,
    pub seed: u64,
    pub accounts: usize,
    pub devices_per_account: usize,
    /// Accounts that exist but only join through later Add actions.
    pub spare_accounts: usize,
    pub admins: usize,
    pub duration_s: u64,
    pub heal_s: u64,
    pub messages: usize,
    pub msg_bytes: usize,
    /// Membership changes during the faulty phase.
    pub churn_ops: usize,
    /// Fraction of churn ops issued by two admins at the same instant.
    pub concurrent_admin_frac: f64,
    /// Network split (seconds after the faulty phase starts, duration): even
    /// accounts reach only relay 0, odd accounts only relay 1.
    pub partition_s: Option<(u64, u64)>,
    /// Confine membership changes to this window (start, duration) in seconds.
    pub churn_window_s: Option<(u64, u64)>,
    pub net: NetProfile,
}

impl Scenario {
    pub fn devices(&self) -> usize {
        (self.accounts + self.spare_accounts) * self.devices_per_account
    }
    pub fn account_of(&self, dev: Dev) -> usize {
        dev / self.devices_per_account
    }
    pub fn devices_of(&self, account: usize) -> std::ops::Range<Dev> {
        account * self.devices_per_account..(account + 1) * self.devices_per_account
    }
}

/// Shared CLI: `<label> <accounts> <devices> <net> <seed> [key=value ...]`.
pub fn scenario_from_args(args: &[String]) -> Scenario {
    let get = |i: usize, d: &str| args.get(i).cloned().unwrap_or_else(|| d.to_string());
    let accounts: usize = get(1, "2").parse().expect("accounts");
    let devices: usize = get(2, "1").parse().expect("devices");
    let net = NetProfile::named(&get(3, "ideal"));
    let seed: u64 = get(4, "1").parse().expect("seed");
    let mut sc = Scenario {
        label: get(0, "run"),
        seed,
        accounts,
        devices_per_account: devices,
        spare_accounts: if accounts > 2 { (accounts / 10).max(1) } else { 0 },
        admins: if accounts > 2 { 2 } else { 1 },
        duration_s: 3600,
        heal_s: 900,
        messages: 200,
        msg_bytes: 120,
        churn_ops: if accounts > 2 { 6 } else { 0 },
        concurrent_admin_frac: 0.5,
        partition_s: None,
        churn_window_s: None,
        net,
    };
    for kv in args.iter().skip(5) {
        let Some((k, v)) = kv.split_once('=') else {
            continue;
        };
        match k {
            "duration" => sc.duration_s = v.parse().unwrap(),
            "heal" => sc.heal_s = v.parse().unwrap(),
            "messages" => sc.messages = v.parse().unwrap(),
            "msg_bytes" => sc.msg_bytes = v.parse().unwrap(),
            "churn" => sc.churn_ops = v.parse().unwrap(),
            "concurrent" => sc.concurrent_admin_frac = v.parse().unwrap(),
            "spare" => sc.spare_accounts = v.parse().unwrap(),
            "partition" | "churn_window" => {
                let (a, b) = v.split_once(':').expect("start:duration");
                let window = Some((a.parse().unwrap(), b.parse().unwrap()));
                if k == "partition" {
                    sc.partition_s = window;
                } else {
                    sc.churn_window_s = window;
                }
            }
            "admins" => sc.admins = v.parse().unwrap(),
            "relays" => sc.net.relays = v.parse().unwrap(),
            "publish_loss" => sc.net.publish_loss = v.parse().unwrap(),
            "live_loss" => sc.net.live_loss = v.parse().unwrap(),
            "relay_down" => sc.net.relay_down_frac = v.parse().unwrap(),
            "offline" => sc.net.dev_offline_frac = v.parse().unwrap(),
            "offline_mean" => sc.net.dev_offline_mean_s = v.parse().unwrap(),
            "long_offline" => sc.net.long_offline_devs = v.parse().unwrap(),
            "long_offline_s" => sc.net.long_offline_s = v.parse().unwrap(),
            "relay_max_bytes" => sc.net.relay_max_bytes = v.parse().unwrap(),
            "retention" => sc.net.relay_retention_s = v.parse().unwrap(),
            "resync" => sc.net.resync_s = v.parse().unwrap(),
            other => panic!("unknown option {other}"),
        }
    }
    sc
}

/// Message plaintext carrying its id, padded to `size`.
pub fn encode_msg(msg: u64, size: usize) -> String {
    let mut s = format!("SIMMSG:{msg:012}:");
    while s.len() < size {
        s.push('x');
    }
    s
}

pub fn decode_msg(text: &str) -> Option<u64> {
    let at = text.find("SIMMSG:")?;
    text.get(at + 7..at + 19)?.parse().ok()
}
