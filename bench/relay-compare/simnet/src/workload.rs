use super::*;

fn merge_outages(mut intervals: Vec<(Ms, Ms)>) -> Vec<(Ms, Ms)> {
    intervals.sort_unstable();
    let mut merged: Vec<(Ms, Ms)> = Vec::new();
    for (start, end) in intervals {
        if let Some(last) = merged.last_mut() {
            if start <= last.1 {
                last.1 = last.1.max(end);
                continue;
            }
        }
        merged.push((start, end));
    }
    merged
}

#[test]
fn overlapping_outages_keep_device_offline_until_both_end() {
    assert_eq!(
        merge_outages(vec![(10, 20), (0, 15), (30, 40)]),
        [(0, 20), (30, 40)]
    );
}

impl<Pr: Protocol> Sim<Pr> {
    // FNV-1a over fixed-width records. Compare actual schedules across builds;
    // omit the engine-dependent setup duration and all runtime outcomes.
    fn hash_schedule(&mut self, words: &[u64]) {
        for byte in words.iter().flat_map(|word| word.to_le_bytes()) {
            self.schedule_hash ^= u64::from(byte);
            self.schedule_hash = self.schedule_hash.wrapping_mul(0x100000001b3);
        }
    }

    pub(super) fn schedule_workload(&mut self, t0: Ms) {
        let span = self.sc.duration_s * 1000;
        let mut wl = StdRng::seed_from_u64(self.sc.seed.wrapping_mul(7919) ^ 0xA11CE);
        let mut plan: Vec<(Ms, Action)> = Vec::new();
        // Intended membership evolves with the churn plan so sends and
        // admin picks are protocol independent.
        let mut member = self.member.clone();
        let (churn_from, churn_to) = match self.sc.churn_window_s {
            Some((start, len)) => (start * 1000, ((start + len) * 1000).min(span)),
            None => (span / 20, span * 19 / 20),
        };
        let mut churn_times: Vec<Ms> = (0..self.sc.churn_ops)
            .map(|_| wl.gen_range(churn_from..churn_to))
            .collect();
        churn_times.sort();
        let dpa = self.sc.devices_per_account;
        let admins = self.sc.admins.max(1);
        let mut churn: Vec<(Ms, bool, usize, usize)> = Vec::new();
        for t in churn_times {
            let outsiders: Vec<usize> = (0..member.len()).filter(|a| !member[*a]).collect();
            let removable: Vec<usize> = (admins..member.len()).filter(|a| member[*a]).collect();
            let add = !outsiders.is_empty() && (removable.len() <= 1 || wl.gen_bool(0.5));
            let admin = wl.gen_range(0..admins);
            if add {
                let a = outsiders[wl.gen_range(0..outsiders.len())];
                member[a] = true;
                churn.push((t, true, admin, a));
            } else if !removable.is_empty() {
                let a = removable[wl.gen_range(0..removable.len())];
                member[a] = false;
                churn.push((t, false, admin, a));
            }
            // A second admin acting in the same instant on someone else.
            if admins > 1 && wl.gen_bool(self.sc.concurrent_admin_frac) {
                let other = (admin + 1 + wl.gen_range(0..admins - 1)) % admins;
                let outsiders: Vec<usize> = (0..member.len()).filter(|a| !member[*a]).collect();
                let removable: Vec<usize> = (admins..member.len()).filter(|a| member[*a]).collect();
                if !outsiders.is_empty() && wl.gen_bool(0.5) {
                    let a = outsiders[wl.gen_range(0..outsiders.len())];
                    member[a] = true;
                    churn.push((t, true, other, a));
                } else if removable.len() > 1 {
                    let a = removable[wl.gen_range(0..removable.len())];
                    member[a] = false;
                    churn.push((t, false, other, a));
                }
            }
        }
        for (t, add, admin, account) in &churn {
            let admin_dev = admin * dpa + wl.gen_range(0..dpa);
            plan.push((
                t0 + t,
                if *add {
                    Action::Add {
                        admin: admin_dev,
                        account: *account,
                    }
                } else {
                    Action::Remove {
                        admin: admin_dev,
                        account: *account,
                    }
                },
            ));
        }
        // Messages: uniformly spread, sender drawn from intended members at that time.
        let mut times: Vec<Ms> = (0..self.sc.messages).map(|_| wl.gen_range(0..span)).collect();
        times.sort();
        for (i, t) in times.into_iter().enumerate() {
            let mut m = self.member.clone();
            for (ct, add, _, a) in &churn {
                // Leave a margin so a sender is not picked while its own
                // admission or removal is still propagating.
                if *ct + 90_000 <= t || (!*add && *ct <= t + 5_000) {
                    m[*a] = *add;
                } else if *add && *ct <= t {
                    m[*a] = false;
                }
            }
            let members: Vec<usize> = (0..m.len()).filter(|a| m[*a]).collect();
            if members.is_empty() {
                continue;
            }
            let account = members[wl.gen_range(0..members.len())];
            let dev = account * dpa + wl.gen_range(0..dpa);
            plan.push((
                t0 + t,
                Action::Send {
                    dev,
                    msg: i as u64 + 1,
                    size: self.sc.msg_bytes,
                },
            ));
        }
        plan.sort_by_key(|(t, _)| *t);
        // Fix the delivery obligations before either engine handles any traffic.
        let mut roster = self.member.clone();
        let mut removed = HashSet::new();
        for (t, action) in plan {
            let (kind, device, argument) = match &action {
                Action::Add { admin, account } => (1, *admin, *account as u64),
                Action::Remove { admin, account } => (2, *admin, *account as u64),
                Action::Send { dev, msg, .. } => (3, *dev, *msg),
                Action::Create { .. } => unreachable!(),
            };
            self.hash_schedule(&[kind, t - t0, device as u64, argument]);
            match &action {
                Action::Add { account, .. } => {
                    roster[*account] = true;
                    removed.remove(account);
                }
                Action::Remove { account, .. } => {
                    roster[*account] = false;
                    removed.insert(*account);
                }
                Action::Send { dev, msg, .. } => {
                    let expect = (0..self.sc.devices())
                        .filter(|d| *d != *dev && roster[self.sc.account_of(*d)])
                        .collect();
                    self.msgs.insert(
                        *msg,
                        MsgRec {
                            sent_at: t,
                            sender: *dev,
                            expect,
                            got: HashMap::new(),
                            refused: false,
                            removed_at_send: removed.clone(),
                            sender_roster_at_send: None,
                            withdrawn: HashSet::new(),
                            online_at_send: HashSet::new(),
                        },
                    );
                }
                Action::Create { .. } => unreachable!(),
            }
            self.actions.push(action);
            let idx = self.actions.len() - 1;
            self.push(t, Ev::Act(idx));
        }
        self.planned_roster = roster;
    }

    pub(super) fn schedule_faults(&mut self, t0: Ms) {
        let span = self.sc.duration_s * 1000;
        let net = self.sc.net.clone();
        let mut fr = StdRng::seed_from_u64(self.sc.seed.wrapping_mul(104_729) ^ 0xFA17);
        let exp = |r: &mut StdRng, mean_s: f64| -> Ms {
            let u: f64 = r.gen_range(1e-9..1.0);
            ((-u.ln()) * mean_s * 1000.0) as Ms + 1
        };
        if net.relay_down_frac > 0.0 {
            let up_mean = net.relay_down_mean_s * (1.0 - net.relay_down_frac) / net.relay_down_frac;
            for relay in 0..net.relays {
                let mut t = exp(&mut fr, up_mean);
                while t < span {
                    let d = exp(&mut fr, net.relay_down_mean_s);
                    self.hash_schedule(&[4, relay as u64, t, (t + d).min(span)]);
                    self.push(t0 + t, Ev::RelayUp { relay, up: false });
                    self.push(t0 + (t + d).min(span), Ev::RelayUp { relay, up: true });
                    t += d + exp(&mut fr, up_mean);
                }
            }
        }
        let mut outages = vec![Vec::new(); self.sc.devices()];
        if net.dev_offline_frac > 0.0 {
            let on_mean = net.dev_offline_mean_s * (1.0 - net.dev_offline_frac) / net.dev_offline_frac;
            for dev in 0..self.sc.devices() {
                let mut t = exp(&mut fr, on_mean);
                while t < span {
                    let d = exp(&mut fr, net.dev_offline_mean_s);
                    outages[dev].push((t, (t + d).min(span)));
                    t += d + exp(&mut fr, on_mean);
                }
            }
        }
        let long = (net.long_offline_s * 1000.0) as Ms;
        for i in 0..net.long_offline_devs.min(self.sc.devices()) {
            // Never the creator's device; spread over the member devices.
            let dev = 1
                + (fr.gen_range(0..self.sc.accounts * self.sc.devices_per_account - 1) + i)
                    % (self.sc.accounts * self.sc.devices_per_account - 1);
            let start = fr.gen_range(span / 10..span / 3);
            outages[dev].push((start, (start + long).min(span)));
        }
        for (dev, intervals) in outages.into_iter().enumerate() {
            for (start, end) in merge_outages(intervals) {
                self.hash_schedule(&[5, dev as u64, start, end]);
                self.push(t0 + start, Ev::DevOnline { dev, online: false });
                self.push(t0 + end, Ev::DevOnline { dev, online: true });
            }
        }
    }
}
