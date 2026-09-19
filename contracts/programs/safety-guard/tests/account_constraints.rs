use anchor_lang::{prelude::*, AccountSerialize};
use safety_guard::{
    GuardTask, GuardianAction, GuardianActionBumps, RiderAction, RiderActionBumps, TaskState,
};
use std::collections::BTreeSet;

// Small, leaked test fixtures keep AccountInfo borrows alive for Anchor's account parser.
fn account(
    key: Pubkey,
    owner: Pubkey,
    signer: bool,
    writable: bool,
    data: Vec<u8>,
) -> AccountInfo<'static> {
    AccountInfo::new(
        Box::leak(Box::new(key)),
        signer,
        writable,
        Box::leak(Box::new(10_000_000)),
        Box::leak(data.into_boxed_slice()),
        Box::leak(Box::new(owner)),
        false,
        0,
    )
}

fn fixture() -> (GuardTask, Pubkey, Vec<u8>) {
    let rider = Pubkey::new_unique();
    let guardian = Pubkey::new_unique();
    let trip_id = [17; 32];
    let (address, bump) =
        Pubkey::find_program_address(&[b"task", rider.as_ref(), &trip_id], &safety_guard::ID);
    let task = GuardTask {
        rider,
        guardian,
        trip_id,
        created_at: 100,
        deadline: 200,
        accepted_at: 0,
        last_check_in_at: 0,
        completed_at: 0,
        check_in_count: 0,
        state: TaskState::Pending,
        bump,
    };
    let mut data = Vec::new();
    task.try_serialize(&mut data).unwrap();
    (task, address, data)
}

fn parse_guardian(accounts: &[AccountInfo<'static>]) -> bool {
    let mut slice: &'static [AccountInfo<'static>] =
        Box::leak(accounts.to_vec().into_boxed_slice());
    GuardianAction::try_accounts(
        &safety_guard::ID,
        &mut slice,
        &[],
        &mut GuardianActionBumps::default(),
        &mut BTreeSet::new(),
    )
    .is_ok()
}

#[test]
fn guardian_constraint_checks_signature_identity_owner_address_and_writability() {
    let (task, address, data) = fixture();
    let wallet_owner = anchor_lang::solana_program::system_program::ID;
    let guardian = account(task.guardian, wallet_owner, true, false, vec![]);
    let stored = account(address, safety_guard::ID, false, true, data.clone());
    assert!(parse_guardian(&[guardian.clone(), stored.clone()]));
    assert!(!parse_guardian(&[
        account(task.guardian, wallet_owner, false, false, vec![]),
        stored.clone()
    ]));
    assert!(!parse_guardian(&[
        account(Pubkey::new_unique(), wallet_owner, true, false, vec![]),
        stored.clone()
    ]));
    assert!(!parse_guardian(&[
        guardian.clone(),
        account(address, wallet_owner, false, true, data.clone())
    ]));
    assert!(!parse_guardian(&[
        guardian.clone(),
        account(
            Pubkey::new_unique(),
            safety_guard::ID,
            false,
            true,
            data.clone()
        )
    ]));
    assert!(!parse_guardian(&[
        guardian,
        account(address, safety_guard::ID, false, false, data)
    ]));
}

#[test]
fn rider_constraint_rejects_guardian_and_unsigned_rider() {
    let (task, address, data) = fixture();
    let wallet_owner = anchor_lang::solana_program::system_program::ID;
    for (key, signed, expected) in [
        (task.rider, true, true),
        (task.rider, false, false),
        (task.guardian, true, false),
    ] {
        let accounts = [
            account(key, wallet_owner, signed, false, vec![]),
            account(address, safety_guard::ID, false, true, data.clone()),
        ];
        let mut slice: &'static [AccountInfo<'static>] = Box::leak(Box::new(accounts));
        let result = RiderAction::try_accounts(
            &safety_guard::ID,
            &mut slice,
            &[],
            &mut RiderActionBumps::default(),
            &mut BTreeSet::new(),
        );
        assert_eq!(result.is_ok(), expected);
    }
}
