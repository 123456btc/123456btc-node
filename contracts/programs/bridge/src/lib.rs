/**
 * Bridge — 123456btc 跨链桥接合约
 *
 * 核心设计：
 * 1. 用户锁定BBT代币到桥接合约（lock_bbt）
 * 2. 中继器提交跨链证明，多签验证后解锁BBT（unlock_bbt）
 * 3. 2/3多签验证机制确保安全性
 * 4. 紧急暂停/恢复功能
 * 5. 可配置的目标链和管理员
 */

use anchor_lang::prelude::*;
use anchor_spl::token::{self, Token, TokenAccount, Transfer};

declare_id!("Brdg1111111111111111111111111111111111111111");

// ── 常量 ──
pub const MAX_SIGNERS: usize = 5;
pub const MIN_THRESHOLD: u8 = 2;
pub const MAX_CHAIN_NAME_LEN: usize = 32;
pub const MAX_ADDRESS_LEN: usize = 128;
pub const MAX_TX_HASH_LEN: usize = 128;
pub const PROPOSAL_EXPIRY: i64 = 3600; // 提案过期时间 1小时

// ── 程序入口 ──
#[program]
pub mod bridge {
    use super::*;

    /// 初始化桥接合约
    pub fn initialize(
        ctx: Context<Initialize>,
        signers: Vec<Pubkey>,
        threshold: u8,
        fee_bps: u64,
    ) -> Result<()> {
        require!(signers.len() <= MAX_SIGNERS, BridgeError::TooManySigners);
        require!(
            threshold >= MIN_THRESHOLD && threshold as usize <= signers.len(),
            BridgeError::InvalidThreshold
        );
        require!(fee_bps <= 10000, BridgeError::InvalidFeeBps);

        let config = &mut ctx.accounts.config;
        let multisig = &mut ctx.accounts.multisig;
        let clock = Clock::get()?;

        // 初始化配置
        config.authority = ctx.accounts.authority.key();
        config.vault = ctx.accounts.vault_token_account.key();
        config.fee_bps = fee_bps;
        config.paused = false;
        config.total_locked = 0;
        config.total_unlocked = 0;
        config.created_at = clock.unix_timestamp;
        config.nonce = 0;

        // 初始化多签
        multisig.signers = signers.clone();
        multisig.threshold = threshold;
        multisig.proposal_count = 0;

        emit!(BridgeInitialized {
            authority: config.authority,
            signers,
            threshold,
            fee_bps,
        });

        Ok(())
    }

    /// 锁定BBT代币到桥接合约
    /// 用户调用此函数将BBT锁定，用于跨链转移到目标链
    pub fn lock_bbt(
        ctx: Context<LockBbt>,
        amount: u64,
        target_chain: String,
        target_address: String,
    ) -> Result<()> {
        require!(amount > 0, BridgeError::ZeroAmount);
        require!(
            target_chain.len() <= MAX_CHAIN_NAME_LEN,
            BridgeError::ChainNameTooLong
        );
        require!(
            target_address.len() <= MAX_ADDRESS_LEN,
            BridgeError::AddressTooLong
        );

        let config = &mut ctx.accounts.config;
        require!(!config.paused, BridgeError::BridgePaused);

        let clock = Clock::get()?;
        config.nonce += 1;

        // 记录跨链交易
        let cross_chain_tx = &mut ctx.accounts.cross_chain_tx;
        cross_chain_tx.user = ctx.accounts.user.key();
        cross_chain_tx.amount = amount;
        cross_chain_tx.target_chain = target_chain.clone();
        cross_chain_tx.target_address = target_address.clone();
        cross_chain_tx.source_chain = "solana".to_string();
        cross_chain_tx.tx_hash = String::new();
        cross_chain_tx.direction = Direction::Outbound;
        cross_chain_tx.status = TxStatus::Pending;
        cross_chain_tx.created_at = clock.unix_timestamp;
        cross_chain_tx.completed_at = 0;
        cross_chain_tx.nonce = config.nonce;

        // 转移BBT到vault
        let cpi_accounts = Transfer {
            from: ctx.accounts.user_token_account.to_account_info(),
            to: ctx.accounts.vault_token_account.to_account_info(),
            authority: ctx.accounts.user.to_account_info(),
        };
        let cpi_program = ctx.accounts.token_program.to_account_info();
        let cpi_ctx = CpiContext::new(cpi_program, cpi_accounts);
        token::transfer(cpi_ctx, amount)?;

        config.total_locked += amount;

        emit!(BbtLocked {
            user: ctx.accounts.user.key(),
            amount,
            target_chain,
            target_address,
            nonce: config.nonce,
            timestamp: clock.unix_timestamp,
        });

        Ok(())
    }

    /// 解锁BBT代币给用户
    /// 中继器提交跨链证明后，通过多签验证解锁BBT
    pub fn unlock_bbt(
        ctx: Context<UnlockBbt>,
        source_chain: String,
        tx_hash: String,
        amount: u64,
    ) -> Result<()> {
        require!(amount > 0, BridgeError::ZeroAmount);
        require!(
            source_chain.len() <= MAX_CHAIN_NAME_LEN,
            BridgeError::ChainNameTooLong
        );
        require!(
            tx_hash.len() <= MAX_TX_HASH_LEN,
            BridgeError::TxHashTooLong
        );

        let config = &mut ctx.accounts.config;
        require!(!config.paused, BridgeError::BridgePaused);

        // 验证多签
        let multisig = &ctx.accounts.multisig;
        let proposal = &ctx.accounts.proposal;

        require!(
            proposal.status == ProposalStatus::Approved,
            BridgeError::ProposalNotApproved
        );
        require!(
            proposal.approvals.len() >= multisig.threshold as usize,
            BridgeError::InsufficientApprovals
        );

        let clock = Clock::get()?;
        config.nonce += 1;

        // 计算手续费
        let fee = amount
            .checked_mul(config.fee_bps)
            .unwrap()
            .checked_div(10000)
            .unwrap();
        let user_amount = amount.checked_sub(fee).unwrap();

        // 记录跨链交易
        let cross_chain_tx = &mut ctx.accounts.cross_chain_tx;
        cross_chain_tx.user = ctx.accounts.user.key();
        cross_chain_tx.amount = amount;
        cross_chain_tx.source_chain = source_chain.clone();
        cross_chain_tx.target_chain = "solana".to_string();
        cross_chain_tx.target_address = ctx.accounts.user.key().to_string();
        cross_chain_tx.tx_hash = tx_hash.clone();
        cross_chain_tx.direction = Direction::Inbound;
        cross_chain_tx.status = TxStatus::Completed;
        cross_chain_tx.created_at = clock.unix_timestamp;
        cross_chain_tx.completed_at = clock.unix_timestamp;
        cross_chain_tx.nonce = config.nonce;

        // 转移BBT给用户
        let seeds = &[
            b"vault".as_ref(),
            &[ctx.bumps.vault_token_account],
        ];
        let signer_seeds = &[&seeds[..]];

        let cpi_accounts = Transfer {
            from: ctx.accounts.vault_token_account.to_account_info(),
            to: ctx.accounts.user_token_account.to_account_info(),
            authority: ctx.accounts.vault_token_account.to_account_info(),
        };
        let cpi_program = ctx.accounts.token_program.to_account_info();
        let cpi_ctx = CpiContext::new_with_signer(
            cpi_program,
            cpi_accounts,
            signer_seeds,
        );
        token::transfer(cpi_ctx, user_amount)?;

        // 如果有手续费，转移到平台账户
        if fee > 0 {
            let fee_accounts = Transfer {
                from: ctx.accounts.vault_token_account.to_account_info(),
                to: ctx.accounts.platform_token_account.to_account_info(),
                authority: ctx.accounts.vault_token_account.to_account_info(),
            };
            let fee_cpi_ctx = CpiContext::new_with_signer(
                ctx.accounts.token_program.to_account_info(),
                fee_accounts,
                signer_seeds,
            );
            token::transfer(fee_cpi_ctx, fee)?;
        }

        config.total_unlocked += user_amount;

        emit!(BbtUnlocked {
            user: ctx.accounts.user.key(),
            amount: user_amount,
            fee,
            source_chain,
            tx_hash,
            nonce: config.nonce,
            timestamp: clock.unix_timestamp,
        });

        Ok(())
    }

    /// 创建多签提案（用于unlock_bbt等操作）
    pub fn create_proposal(
        ctx: Context<CreateProposal>,
        target_chain: String,
        tx_hash: String,
        amount: u64,
        user: Pubkey,
    ) -> Result<()> {
        let multisig = &mut ctx.accounts.multisig;

        // 验证调用者是签名者
        require!(
            multisig.signers.contains(&ctx.accounts.signer.key()),
            BridgeError::NotSigner
        );

        let proposal = &mut ctx.accounts.proposal;
        let clock = Clock::get()?;

        proposal.creator = ctx.accounts.signer.key();
        proposal.target_chain = target_chain;
        proposal.tx_hash = tx_hash;
        proposal.amount = amount;
        proposal.user = user;
        proposal.approvals = vec![ctx.accounts.signer.key()];
        proposal.status = ProposalStatus::Pending;
        proposal.created_at = clock.unix_timestamp;
        proposal.executed = false;

        multisig.proposal_count += 1;

        emit!(ProposalCreated {
            proposal: proposal.key(),
            creator: ctx.accounts.signer.key(),
            amount,
            user,
        });

        Ok(())
    }

    /// 审批多签提案
    pub fn approve_proposal(ctx: Context<ApproveProposal>) -> Result<()> {
        let multisig = &ctx.accounts.multisig;
        let proposal = &mut ctx.accounts.proposal;

        // 验证调用者是签名者
        require!(
            multisig.signers.contains(&ctx.accounts.signer.key()),
            BridgeError::NotSigner
        );
        // 验证提案状态
        require!(
            proposal.status == ProposalStatus::Pending,
            BridgeError::ProposalNotPending
        );
        // 验证未重复审批
        require!(
            !proposal.approvals.contains(&ctx.accounts.signer.key()),
            BridgeError::AlreadyApproved
        );

        let clock = Clock::get()?;

        // 检查提案是否过期
        require!(
            clock.unix_timestamp - proposal.created_at < PROPOSAL_EXPIRY,
            BridgeError::ProposalExpired
        );

        proposal.approvals.push(ctx.accounts.signer.key());

        // 检查是否达到阈值
        if proposal.approvals.len() >= multisig.threshold as usize {
            proposal.status = ProposalStatus::Approved;
        }

        emit!(ProposalApproved {
            proposal: proposal.key(),
            approver: ctx.accounts.signer.key(),
            total_approvals: proposal.approvals.len() as u8,
        });

        Ok(())
    }

    /// 紧急暂停桥接
    pub fn pause_bridge(ctx: Context<PauseBridge>) -> Result<()> {
        let config = &mut ctx.accounts.config;

        require!(
            ctx.accounts.authority.key() == config.authority,
            BridgeError::Unauthorized
        );
        require!(!config.paused, BridgeError::AlreadyPaused);

        config.paused = true;

        emit!(BridgePaused {
            authority: ctx.accounts.authority.key(),
            timestamp: Clock::get()?.unix_timestamp,
        });

        Ok(())
    }

    /// 恢复桥接
    pub fn unpause_bridge(ctx: Context<UnpauseBridge>) -> Result<()> {
        let config = &mut ctx.accounts.config;

        require!(
            ctx.accounts.authority.key() == config.authority,
            BridgeError::Unauthorized
        );
        require!(config.paused, BridgeError::NotPaused);

        config.paused = false;

        emit!(BridgeUnpaused {
            authority: ctx.accounts.authority.key(),
            timestamp: Clock::get()?.unix_timestamp,
        });

        Ok(())
    }

    /// 更新桥接配置
    pub fn update_config(
        ctx: Context<UpdateConfig>,
        new_authority: Option<Pubkey>,
        new_fee_bps: Option<u64>,
        new_signers: Option<Vec<Pubkey>>,
        new_threshold: Option<u8>,
    ) -> Result<()> {
        let config = &mut ctx.accounts.config;
        let multisig = &mut ctx.accounts.multisig;

        require!(
            ctx.accounts.authority.key() == config.authority,
            BridgeError::Unauthorized
        );

        if let Some(authority) = new_authority {
            config.authority = authority;
        }

        if let Some(fee_bps) = new_fee_bps {
            require!(fee_bps <= 10000, BridgeError::InvalidFeeBps);
            config.fee_bps = fee_bps;
        }

        if let Some(signers) = new_signers {
            require!(signers.len() <= MAX_SIGNERS, BridgeError::TooManySigners);
            multisig.signers = signers;
        }

        if let Some(threshold) = new_threshold {
            require!(
                threshold >= MIN_THRESHOLD && threshold as usize <= multisig.signers.len(),
                BridgeError::InvalidThreshold
            );
            multisig.threshold = threshold;
        }

        emit!(ConfigUpdated {
            authority: ctx.accounts.authority.key(),
            timestamp: Clock::get()?.unix_timestamp,
        });

        Ok(())
    }
}

// ── Accounts 结构 ──

#[derive(Accounts)]
pub struct Initialize<'info> {
    #[account(mut)]
    pub authority: Signer<'info>,

    #[account(
        init,
        payer = authority,
        space = 8 + BridgeConfig::INIT_SPACE,
        seeds = [b"config"],
        bump
    )]
    pub config: Account<'info, BridgeConfig>,

    #[account(
        init,
        payer = authority,
        space = 8 + Multisig::INIT_SPACE,
        seeds = [b"multisig"],
        bump
    )]
    pub multisig: Account<'info, Multisig>,

    /// CHECK: Vault token account PDA
    #[account(
        init,
        payer = authority,
        token::mint = bbt_mint,
        token::authority = vault_token_account,
        seeds = [b"vault"],
        bump
    )]
    pub vault_token_account: Account<'info, TokenAccount>,

    /// CHECK: BBT mint
    pub bbt_mint: AccountInfo<'info>,

    pub token_program: Program<'info, Token>,
    pub system_program: Program<'info, System>,
}

#[derive(Accounts)]
#[instruction(amount: u64, target_chain: String, target_address: String)]
pub struct LockBbt<'info> {
    #[account(mut)]
    pub user: Signer<'info>,

    #[account(
        mut,
        seeds = [b"config"],
        bump
    )]
    pub config: Account<'info, BridgeConfig>,

    #[account(
        init,
        payer = user,
        space = 8 + CrossChainTx::INIT_SPACE,
        seeds = [
            b"tx",
            user.key().as_ref(),
            &config.nonce.to_le_bytes()
        ],
        bump
    )]
    pub cross_chain_tx: Account<'info, CrossChainTx>,

    #[account(mut)]
    pub user_token_account: Account<'info, TokenAccount>,

    #[account(
        mut,
        seeds = [b"vault"],
        bump
    )]
    pub vault_token_account: Account<'info, TokenAccount>,

    pub token_program: Program<'info, Token>,
    pub system_program: Program<'info, System>,
}

#[derive(Accounts)]
#[instruction(source_chain: String, tx_hash: String, amount: u64)]
pub struct UnlockBbt<'info> {
    #[account(mut)]
    pub relayer: Signer<'info>,

    #[account(
        mut,
        seeds = [b"config"],
        bump
    )]
    pub config: Account<'info, BridgeConfig>,

    #[account(
        seeds = [b"multisig"],
        bump
    )]
    pub multisig: Account<'info, Multisig>,

    #[account(mut)]
    pub proposal: Account<'info, Proposal>,

    #[account(
        init,
        payer = relayer,
        space = 8 + CrossChainTx::INIT_SPACE,
        seeds = [
            b"tx",
            proposal.user.as_ref(),
            &config.nonce.to_le_bytes()
        ],
        bump
    )]
    pub cross_chain_tx: Account<'info, CrossChainTx>,

    /// CHECK: User receiving tokens
    pub user: AccountInfo<'info>,

    #[account(mut)]
    pub user_token_account: Account<'info, TokenAccount>,

    #[account(
        mut,
        seeds = [b"vault"],
        bump
    )]
    pub vault_token_account: Account<'info, TokenAccount>,

    #[account(mut)]
    pub platform_token_account: Account<'info, TokenAccount>,

    pub token_program: Program<'info, Token>,
    pub system_program: Program<'info, System>,
}

#[derive(Accounts)]
pub struct CreateProposal<'info> {
    #[account(mut)]
    pub signer: Signer<'info>,

    #[account(
        mut,
        seeds = [b"multisig"],
        bump
    )]
    pub multisig: Account<'info, Multisig>,

    #[account(
        init,
        payer = signer,
        space = 8 + Proposal::INIT_SPACE,
        seeds = [
            b"proposal",
            multisig.proposal_count.to_le_bytes().as_ref()
        ],
        bump
    )]
    pub proposal: Account<'info, Proposal>,

    pub system_program: Program<'info, System>,
}

#[derive(Accounts)]
pub struct ApproveProposal<'info> {
    pub signer: Signer<'info>,

    #[account(
        seeds = [b"multisig"],
        bump
    )]
    pub multisig: Account<'info, Multisig>,

    #[account(mut)]
    pub proposal: Account<'info, Proposal>,
}

#[derive(Accounts)]
pub struct PauseBridge<'info> {
    pub authority: Signer<'info>,

    #[account(
        mut,
        seeds = [b"config"],
        bump
    )]
    pub config: Account<'info, BridgeConfig>,
}

#[derive(Accounts)]
pub struct UnpauseBridge<'info> {
    pub authority: Signer<'info>,

    #[account(
        mut,
        seeds = [b"config"],
        bump
    )]
    pub config: Account<'info, BridgeConfig>,
}

#[derive(Accounts)]
pub struct UpdateConfig<'info> {
    pub authority: Signer<'info>,

    #[account(
        mut,
        seeds = [b"config"],
        bump
    )]
    pub config: Account<'info, BridgeConfig>,

    #[account(
        mut,
        seeds = [b"multisig"],
        bump
    )]
    pub multisig: Account<'info, Multisig>,
}

// ── 数据状态 ──

#[account]
#[derive(InitSpace)]
pub struct BridgeConfig {
    pub authority: Pubkey,
    pub vault: Pubkey,
    pub fee_bps: u64,
    pub paused: bool,
    pub total_locked: u64,
    pub total_unlocked: u64,
    pub created_at: i64,
    pub nonce: u64,
}

#[account]
#[derive(InitSpace)]
pub struct Multisig {
    #[max_len(5)]
    pub signers: Vec<Pubkey>,
    pub threshold: u8,
    pub proposal_count: u64,
}

#[account]
#[derive(InitSpace)]
pub struct Proposal {
    pub creator: Pubkey,
    #[max_len(32)]
    pub target_chain: String,
    #[max_len(128)]
    pub tx_hash: String,
    pub amount: u64,
    pub user: Pubkey,
    #[max_len(5)]
    pub approvals: Vec<Pubkey>,
    pub status: ProposalStatus,
    pub created_at: i64,
    pub executed: bool,
}

#[account]
#[derive(InitSpace)]
pub struct CrossChainTx {
    pub user: Pubkey,
    pub amount: u64,
    #[max_len(32)]
    pub source_chain: String,
    #[max_len(32)]
    pub target_chain: String,
    #[max_len(128)]
    pub target_address: String,
    #[max_len(128)]
    pub tx_hash: String,
    pub direction: Direction,
    pub status: TxStatus,
    pub created_at: i64,
    pub completed_at: i64,
    pub nonce: u64,
}

#[derive(AnchorSerialize, AnchorDeserialize, Clone, PartialEq, Eq, InitSpace)]
pub enum Direction {
    Inbound,
    Outbound,
}

#[derive(AnchorSerialize, AnchorDeserialize, Clone, PartialEq, Eq, InitSpace)]
pub enum TxStatus {
    Pending,
    Completed,
    Failed,
}

#[derive(AnchorSerialize, AnchorDeserialize, Clone, PartialEq, Eq, InitSpace)]
pub enum ProposalStatus {
    Pending,
    Approved,
    Rejected,
    Executed,
}

// ── 事件 ──

#[event]
pub struct BridgeInitialized {
    pub authority: Pubkey,
    pub signers: Vec<Pubkey>,
    pub threshold: u8,
    pub fee_bps: u64,
}

#[event]
pub struct BbtLocked {
    pub user: Pubkey,
    pub amount: u64,
    pub target_chain: String,
    pub target_address: String,
    pub nonce: u64,
    pub timestamp: i64,
}

#[event]
pub struct BbtUnlocked {
    pub user: Pubkey,
    pub amount: u64,
    pub fee: u64,
    pub source_chain: String,
    pub tx_hash: String,
    pub nonce: u64,
    pub timestamp: i64,
}

#[event]
pub struct ProposalCreated {
    pub proposal: Pubkey,
    pub creator: Pubkey,
    pub amount: u64,
    pub user: Pubkey,
}

#[event]
pub struct ProposalApproved {
    pub proposal: Pubkey,
    pub approver: Pubkey,
    pub total_approvals: u8,
}

#[event]
pub struct BridgePaused {
    pub authority: Pubkey,
    pub timestamp: i64,
}

#[event]
pub struct BridgeUnpaused {
    pub authority: Pubkey,
    pub timestamp: i64,
}

#[event]
pub struct ConfigUpdated {
    pub authority: Pubkey,
    pub timestamp: i64,
}

// ── 错误码 ──

#[error_code]
pub enum BridgeError {
    #[msg("Amount must be > 0")]
    ZeroAmount,
    #[msg("Bridge is paused")]
    BridgePaused,
    #[msg("Chain name too long")]
    ChainNameTooLong,
    #[msg("Address too long")]
    AddressTooLong,
    #[msg("Transaction hash too long")]
    TxHashTooLong,
    #[msg("Unauthorized")]
    Unauthorized,
    #[msg("Too many signers (max 5)")]
    TooManySigners,
    #[msg("Invalid threshold (min 2, max signers count)")]
    InvalidThreshold,
    #[msg("Invalid fee basis points (max 10000)")]
    InvalidFeeBps,
    #[msg("Not a signer")]
    NotSigner,
    #[msg("Proposal not pending")]
    ProposalNotPending,
    #[msg("Already approved")]
    AlreadyApproved,
    #[msg("Proposal expired")]
    ProposalExpired,
    #[msg("Proposal not approved")]
    ProposalNotApproved,
    #[msg("Insufficient approvals")]
    InsufficientApprovals,
    #[msg("Bridge already paused")]
    AlreadyPaused,
    #[msg("Bridge not paused")]
    NotPaused,
}
