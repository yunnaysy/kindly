// SPDX-License-Identifier: MIT
pragma solidity ^0.8.24;

import {ERC20} from "@openzeppelin/contracts/token/ERC20/ERC20.sol";

/// @notice Local-only stand-in for tUSD8 (6 decimals). Never deployed to Aevum; the real
///         tUSD8 lives at 0x456569838f1d43009A91ebA4263147Afd7233483.
contract MockUSD8 is ERC20 {
    constructor() ERC20("Mock tUSD8", "tUSD8") {}

    function decimals() public pure override returns (uint8) {
        return 6;
    }

    function mint(address to, uint256 amount) external {
        _mint(to, amount);
    }
}
