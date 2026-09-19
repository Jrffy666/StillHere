use anchor_lang::prelude::*;

declare_id!("Fg6PaFpoGXkYsidMpWxTWqkZqZH7bGQjR67FvBPMR6Dz");

pub const REWARD_POINTS: u64 = 10;
pub const MAX_DURATION_SECONDS: i64 = 86_400;
pub const CHECK_IN_COOLDOWN_SECONDS: i64 = 15;

#[program]
pub mod safety_guard {
    use super::*;

    pub fn create_task(ctx: Context<CreateTask>, trip_id: [u8; 32], deadline: i64) -> Result<()> {
        let now = Clock::get()?.unix_timestamp;
        ctx.accounts.task.initialize(
            ctx.accounts.rider.key(),
            ctx.accounts.guardian.key(),
            trip_id,
            now,
            deadline,
            ctx.bumps.task,
        )
    }

    pub fn accept_task(ctx: Context<GuardianAction>) -> Result<()> {
        ctx.accounts.task.accept(Clock::get()?.unix_timestamp)
    }

    pub fn check_in(ctx: Context<GuardianAction>) -> Result<()> {
        ctx.accounts.task.check_in(Clock::get()?.unix_timestamp)
    }

    pub fn complete_task(ctx: Context<CompleteTask>) -> Result<()> {
        let task = &mut ctx.accounts.task;
        let reputation = &mut ctx.accounts.reputation;
        // This PDA is never closed. A terminal task cannot be replayed for points.
        task.complete(reputation, Clock::get()?.unix_timestamp)?;
        reputation.bump = ctx.bumps.reputation;
        Ok(())
    }

    pub fn cancel_task(ctx: Context<RiderAction>) -> Result<()> {
        ctx.accounts.task.cancel(Clock::get()?.unix_timestamp)
    }
}

#[derive(Accounts)]
#[instruction(trip_id: [u8; 32])]
pub struct CreateTask<'info> {
    #[account(mut)]
    pub rider: Signer<'info>,
    /// CHECK: Only the public key is stored; accepting later requires its signature.
    pub guardian: UncheckedAccount<'info>,
    #[account(
        init,
        payer = rider,
        space = 8 + GuardTask::INIT_SPACE,
        seeds = [b"task", rider.key().as_ref(), trip_id.as_ref()],
        bump
    )]
    pub task: Account<'info, GuardTask>,
    pub system_program: Program<'info, System>,
}

#[derive(Accounts)]
pub struct GuardianAction<'info> {
    pub guardian: Signer<'info>,
    #[account(
        mut,
        seeds = [b"task", task.rider.as_ref(), task.trip_id.as_ref()],
        bump = task.bump,
        has_one = guardian @ GuardError::UnauthorizedGuardian
    )]
    pub task: Account<'info, GuardTask>,
}

#[derive(Accounts)]
pub struct RiderAction<'info> {
    pub rider: Signer<'info>,
    #[account(
        mut,
        seeds = [b"task", rider.key().as_ref(), task.trip_id.as_ref()],
        bump = task.bump,
        has_one = rider @ GuardError::UnauthorizedRider
    )]
    pub task: Account<'info, GuardTask>,
}

#[derive(Accounts)]
pub struct CompleteTask<'info> {
    #[account(mut)]
    pub rider: Signer<'info>,
    #[account(
        mut,
        seeds = [b"task", rider.key().as_ref(), task.trip_id.as_ref()],
        bump = task.bump,
        has_one = rider @ GuardError::UnauthorizedRider
    )]
    pub task: Account<'info, GuardTask>,
    #[account(
        init_if_needed,
        payer = rider,
        space = 8 + Reputation::INIT_SPACE,
        seeds = [b"reputation", task.guardian.as_ref()],
        bump
    )]
    pub reputation: Account<'info, Reputation>,
    pub system_program: Program<'info, System>,
}

#[account]
#[derive(InitSpace, Debug)]
pub struct GuardTask {
    pub rider: Pubkey,
    pub guardian: Pubkey,
    pub trip_id: [u8; 32],
    pub created_at: i64,
    pub deadline: i64,
    pub accepted_at: i64,
    pub last_check_in_at: i64,
    pub completed_at: i64,
    pub check_in_count: u32,
    pub state: TaskState,
    pub bump: u8,
}

impl GuardTask {
    pub fn initialize(
        &mut self,
        rider: Pubkey,
        guardian: Pubkey,
        trip_id: [u8; 32],
        now: i64,
        deadline: i64,
        bump: u8,
    ) -> Result<()> {
        require!(rider != guardian, GuardError::SelfGuarding);
        require!(guardian != Pubkey::default(), GuardError::InvalidGuardian);
        require!(trip_id != [0; 32], GuardError::InvalidTripId);
        require!(deadline > now, GuardError::InvalidDeadline);
        require!(
            deadline.checked_sub(now).ok_or(GuardError::Overflow)? <= MAX_DURATION_SECONDS,
            GuardError::InvalidDeadline
        );
        *self = Self {
            rider,
            guardian,
            trip_id,
            created_at: now,
            deadline,
            accepted_at: 0,
            last_check_in_at: 0,
            completed_at: 0,
            check_in_count: 0,
            state: TaskState::Pending,
            bump,
        };
        Ok(())
    }

    pub fn accept(&mut self, now: i64) -> Result<()> {
        require!(self.state == TaskState::Pending, GuardError::InvalidState);
        require!(now <= self.deadline, GuardError::Expired);
        self.state = TaskState::Active;
        self.accepted_at = now;
        Ok(())
    }

    pub fn check_in(&mut self, now: i64) -> Result<()> {
        require!(self.state == TaskState::Active, GuardError::InvalidState);
        require!(now <= self.deadline, GuardError::Expired);
        require!(
            self.check_in_count == 0
                || now
                    .checked_sub(self.last_check_in_at)
                    .ok_or(GuardError::Overflow)?
                    >= CHECK_IN_COOLDOWN_SECONDS,
            GuardError::CheckInTooSoon
        );
        self.check_in_count = self
            .check_in_count
            .checked_add(1)
            .ok_or(GuardError::Overflow)?;
        self.last_check_in_at = now;
        Ok(())
    }

    pub fn complete(&mut self, reputation: &mut Reputation, now: i64) -> Result<()> {
        require!(self.state == TaskState::Active, GuardError::InvalidState);
        require!(self.check_in_count > 0, GuardError::NoCheckIns);
        require!(
            reputation.guardian == Pubkey::default() || reputation.guardian == self.guardian,
            GuardError::UnauthorizedGuardian
        );
        let points = reputation
            .points
            .checked_add(REWARD_POINTS)
            .ok_or(GuardError::Overflow)?;
        let completed_tasks = reputation
            .completed_tasks
            .checked_add(1)
            .ok_or(GuardError::Overflow)?;
        reputation.guardian = self.guardian;
        reputation.points = points;
        reputation.completed_tasks = completed_tasks;
        self.state = TaskState::Completed;
        self.completed_at = now;
        Ok(())
    }

    pub fn cancel(&mut self, now: i64) -> Result<()> {
        require!(
            self.state == TaskState::Pending || self.state == TaskState::Active,
            GuardError::InvalidState
        );
        self.state = TaskState::Cancelled;
        self.completed_at = now;
        Ok(())
    }
}

#[derive(AnchorSerialize, AnchorDeserialize, Clone, Copy, PartialEq, Eq, InitSpace, Debug)]
pub enum TaskState {
    Pending,
    Active,
    Completed,
    Cancelled,
}

#[account]
#[derive(InitSpace, Debug, Default)]
pub struct Reputation {
    pub guardian: Pubkey,
    pub points: u64,
    pub completed_tasks: u64,
    pub bump: u8,
}

#[error_code]
pub enum GuardError {
    #[msg("Rider and guardian must use distinct wallet addresses")]
    SelfGuarding,
    #[msg("Guardian must be a nonzero wallet address")]
    InvalidGuardian,
    #[msg("Trip ID must be a random nonzero 32-byte value")]
    InvalidTripId,
    #[msg("Deadline must be in the next 24 hours")]
    InvalidDeadline,
    #[msg("Instruction is not allowed in the current task state")]
    InvalidState,
    #[msg("Only the designated guardian may perform this action")]
    UnauthorizedGuardian,
    #[msg("Only the rider may perform this action")]
    UnauthorizedRider,
    #[msg("The task deadline has passed")]
    Expired,
    #[msg("Guardian must record at least one check-in before completion")]
    NoCheckIns,
    #[msg("Check-ins must be at least 15 seconds apart")]
    CheckInTooSoon,
    #[msg("Numeric overflow")]
    Overflow,
}

#[cfg(test)]
mod tests {
    use super::*;

    fn task() -> GuardTask {
        let mut task = GuardTask {
            rider: Pubkey::default(),
            guardian: Pubkey::default(),
            trip_id: [0; 32],
            created_at: 0,
            deadline: 0,
            accepted_at: 0,
            last_check_in_at: 0,
            completed_at: 0,
            check_in_count: 0,
            state: TaskState::Pending,
            bump: 0,
        };
        task.initialize(
            Pubkey::new_unique(),
            Pubkey::new_unique(),
            [7; 32],
            100,
            500,
            255,
        )
        .unwrap();
        task
    }

    #[test]
    fn completion_is_single_use_and_requires_check_in() {
        let mut task = task();
        let mut rep = Reputation::default();
        assert!(task.complete(&mut rep, 101).is_err());
        task.accept(102).unwrap();
        assert!(task.complete(&mut rep, 103).is_err());
        task.check_in(104).unwrap();
        task.complete(&mut rep, 105).unwrap();
        assert_eq!(rep.points, REWARD_POINTS);
        assert_eq!(rep.completed_tasks, 1);
        assert!(task.complete(&mut rep, 106).is_err());
        assert!(task.check_in(107).is_err());
        assert!(task.cancel(108).is_err());
        assert_eq!(rep.points, REWARD_POINTS);
    }

    #[test]
    fn cancellation_is_terminal_and_awards_nothing() {
        for accepted in [false, true] {
            let mut task = task();
            if accepted {
                task.accept(101).unwrap();
                task.check_in(102).unwrap();
            }
            task.cancel(103).unwrap();
            let mut rep = Reputation::default();
            assert!(task.accept(104).is_err());
            assert!(task.check_in(104).is_err());
            assert!(task.complete(&mut rep, 104).is_err());
            assert_eq!(rep.points, 0);
        }
    }

    #[test]
    fn check_in_spam_and_expired_actions_are_rejected() {
        let mut task = task();
        assert!(task.accept(501).is_err());
        task.accept(101).unwrap();
        task.check_in(102).unwrap();
        assert!(task.check_in(116).is_err());
        task.check_in(117).unwrap();
        assert!(task.check_in(501).is_err());
        assert_eq!(task.check_in_count, 2);
        // An actual arrival may be confirmed late, without more guardian activity.
        task.complete(&mut Reputation::default(), 600).unwrap();
    }

    #[test]
    fn invalid_creation_and_wrong_reputation_are_rejected() {
        let mut task = task();
        let key = Pubkey::new_unique();
        assert!(task.initialize(key, key, [1; 32], 100, 200, 1).is_err());
        assert!(task
            .initialize(key, Pubkey::default(), [1; 32], 100, 200, 1)
            .is_err());
        assert!(task
            .initialize(key, Pubkey::new_unique(), [0; 32], 100, 200, 1)
            .is_err());
        assert!(task
            .initialize(key, Pubkey::new_unique(), [1; 32], 100, 100, 1)
            .is_err());
        assert!(task
            .initialize(
                key,
                Pubkey::new_unique(),
                [1; 32],
                100,
                100 + MAX_DURATION_SECONDS + 1,
                1
            )
            .is_err());
        task.accept(101).unwrap();
        task.check_in(102).unwrap();
        let mut rep = Reputation {
            guardian: Pubkey::new_unique(),
            ..Reputation::default()
        };
        assert!(task.complete(&mut rep, 103).is_err());
        assert_eq!(task.state, TaskState::Active);
    }

    #[test]
    fn overflow_never_partially_rewards() {
        let mut task = task();
        task.accept(101).unwrap();
        task.check_in(102).unwrap();
        let mut rep = Reputation {
            guardian: task.guardian,
            points: 20,
            completed_tasks: u64::MAX,
            bump: 1,
        };
        assert!(task.complete(&mut rep, 103).is_err());
        assert_eq!(rep.points, 20);
        assert_eq!(task.state, TaskState::Active);
    }

    #[test]
    fn account_sizes_match_client_wire_format() {
        assert_eq!(GuardTask::INIT_SPACE, 142);
        assert_eq!(Reputation::INIT_SPACE, 49);
    }
}
