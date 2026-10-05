// SPDX-License-Identifier: MIT
pragma solidity ^0.8.28;

/// @notice Recipient that needs a lot of gas to accept HBAR. Hedera creates the account for a first payment to a
///         new address inside the transfer, which costs about 650k gas; this mock burns a similar amount.
contract GasHungryReceiver {
    uint256 public immutable GAS_TO_BURN;

    constructor(uint256 gasToBurn) {
        GAS_TO_BURN = gasToBurn;
    }

    receive() external payable {
        uint256 start = gasleft();
        while (start - gasleft() < GAS_TO_BURN) { }
    }
}
