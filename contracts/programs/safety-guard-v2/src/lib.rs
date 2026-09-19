use anchor_lang::prelude::*;

// Development-only V2 address. setup-v2.ts replaces this for an isolated deployment.
declare_id!("9xQeWvG816bUx9EPfEZKZQXav6BYXPiZY82AKgNxqHLQ");
pub const MAX_GUARDIANS: usize = 16;
pub const POINTS_POOL: u64 = 25;
pub const REPUTATION_POOL: u64 = 10;
pub const MAX_DURATION: i64 = 86_400;
pub const PROPOSAL_DURATION: i64 = 300;
pub const CHECK_IN_COOLDOWN: i64 = 15;

#[program]
pub mod safety_guard_v2 {
    use super::*;
    pub fn create_journey(ctx: Context<CreateJourney>, reference: [u8; 32], deadline: i64) -> Result<()> {
        ctx.accounts.journey.initialize(ctx.accounts.rider.key(), reference, Clock::get()?.unix_timestamp, deadline, ctx.bumps.journey)
    }
    pub fn propose_guardian(ctx: Context<RiderAction>, guardian: Pubkey, expected_revision: u32) -> Result<()> {
        ctx.accounts.journey.propose(guardian, expected_revision, Clock::get()?.unix_timestamp)
    }
    pub fn cancel_proposal(ctx: Context<RiderAction>, expected_revision: u32) -> Result<()> {
        ctx.accounts.journey.cancel_proposal(expected_revision)
    }
    pub fn accept_guardian(ctx: Context<GuardianAction>, expected_revision: u32) -> Result<()> {
        ctx.accounts.journey.accept(ctx.accounts.guardian.key(), expected_revision, Clock::get()?.unix_timestamp)
    }
    pub fn check_in(ctx: Context<GuardianAction>, expected_sequence: u32) -> Result<()> {
        ctx.accounts.journey.check_in(ctx.accounts.guardian.key(), expected_sequence, Clock::get()?.unix_timestamp)
    }
    pub fn complete_journey(ctx: Context<RiderAction>, expected_revision: u32) -> Result<()> {
        ctx.accounts.journey.complete(expected_revision, Clock::get()?.unix_timestamp)
    }
    pub fn cancel_journey(ctx: Context<RiderAction>, expected_revision: u32) -> Result<()> {
        ctx.accounts.journey.cancel(expected_revision, Clock::get()?.unix_timestamp)
    }
    pub fn claim_reward(ctx: Context<ClaimReward>) -> Result<()> {
        ctx.accounts.journey.claim(ctx.accounts.guardian.key(), &mut ctx.accounts.reputation)?;
        ctx.accounts.reputation.bump = ctx.bumps.reputation;
        Ok(())
    }
}

#[derive(Accounts)]
#[instruction(reference: [u8; 32])]
pub struct CreateJourney<'info> {
    #[account(mut)] pub rider: Signer<'info>,
    #[account(init, payer = rider, space = 8 + JourneyV2::INIT_SPACE,
        seeds = [b"journey", rider.key().as_ref(), reference.as_ref()], bump)]
    pub journey: Box<Account<'info, JourneyV2>>,
    pub system_program: Program<'info, System>,
}
#[derive(Accounts)]
pub struct RiderAction<'info> {
    pub rider: Signer<'info>,
    #[account(mut, seeds = [b"journey", rider.key().as_ref(), journey.reference.as_ref()],
        bump = journey.bump, has_one = rider @ GuardError::Unauthorized)]
    pub journey: Box<Account<'info, JourneyV2>>,
}
#[derive(Accounts)]
pub struct GuardianAction<'info> {
    pub guardian: Signer<'info>,
    #[account(mut, seeds = [b"journey", journey.rider.as_ref(), journey.reference.as_ref()], bump = journey.bump)]
    pub journey: Box<Account<'info, JourneyV2>>,
}
#[derive(Accounts)]
pub struct ClaimReward<'info> {
    #[account(mut)] pub payer: Signer<'info>,
    /// CHECK: No data is read; the key must match an eligible stored contributor.
    pub guardian: UncheckedAccount<'info>,
    #[account(mut, seeds = [b"journey", journey.rider.as_ref(), journey.reference.as_ref()], bump = journey.bump)]
    pub journey: Box<Account<'info, JourneyV2>>,
    #[account(init_if_needed, payer = payer, space = 8 + ReputationV2::INIT_SPACE,
        seeds = [b"reputation_v2", guardian.key().as_ref()], bump)]
    pub reputation: Account<'info, ReputationV2>,
    pub system_program: Program<'info, System>,
}

#[account]
#[derive(InitSpace, Debug)]
pub struct JourneyV2 {
    pub version: u8,
    pub rider: Pubkey,
    pub reference: [u8; 32],
    pub current_guardian: Pubkey,
    pub proposed_guardian: Pubkey,
    pub created_at: i64,
    pub deadline: i64,
    pub proposal_expires_at: i64,
    pub completed_at: i64,
    pub assignment_revision: u32,
    pub sequence: u32,
    pub state: JourneyState,
    pub guardian_count: u8,
    pub bump: u8,
    pub contributions: [Contribution; MAX_GUARDIANS],
}
#[derive(AnchorSerialize, AnchorDeserialize, InitSpace, Debug, Clone, Copy, Default)]
pub struct Contribution {
    pub guardian: Pubkey,
    pub check_ins: u32,
    pub last_check_in_at: i64,
    pub started_at: i64,
    pub ended_at: i64,
    pub points: u64,
    pub reputation: u64,
    pub claimed: bool,
}
#[account]
#[derive(InitSpace, Debug, Default)]
pub struct ReputationV2 {
    pub version: u8,
    pub guardian: Pubkey,
    pub points: u64,
    pub reputation: u64,
    pub completed_journeys: u64,
    pub bump: u8,
}
#[derive(AnchorSerialize, AnchorDeserialize, InitSpace, Debug, Clone, Copy, PartialEq, Eq)]
pub enum JourneyState { Open, Active, Completed, Cancelled }

impl JourneyV2 {
    pub fn initialize(&mut self, rider: Pubkey, reference: [u8; 32], now: i64, deadline: i64, bump: u8) -> Result<()> {
        require!(reference != [0; 32], GuardError::InvalidReference);
        require!(deadline > now && deadline.checked_sub(now).ok_or(GuardError::Overflow)? <= MAX_DURATION, GuardError::InvalidDeadline);
        *self = Self { version: 2, rider, reference, current_guardian: Pubkey::default(), proposed_guardian: Pubkey::default(),
            created_at: now, deadline, proposal_expires_at: 0, completed_at: 0, assignment_revision: 0, sequence: 0,
            state: JourneyState::Open, guardian_count: 0, bump, contributions: [Contribution::default(); MAX_GUARDIANS] };
        Ok(())
    }
    fn revision(&self, expected: u32) -> Result<u32> {
        require!(self.version == 2, GuardError::WrongVersion);
        require!(matches!(self.state, JourneyState::Open | JourneyState::Active), GuardError::InvalidState);
        require!(self.assignment_revision == expected, GuardError::StaleRevision);
        self.assignment_revision.checked_add(1).ok_or_else(|| error!(GuardError::Overflow))
    }
    fn index(&self, guardian: Pubkey) -> Option<usize> {
        self.contributions[..self.guardian_count as usize].iter().position(|item| item.guardian == guardian)
    }
    pub fn propose(&mut self, guardian: Pubkey, expected: u32, now: i64) -> Result<()> {
        let revision = self.revision(expected)?;
        require!(now <= self.deadline, GuardError::Expired);
        require!(guardian != Pubkey::default() && guardian != self.rider && guardian != self.current_guardian, GuardError::InvalidGuardian);
        require!(guardian != self.proposed_guardian || now > self.proposal_expires_at, GuardError::DuplicateProposal);
        require!(self.index(guardian).is_some() || (self.guardian_count as usize) < MAX_GUARDIANS, GuardError::GuardianLimit);
        self.proposed_guardian = guardian;
        self.proposal_expires_at = now.checked_add(PROPOSAL_DURATION).ok_or(GuardError::Overflow)?.min(self.deadline);
        self.assignment_revision = revision;
        Ok(())
    }
    pub fn cancel_proposal(&mut self, expected: u32) -> Result<()> {
        let revision = self.revision(expected)?;
        require!(self.proposed_guardian != Pubkey::default(), GuardError::NoProposal);
        self.proposed_guardian = Pubkey::default(); self.proposal_expires_at = 0; self.assignment_revision = revision;
        Ok(())
    }
    pub fn accept(&mut self, guardian: Pubkey, expected: u32, now: i64) -> Result<()> {
        let revision = self.revision(expected)?;
        require!(guardian != Pubkey::default() && guardian == self.proposed_guardian, GuardError::Unauthorized);
        require!(now <= self.deadline && now <= self.proposal_expires_at, GuardError::Expired);
        let sequence = self.sequence.checked_add(1).ok_or(GuardError::Overflow)?;
        let index = if let Some(index) = self.index(guardian) { index } else {
            require!((self.guardian_count as usize) < MAX_GUARDIANS, GuardError::GuardianLimit);
            self.guardian_count as usize
        };
        if let Some(previous) = self.index(self.current_guardian) { self.contributions[previous].ended_at = now; }
        if index == self.guardian_count as usize {
            self.contributions[index] = Contribution { guardian, started_at: now, ..Contribution::default() };
            self.guardian_count += 1;
        }
        self.contributions[index].ended_at = 0;
        self.current_guardian = guardian; self.proposed_guardian = Pubkey::default(); self.proposal_expires_at = 0;
        self.sequence = sequence; self.assignment_revision = revision; self.state = JourneyState::Active;
        Ok(())
    }
    pub fn check_in(&mut self, guardian: Pubkey, expected_sequence: u32, now: i64) -> Result<()> {
        require!(self.version == 2 && self.state == JourneyState::Active, GuardError::InvalidState);
        require!(self.sequence == expected_sequence, GuardError::StaleSequence);
        require!(guardian == self.current_guardian, GuardError::Unauthorized);
        require!(now <= self.deadline, GuardError::Expired);
        let index = self.index(guardian).ok_or(GuardError::Unauthorized)?;
        let contribution = &mut self.contributions[index];
        require!(contribution.check_ins == 0 || now.checked_sub(contribution.last_check_in_at).ok_or(GuardError::Overflow)? >= CHECK_IN_COOLDOWN, GuardError::CheckInTooSoon);
        contribution.check_ins = contribution.check_ins.checked_add(1).ok_or(GuardError::Overflow)?;
        contribution.last_check_in_at = now;
        Ok(())
    }
    pub fn complete(&mut self, expected: u32, now: i64) -> Result<()> {
        let revision = self.revision(expected)?;
        require!(self.state == JourneyState::Active, GuardError::InvalidState);
        let count = self.guardian_count as usize;
        let eligible = self.contributions[..count].iter().filter(|item| item.check_ins > 0).count() as u64;
        require!(eligible > 0, GuardError::NoCheckIns);
        // Wallet byte order is deterministic; joining repeatedly never creates another share.
        for i in 0..count {
            if self.contributions[i].check_ins > 0 {
                let rank = self.contributions[..count].iter().filter(|other| other.check_ins > 0 && other.guardian.to_bytes() < self.contributions[i].guardian.to_bytes()).count() as u64;
                self.contributions[i].points = POINTS_POOL / eligible + u64::from(rank < POINTS_POOL % eligible);
                self.contributions[i].reputation = REPUTATION_POOL / eligible + u64::from(rank < REPUTATION_POOL % eligible);
            }
            if self.contributions[i].ended_at == 0 { self.contributions[i].ended_at = now; }
        }
        self.state = JourneyState::Completed; self.completed_at = now; self.assignment_revision = revision;
        self.proposed_guardian = Pubkey::default(); self.proposal_expires_at = 0;
        Ok(())
    }
    pub fn cancel(&mut self, expected: u32, now: i64) -> Result<()> {
        let revision = self.revision(expected)?;
        for item in &mut self.contributions[..self.guardian_count as usize] { if item.ended_at == 0 { item.ended_at = now; } }
        self.state = JourneyState::Cancelled; self.completed_at = now; self.assignment_revision = revision;
        self.proposed_guardian = Pubkey::default(); self.proposal_expires_at = 0;
        Ok(())
    }
    pub fn claim(&mut self, guardian: Pubkey, reputation: &mut ReputationV2) -> Result<()> {
        require!(self.version == 2 && self.state == JourneyState::Completed, GuardError::InvalidState);
        let index = self.index(guardian).ok_or(GuardError::Unauthorized)?;
        let contribution = &mut self.contributions[index];
        require!(contribution.check_ins > 0, GuardError::NoCheckIns);
        require!(!contribution.claimed, GuardError::AlreadyClaimed);
        require!((reputation.version == 0 && reputation.guardian == Pubkey::default()) || (reputation.version == 2 && reputation.guardian == guardian), GuardError::Unauthorized);
        let points = reputation.points.checked_add(contribution.points).ok_or(GuardError::Overflow)?;
        let rep = reputation.reputation.checked_add(contribution.reputation).ok_or(GuardError::Overflow)?;
        let completed = reputation.completed_journeys.checked_add(1).ok_or(GuardError::Overflow)?;
        reputation.version = 2; reputation.guardian = guardian; reputation.points = points;
        reputation.reputation = rep; reputation.completed_journeys = completed; contribution.claimed = true;
        Ok(())
    }
}
#[error_code]
pub enum GuardError {
    #[msg("Unsupported account version")] WrongVersion,
    #[msg("A random nonzero 32-byte reference is required")] InvalidReference,
    #[msg("Deadline must be within the next 24 hours")] InvalidDeadline,
    #[msg("Action is not allowed in this journey state")] InvalidState,
    #[msg("Assignment revision changed; refresh before signing")] StaleRevision,
    #[msg("Guardian assignment changed; refresh before signing")] StaleSequence,
    #[msg("Signer is not authorized for this action")] Unauthorized,
    #[msg("Proposal or journey deadline has passed")] Expired,
    #[msg("Guardian must differ from rider, current guardian, and zero address")] InvalidGuardian,
    #[msg("This guardian already has a live proposal")] DuplicateProposal,
    #[msg("No proposal exists")] NoProposal,
    #[msg("A journey supports at most 16 distinct guardians")] GuardianLimit,
    #[msg("At least one signed check-in is required")] NoCheckIns,
    #[msg("Signed check-ins must be at least 15 seconds apart")] CheckInTooSoon,
    #[msg("This contribution was already credited")] AlreadyClaimed,
    #[msg("Numeric overflow")] Overflow,
}

#[cfg(test)]
mod tests {
    use super::*;
    fn journey() -> JourneyV2 {
        let mut value = JourneyV2 { version: 0, rider: Pubkey::default(), reference: [0; 32], current_guardian: Pubkey::default(), proposed_guardian: Pubkey::default(), created_at: 0, deadline: 0, proposal_expires_at: 0, completed_at: 0, assignment_revision: 0, sequence: 0, state: JourneyState::Open, guardian_count: 0, bump: 0, contributions: [Contribution::default(); MAX_GUARDIANS] };
        value.initialize(Pubkey::new_unique(), [42; 32], 100, 2000, 255).unwrap(); value
    }
    fn join(value: &mut JourneyV2, guardian: Pubkey, now: i64) {
        value.propose(guardian, value.assignment_revision, now).unwrap();
        value.accept(guardian, value.assignment_revision, now + 1).unwrap();
    }
    #[test]
    fn relay_returns_keep_unique_contributions_and_exact_pool() {
        let mut j = journey(); let a = Pubkey::new_unique(); let b = Pubkey::new_unique();
        join(&mut j, a, 110); j.check_in(a, 1, 112).unwrap();
        j.propose(b, 2, 115).unwrap(); j.check_in(a, 1, 127).unwrap(); // A remains assigned while B is pending.
        assert!(j.accept(b, 2, 128).is_err()); j.accept(b, 3, 128).unwrap();
        assert!(j.check_in(a, 1, 129).is_err()); assert!(j.check_in(a, 2, 129).is_err());
        j.check_in(b, 2, 129).unwrap(); join(&mut j, a, 140);
        assert!(j.check_in(a, 1, 150).is_err()); j.check_in(a, 3, 150).unwrap();
        assert_eq!(j.guardian_count, 2); assert_eq!(j.contributions[0].check_ins, 3);
        j.complete(j.assignment_revision, 160).unwrap();
        assert_eq!(j.contributions.iter().map(|c| c.points).sum::<u64>(), 25);
        assert_eq!(j.contributions.iter().map(|c| c.reputation).sum::<u64>(), 10);
        let expected_a = if a.to_bytes() < b.to_bytes() { 13 } else { 12 };
        assert_eq!(j.contributions[0].points, expected_a);
        let mut rep = ReputationV2::default(); j.claim(a, &mut rep).unwrap();
        assert_eq!(rep.points, expected_a); assert_eq!(rep.completed_journeys, 1);
        assert!(j.claim(a, &mut rep).is_err()); assert!(j.complete(j.assignment_revision, 161).is_err());
        assert!(j.propose(b, j.assignment_revision, 161).is_err());
    }
    #[test]
    fn stale_revisions_proposals_and_expiry_cannot_hijack_assignment() {
        let mut j = journey(); let a = Pubkey::new_unique(); let b = Pubkey::new_unique();
        j.propose(a, 0, 110).unwrap(); assert_eq!(j.proposal_expires_at, 410);
        assert!(j.propose(a, 1, 111).is_err()); assert!(j.accept(b, 1, 112).is_err());
        assert!(j.accept(a, 1, 411).is_err()); j.propose(b, 1, 412).unwrap();
        assert!(j.accept(a, 1, 413).is_err()); assert!(j.cancel_proposal(1).is_err());
        j.cancel_proposal(2).unwrap(); assert!(j.accept(b, 3, 414).is_err());
        assert!(j.propose(j.rider, 3, 420).is_err()); assert!(j.propose(Pubkey::default(), 3, 420).is_err());
        join(&mut j, a, 500); assert!(j.propose(a, j.assignment_revision, 502).is_err());
        assert!(j.cancel(j.assignment_revision - 1, 503).is_err());
        j.propose(b, j.assignment_revision, 1950).unwrap(); assert_eq!(j.proposal_expires_at, 2000);
        assert!(j.accept(b, j.assignment_revision, 2001).is_err());
    }
    #[test]
    fn no_check_in_no_reward_and_cancellation_is_terminal() {
        let mut j = journey(); let a = Pubkey::new_unique(); join(&mut j, a, 110);
        assert!(j.complete(j.assignment_revision, 113).is_err());
        j.check_in(a, 1, 114).unwrap(); assert!(j.check_in(a, 1, 128).is_err());
        assert!(j.check_in(a, 1, 2001).is_err());
        j.cancel(j.assignment_revision, 115).unwrap();
        assert!(j.claim(a, &mut ReputationV2::default()).is_err());
        assert!(j.complete(j.assignment_revision, 116).is_err());
        assert_eq!(j.contributions[0].points, 0);
    }
    #[test]
    fn all_sixteen_guardians_share_the_same_pool_and_returning_guardian_is_allowed() {
        let mut j = journey();
        for i in 0..MAX_GUARDIANS {
            let guardian = Pubkey::new_unique(); let now = 110 + i as i64 * 20;
            join(&mut j, guardian, now); j.check_in(guardian, j.sequence, now + 2).unwrap();
        }
        assert!(j.propose(Pubkey::new_unique(), j.assignment_revision, 450).is_err());
        let first = j.contributions[0].guardian; join(&mut j, first, 451);
        j.complete(j.assignment_revision, 460).unwrap();
        assert_eq!(j.guardian_count, 16);
        assert_eq!(j.contributions.iter().map(|c| c.points).sum::<u64>(), 25);
        assert_eq!(j.contributions.iter().map(|c| c.reputation).sum::<u64>(), 10);
        for i in 0..MAX_GUARDIANS { j.claim(j.contributions[i].guardian, &mut ReputationV2::default()).unwrap(); }
        assert!(j.contributions.iter().all(|c| c.claimed));
    }
    #[test]
    fn acceptance_without_check_in_never_dilutes_eligible_reward() {
        let mut j = journey(); let a = Pubkey::new_unique(); let b = Pubkey::new_unique();
        join(&mut j, a, 110); j.check_in(a, 1, 112).unwrap(); join(&mut j, b, 120);
        j.complete(j.assignment_revision, 3000).unwrap(); // Late arrival may settle already recorded contributions.
        assert_eq!(j.contributions[0].points, 25); assert_eq!(j.contributions[0].reputation, 10);
        assert!(j.claim(b, &mut ReputationV2::default()).is_err());
    }
    #[test]
    fn overflow_and_wrong_reputation_do_not_partially_credit() {
        let mut j = journey(); let a = Pubkey::new_unique(); join(&mut j, a, 110); j.check_in(a, 1, 112).unwrap(); j.complete(j.assignment_revision, 113).unwrap();
        let mut rep = ReputationV2 { version: 2, guardian: a, completed_journeys: u64::MAX, ..ReputationV2::default() };
        assert!(j.claim(a, &mut rep).is_err()); assert_eq!(rep.points, 0); assert!(!j.contributions[0].claimed);
        rep.guardian = Pubkey::new_unique(); assert!(j.claim(a, &mut rep).is_err());
    }
    #[test]
    fn borsh_layout_matches_portable_client_offsets() {
        let j = journey(); let mut bytes = Vec::new(); j.try_serialize(&mut bytes).unwrap();
        assert_eq!(JourneyV2::INIT_SPACE, 1404); assert_eq!(bytes.len(), 1412);
        assert_eq!(bytes[8], 2); assert_eq!(&bytes[9..41], j.rider.as_ref());
        assert_eq!(&bytes[41..73], &[42; 32]); assert_eq!(bytes[179], 255);
        assert_eq!(Contribution::INIT_SPACE, 77); assert_eq!(ReputationV2::INIT_SPACE, 58);
    }
}
