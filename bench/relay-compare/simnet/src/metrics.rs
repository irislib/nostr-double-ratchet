use super::*;

impl<Pr: Protocol> Sim<Pr> {
    pub(super) fn snapshot_phase(&mut self) {
        let n = self.devs.len().max(1) as u64;
        let rx: Vec<u64> = self.devs.iter().map(|d| d.rx_bytes).collect();
        self.cur.rx_bytes_avg_per_device = rx.iter().sum::<u64>() / n;
        self.cur.rx_bytes_max_per_device = rx.iter().copied().max().unwrap_or(0);
        self.cur.rx_events_avg_per_device = self.devs.iter().map(|d| d.rx_wires).sum::<u64>() / n;
        let elapsed: Vec<f64> = self.devs.iter().map(|d| d.adapter_wall_ns as f64 / 1e6).collect();
        self.cur.adapter_wall_ms_total = elapsed.iter().sum::<f64>() as u64;
        self.cur.adapter_wall_ms_avg_per_device = elapsed.iter().sum::<f64>() / n as f64;
        self.cur.adapter_wall_ms_max_per_device = elapsed.iter().copied().fold(0.0, f64::max);
    }

    pub(super) fn finish(mut self, protocol: &str, wall_s: f64) -> Report {
        let heal_at = self.heal_at;
        let mut expected = 0u64;
        let mut delivered = 0u64;
        let mut before_heal = 0u64;
        let mut lat: Vec<u64> = Vec::new();
        let mut olat: Vec<u64> = Vec::new();
        let mut online_expected = 0u64;
        let mut undelivered_msgs = 0usize;
        let mut refused = 0usize;
        let mut withdrawn = 0u64;
        let final_member = &self.planned_roster;
        let trace = std::env::var("SIM_TRACE").is_ok();
        if trace {
            for (i, action) in self.actions.iter().enumerate() {
                if !matches!(action, Action::Send { .. }) {
                    eprintln!("[trace] action {i}: {action:?}");
                }
            }
        }
        for (msg_id, rec) in self.msgs.iter() {
            if rec.refused {
                refused += 1;
            }
            let mut all = true;
            for dev in &rec.expect {
                expected += 1;
                let was_online = rec.online_at_send.contains(dev);
                if was_online {
                    online_expected += 1;
                }
                match rec.got.get(dev) {
                    Some(at) => {
                        if rec.withdrawn.contains(dev) {
                            withdrawn += 1;
                            all = false;
                            continue;
                        }
                        delivered += 1;
                        lat.push(at.saturating_sub(rec.sent_at));
                        if was_online {
                            olat.push(at.saturating_sub(rec.sent_at));
                        }
                        if *at <= heal_at {
                            before_heal += 1;
                        }
                    }
                    None => all = false,
                }
            }
            if !all {
                undelivered_msgs += 1;
                if trace {
                    let mut missing: Vec<Dev> = rec
                        .expect
                        .iter()
                        .copied()
                        .filter(|d| !rec.got.contains_key(d) || rec.withdrawn.contains(d))
                        .collect();
                    missing.sort_unstable();
                    eprintln!(
                        "[trace] undelivered msg {msg_id} t={}s sender dev {} missing {:?}",
                        rec.sent_at / 1000,
                        rec.sender,
                        missing
                    );
                }
            }
        }
        lat.sort_unstable();
        olat.sort_unstable();
        let pick = |v: &Vec<u64>, p: f64| -> u64 {
            if v.is_empty() {
                0
            } else {
                v[((v.len() - 1) as f64 * p) as usize]
            }
        };
        let pct = |p: f64| pick(&lat, p);
        let within = |ms: u64| -> f64 {
            if online_expected == 0 {
                0.0
            } else {
                olat.iter().filter(|l| **l <= ms).count() as f64 / online_expected as f64
            }
        };
        // Convergence of the shared state among intended members.
        let mut clusters: HashMap<String, usize> = HashMap::new();
        let mut members_expected = 0usize;
        let mut not_in_group = 0usize;
        let mut removed_still_in = 0usize;
        let mut storage: Vec<u64> = Vec::new();
        for dev in 0..self.devs.len() {
            let acct = self.sc.account_of(dev);
            let view = self.proto.view(dev);
            if trace {
                eprintln!(
                    "[trace] final dev {dev} acct {acct} member={} in_group={} {} | {}",
                    final_member[acct], view.in_group, view.state, view.detail
                );
            }
            if let Some(b) = self.proto.storage_bytes(dev) {
                storage.push(b);
            }
            if final_member[acct] {
                members_expected += 1;
                if view.in_group {
                    *clusters.entry(view.state).or_default() += 1;
                } else {
                    not_in_group += 1;
                }
            } else if view.in_group && self.removed_at[acct].is_some() {
                removed_still_in += 1;
            }
        }
        let mut state_clusters: Vec<(String, usize)> = clusters.into_iter().collect();
        state_clusters.sort_by(|a, b| b.1.cmp(&a.1).then(a.0.cmp(&b.0)));
        let largest = state_clusters.first().map(|c| c.1).unwrap_or(0);
        let sends_scheduled = self.msgs.len();
        let steady = std::mem::take(&mut self.cur);
        Report {
            protocol: protocol.to_string(),
            setup: self.setup_cost.take().unwrap_or_default(),
            steady,
            sends_scheduled,
            sends_attempted: self.attempted,
            sends_refused: refused,
            expected_deliveries: expected,
            delivered,
            delivered_before_heal: before_heal,
            delivery_ratio: if expected == 0 {
                0.0
            } else {
                delivered as f64 / expected as f64
            },
            delivery_ratio_before_heal: if expected == 0 {
                0.0
            } else {
                before_heal as f64 / expected as f64
            },
            undelivered_messages: undelivered_msgs,
            latency_ms_p50: pct(0.50),
            latency_ms_p95: pct(0.95),
            latency_ms_p99: pct(0.99),
            online_expected,
            online_latency_ms_p50: pick(&olat, 0.50),
            online_latency_ms_p95: pick(&olat, 0.95),
            online_latency_ms_p99: pick(&olat, 0.99),
            online_within_10s: within(10_000),
            online_within_60s: within(60_000),
            withdrawn_after_delivery: withdrawn,
            delivery_outside_intended_roster_after_removal: self.post_removal.included_account
                + self.post_removal.excluded_account + self.post_removal.unavailable,
            post_removal_sender_view: self.post_removal,
            schedule_fingerprint: format!("{:016x}", self.schedule_hash),
            state_clusters,
            members_expected,
            members_in_largest_cluster: largest,
            members_not_in_group: not_in_group,
            removed_still_in_group: removed_still_in,
            counters: self.counters,
            storage_bytes_avg: (!storage.is_empty())
                .then(|| storage.iter().sum::<u64>() / storage.len() as u64),
            storage_bytes_max: storage.iter().copied().max(),
            wall_s,
            virtual_s: self.now / 1000,
            scenario: self.sc,
        }
    }
}
