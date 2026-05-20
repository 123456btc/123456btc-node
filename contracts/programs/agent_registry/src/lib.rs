/**
 * Agent Registry — 123456btc Agent ID注册合约
 *
 * 核心设计：
 * 1. Agent注册自己的链上身份
 * 2. 支持Agent验证和声誉系统
 * 3. 支持Agent状态管理（活跃/暂停/封禁）
 * 4. 支持Agent元数据存储
 */

use anchor_lang::prelude::*;

declare_id!("zw4fVpJ77LoFh2T4CEzeRwUkPcnA4WyeHoRznVmHkSS");

// ── 常量 ──
pub const MAX_AGENT_NAME_LEN: usize = 64;
pub const MAX_AGENT_DESC_LEN: usize = 256;
pub const MAX_ENDPOINT_LEN: usize = 128;
pub const MAX_CAPABILITIES_LEN: usize = 10;

// ── 程序入口 ──
#[program]
pub mod agent_registry {
    use super::*;

    /// 注册新Agent
    pub fn register_agent(
        ctx: Context<RegisterAgent>,
        name: String,
        description: String,
        endpoint: String,
        capabilities: Vec<String>,
    ) -> Result<()> {
        require!(name.len() <= MAX_AGENT_NAME_LEN, AgentError::NameTooLong);
        require!(description.len() <= MAX_AGENT_DESC_LEN, AgentError::DescriptionTooLong);
        require!(endpoint.len() <= MAX_ENDPOINT_LEN, AgentError::EndpointTooLong);
        require!(capabilities.len() <= MAX_CAPABILITIES_LEN, AgentError::TooManyCapabilities);

        let agent = &mut ctx.accounts.agent;
        let clock = Clock::get()?;

        agent.owner = ctx.accounts.owner.key();
        agent.name = name;
        agent.description = description;
        agent.endpoint = endpoint;
        agent.capabilities = capabilities;
        agent.status = AgentStatus::Active;
        agent.reputation_score = 0;
        agent.total_tasks = 0;
        agent.successful_tasks = 0;
        agent.registered_at = clock.unix_timestamp;
        agent.last_active_at = clock.unix_timestamp;
        agent.verification_level = VerificationLevel::Unverified;

        emit!(AgentRegistered {
            agent: agent.key(),
            owner: agent.owner,
            name: agent.name.clone(),
        });

        Ok(())
    }

    /// 更新Agent信息
    pub fn update_agent(
        ctx: Context<UpdateAgent>,
        name: Option<String>,
        description: Option<String>,
        endpoint: Option<String>,
        capabilities: Option<Vec<String>>,
    ) -> Result<()> {
        let agent = &mut ctx.accounts.agent;

        require!(agent.owner == ctx.accounts.owner.key(), AgentError::Unauthorized);

        if let Some(new_name) = name {
            require!(new_name.len() <= MAX_AGENT_NAME_LEN, AgentError::NameTooLong);
            agent.name = new_name;
        }
        if let Some(new_desc) = description {
            require!(new_desc.len() <= MAX_AGENT_DESC_LEN, AgentError::DescriptionTooLong);
            agent.description = new_desc;
        }
        if let Some(new_endpoint) = endpoint {
            require!(new_endpoint.len() <= MAX_ENDPOINT_LEN, AgentError::EndpointTooLong);
            agent.endpoint = new_endpoint;
        }
        if let Some(new_capabilities) = capabilities {
            require!(new_capabilities.len() <= MAX_CAPABILITIES_LEN, AgentError::TooManyCapabilities);
            agent.capabilities = new_capabilities;
        }

        emit!(AgentUpdated {
            agent: agent.key(),
            owner: agent.owner,
        });

        Ok(())
    }

    /// 更新Agent状态
    pub fn update_status(ctx: Context<UpdateStatus>, new_status: AgentStatus) -> Result<()> {
        let agent = &mut ctx.accounts.agent;

        // 只有owner可以更新自己的状态
        if agent.owner == ctx.accounts.owner.key() {
            agent.status = new_status.clone();
        } else {
            // 管理员可以暂停或封禁
            require!(
                ctx.accounts.owner.key() == ctx.accounts.admin.key(),
                AgentError::Unauthorized
            );
            require!(
                new_status == AgentStatus::Paused || new_status == AgentStatus::Banned,
                AgentError::InvalidStatusTransition
            );
            agent.status = new_status.clone();
        }

        let clock = Clock::get()?;
        agent.last_active_at = clock.unix_timestamp;

        emit!(AgentStatusUpdated {
            agent: agent.key(),
            status: new_status,
        });

        Ok(())
    }

    /// 提交任务结果（用于声誉计算）
    pub fn submit_task_result(ctx: Context<SubmitTaskResult>, success: bool) -> Result<()> {
        let agent = &mut ctx.accounts.agent;

        require!(agent.status == AgentStatus::Active, AgentError::AgentNotActive);

        agent.total_tasks += 1;
        if success {
            agent.successful_tasks += 1;
        }

        // 简单声誉计算：成功率 * 100
        if agent.total_tasks > 0 {
            agent.reputation_score = (agent.successful_tasks as f64 / agent.total_tasks as f64 * 100.0) as u64;
        }

        let clock = Clock::get()?;
        agent.last_active_at = clock.unix_timestamp;

        emit!(TaskResultSubmitted {
            agent: agent.key(),
            success,
            reputation_score: agent.reputation_score,
        });

        Ok(())
    }

    /// 验证Agent（管理员操作）
    pub fn verify_agent(ctx: Context<VerifyAgent>, level: VerificationLevel) -> Result<()> {
        let agent = &mut ctx.accounts.agent;

        require!(
            ctx.accounts.admin.key() == ctx.accounts.authority.key(),
            AgentError::Unauthorized
        );

        agent.verification_level = level.clone();

        emit!(AgentVerified {
            agent: agent.key(),
            level,
        });

        Ok(())
    }
}

// ── Accounts 结构 ──

#[derive(Accounts)]
#[instruction(name: String)]
pub struct RegisterAgent<'info> {
    #[account(mut)]
    pub owner: Signer<'info>,

    #[account(
        init,
        payer = owner,
        space = 8 + Agent::INIT_SPACE,
        seeds = [b"agent", owner.key().as_ref()],
        bump
    )]
    pub agent: Account<'info, Agent>,

    pub system_program: Program<'info, System>,
}

#[derive(Accounts)]
pub struct UpdateAgent<'info> {
    #[account(mut)]
    pub owner: Signer<'info>,

    #[account(
        mut,
        seeds = [b"agent", owner.key().as_ref()],
        bump,
        constraint = agent.owner == owner.key()
    )]
    pub agent: Account<'info, Agent>,
}

#[derive(Accounts)]
pub struct UpdateStatus<'info> {
    /// CHECK: 可以是owner或admin
    pub owner: Signer<'info>,

    /// CHECK: 管理员地址
    pub admin: AccountInfo<'info>,

    #[account(mut)]
    pub agent: Account<'info, Agent>,
}

#[derive(Accounts)]
pub struct SubmitTaskResult<'info> {
    #[account(mut)]
    pub owner: Signer<'info>,

    #[account(
        mut,
        seeds = [b"agent", owner.key().as_ref()],
        bump,
        constraint = agent.owner == owner.key()
    )]
    pub agent: Account<'info, Agent>,
}

#[derive(Accounts)]
pub struct VerifyAgent<'info> {
    /// CHECK: 管理员
    pub admin: Signer<'info>,

    /// CHECK: 权威账户
    pub authority: AccountInfo<'info>,

    #[account(mut)]
    pub agent: Account<'info, Agent>,
}

// ── 数据状态 ──

#[account]
#[derive(InitSpace)]
pub struct Agent {
    pub owner: Pubkey,
    #[max_len(64)]
    pub name: String,
    #[max_len(256)]
    pub description: String,
    #[max_len(128)]
    pub endpoint: String,
    #[max_len(10, 64)]
    pub capabilities: Vec<String>,
    pub status: AgentStatus,
    pub reputation_score: u64,
    pub total_tasks: u64,
    pub successful_tasks: u64,
    pub registered_at: i64,
    pub last_active_at: i64,
    pub verification_level: VerificationLevel,
}

#[derive(AnchorSerialize, AnchorDeserialize, Clone, PartialEq, Eq, InitSpace)]
pub enum AgentStatus {
    Active,
    Paused,
    Banned,
}

#[derive(AnchorSerialize, AnchorDeserialize, Clone, PartialEq, Eq, InitSpace)]
pub enum VerificationLevel {
    Unverified,
    Basic,
    Verified,
    Premium,
}

// ── 事件 ──

#[event]
pub struct AgentRegistered {
    pub agent: Pubkey,
    pub owner: Pubkey,
    pub name: String,
}

#[event]
pub struct AgentUpdated {
    pub agent: Pubkey,
    pub owner: Pubkey,
}

#[event]
pub struct AgentStatusUpdated {
    pub agent: Pubkey,
    pub status: AgentStatus,
}

#[event]
pub struct TaskResultSubmitted {
    pub agent: Pubkey,
    pub success: bool,
    pub reputation_score: u64,
}

#[event]
pub struct AgentVerified {
    pub agent: Pubkey,
    pub level: VerificationLevel,
}

// ── 错误码 ──

#[error_code]
pub enum AgentError {
    #[msg("Name too long")]
    NameTooLong,
    #[msg("Description too long")]
    DescriptionTooLong,
    #[msg("Endpoint too long")]
    EndpointTooLong,
    #[msg("Too many capabilities")]
    TooManyCapabilities,
    #[msg("Unauthorized")]
    Unauthorized,
    #[msg("Invalid status transition")]
    InvalidStatusTransition,
    #[msg("Agent not active")]
    AgentNotActive,
}
