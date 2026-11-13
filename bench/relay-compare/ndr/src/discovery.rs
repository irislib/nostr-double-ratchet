use super::*;
use iris_chat_protocol::invite_unsigned_event;

impl NdrSim {
    pub(super) fn bootstrap(&mut self, out: &mut Out<Event>) -> anyhow::Result<()> {
        let accounts = self.sc.accounts + self.sc.spare_accounts;
        let created = secs(0) - 10;
        let mut published = Vec::new();
        for account in 0..accounts {
            let devices = self
                .sc
                .devices_of(account)
                .map(|d| DeviceEntry::new(self.device_keys[d].public_key(), created))
                .collect();
            let event = AppKeys::new(devices)
                .get_event_at(self.owner_keys[account].public_key(), created)
                .sign_with_keys(&self.owner_keys[account])?;
            published.push(("ndr_app_keys", event));
        }
        let app_keys: Vec<Event> = published.iter().map(|(_, e)| e.clone()).collect();
        for engine in &mut self.engines {
            engine.enter_batch();
            for event in &app_keys {
                engine.ingest_app_keys_event(event)?;
            }
        }
        let mut invites = Vec::new();
        for dev in 0..self.engines.len() {
            let invite = self.engines[dev]
                .local_invite()
                .ok_or_else(|| anyhow::anyhow!("device {dev} has no local invite"))?;
            let event = invite_unsigned_event(&invite)?.sign_with_keys(&self.device_keys[dev])?;
            invites.push(event.clone());
            published.push(("ndr_device_invite", event));
        }
        for (dev, engine) in self.engines.iter_mut().enumerate() {
            for (other, event) in invites.iter().enumerate() {
                if other != dev {
                    engine.observe_invite_event(event)?;
                }
            }
            engine.exit_batch()?;
        }
        for (class, event) in published {
            let id = self.next_wire;
            self.next_wire += 1;
            out.publishes.push(Wire {
                id,
                class,
                bytes: event.as_json().len(),
                keys: Vec::new(),
                payload: event,
            });
        }
        Ok(())
    }
}
