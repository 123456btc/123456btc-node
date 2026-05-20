// SPDX-License-Identifier: MIT
pragma solidity ^0.8.20;

import "@openzeppelin/contracts/utils/ReentrancyGuard.sol";
import "@openzeppelin/contracts/utils/Pausable.sol";
import "@openzeppelin/contracts/access/AccessControl.sol";
import "@openzeppelin/contracts/token/ERC20/IERC20.sol";
import "@openzeppelin/contracts/token/ERC20/utils/SafeERC20.sol";
import "./interfaces/IBBTBridge.sol";
import "./BBTToken.sol";

/**
 * @title BBTBridge
 * @notice BBT跨链桥接合约（ETH/BNB共用）
 * @dev 实现锁定/解锁、铸造/销毁、限额控制、多签验证
 */
contract BBTBridge is IBBTBridge, ReentrancyGuard, Pausable, AccessControl {
    using SafeERC20 for IERC20;

    // ==================== 角色定义 ====================
    bytes32 public constant OPERATOR_ROLE = keccak256("OPERATOR_ROLE");
    bytes32 public constant GUARDIAN_ROLE = keccak256("GUARDIAN_ROLE");
    bytes32 public constant SIGNER_ROLE = keccak256("SIGNER_ROLE");

    // ==================== 状态变量 ====================

    /// @notice BBT代币合约（源链上的原生BBT）
    IERC20 public immutable bbtToken;

    /// @notice Wrapped BBT代币合约（目标链上的wrapped BBT）
    BBTToken public immutable wrappedBBT;

    /// @notice 当前链ID
    uint256 public immutable chainId;

    /// @notice 交易计数器（用于生成唯一nonce）
    uint256 public txCounter;

    // ==================== 限额状态 ====================

    /// @notice 单笔限额
    uint256 public singleTxLimit;

    /// @notice 日限额
    uint256 public dailyLimit;

    /// @notice 周限额
    uint256 public weeklyLimit;

    /// @notice 每日已用量（按UTC日期重置）
    uint256 public dailyUsed;

    /// @notice 每周已用量（按UTC周重置）
    uint256 public weeklyUsed;

    /// @notice 上次重置日限额的时间戳
    uint256 public lastDailyReset;

    /// @notice 上次重置周限额的时间戳
    uint256 public lastWeeklyReset;

    // ==================== 多签状态 ====================

    /// @notice 多签确认数
    mapping(bytes32 => uint256) public multiSigConfirmations;

    /// @notice 多签交易是否已执行
    mapping(bytes32 => bool) public multiSigExecuted;

    /// @notice 签名者是否已确认特定交易
    mapping(bytes32 => mapping(address => bool)) public hasConfirmed;

    /// @notice 所需确认数
    uint256 public requiredConfirmations;

    // ==================== 交易记录 ====================

    /// @notice 已处理的交易哈希（防止重放）
    mapping(bytes32 => bool) public processedTxs;

    // ==================== 构造函数 ====================

    /**
     * @notice 初始化桥接合约
     * @param _bbtToken 源链BBT代币地址（目标链传address(0)）
     * @param _wrappedBBT Wrapped BBT代币地址（源链传address(0)）
     * @param _requiredConfirmations 多签所需确认数
     * @param _singleTxLimit 单笔限额
     * @param _dailyLimit 日限额
     * @param _weeklyLimit 周限额
     */
    constructor(
        address _bbtToken,
        address _wrappedBBT,
        uint256 _requiredConfirmations,
        uint256 _singleTxLimit,
        uint256 _dailyLimit,
        uint256 _weeklyLimit
    ) {
        require(
            _requiredConfirmations > 0,
            "BBTBridge: invalid confirmations"
        );
        require(
            _singleTxLimit > 0 && _dailyLimit > 0 && _weeklyLimit > 0,
            "BBTBridge: invalid limits"
        );

        bbtToken = IERC20(_bbtToken);
        wrappedBBT = BBTToken(_wrappedBBT);
        chainId = block.chainid;

        requiredConfirmations = _requiredConfirmations;
        singleTxLimit = _singleTxLimit;
        dailyLimit = _dailyLimit;
        weeklyLimit = _weeklyLimit;

        // 初始化限额重置时间
        lastDailyReset = _getDayStart(block.timestamp);
        lastWeeklyReset = _getWeekStart(block.timestamp);

        // 授予角色
        _grantRole(DEFAULT_ADMIN_ROLE, msg.sender);
        _grantRole(OPERATOR_ROLE, msg.sender);
        _grantRole(GUARDIAN_ROLE, msg.sender);
    }

    // ==================== 核心桥接函数 ====================

    /**
     * @notice 锁定BBT用于跨链转移
     * @dev 用户在源链调用，BBT被锁定在合约中
     */
    function lockBBT(
        uint256 amount,
        uint256 targetChain,
        bytes32 targetAddress
    ) external override whenNotPaused nonReentrant {
        // 参数验证
        require(amount > 0, "BBTBridge: zero amount");
        require(
            targetAddress != bytes32(0),
            "BBTBridge: zero target address"
        );
        require(
            targetChain != chainId,
            "BBTBridge: same chain not allowed"
        );

        // 限额检查
        _checkLimits(amount);

        // 转移BBT到合约
        bbtToken.safeTransferFrom(msg.sender, address(this), amount);

        // 更新限额用量
        _updateUsage(amount);

        // 递增交易计数器
        txCounter++;

        // 发射锁定事件（中继器监听）
        emit BBTLocked(
            msg.sender,
            amount,
            targetChain,
            targetAddress,
            block.timestamp,
            txCounter
        );
    }

    /**
     * @notice 解锁BBT
     * @dev 中继器调用，将锁定的BBT释放给接收者
     */
    function unlockBBT(
        address recipient,
        uint256 amount,
        uint256 sourceChain,
        bytes32 sourceTxHash
    ) external override whenNotPaused nonReentrant {
        // 权限检查
        require(
            hasRole(OPERATOR_ROLE, msg.sender),
            "BBTBridge: not operator"
        );

        // 参数验证
        require(recipient != address(0), "BBTBridge: zero recipient");
        require(amount > 0, "BBTBridge: zero amount");
        require(
            sourceTxHash != bytes32(0),
            "BBTBridge: zero tx hash"
        );
        require(
            sourceChain != chainId,
            "BBTBridge: same chain not allowed"
        );

        // 防止重放
        require(
            !processedTxs[sourceTxHash],
            "BBTBridge: tx already processed"
        );

        // 标记为已处理
        processedTxs[sourceTxHash] = true;

        // 解锁BBT
        bbtToken.safeTransfer(recipient, amount);

        // 发射解锁事件
        emit BBTUnlocked(
            recipient,
            amount,
            sourceChain,
            sourceTxHash,
            block.timestamp
        );
    }

    /**
     * @notice 铸造wrapped BBT
     * @dev 中继器调用，在目标链上铸造wrapped BBT
     */
    function mintBBT(
        address to,
        uint256 amount,
        uint256 sourceChain,
        bytes32 sourceTxHash
    ) external override whenNotPaused nonReentrant {
        // 权限检查
        require(
            hasRole(OPERATOR_ROLE, msg.sender),
            "BBTBridge: not operator"
        );

        // 参数验证
        require(to != address(0), "BBTBridge: zero recipient");
        require(amount > 0, "BBTBridge: zero amount");
        require(
            sourceTxHash != bytes32(0),
            "BBTBridge: zero tx hash"
        );

        // 防止重放
        require(
            !processedTxs[sourceTxHash],
            "BBTBridge: tx already processed"
        );

        // 标记为已处理
        processedTxs[sourceTxHash] = true;

        // 铸造wrapped BBT
        wrappedBBT.mint(to, amount);

        // 发射铸造事件
        emit BBTMinted(
            to,
            amount,
            sourceChain,
            sourceTxHash,
            block.timestamp
        );
    }

    /**
     * @notice 销毁wrapped BBT
     * @dev 用户调用，销毁wrapped BBT以便在源链解锁
     */
    function burnBBT(
        uint256 amount
    ) external override whenNotPaused nonReentrant {
        // 参数验证
        require(amount > 0, "BBTBridge: zero amount");

        // 限额检查
        _checkLimits(amount);

        // 更新限额用量
        _updateUsage(amount);

        // 先将用户的wBBT转移到bridge合约（因为burn从msg.sender销毁）
        IERC20(address(wrappedBBT)).safeTransferFrom(msg.sender, address(this), amount);

        // 销毁wrapped BBT
        wrappedBBT.burn(amount);

        // 发射销毁事件
        emit BBTBurned(msg.sender, amount, block.timestamp);
    }

    // ==================== 管理函数 ====================

    /**
     * @notice 暂停桥接
     */
    function pauseBridge() external override {
        require(
            hasRole(GUARDIAN_ROLE, msg.sender),
            "BBTBridge: not guardian"
        );
        _pause();
        emit BridgePaused(msg.sender, block.timestamp);
    }

    /**
     * @notice 恢复桥接
     */
    function unpauseBridge() external override {
        require(
            hasRole(DEFAULT_ADMIN_ROLE, msg.sender),
            "BBTBridge: not admin"
        );
        _unpause();
        emit BridgeUnpaused(msg.sender, block.timestamp);
    }

    /**
     * @notice 更新限额
     */
    function updateLimits(
        uint256 _singleTxLimit,
        uint256 _dailyLimit,
        uint256 _weeklyLimit
    ) external override {
        require(
            hasRole(DEFAULT_ADMIN_ROLE, msg.sender),
            "BBTBridge: not admin"
        );
        require(
            _singleTxLimit > 0 && _dailyLimit > 0 && _weeklyLimit > 0,
            "BBTBridge: invalid limits"
        );

        singleTxLimit = _singleTxLimit;
        dailyLimit = _dailyLimit;
        weeklyLimit = _weeklyLimit;

        emit LimitsUpdated(
            _singleTxLimit,
            _dailyLimit,
            _weeklyLimit,
            block.timestamp
        );
    }

    // ==================== 多签函数 ====================

    /**
     * @notice 确认多签交易
     * @param txHash 交易哈希
     */
    function confirmMultiSig(bytes32 txHash) external override {
        require(
            hasRole(SIGNER_ROLE, msg.sender),
            "BBTBridge: not signer"
        );
        require(!multiSigExecuted[txHash], "BBTBridge: already executed");
        require(
            !hasConfirmed[txHash][msg.sender],
            "BBTBridge: already confirmed"
        );

        hasConfirmed[txHash][msg.sender] = true;
        multiSigConfirmations[txHash]++;

        emit MultiSigConfirmed(txHash, msg.sender, multiSigConfirmations[txHash]);
    }

    /**
     * @notice 撤销多签确认
     * @param txHash 交易哈希
     */
    function revokeMultiSig(bytes32 txHash) external override {
        require(
            hasRole(SIGNER_ROLE, msg.sender),
            "BBTBridge: not signer"
        );
        require(!multiSigExecuted[txHash], "BBTBridge: already executed");
        require(
            hasConfirmed[txHash][msg.sender],
            "BBTBridge: not confirmed"
        );

        hasConfirmed[txHash][msg.sender] = false;
        multiSigConfirmations[txHash]--;
    }

    /**
     * @notice 执行多签交易
     * @param txHash 交易哈希
     */
    function executeMultiSig(bytes32 txHash) external override nonReentrant {
        require(!multiSigExecuted[txHash], "BBTBridge: already executed");
        require(
            multiSigConfirmations[txHash] >= requiredConfirmations,
            "BBTBridge: insufficient confirmations"
        );

        multiSigExecuted[txHash] = true;

        emit MultiSigExecuted(txHash, block.timestamp);
    }

    // ==================== 查询函数 ====================

    /**
     * @notice 获取当前限额
     */
    function getLimits()
        external
        view
        override
        returns (uint256, uint256, uint256)
    {
        return (singleTxLimit, dailyLimit, weeklyLimit);
    }

    /**
     * @notice 获取每日已用量（视图函数，不修改状态）
     */
    function getDailyUsed() external view override returns (uint256) {
        uint256 currentDayStart = _getDayStart(block.timestamp);
        if (currentDayStart > lastDailyReset) {
            return 0; // 期间已重置
        }
        return dailyUsed;
    }

    /**
     * @notice 获取每周已用量（视图函数，不修改状态）
     */
    function getWeeklyUsed() external view override returns (uint256) {
        uint256 currentWeekStart = _getWeekStart(block.timestamp);
        if (currentWeekStart > lastWeeklyReset) {
            return 0; // 期间已重置
        }
        return weeklyUsed;
    }

    /**
     * @notice 检查交易是否已处理
     */
    function isTxProcessed(bytes32 txHash)
        external
        view
        override
        returns (bool)
    {
        return processedTxs[txHash];
    }

    /**
     * @notice 获取多签确认数
     */
    function getMultiSigConfirmations(bytes32 txHash)
        external
        view
        override
        returns (uint256)
    {
        return multiSigConfirmations[txHash];
    }

    // ==================== 内部函数 ====================

    /**
     * @notice 检查限额
     */
    function _checkLimits(uint256 amount) internal {
        // 单笔限额检查
        require(
            amount <= singleTxLimit,
            "BBTBridge: exceeds single tx limit"
        );

        // 重置并检查日限额
        _resetDailyIfNeeded();
        require(
            dailyUsed + amount <= dailyLimit,
            "BBTBridge: exceeds daily limit"
        );

        // 重置并检查周限额
        _resetWeeklyIfNeeded();
        require(
            weeklyUsed + amount <= weeklyLimit,
            "BBTBridge: exceeds weekly limit"
        );
    }

    /**
     * @notice 更新用量统计
     */
    function _updateUsage(uint256 amount) internal {
        dailyUsed += amount;
        weeklyUsed += amount;
    }

    /**
     * @notice 重置日限额（如果需要）
     */
    function _resetDailyIfNeeded() internal {
        uint256 currentDayStart = _getDayStart(block.timestamp);
        if (currentDayStart > lastDailyReset) {
            dailyUsed = 0;
            lastDailyReset = currentDayStart;
        }
    }

    /**
     * @notice 重置周限额（如果需要）
     */
    function _resetWeeklyIfNeeded() internal {
        uint256 currentWeekStart = _getWeekStart(block.timestamp);
        if (currentWeekStart > lastWeeklyReset) {
            weeklyUsed = 0;
            lastWeeklyReset = currentWeekStart;
        }
    }

    /**
     * @notice 获取当天开始时间戳（UTC 00:00）
     */
    function _getDayStart(uint256 timestamp) internal pure returns (uint256) {
        return timestamp - (timestamp % 1 days);
    }

    /**
     * @notice 获取本周开始时间戳（UTC Monday 00:00）
     */
    function _getWeekStart(uint256 timestamp) internal pure returns (uint256) {
        // Unix epoch (1970-01-01) is Thursday (4)
        // Monday = 0, so we need to adjust
        uint256 day = timestamp / 1 days;
        uint256 weekday = (day + 4) % 7; // 0=Monday, 6=Sunday
        return (day - weekday) * 1 days;
    }

    /**
     * @notice 接收ETH（用于Gas费退款等）
     */
    receive() external payable {}

    /**
     * @notice 紧急提取代币（仅管理员）
     */
    function emergencyWithdraw(
        address token,
        address to,
        uint256 amount
    ) external {
        require(
            hasRole(DEFAULT_ADMIN_ROLE, msg.sender),
            "BBTBridge: not admin"
        );
        require(to != address(0), "BBTBridge: zero address");

        if (token == address(0)) {
            // 提取ETH
            payable(to).transfer(amount);
        } else {
            // 提取ERC20
            IERC20(token).safeTransfer(to, amount);
        }
    }
}
