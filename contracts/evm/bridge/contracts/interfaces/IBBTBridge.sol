// SPDX-License-Identifier: MIT
pragma solidity ^0.8.20;

/**
 * @title IBBTBridge
 * @notice BBT桥接合约接口
 * @dev 定义桥接合约的核心功能
 */
interface IBBTBridge {
    // ==================== 事件 ====================

    /// @notice BBT锁定事件
    event BBTLocked(
        address indexed sender,
        uint256 amount,
        uint256 targetChain,
        bytes32 targetAddress,
        uint256 timestamp,
        uint256 nonce
    );

    /// @notice BBT解锁事件
    event BBTUnlocked(
        address indexed recipient,
        uint256 amount,
        uint256 sourceChain,
        bytes32 sourceTxHash,
        uint256 timestamp
    );

    /// @notice Wrapped BBT铸造事件
    event BBTMinted(
        address indexed to,
        uint256 amount,
        uint256 sourceChain,
        bytes32 sourceTxHash,
        uint256 timestamp
    );

    /// @notice Wrapped BBT销毁事件
    event BBTBurned(
        address indexed from,
        uint256 amount,
        uint256 timestamp
    );

    /// @notice 桥接暂停事件
    event BridgePaused(address indexed account, uint256 timestamp);

    /// @notice 桥接恢复事件
    event BridgeUnpaused(address indexed account, uint256 timestamp);

    /// @notice 限额更新事件
    event LimitsUpdated(
        uint256 singleTxLimit,
        uint256 dailyLimit,
        uint256 weeklyLimit,
        uint256 timestamp
    );

    /// @notice 多签确认事件
    event MultiSigConfirmed(
        bytes32 indexed txHash,
        address indexed signer,
        uint256 confirmations
    );

    /// @notice 多签执行事件
    event MultiSigExecuted(bytes32 indexed txHash, uint256 timestamp);

    /// @notice 跨链证明提交事件
    event ProofSubmitted(
        bytes32 indexed eventId,
        bytes32 indexed leafHash,
        address submitter,
        uint256 timestamp
    );

    // ==================== 错误 ====================

    error BridgeIsPaused();
    error BridgeNotPaused();
    error InsufficientBalance();
    error ExceedsSingleTxLimit();
    error ExceedsDailyLimit();
    error ExceedsWeeklyLimit();
    error InvalidAmount();
    error InvalidAddress();
    error InvalidChain();
    error NotSigner();
    error NotOperator();
    error NotGuardian();
    error TxAlreadyProcessed();
    error TxNotConfirmed();
    error AlreadyConfirmed();
    error AlreadyRevoked();
    error ZeroAddress();

    // ==================== 函数签名 ====================

    /**
     * @notice 锁定BBT用于跨链转移
     * @param amount 锁定数量
     * @param targetChain 目标链ID
     * @param targetAddress 目标地址(bytes32格式)
     */
    function lockBBT(
        uint256 amount,
        uint256 targetChain,
        bytes32 targetAddress
    ) external;

    /**
     * @notice 解锁BBT（从中继器调用）
     * @param recipient 接收地址
     * @param amount 解锁数量
     * @param sourceChain 源链ID
     * @param sourceTxHash 源链交易哈希
     */
    function unlockBBT(
        address recipient,
        uint256 amount,
        uint256 sourceChain,
        bytes32 sourceTxHash
    ) external;

    /**
     * @notice 铸造wrapped BBT
     * @param to 接收地址
     * @param amount 铸造数量
     * @param sourceChain 源链ID
     * @param sourceTxHash 源链交易哈希
     */
    function mintBBT(
        address to,
        uint256 amount,
        uint256 sourceChain,
        bytes32 sourceTxHash
    ) external;

    /**
     * @notice 销毁wrapped BBT
     * @param amount 销毁数量
     */
    function burnBBT(uint256 amount) external;

    /**
     * @notice 暂停桥接
     */
    function pauseBridge() external;

    /**
     * @notice 恢复桥接
     */
    function unpauseBridge() external;

    /**
     * @notice 更新限额
     * @param singleTxLimit 单笔限额
     * @param dailyLimit 日限额
     * @param weeklyLimit 周限额
     */
    function updateLimits(
        uint256 singleTxLimit,
        uint256 dailyLimit,
        uint256 weeklyLimit
    ) external;

    /**
     * @notice 确认多签交易
     * @param txHash 交易哈希
     */
    function confirmMultiSig(bytes32 txHash) external;

    /**
     * @notice 撤销多签确认
     * @param txHash 交易哈希
     */
    function revokeMultiSig(bytes32 txHash) external;

    /**
     * @notice 执行多签交易
     * @param txHash 交易哈希
     */
    function executeMultiSig(bytes32 txHash) external;

    /**
     * @notice 提交跨链证明
     * @param eventId 事件ID (bytes32)
     * @param merkleRoot Merkle根 (bytes32)
     * @param leafHash 叶子哈希 (bytes32)
     * @param proof Merkle证明路径
     * @param signatures 中继器签名数组
     */
    function submitProof(
        bytes32 eventId,
        bytes32 merkleRoot,
        bytes32 leafHash,
        bytes32[] calldata proof,
        bytes[] calldata signatures
    ) external;

    // ==================== 查询函数 ====================

    /**
     * @notice 获取当前限额
     * @return singleTxLimit 单笔限额
     * @return dailyLimit 日限额
     * @return weeklyLimit 周限额
     */
    function getLimits()
        external
        view
        returns (uint256 singleTxLimit, uint256 dailyLimit, uint256 weeklyLimit);

    /**
     * @notice 获取每日已用量
     * @return 已用量
     */
    function getDailyUsed() external view returns (uint256);

    /**
     * @notice 获取每周已用量
     * @return 已用量
     */
    function getWeeklyUsed() external view returns (uint256);

    /**
     * @notice 检查交易是否已处理
     * @param txHash 交易哈希
     * @return 是否已处理
     */
    function isTxProcessed(bytes32 txHash) external view returns (bool);

    /**
     * @notice 获取多签确认数
     * @param txHash 交易哈希
     * @return 确认数
     */
    function getMultiSigConfirmations(bytes32 txHash)
        external
        view
        returns (uint256);
}
