use anchor_lang::prelude::*;
use crate::program::CommunityLedger;

// setup-community.ts replaces only this program's development identity.
declare_id!("7vuz78V9Tu53Bpt3iXHc37VSDBmRSYxcEguWewR9LXzm");
pub const MAX_GUARDIANS: usize = 16;
pub const RULE_VERSION: u8 = 1;
pub const PLATFORM_ATTESTED: u8 = 1;
pub const CREATED: u8 = 1;
pub const ASSIGNED: u8 = 2;
pub const CHECK_IN: u8 = 3;
pub const RELAY_REQUESTED: u8 = 4;
pub const CLOSED: u8 = 5;
pub const CONTRIBUTION: u8 = 6;
pub const GRATITUDE: u8 = 7;
pub const WITHDRAWN: u8 = 8;

#[program]
pub mod community_ledger {
    use super::*;
    pub fn initialize(ctx: Context<Initialize>, issuer: Pubkey, sponsor: Pubkey) -> Result<()> {
        validate_keys(ctx.accounts.admin.key(), issuer, sponsor)?;
        *ctx.accounts.config = CommunityConfig { version: 1, admin: ctx.accounts.admin.key(), issuer, sponsor, revision: 0 };
        Ok(())
    }
    pub fn rotate_authorities(ctx: Context<Rotate>, next_admin: Pubkey, next_issuer: Pubkey, next_sponsor: Pubkey, expected_revision: u32) -> Result<()> {
        validate_keys(next_admin, next_issuer, next_sponsor)?;
        let config = &mut ctx.accounts.config;
        require!(config.revision == expected_revision, LedgerError::OutOfOrder);
        config.revision = config.revision.checked_add(1).ok_or(LedgerError::Overflow)?;
        config.admin = next_admin; config.issuer = next_issuer; config.sponsor = next_sponsor;
        Ok(())
    }
    pub fn append_event(ctx: Context<AppendEvent>, event: EventInput) -> Result<()> {
        let now = Clock::get()?.unix_timestamp;
        let (points, reputation) = ctx.accounts.journey.apply(&event, now)?;
        ctx.accounts.record.set(event, ctx.accounts.issuer.key(), now, points, reputation, 0);
        Ok(())
    }
    pub fn withdraw_journey(ctx: Context<WithdrawJourney>, journey_id: [u8; 32], sequence: u32, target_sequence: u32, reason: u8, observed_at: i64) -> Result<()> {
        let now = Clock::get()?.unix_timestamp;
        let journey = &mut ctx.accounts.journey;
        require!(journey.journey_id == journey_id && journey.next_sequence == sequence, LedgerError::OutOfOrder);
        require!(!journey.withdrawn && journey.outcome != 0 && (1..=4).contains(&reason), LedgerError::InvalidCorrection);
        require!(ctx.accounts.target.journey_id == journey_id && ctx.accounts.target.sequence == target_sequence && target_sequence < sequence, LedgerError::InvalidCorrection);
        validate_time(observed_at, journey.last_observed_at, now)?;
        journey.withdrawn = true;
        ctx.accounts.record.set(EventInput { journey_id, sequence, kind: WITHDRAWN, actor_id: journey.rider_id, subject_id: journey.rider_id, assignment: journey.assignment, observed_at, value: reason }, ctx.accounts.admin.key(), now, 0, 0, target_sequence);
        Ok(())
    }
}

fn validate_keys(admin: Pubkey, issuer: Pubkey, sponsor: Pubkey) -> Result<()> {
    require!(admin != Pubkey::default() && issuer != Pubkey::default() && sponsor != Pubkey::default(), LedgerError::InvalidIdentity);
    require!(admin != issuer && admin != sponsor && issuer != sponsor, LedgerError::SeparateAuthorities);
    Ok(())
}
fn validate_time(observed: i64, previous: i64, now: i64) -> Result<()> {
    require!(observed > 0 && observed >= previous && observed <= now.checked_add(300).ok_or(LedgerError::Overflow)?, LedgerError::InvalidTime);
    Ok(())
}

#[derive(Accounts)]
pub struct Initialize<'info> {
    #[account(mut)] pub admin: Signer<'info>,
    #[account(init, payer = admin, space = 8 + CommunityConfig::INIT_SPACE, seeds = [b"community_config"], bump)] pub config: Account<'info, CommunityConfig>,
    #[account(constraint = program.programdata_address()? == Some(program_data.key()) @ LedgerError::Unauthorized)] pub program: Program<'info, CommunityLedger>,
    #[account(constraint = program_data.upgrade_authority_address == Some(admin.key()) @ LedgerError::Unauthorized)] pub program_data: Account<'info, ProgramData>,
    pub system_program: Program<'info, System>,
}
#[derive(Accounts)]
pub struct Rotate<'info> {
    pub admin: Signer<'info>,
    #[account(mut, seeds = [b"community_config"], bump, has_one = admin)] pub config: Account<'info, CommunityConfig>,
}
#[derive(Accounts)]
#[instruction(event: EventInput)]
pub struct AppendEvent<'info> {
    #[account(seeds = [b"community_config"], bump, has_one = issuer, has_one = sponsor)] pub config: Account<'info, CommunityConfig>,
    pub issuer: Signer<'info>,
    #[account(mut)] pub sponsor: Signer<'info>,
    #[account(init_if_needed, payer = sponsor, space = 8 + CommunityJourney::INIT_SPACE, seeds = [b"community_journey", event.journey_id.as_ref()], bump)] pub journey: Account<'info, CommunityJourney>,
    #[account(init, payer = sponsor, space = 8 + CommunityRecord::INIT_SPACE, seeds = [b"community_record", event.journey_id.as_ref(), &event.sequence.to_le_bytes()], bump)] pub record: Account<'info, CommunityRecord>,
    pub system_program: Program<'info, System>,
}
#[derive(Accounts)]
#[instruction(journey_id: [u8; 32], sequence: u32, target_sequence: u32)]
pub struct WithdrawJourney<'info> {
    #[account(seeds = [b"community_config"], bump, has_one = admin, has_one = sponsor)] pub config: Account<'info, CommunityConfig>,
    pub admin: Signer<'info>,
    #[account(mut)] pub sponsor: Signer<'info>,
    #[account(mut, seeds = [b"community_journey", journey_id.as_ref()], bump)] pub journey: Account<'info, CommunityJourney>,
    #[account(seeds = [b"community_record", journey_id.as_ref(), &target_sequence.to_le_bytes()], bump)] pub target: Account<'info, CommunityRecord>,
    #[account(init, payer = sponsor, space = 8 + CommunityRecord::INIT_SPACE, seeds = [b"community_withdrawal", journey_id.as_ref()], bump)] pub record: Account<'info, CommunityRecord>,
    pub system_program: Program<'info, System>,
}

#[account]
#[derive(InitSpace)]
pub struct CommunityConfig { pub version: u8, pub admin: Pubkey, pub issuer: Pubkey, pub sponsor: Pubkey, pub revision: u32 }
#[derive(AnchorSerialize, AnchorDeserialize, Clone, InitSpace)]
pub struct EventInput {
    pub journey_id: [u8; 32], pub sequence: u32, pub kind: u8, pub actor_id: [u8; 32], pub subject_id: [u8; 32],
    pub assignment: u32, pub observed_at: i64, pub value: u8,
}
#[account]
#[derive(InitSpace)]
pub struct CommunityRecord {
    pub version: u8, pub provenance: u8, pub rule_version: u8,
    pub journey_id: [u8; 32], pub sequence: u32, pub kind: u8,
    pub actor_id: [u8; 32], pub subject_id: [u8; 32], pub assignment: u32,
    pub observed_at: i64, pub value: u8, pub issuer: Pubkey, pub recorded_at: i64,
    pub points: u16, pub reputation: u16, pub target_sequence: u32,
}
impl CommunityRecord {
    pub fn set(&mut self, e: EventInput, issuer: Pubkey, recorded_at: i64, points: u16, reputation: u16, target_sequence: u32) {
        *self = Self { version: 1, provenance: PLATFORM_ATTESTED, rule_version: RULE_VERSION, journey_id: e.journey_id, sequence: e.sequence, kind: e.kind, actor_id: e.actor_id, subject_id: e.subject_id, assignment: e.assignment, observed_at: e.observed_at, value: e.value, issuer, recorded_at, points, reputation, target_sequence };
    }
}
#[derive(AnchorSerialize, AnchorDeserialize, Copy, Clone, Default, InitSpace)]
pub struct MemberContribution { pub member_id: [u8; 32], pub check_ins: u32, pub claimed: bool, pub thanked: bool, pub last_assignment: u32 }
#[account]
#[derive(InitSpace, Default)]
pub struct CommunityJourney {
    pub version: u8, pub journey_id: [u8; 32], pub rider_id: [u8; 32], pub next_sequence: u32,
    pub assignment: u32, pub current_guardian_id: [u8; 32], pub outcome: u8, pub withdrawn: bool,
    pub last_observed_at: i64, pub guardian_count: u8, pub contributions: [MemberContribution; MAX_GUARDIANS],
}
impl CommunityJourney {
    fn index(&self, id: [u8; 32]) -> Option<usize> { self.contributions[..self.guardian_count as usize].iter().position(|c| c.member_id == id) }
    pub fn apply(&mut self, e: &EventInput, now: i64) -> Result<(u16, u16)> {
        require!(e.journey_id != [0; 32] && (e.actor_id != [0; 32] || (e.kind == RELAY_REQUESTED && e.value == 1)) && e.subject_id != [0; 32], LedgerError::InvalidIdentity);
        validate_time(e.observed_at, self.last_observed_at, now)?;
        let next = e.sequence.checked_add(1).ok_or(LedgerError::Overflow)?;
        if e.kind == CREATED {
            require!(self.version == 0 && e.sequence == 0 && e.assignment == 0 && e.actor_id == e.subject_id && e.value == 0, LedgerError::InvalidEvent);
            self.version = 1; self.journey_id = e.journey_id; self.rider_id = e.actor_id;
        } else {
            require!(self.version == 1 && self.journey_id == e.journey_id && self.next_sequence == e.sequence, LedgerError::OutOfOrder);
            require!((ASSIGNED..=GRATITUDE).contains(&e.kind), LedgerError::InvalidEvent);
            if ![ASSIGNED, CONTRIBUTION, GRATITUDE].contains(&e.kind) { require!(e.assignment == self.assignment, LedgerError::StaleAssignment); }
            if ![CLOSED, GRATITUDE, RELAY_REQUESTED].contains(&e.kind) { require!(e.value == 0, LedgerError::InvalidEvent); }
            match e.kind {
                ASSIGNED => {
                    require!(self.outcome == 0 && e.actor_id == self.rider_id, LedgerError::Unauthorized);
                    require!(e.subject_id != self.rider_id && e.subject_id != self.current_guardian_id, LedgerError::InvalidIdentity);
                    require!(e.assignment == self.assignment.checked_add(1).ok_or(LedgerError::Overflow)?, LedgerError::StaleAssignment);
                    if self.index(e.subject_id).is_none() {
                        require!((self.guardian_count as usize) < MAX_GUARDIANS, LedgerError::GuardianLimit);
                        self.contributions[self.guardian_count as usize].member_id = e.subject_id;
                        self.guardian_count += 1;
                    }
                    let index = self.index(e.subject_id).ok_or(LedgerError::Unauthorized)?;
                    self.contributions[index].last_assignment = e.assignment;
                    self.current_guardian_id = e.subject_id; self.assignment = e.assignment;
                },
                CHECK_IN => {
                    require!(self.outcome == 0 && self.assignment > 0 && e.actor_id == self.current_guardian_id && e.subject_id == e.actor_id, LedgerError::Unauthorized);
                    let index = self.index(e.actor_id).ok_or(LedgerError::Unauthorized)?;
                    self.contributions[index].check_ins = self.contributions[index].check_ins.checked_add(1).ok_or(LedgerError::Overflow)?;
                },
                RELAY_REQUESTED => {
                    let human = e.value == 0 && (e.actor_id == self.rider_id || e.actor_id == self.current_guardian_id);
                    let automatic = e.value == 1 && e.actor_id == [0;32];
                    require!(self.outcome == 0 && self.assignment > 0 && e.subject_id == self.current_guardian_id && (human || automatic), LedgerError::Unauthorized);
                },
                CLOSED => {
                    require!(self.outcome == 0 && e.actor_id == self.rider_id && e.subject_id == self.rider_id && (1..=3).contains(&e.value), LedgerError::InvalidEvent);
                    self.outcome = e.value;
                },
                CONTRIBUTION => {
                    require!(self.outcome == 1 && e.actor_id == e.subject_id, LedgerError::Ineligible);
                    let index = self.index(e.subject_id).ok_or(LedgerError::Ineligible)?;
                    require!(e.assignment == self.contributions[index].last_assignment, LedgerError::StaleAssignment);
                    require!(self.contributions[index].check_ins > 0 && !self.contributions[index].claimed, LedgerError::Ineligible);
                    let eligible = self.contributions[..self.guardian_count as usize].iter().filter(|c| c.check_ins > 0).count() as u16;
                    let rank = self.contributions[..self.guardian_count as usize].iter().filter(|c| c.check_ins > 0 && c.member_id < e.subject_id).count() as u16;
                    self.contributions[index].claimed = true;
                    self.next_sequence = next; self.last_observed_at = e.observed_at;
                    return Ok((25 / eligible + u16::from(rank < 25 % eligible), 10 / eligible + u16::from(rank < 10 % eligible)));
                },
                GRATITUDE => {
                    require!(self.outcome != 0 && e.actor_id == self.rider_id && (1..=3).contains(&e.value), LedgerError::Ineligible);
                    let index = self.index(e.subject_id).ok_or(LedgerError::Ineligible)?;
                    require!(e.assignment == self.contributions[index].last_assignment, LedgerError::StaleAssignment);
                    require!(self.contributions[index].check_ins > 0 && !self.contributions[index].thanked, LedgerError::Ineligible);
                    self.contributions[index].thanked = true;
                },
                _ => return err!(LedgerError::InvalidEvent),
            }
        }
        self.next_sequence = next; self.last_observed_at = e.observed_at;
        Ok((0, 0))
    }
}

#[error_code]
pub enum LedgerError {
    #[msg("Unauthorized issuer, sponsor, or administrator")] Unauthorized,
    #[msg("Identity references must be nonzero and valid for the action")] InvalidIdentity,
    #[msg("Administrator, issuer, and sponsor must be separate keys")] SeparateAuthorities,
    #[msg("Record sequence does not follow the current journey")] OutOfOrder,
    #[msg("Assignment does not match the current responsibility period")] StaleAssignment,
    #[msg("Invalid event kind, fields, or journey state")] InvalidEvent,
    #[msg("Observation times must be ordered and cannot be in the future")] InvalidTime,
    #[msg("This recognition is ineligible or already issued")] Ineligible,
    #[msg("A journey supports at most sixteen distinct guardians")] GuardianLimit,
    #[msg("This journey has an administrative withdrawal")] Withdrawn,
    #[msg("Invalid or duplicate administrative correction")] InvalidCorrection,
    #[msg("Numeric overflow")] Overflow,
}

#[cfg(test)]
mod tests {
    use super::*;
    fn event(j: &CommunityJourney, kind: u8, actor: u8, subject: u8, value: u8) -> EventInput {
        let assignment=if [CONTRIBUTION,GRATITUDE].contains(&kind) { j.index([subject;32]).map(|i|j.contributions[i].last_assignment).unwrap_or(j.assignment) } else { j.assignment + u32::from(kind == ASSIGNED) };
        EventInput { journey_id: [42;32], sequence: j.next_sequence, kind, actor_id: [actor;32], subject_id: [subject;32], assignment, observed_at: 100 + j.next_sequence as i64, value }
    }
    fn apply(j: &mut CommunityJourney, kind: u8, actor: u8, subject: u8, value: u8) -> Result<(u16,u16)> { j.apply(&event(j,kind,actor,subject,value), 1000) }
    fn created() -> CommunityJourney { let mut j = CommunityJourney::default(); apply(&mut j,CREATED,1,1,0).unwrap(); j }
    #[test] fn returns_keep_three_assignments_and_one_share_each() {
        let mut j=created(); apply(&mut j,ASSIGNED,1,2,0).unwrap(); apply(&mut j,CHECK_IN,2,2,0).unwrap();
        apply(&mut j,RELAY_REQUESTED,2,2,0).unwrap(); apply(&mut j,ASSIGNED,1,3,0).unwrap(); apply(&mut j,CHECK_IN,3,3,0).unwrap();
        apply(&mut j,ASSIGNED,1,2,0).unwrap(); apply(&mut j,CHECK_IN,2,2,0).unwrap();
        assert_eq!(j.assignment,3); assert_eq!(j.guardian_count,2); apply(&mut j,CLOSED,1,1,1).unwrap();
        assert_eq!(apply(&mut j,CONTRIBUTION,2,2,0).unwrap(),(13,5)); assert_eq!(apply(&mut j,CONTRIBUTION,3,3,0).unwrap(),(12,5));
        assert!(apply(&mut j,CONTRIBUTION,2,2,0).is_err()); apply(&mut j,GRATITUDE,1,3,3).unwrap(); assert!(apply(&mut j,GRATITUDE,1,3,1).is_err());
    }
    #[test] fn cancelled_former_guardian_can_receive_thanks_but_no_points() {
        let mut j=created(); apply(&mut j,ASSIGNED,1,2,0).unwrap(); apply(&mut j,CHECK_IN,2,2,0).unwrap(); apply(&mut j,ASSIGNED,1,3,0).unwrap();
        apply(&mut j,CLOSED,1,1,2).unwrap(); assert!(apply(&mut j,CONTRIBUTION,2,2,0).is_err());
        apply(&mut j,GRATITUDE,1,2,1).unwrap(); assert!(apply(&mut j,GRATITUDE,1,3,1).is_err()); assert!(apply(&mut j,CHECK_IN,3,3,0).is_err());
    }
    #[test] fn sequence_actor_time_and_assignment_cannot_be_forged() {
        let mut j=created(); let mut e=event(&j,ASSIGNED,1,2,0); e.sequence+=1; assert!(j.apply(&e,1000).is_err());
        assert!(apply(&mut j,ASSIGNED,2,3,0).is_err()); assert!(apply(&mut j,ASSIGNED,1,1,0).is_err());
        apply(&mut j,ASSIGNED,1,2,0).unwrap(); let mut stale=event(&j,CHECK_IN,2,2,0); stale.assignment=0; assert!(j.apply(&stale,1000).is_err());
        assert!(apply(&mut j,CHECK_IN,3,3,0).is_err()); let mut future=event(&j,CHECK_IN,2,2,0); future.observed_at=1301; assert!(j.apply(&future,1000).is_err());
        future.observed_at=1; assert!(j.apply(&future,1000).is_err()); assert!(apply(&mut j,GRATITUDE,1,2,1).is_err());
    }
    #[test] fn empty_arrival_has_no_recognition_and_withdrawn_journey_retains_late_audit_receipts() {
        let mut j=created(); apply(&mut j,CLOSED,1,1,1).unwrap(); assert!(apply(&mut j,CONTRIBUTION,2,2,0).is_err());
        let mut j=created(); apply(&mut j,ASSIGNED,1,2,0).unwrap(); apply(&mut j,CHECK_IN,2,2,0).unwrap(); apply(&mut j,CLOSED,1,1,1).unwrap();
        j.withdrawn=true; assert_eq!(apply(&mut j,CONTRIBUTION,2,2,0).unwrap(),(25,10)); apply(&mut j,GRATITUDE,1,2,1).unwrap();
        assert!(apply(&mut j,CHECK_IN,2,2,0).is_err());
    }
    #[test] fn authority_keys_are_distinct_and_nonzero() {
        let a=Pubkey::new_unique(); let b=Pubkey::new_unique(); let c=Pubkey::new_unique(); validate_keys(a,b,c).unwrap();
        assert!(validate_keys(a,a,c).is_err()); assert!(validate_keys(a,b,b).is_err()); assert!(validate_keys(Pubkey::default(),b,c).is_err());
    }
    #[test] fn public_wire_layout_is_stable() {
        assert_eq!(CommunityConfig::INIT_SPACE+8,109); assert_eq!(CommunityRecord::INIT_SPACE+8,173); assert_eq!(CommunityJourney::INIT_SPACE+8,796);
        let mut record=CommunityRecord { version:0,provenance:0,rule_version:0,journey_id:[0;32],sequence:0,kind:0,actor_id:[0;32],subject_id:[0;32],assignment:0,observed_at:0,value:0,issuer:Pubkey::default(),recorded_at:0,points:0,reputation:0,target_sequence:0 };
        record.set(event(&CommunityJourney::default(),CREATED,1,1,0),Pubkey::new_unique(),200,0,0,0);
        let mut bytes=Vec::new(); record.try_serialize(&mut bytes).unwrap(); assert_eq!(bytes.len(),173); assert_eq!(&bytes[11..43],&[42;32]); assert_eq!(bytes[47],CREATED); assert_eq!(&bytes[80..112],&[1;32]);
    }
}
