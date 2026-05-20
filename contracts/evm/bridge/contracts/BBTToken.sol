// SPDX-License-Identifier: MIT
pragma solidity ^0.8.20;

import "@openzeppelin/contracts/token/ERC20/ERC20.sol";
import "@openzeppelin/contracts/access/AccessControl.sol";
import "@openzeppelin/contracts/utils/Pausable.sol";

/**
 * @title BBTToken
 * @notice Wrapped BBT代币合约（用于跨链桥接）
 * @dev 在目标链上铸造/销毁，代表源链上的BBT
 */
contract BBTToken is ERC20, AccessControl, Pausable {
    bytes32 public constant MINTER_ROLE = keccak256("MINTER_ROLE");
    bytes32 public constant BURNER_ROLE = keccak256("BURNER_ROLE");

    constructor(
        string memory name,
        string memory symbol,
        address admin
    ) ERC20(name, symbol) {
        _grantRole(DEFAULT_ADMIN_ROLE, admin);
    }

    /**
     * @notice 铸造wrapped BBT
     * @param to 接收地址
     * @param amount 铸造数量
     */
    function mint(address to, uint256 amount) external whenNotPaused {
        require(hasRole(MINTER_ROLE, msg.sender), "BBTToken: not minter");
        require(to != address(0), "BBTToken: mint to zero");
        require(amount > 0, "BBTToken: zero amount");

        _mint(to, amount);
    }

    /**
     * @notice 销毁wrapped BBT
     * @param amount 销毁数量
     */
    function burn(uint256 amount) external whenNotPaused {
        require(hasRole(BURNER_ROLE, msg.sender), "BBTToken: not burner");
        require(amount > 0, "BBTToken: zero amount");

        _burn(msg.sender, amount);
    }

    /**
     * @notice 暂停代币转移（紧急情况）
     */
    function pause() external {
        require(hasRole(DEFAULT_ADMIN_ROLE, msg.sender), "BBTToken: not admin");
        _pause();
    }

    /**
     * @notice 恢复代币转移
     */
    function unpause() external {
        require(hasRole(DEFAULT_ADMIN_ROLE, msg.sender), "BBTToken: not admin");
        _unpause();
    }

    /**
     * @notice 授予铸造权限
     * @param account 地址
     */
    function grantMinter(address account) external {
        require(
            hasRole(DEFAULT_ADMIN_ROLE, msg.sender),
            "BBTToken: not admin"
        );
        grantRole(MINTER_ROLE, account);
    }

    /**
     * @notice 授予销毁权限
     * @param account 地址
     */
    function grantBurner(address account) external {
        require(
            hasRole(DEFAULT_ADMIN_ROLE, msg.sender),
            "BBTToken: not admin"
        );
        grantRole(BURNER_ROLE, account);
    }

    /**
     * @notice 覆盖_update以实现暂停功能（OZ v5使用_update替代_transfer/_approve）
     */
    function _update(
        address from,
        address to,
        uint256 value
    ) internal override whenNotPaused {
        super._update(from, to, value);
    }
}
