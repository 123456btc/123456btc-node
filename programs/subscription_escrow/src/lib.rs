/**
 * SubscriptionEscrow — 123456btc-node 链上订阅托管合约
 *
 * 核心设计：
 * 1. 用户资金进入合约托管，不直接到 Provider 钱包
 * 2. 按时间窗口释放：Provider 只能claim已到期部分
 * 3. 心跳机制：Provider 必须定期链上交互，证明存活
 * 4. 争议仲裁：用户可举证（链下 Merkle Proof）申请退款
 * 5. 高频信号完全链下，通过 Merkle Root 定期锚定
 */

use anchor_lang::prelude::*;
use anchor_spl::token::{self, Token, TokenAccount, Transfer};

declare_id!("93AJ7GBX9QTRu3KcZbFDxgHJVQqSgDAeUkUZnFjqD3Ka"); // 占位，部署时替换

// ── 常量 ──
pub const HEARTBEAT_INTERVAL: i64 = 3600; // 1小时必须有一次心跳
pub const DISPUTE_WINDOW: i64 = 86400 * 3; // 争议窗口 3天
pub const FEE_BPS: u64 = 500; // 平台抽成 5% (basis points)
pub const MIN_SUBSCRIPTION_SECONDS: i64 = 2; // 最短订阅 2秒 (测试用)

// ── 程序入口 ──
#[program]
pub mod subscription_escrow {
    use super::*;

    // ═══════════════════════════════════════════════════════════
    // 用户侧指令
    // ═══════════════════════════════════════════════════════════

    /// 创建订阅：用户将 BBT 转入合约托管
    pub fn create_subscription(
        ctx: Context<CreateSubscription>,
        strategy_id: String,
        amount: u64,
        duration_seconds: i64,
        nonce: u64,
    ) -> Result<()> {
        let _ = nonce;
        require!(duration_seconds >= MIN_SUBSCRIPTION_SECONDS, ErrorCode::DurationTooShort);
        require!(amount > 0, ErrorCode::ZeroAmount);

        let sub = &mut ctx.accounts.subscription;
        let clock = Clock::get()?;

        sub.user = ctx.accounts.user.key();
        sub.provider = ctx.accounts.provider.key();
        sub.strategy_id = strategy_id;
        sub.amount_deposited = amount;
        sub.amount_claimed = 0;
        sub.start_time = clock.unix_timestamp;
        sub.end_time = clock.unix_timestamp + duration_seconds;
        sub.status = SubscriptionStatus::Active;
        sub.last_heartbeat = clock.unix_timestamp;
        sub.signal_sequence = 0;
        sub.merkle_root = [0u8; 32];
        sub.dispute_reason = String::new();
        sub.dispute_time = 0;

        // 资金从用户 token account 转入合约 vault
        let cpi_accounts = Transfer {
            from: ctx.accounts.user_token_account.to_account_info(),
            to: ctx.accounts.vault_token_account.to_account_info(),
            authority: ctx.accounts.user.to_account_info(),
        };
        let cpi_program = ctx.accounts.token_program.to_account_info();
        let cpi_ctx = CpiContext::new(cpi_program, cpi_accounts);
        token::transfer(cpi_ctx, amount)?;

        emit!(SubscriptionCreated {
            subscription: sub.key(),
            user: sub.user,
            provider: sub.provider,
            strategy_id: sub.strategy_id.clone(),
            amount,
            start_time: sub.start_time,
            end_time: sub.end_time,
        });

        Ok(())
    }

    /// 用户提前取消：按未使用时间比例退款
    pub fn user_cancel(ctx: Context<UserCancel>) -> Result<()> {
        let sub = &mut ctx.accounts.subscription;
        let clock = Clock::get()?;

        require!(sub.status == SubscriptionStatus::Active, ErrorCode::NotActive);
        require!(sub.user == ctx.accounts.user.key(), ErrorCode::Unauthorized);
        require!(clock.unix_timestamp < sub.end_time, ErrorCode::AlreadyExpired);

        let elapsed = clock.unix_timestamp - sub.start_time;
        let total = sub.end_time - sub.start_time;
        let earned = (sub.amount_deposited as i64)
            .checked_mul(elapsed)
            .unwrap()
            .checked_div(total)
            .unwrap() as u64;
        let refund = sub.amount_deposited - earned;

        let vault_seeds = &[b"vault_authority".as_ref(), &[ctx.bumps.vault_authority]];
        let signer_seeds = &[&vault_seeds[..]];

        // 给 Provider 结算已到期部分
        if earned > sub.amount_claimed {
            let to_provider = earned - sub.amount_claimed;
            let cpi_accounts = Transfer {
                from: ctx.accounts.vault_token_account.to_account_info(),
                to: ctx.accounts.provider_token_account.to_account_info(),
                authority: ctx.accounts.vault_authority.to_account_info(),
            };
            let cpi_program = ctx.accounts.token_program.to_account_info();
            let cpi_ctx = CpiContext::new_with_signer(cpi_program, cpi_accounts, signer_seeds);
            token::transfer(cpi_ctx, to_provider)?;
            sub.amount_claimed = earned;
        }

        // 退还给用户
        if refund > 0 {
            let cpi_accounts = Transfer {
                from: ctx.accounts.vault_token_account.to_account_info(),
                to: ctx.accounts.user_token_account.to_account_info(),
                authority: ctx.accounts.vault_authority.to_account_info(),
            };
            let cpi_program = ctx.accounts.token_program.to_account_info();
            let cpi_ctx = CpiContext::new_with_signer(cpi_program, cpi_accounts, signer_seeds);
            token::transfer(cpi_ctx, refund)?;
        }

        sub.status = SubscriptionStatus::Cancelled;

        emit!(SubscriptionCancelled {
            subscription: sub.key(),
            refund,
            earned,
        });

        Ok(())
    }

    /// 用户发起争议：冻结剩余资金
    pub fn initiate_dispute(ctx: Context<InitiateDispute>, reason: String) -> Result<()> {
        let sub = &mut ctx.accounts.subscription;
        let clock = Clock::get()?;

        require!(sub.status == SubscriptionStatus::Active, ErrorCode::NotActive);
        require!(sub.user == ctx.accounts.user.key(), ErrorCode::Unauthorized);
        require!(
            clock.unix_timestamp < sub.end_time + DISPUTE_WINDOW,
            ErrorCode::DisputeWindowClosed
        );

        sub.status = SubscriptionStatus::Disputed;
        sub.dispute_reason = reason.clone();
        sub.dispute_time = clock.unix_timestamp;

        emit!(DisputeInitiated {
            subscription: sub.key(),
            user: sub.user,
            reason,
        });

        Ok(())
    }

    // ═══════════════════════════════════════════════════════════
    // Provider 侧指令
    // ═══════════════════════════════════════════════════════════

    /// Provider 提取已到期费用（按时间比例）
    pub fn provider_claim(ctx: Context<ProviderClaim>) -> Result<()> {
        let sub = &mut ctx.accounts.subscription;
        let clock = Clock::get()?;

        require!(sub.provider == ctx.accounts.provider.key(), ErrorCode::Unauthorized);
        require!(
            sub.status == SubscriptionStatus::Active || sub.status == SubscriptionStatus::Settled,
            ErrorCode::NotClaimable
        );

        let elapsed = clock.unix_timestamp.min(sub.end_time) - sub.start_time;
        let total = sub.end_time - sub.start_time;
        let earned = (sub.amount_deposited as i64)
            .checked_mul(elapsed)
            .unwrap()
            .checked_div(total)
            .unwrap() as u64;

        let claimable = earned.saturating_sub(sub.amount_claimed);
        require!(claimable > 0, ErrorCode::NothingToClaim);

        // 扣除平台费
        let fee = claimable * FEE_BPS / 10000;
        let to_provider = claimable - fee;

        let vault_seeds = &[b"vault_authority".as_ref(), &[ctx.bumps.vault_authority]];
        let signer_seeds = &[&vault_seeds[..]];

        if to_provider > 0 {
            let cpi_accounts = Transfer {
                from: ctx.accounts.vault_token_account.to_account_info(),
                to: ctx.accounts.provider_token_account.to_account_info(),
                authority: ctx.accounts.vault_authority.to_account_info(),
            };
            let cpi_program = ctx.accounts.token_program.to_account_info();
            let cpi_ctx = CpiContext::new_with_signer(cpi_program, cpi_accounts, signer_seeds);
            token::transfer(cpi_ctx, to_provider)?;
        }

        if fee > 0 {
            let cpi_accounts = Transfer {
                from: ctx.accounts.vault_token_account.to_account_info(),
                to: ctx.accounts.platform_token_account.to_account_info(),
                authority: ctx.accounts.vault_authority.to_account_info(),
            };
            let cpi_program = ctx.accounts.token_program.to_account_info();
            let cpi_ctx = CpiContext::new_with_signer(cpi_program, cpi_accounts, signer_seeds);
            token::transfer(cpi_ctx, fee)?;
        }

        sub.amount_claimed += claimable;

        // 如果到期且全部 claim，自动标记 Settled
        if clock.unix_timestamp >= sub.end_time && sub.amount_claimed >= sub.amount_deposited {
            sub.status = SubscriptionStatus::Settled;
        }

        emit!(ProviderClaimed {
            subscription: sub.key(),
            provider: sub.provider,
            amount: to_provider,
            fee,
        });

        Ok(())
    }

    /// Provider 心跳：证明服务在线
    pub fn submit_heartbeat(ctx: Context<SubmitHeartbeat>) -> Result<()> {
        let sub = &mut ctx.accounts.subscription;
        let clock = Clock::get()?;

        require!(sub.provider == ctx.accounts.provider.key(), ErrorCode::Unauthorized);
        require!(sub.status == SubscriptionStatus::Active, ErrorCode::NotActive);

        sub.last_heartbeat = clock.unix_timestamp;

        emit!(HeartbeatSubmitted {
            subscription: sub.key(),
            provider: sub.provider,
            timestamp: clock.unix_timestamp,
        });

        Ok(())
    }

    /// Provider 提交信号 Merkle Root（服务证明）
    pub fn submit_signal_merkle(
        ctx: Context<SubmitSignalMerkle>,
        merkle_root: [u8; 32],
        sequence: u64,
    ) -> Result<()> {
        let sub = &mut ctx.accounts.subscription;

        require!(sub.provider == ctx.accounts.provider.key(), ErrorCode::Unauthorized);
        require!(sub.status == SubscriptionStatus::Active, ErrorCode::NotActive);
        require!(sequence > sub.signal_sequence, ErrorCode::InvalidSequence);

        sub.merkle_root = merkle_root;
        sub.signal_sequence = sequence;

        emit!(SignalMerkleSubmitted {
            subscription: sub.key(),
            merkle_root,
            sequence,
        });

        Ok(())
    }

    // ═══════════════════════════════════════════════════════════
    // 仲裁侧指令
    // ═══════════════════════════════════════════════════════════

    /// 仲裁者解决争议（平台治理/DAO 多重签名）
    pub fn resolve_dispute(
        ctx: Context<ResolveDispute>,
        refund_bps: u16, // 退款比例，单位：万分之（10000 = 全退）
    ) -> Result<()> {
        let sub = &mut ctx.accounts.subscription;

        require!(sub.status == SubscriptionStatus::Disputed, ErrorCode::NotDisputed);
        require!(refund_bps <= 10000, ErrorCode::InvalidRefundBps);

        let remaining = sub.amount_deposited - sub.amount_claimed;
        let refund = (remaining as u128)
            .checked_mul(refund_bps as u128)
            .unwrap()
            .checked_div(10000)
            .unwrap() as u64;
        let to_provider = remaining - refund;

        let vault_seeds = &[b"vault_authority".as_ref(), &[ctx.bumps.vault_authority]];
        let signer_seeds = &[&vault_seeds[..]];

        if refund > 0 {
            let cpi_accounts = Transfer {
                from: ctx.accounts.vault_token_account.to_account_info(),
                to: ctx.accounts.user_token_account.to_account_info(),
                authority: ctx.accounts.vault_authority.to_account_info(),
            };
            let cpi_program = ctx.accounts.token_program.to_account_info();
            let cpi_ctx = CpiContext::new_with_signer(cpi_program, cpi_accounts, signer_seeds);
            token::transfer(cpi_ctx, refund)?;
        }
        if to_provider > 0 {
            let cpi_accounts = Transfer {
                from: ctx.accounts.vault_token_account.to_account_info(),
                to: ctx.accounts.provider_token_account.to_account_info(),
                authority: ctx.accounts.vault_authority.to_account_info(),
            };
            let cpi_program = ctx.accounts.token_program.to_account_info();
            let cpi_ctx = CpiContext::new_with_signer(cpi_program, cpi_accounts, signer_seeds);
            token::transfer(cpi_ctx, to_provider)?;
        }

        sub.status = SubscriptionStatus::Settled;

        emit!(DisputeResolved {
            subscription: sub.key(),
            refund,
            to_provider,
            refund_bps,
        });

        Ok(())
    }

    /// 到期自动结算（任何人可调用，清理过期订阅）
    pub fn auto_settle(ctx: Context<AutoSettle>) -> Result<()> {
        let sub = &mut ctx.accounts.subscription;
        let clock = Clock::get()?;

        require!(clock.unix_timestamp >= sub.end_time, ErrorCode::NotExpired);
        require!(
            sub.status == SubscriptionStatus::Active || sub.status == SubscriptionStatus::Disputed,
            ErrorCode::AlreadySettled
        );

        // 如果争议未在窗口期内解决，默认 Provider 赢（激励 Provider 保持心跳）
        if sub.status == SubscriptionStatus::Disputed {
            let dispute_deadline = sub.dispute_time + DISPUTE_WINDOW;
            require!(clock.unix_timestamp > dispute_deadline, ErrorCode::DisputePending);
        }

        let remaining = sub.amount_deposited - sub.amount_claimed;
        if remaining > 0 {
            let fee = remaining * FEE_BPS / 10000;
            let to_provider = remaining - fee;

            let vault_seeds = &[b"vault_authority".as_ref(), &[ctx.bumps.vault_authority]];
            let signer_seeds = &[&vault_seeds[..]];

            if to_provider > 0 {
                let cpi_accounts = Transfer {
                    from: ctx.accounts.vault_token_account.to_account_info(),
                    to: ctx.accounts.provider_token_account.to_account_info(),
                    authority: ctx.accounts.vault_authority.to_account_info(),
                };
                let cpi_program = ctx.accounts.token_program.to_account_info();
                let cpi_ctx = CpiContext::new_with_signer(cpi_program, cpi_accounts, signer_seeds);
                token::transfer(cpi_ctx, to_provider)?;
            }

            if fee > 0 {
                let cpi_accounts = Transfer {
                    from: ctx.accounts.vault_token_account.to_account_info(),
                    to: ctx.accounts.platform_token_account.to_account_info(),
                    authority: ctx.accounts.vault_authority.to_account_info(),
                };
                let cpi_program = ctx.accounts.token_program.to_account_info();
                let cpi_ctx = CpiContext::new_with_signer(cpi_program, cpi_accounts, signer_seeds);
                token::transfer(cpi_ctx, fee)?;
            }

            sub.amount_claimed = sub.amount_deposited;
        }

        sub.status = SubscriptionStatus::Settled;

        emit!(SubscriptionSettled {
            subscription: sub.key(),
            provider: sub.provider,
            final_amount: sub.amount_claimed,
        });

        Ok(())
    }
}

// ── Accounts 结构 ──

#[derive(Accounts)]
#[instruction(strategy_id: String, amount: u64, duration_seconds: i64, nonce: u64)]
pub struct CreateSubscription<'info> {
    #[account(mut)]
    pub user: Signer<'info>,
    /// CHECK: Provider 地址，仅作为订阅目标
    pub provider: AccountInfo<'info>,
    #[account(
        init,
        payer = user,
        space = 8 + Subscription::SIZE,
        seeds = [b"subscription", user.key().as_ref(), strategy_id.as_bytes().as_ref(), &nonce.to_le_bytes()],
        bump
    )]
    pub subscription: Account<'info, Subscription>,
    #[account(mut)]
    pub user_token_account: Account<'info, TokenAccount>,
    #[account(mut)]
    pub vault_token_account: Account<'info, TokenAccount>,
    #[account(
        seeds = [b"vault_authority"],
        bump,
    )]
    pub vault_authority: AccountInfo<'info>,
    pub token_program: Program<'info, Token>,
    pub system_program: Program<'info, System>,
    /// CHECK: 策略 ID account（ instruction 参数通过 #[instruction] 传入）
    pub strategy_id_info: AccountInfo<'info>,
}

#[derive(Accounts)]
pub struct UserCancel<'info> {
    #[account(mut)]
    pub user: Signer<'info>,
    #[account(mut, has_one = user)]
    pub subscription: Account<'info, Subscription>,
    #[account(mut)]
    pub vault_token_account: Account<'info, TokenAccount>,
    #[account(mut)]
    pub user_token_account: Account<'info, TokenAccount>,
    #[account(mut)]
    pub provider_token_account: Account<'info, TokenAccount>,
    #[account(
        seeds = [b"vault_authority"],
        bump,
    )]
    pub vault_authority: AccountInfo<'info>,
    pub token_program: Program<'info, Token>,
}

#[derive(Accounts)]
pub struct InitiateDispute<'info> {
    #[account(mut)]
    pub user: Signer<'info>,
    #[account(mut, has_one = user)]
    pub subscription: Account<'info, Subscription>,
}

#[derive(Accounts)]
pub struct ProviderClaim<'info> {
    #[account(mut)]
    pub provider: Signer<'info>,
    #[account(mut, has_one = provider)]
    pub subscription: Account<'info, Subscription>,
    #[account(mut)]
    pub vault_token_account: Account<'info, TokenAccount>,
    #[account(mut)]
    pub provider_token_account: Account<'info, TokenAccount>,
    #[account(mut)]
    pub platform_token_account: Account<'info, TokenAccount>,
    #[account(
        seeds = [b"vault_authority"],
        bump,
    )]
    pub vault_authority: AccountInfo<'info>,
    pub token_program: Program<'info, Token>,
}

#[derive(Accounts)]
pub struct SubmitHeartbeat<'info> {
    #[account(mut)]
    pub provider: Signer<'info>,
    #[account(mut, has_one = provider)]
    pub subscription: Account<'info, Subscription>,
}

#[derive(Accounts)]
pub struct SubmitSignalMerkle<'info> {
    #[account(mut)]
    pub provider: Signer<'info>,
    #[account(mut, has_one = provider)]
    pub subscription: Account<'info, Subscription>,
}

#[derive(Accounts)]
pub struct ResolveDispute<'info> {
    #[account(mut)]
    pub arbitrator: Signer<'info>,
    #[account(
        mut,
        constraint = subscription.status == SubscriptionStatus::Disputed
    )]
    pub subscription: Account<'info, Subscription>,
    #[account(mut)]
    pub vault_token_account: Account<'info, TokenAccount>,
    #[account(mut)]
    pub user_token_account: Account<'info, TokenAccount>,
    #[account(mut)]
    pub provider_token_account: Account<'info, TokenAccount>,
    #[account(
        seeds = [b"vault_authority"],
        bump,
    )]
    pub vault_authority: AccountInfo<'info>,
    pub token_program: Program<'info, Token>,
}

#[derive(Accounts)]
pub struct AutoSettle<'info> {
    /// CHECK: 任何人可调用
    pub caller: AccountInfo<'info>,
    #[account(mut)]
    pub subscription: Account<'info, Subscription>,
    #[account(mut)]
    pub vault_token_account: Account<'info, TokenAccount>,
    #[account(mut)]
    pub provider_token_account: Account<'info, TokenAccount>,
    #[account(mut)]
    pub platform_token_account: Account<'info, TokenAccount>,
    #[account(
        seeds = [b"vault_authority"],
        bump,
    )]
    pub vault_authority: AccountInfo<'info>,
    pub token_program: Program<'info, Token>,
}

// ── 数据状态 ──

#[account]
pub struct Subscription {
    pub user: Pubkey,
    pub provider: Pubkey,
    pub strategy_id: String,
    pub amount_deposited: u64,
    pub amount_claimed: u64,
    pub start_time: i64,
    pub end_time: i64,
    pub status: SubscriptionStatus,
    pub last_heartbeat: i64,
    pub signal_sequence: u64,
    pub merkle_root: [u8; 32],
    pub dispute_reason: String,
    pub dispute_time: i64,
}

impl Subscription {
    // 估算空间：约 500 bytes
    pub const SIZE: usize = 32 + 32 + (4 + 64) + 8 + 8 + 8 + 8 + 1 + 8 + 8 + 32 + (4 + 256) + 8;
}

#[derive(AnchorSerialize, AnchorDeserialize, Clone, PartialEq, Eq)]
pub enum SubscriptionStatus {
    Active,
    Cancelled,
    Disputed,
    Settled,
}

// ── 事件 ──

#[event]
pub struct SubscriptionCreated {
    pub subscription: Pubkey,
    pub user: Pubkey,
    pub provider: Pubkey,
    pub strategy_id: String,
    pub amount: u64,
    pub start_time: i64,
    pub end_time: i64,
}

#[event]
pub struct SubscriptionCancelled {
    pub subscription: Pubkey,
    pub refund: u64,
    pub earned: u64,
}

#[event]
pub struct ProviderClaimed {
    pub subscription: Pubkey,
    pub provider: Pubkey,
    pub amount: u64,
    pub fee: u64,
}

#[event]
pub struct HeartbeatSubmitted {
    pub subscription: Pubkey,
    pub provider: Pubkey,
    pub timestamp: i64,
}

#[event]
pub struct SignalMerkleSubmitted {
    pub subscription: Pubkey,
    pub merkle_root: [u8; 32],
    pub sequence: u64,
}

#[event]
pub struct DisputeInitiated {
    pub subscription: Pubkey,
    pub user: Pubkey,
    pub reason: String,
}

#[event]
pub struct DisputeResolved {
    pub subscription: Pubkey,
    pub refund: u64,
    pub to_provider: u64,
    pub refund_bps: u16,
}

#[event]
pub struct SubscriptionSettled {
    pub subscription: Pubkey,
    pub provider: Pubkey,
    pub final_amount: u64,
}

// ── 错误码 ──

#[error_code]
pub enum ErrorCode {
    #[msg("Duration too short")]
    DurationTooShort,
    #[msg("Amount must be > 0")]
    ZeroAmount,
    #[msg("Subscription not active")]
    NotActive,
    #[msg("Unauthorized")]
    Unauthorized,
    #[msg("Subscription already expired")]
    AlreadyExpired,
    #[msg("Dispute window closed")]
    DisputeWindowClosed,
    #[msg("Not claimable")]
    NotClaimable,
    #[msg("Nothing to claim")]
    NothingToClaim,
    #[msg("Not disputed")]
    NotDisputed,
    #[msg("Invalid refund basis points")]
    InvalidRefundBps,
    #[msg("Invalid sequence")]
    InvalidSequence,
    #[msg("Not expired")]
    NotExpired,
    #[msg("Already settled")]
    AlreadySettled,
    #[msg("Dispute still pending")]
    DisputePending,
}
