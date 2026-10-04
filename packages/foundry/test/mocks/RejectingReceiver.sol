// SPDX-License-Identifier: MIT
pragma solidity ^0.8.28;

/// @notice Recipient that refuses HBAR, or accepts it once switched on. Used to exercise `PaymentFailed`.
contract RejectingReceiver {
    bool public accepting;

    function setAccepting(bool value) external {
        accepting = value;
    }

    receive() external payable {
        require(accepting, "RejectingReceiver: not accepting");
    }
}
