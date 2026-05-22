/**
 * BlindBox Escrow — 123456btc 盲盒托管合约
 *
 * 核心设计：
 * 1. 用户创建盲盒并锁定BBT代币
 * 2. 盲盒可以被购买者打开（reveal）
 * 3. 支持争议仲裁机制
 * 4. 平台收取手续费
 */

use anchor_lang::prelude::*;
use anchor_spl::token::{self, Mint, Token, TokenAccount, Transfer};

declare_id!("BX2fkBCPkkx8ogWUPPLw1rX1irX1SJP6hxx92Yxu1vTh");

// ── 常量 ──
pub const FEE_BPS: u64 = 500; // 平台抽成 5%
pub const MAX_BLINDBOX_NAME_LEN: usize = 64;
pub const MAX_BLINDBOX_DESC_LEN: usize = 256;
pub const DISPUTE_WINDOW: i64 = 86400 * 3; // 争议窗口 3天

// ── 程序入口 ──
#[program]
pub mod blindbox_escrow {
    use super::*;

    /// 创建盲盒：用户将BBT转入合约托管
    pub fn create_blindbox(
        ctx: Context<CreateBlindBox>,
        name: String,
        description: String,
        amount: u64,
        rarity: Rarity,
    ) -> Result<()> {
        require!(amount > 0, BlindBoxError::ZeroAmount);
        require!(name.len() <= MAX_BLINDBOX_NAME_LEN, BlindBoxError::NameTooLong);
        require!(description.len() <= MAX_BLINDBOX_DESC_LEN, BlindBoxError::DescriptionTooLong);

        let blindbox = &mut ctx.accounts.blindbox;
        let clock = Clock::get()?;

        blindbox.creator = ctx.accounts.creator.key();
        blindbox.name = name;
        blindbox.description = description;
        blindbox.amount = amount;
        blindbox.rarity = rarity;
        blindbox.status = BlindBoxStatus::Locked;
        blindbox.created_at = clock.unix_timestamp;
        blindbox.revealed_at = 0;
        blindbox.buyer = None;
        blindbox.dispute_reason = String::new();
        blindbox.dispute_time = 0;

        // 资金从创建者转入合约vault
        let cpi_accounts = Transfer {
            from: ctx.accounts.creator_token_account.to_account_info(),
            to: ctx.accounts.vault_token_account.to_account_info(),
            authority: ctx.accounts.creator.to_account_info(),
        };
        let cpi_program = ctx.accounts.token_program.to_account_info();
        let cpi_ctx = CpiContext::new(cpi_program, cpi_accounts);
        token::transfer(cpi_ctx, amount)?;

        emit!(BlindBoxCreated {
            blindbox: blindbox.key(),
            creator: blindbox.creator,
            name: blindbox.name.clone(),
            amount,
            rarity: blindbox.rarity.clone(),
        });

        Ok(())
    }

    /// 购买盲盒：买家支付BBT，获得盲盒所有权
    pub fn purchase_blindbox(ctx: Context<PurchaseBlindBox>) -> Result<()> {
        let blindbox = &mut ctx.accounts.blindbox;

        require!(blindbox.status == BlindBoxStatus::Locked, BlindBoxError::NotAvailable);
        require!(blindbox.creator != ctx.accounts.buyer.key(), BlindBoxError::CannotBuyOwnBox);

        let clock = Clock::get()?;

        blindbox.buyer = Some(ctx.accounts.buyer.key());
        blindbox.status = BlindBoxStatus::Purchased;
        blindbox.purchased_at = Some(clock.unix_timestamp);

        emit!(BlindBoxPurchased {
            blindbox: blindbox.key(),
            buyer: ctx.accounts.buyer.key(),
            amount: blindbox.amount,
        });

        Ok(())
    }

    /// 打开盲盒：买家揭示盲盒内容
    pub fn reveal_blindbox(ctx: Context<RevealBlindBox>) -> Result<()> {
        let blindbox = &mut ctx.accounts.blindbox;

        require!(blindbox.status == BlindBoxStatus::Purchased, BlindBoxError::NotPurchased);
        require!(
            blindbox.buyer == Some(ctx.accounts.buyer.key()),
            BlindBoxError::Unauthorized
        );

        let clock = Clock::get()?;

        blindbox.status = BlindBoxStatus::Revealed;
        blindbox.revealed_at = clock.unix_timestamp;

        // 计算费用并分配
        let fee = blindbox.amount * FEE_BPS / 10000;
        let to_creator = blindbox.amount - fee;

        let seeds = &[
            b"blindbox_vault".as_ref(),
            blindbox.creator.as_ref(),
            &[ctx.bumps.vault_token_account],
        ];
        let signer_seeds = &[&seeds[..]];

        // 转给创建者
        let cpi_accounts_creator = Transfer {
            from: ctx.accounts.vault_token_account.to_account_info(),
            to: ctx.accounts.creator_token_account.to_account_info(),
            authority: ctx.accounts.vault_token_account.to_account_info(),
        };
        let cpi_ctx_creator = CpiContext::new_with_signer(
            ctx.accounts.token_program.to_account_info(),
            cpi_accounts_creator,
            signer_seeds,
        );
        token::transfer(cpi_ctx_creator, to_creator)?;

        // 转平台费
        let cpi_accounts_fee = Transfer {
            from: ctx.accounts.vault_token_account.to_account_info(),
            to: ctx.accounts.platform_token_account.to_account_info(),
            authority: ctx.accounts.vault_token_account.to_account_info(),
        };
        let cpi_ctx_fee = CpiContext::new_with_signer(
            ctx.accounts.token_program.to_account_info(),
            cpi_accounts_fee,
            signer_seeds,
        );
        token::transfer(cpi_ctx_fee, fee)?;

        emit!(BlindBoxRevealed {
            blindbox: blindbox.key(),
            buyer: ctx.accounts.buyer.key(),
            creator: blindbox.creator,
            amount: blindbox.amount,
            fee,
        });

        Ok(())
    }

    /// 发起争议
    pub fn initiate_dispute(ctx: Context<InitiateDispute>, reason: String) -> Result<()> {
        let blindbox = &mut ctx.accounts.blindbox;
        let clock = Clock::get()?;

        require!(
            blindbox.status == BlindBoxStatus::Purchased || blindbox.status == BlindBoxStatus::Revealed,
            BlindBoxError::NotDisputable
        );
        require!(
            blindbox.buyer == Some(ctx.accounts.buyer.key()),
            BlindBoxError::Unauthorized
        );

        blindbox.status = BlindBoxStatus::Disputed;
        blindbox.dispute_reason = reason.clone();
        blindbox.dispute_time = clock.unix_timestamp;

        emit!(DisputeInitiated {
            blindbox: blindbox.key(),
            buyer: ctx.accounts.buyer.key(),
            reason,
        });

        Ok(())
    }

    /// 解决争议（仲裁者）
    pub fn resolve_dispute(
        ctx: Context<ResolveDispute>,
        refund_bps: u16,
    ) -> Result<()> {
        let blindbox = &mut ctx.accounts.blindbox;

        require!(blindbox.status == BlindBoxStatus::Disputed, BlindBoxError::NotDisputed);
        require!(refund_bps <= 10000, BlindBoxError::InvalidRefundBps);

        let refund = (blindbox.amount as u128)
            .checked_mul(refund_bps as u128)
            .unwrap()
            .checked_div(10000)
            .unwrap() as u64;
        let to_creator = blindbox.amount - refund;

        let seeds = &[
            b"blindbox_vault".as_ref(),
            blindbox.creator.as_ref(),
            &[ctx.bumps.vault_token_account],
        ];
        let signer_seeds = &[&seeds[..]];

        if refund > 0 {
            if let Some(buyer_account) = &ctx.accounts.buyer_token_account {
                let cpi_accounts = Transfer {
                    from: ctx.accounts.vault_token_account.to_account_info(),
                    to: buyer_account.to_account_info(),
                    authority: ctx.accounts.vault_token_account.to_account_info(),
                };
                let cpi_ctx = CpiContext::new_with_signer(
                    ctx.accounts.token_program.to_account_info(),
                    cpi_accounts,
                    signer_seeds,
                );
                token::transfer(cpi_ctx, refund)?;
            }
        }
        if to_creator > 0 {
            let cpi_accounts = Transfer {
                from: ctx.accounts.vault_token_account.to_account_info(),
                to: ctx.accounts.creator_token_account.to_account_info(),
                authority: ctx.accounts.vault_token_account.to_account_info(),
            };
            let cpi_ctx = CpiContext::new_with_signer(
                ctx.accounts.token_program.to_account_info(),
                cpi_accounts,
                signer_seeds,
            );
            token::transfer(cpi_ctx, to_creator)?;
        }

        blindbox.status = BlindBoxStatus::Settled;

        emit!(DisputeResolved {
            blindbox: blindbox.key(),
            refund,
            to_creator,
            refund_bps,
        });

        Ok(())
    }
}

// ── Accounts 结构 ──

#[derive(Accounts)]
#[instruction(name: String, description: String)]
pub struct CreateBlindBox<'info> {
    #[account(mut)]
    pub creator: Signer<'info>,

    #[account(
        init,
        payer = creator,
        space = 8 + BlindBox::INIT_SPACE,
        seeds = [b"blindbox", creator.key().as_ref(), name.as_bytes()],
        bump
    )]
    pub blindbox: Account<'info, BlindBox>,

    #[account(mut)]
    pub creator_token_account: Account<'info, TokenAccount>,

    #[account(
        init_if_needed,
        payer = creator,
        seeds = [b"blindbox_vault", creator.key().as_ref()],
        bump,
        token::mint = bbt_mint,
        token::authority = vault_token_account,
    )]
    pub vault_token_account: Account<'info, TokenAccount>,

    pub bbt_mint: Account<'info, Mint>,

    pub token_program: Program<'info, Token>,
    pub system_program: Program<'info, System>,
}

#[derive(Accounts)]
pub struct PurchaseBlindBox<'info> {
    #[account(mut)]
    pub buyer: Signer<'info>,

    #[account(mut)]
    pub blindbox: Account<'info, BlindBox>,
}

#[derive(Accounts)]
pub struct RevealBlindBox<'info> {
    #[account(mut)]
    pub buyer: Signer<'info>,

    #[account(mut)]
    pub blindbox: Account<'info, BlindBox>,

    #[account(
        mut,
        seeds = [b"blindbox_vault", blindbox.creator.as_ref()],
        bump,
    )]
    pub vault_token_account: Account<'info, TokenAccount>,

    #[account(mut)]
    pub creator_token_account: Account<'info, TokenAccount>,

    #[account(mut)]
    pub platform_token_account: Account<'info, TokenAccount>,

    pub token_program: Program<'info, Token>,
}

#[derive(Accounts)]
pub struct InitiateDispute<'info> {
    #[account(mut)]
    pub buyer: Signer<'info>,

    #[account(mut)]
    pub blindbox: Account<'info, BlindBox>,
}

#[derive(Accounts)]
pub struct ResolveDispute<'info> {
    #[account(mut)]
    pub arbitrator: Signer<'info>,

    #[account(mut)]
    pub blindbox: Account<'info, BlindBox>,

    #[account(
        mut,
        seeds = [b"blindbox_vault", blindbox.creator.as_ref()],
        bump,
    )]
    pub vault_token_account: Account<'info, TokenAccount>,

    #[account(mut)]
    pub creator_token_account: Account<'info, TokenAccount>,

    /// CHECK: 买家token账户（可选）
    #[account(mut)]
    pub buyer_token_account: Option<Account<'info, TokenAccount>>,

    pub token_program: Program<'info, Token>,
}

// ── 数据状态 ──

#[account]
#[derive(InitSpace)]
pub struct BlindBox {
    pub creator: Pubkey,
    #[max_len(64)]
    pub name: String,
    #[max_len(256)]
    pub description: String,
    pub amount: u64,
    pub rarity: Rarity,
    pub status: BlindBoxStatus,
    pub created_at: i64,
    pub revealed_at: i64,
    pub buyer: Option<Pubkey>,
    pub purchased_at: Option<i64>,
    #[max_len(256)]
    pub dispute_reason: String,
    pub dispute_time: i64,
}

#[derive(AnchorSerialize, AnchorDeserialize, Clone, PartialEq, Eq, InitSpace)]
pub enum Rarity {
    Common,
    Uncommon,
    Rare,
    Epic,
    Legendary,
}

#[derive(AnchorSerialize, AnchorDeserialize, Clone, PartialEq, Eq, InitSpace)]
pub enum BlindBoxStatus {
    Locked,
    Purchased,
    Revealed,
    Disputed,
    Settled,
}

// ── 事件 ──

#[event]
pub struct BlindBoxCreated {
    pub blindbox: Pubkey,
    pub creator: Pubkey,
    pub name: String,
    pub amount: u64,
    pub rarity: Rarity,
}

#[event]
pub struct BlindBoxPurchased {
    pub blindbox: Pubkey,
    pub buyer: Pubkey,
    pub amount: u64,
}

#[event]
pub struct BlindBoxRevealed {
    pub blindbox: Pubkey,
    pub buyer: Pubkey,
    pub creator: Pubkey,
    pub amount: u64,
    pub fee: u64,
}

#[event]
pub struct DisputeInitiated {
    pub blindbox: Pubkey,
    pub buyer: Pubkey,
    pub reason: String,
}

#[event]
pub struct DisputeResolved {
    pub blindbox: Pubkey,
    pub refund: u64,
    pub to_creator: u64,
    pub refund_bps: u16,
}

// ── 错误码 ──

#[error_code]
pub enum BlindBoxError {
    #[msg("Amount must be > 0")]
    ZeroAmount,
    #[msg("Name too long")]
    NameTooLong,
    #[msg("Description too long")]
    DescriptionTooLong,
    #[msg("BlindBox not available")]
    NotAvailable,
    #[msg("Cannot buy your own blindbox")]
    CannotBuyOwnBox,
    #[msg("BlindBox not purchased")]
    NotPurchased,
    #[msg("Unauthorized")]
    Unauthorized,
    #[msg("BlindBox not disputable")]
    NotDisputable,
    #[msg("BlindBox not disputed")]
    NotDisputed,
    #[msg("Invalid refund basis points")]
    InvalidRefundBps,
}
