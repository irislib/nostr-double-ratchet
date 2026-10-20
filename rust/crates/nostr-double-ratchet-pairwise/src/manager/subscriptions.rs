use super::*;

pub(super) fn message_authors(
    state: &PairwiseState,
    limits: &RuntimeLimits,
) -> Result<Vec<String>> {
    let mut authors = BTreeSet::new();
    for peer in state.peers.values() {
        authors.extend(
            peer.tracked_sender_pubkeys()
                .into_iter()
                .map(|pubkey| pubkey.to_hex()),
        );
        if authors.len() > limits.max_subscription_authors {
            return Err(PairwiseError::QueueFull {
                queue: "subscription-authors",
            });
        }
    }
    Ok(authors.into_iter().collect())
}

pub(super) fn refresh_subscription_actions(
    state: &mut PairwiseState,
    installed_authors: &[String],
    force: bool,
    limits: &RuntimeLimits,
) -> Result<Vec<String>> {
    let authors = message_authors(state, limits)?;
    let subscription_id = state.message_subscription_id.clone();
    let expected_filter = serde_json::to_string(
        &Filter::new()
            .kind(Kind::from(MESSAGE_EVENT_KIND as u16))
            .authors(
                authors
                    .iter()
                    .map(|author| PublicKey::parse(author))
                    .collect::<std::result::Result<Vec<_>, _>>()?,
            ),
    )?;
    let has_pending_subscribe = state.pending_actions.iter().any(|action| {
        matches!(
            &action.kind,
            PairwiseActionKind::Subscribe {
                subscription_id: pending,
                filter_json,
            } if pending == &subscription_id && filter_json == &expected_filter
        )
    });
    let has_pending_unsubscribe = state.pending_actions.iter().any(|action| {
        matches!(
            &action.kind,
            PairwiseActionKind::Unsubscribe {
                subscription_id: pending,
            } if pending == &subscription_id
        )
    });
    if installed_authors.is_empty()
        && (has_pending_subscribe || (authors.is_empty() && has_pending_unsubscribe))
    {
        return Ok(authors);
    }
    if !force && authors == installed_authors {
        return Ok(authors);
    }
    state.pending_actions.retain(|action| match &action.kind {
        PairwiseActionKind::Subscribe {
            subscription_id: pending,
            ..
        }
        | PairwiseActionKind::Unsubscribe {
            subscription_id: pending,
        } => pending != &subscription_id,
        _ => true,
    });
    if authors.is_empty() && !installed_authors.is_empty() {
        push_action(
            state,
            PairwiseActionKind::Unsubscribe {
                subscription_id: subscription_id.clone(),
            },
        );
    }
    if !authors.is_empty() {
        let pubkeys = authors
            .iter()
            .map(|author| PublicKey::parse(author))
            .collect::<std::result::Result<Vec<_>, _>>()?;
        let filter = Filter::new()
            .kind(Kind::from(MESSAGE_EVENT_KIND as u16))
            .authors(pubkeys);
        push_action(
            state,
            PairwiseActionKind::Subscribe {
                subscription_id,
                filter_json: serde_json::to_string(&filter)?,
            },
        );
    }
    Ok(authors)
}
