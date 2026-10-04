// SPDX-License-Identifier: MIT
pragma solidity ^0.8.28;

import { IHederaScheduleService } from "../../contracts/interfaces/IHederaScheduleService.sol";

/// @notice Test double for the HSS system contract. Foundry has no HSS, so tests etch this bytecode at 0x16b.
/// @dev `vm.etch` copies code only, never storage, so every default below must be the zero value.
contract MockHederaScheduleService is IHederaScheduleService {
    struct Call {
        address to;
        uint256 expirySecond;
        bytes callData;
        bool deleted;
    }

    Call[] public calls;
    bool public capacityBlocked;
    int64 public nextFailureCode;

    function setCapacityAvailable(bool value) external {
        capacityBlocked = !value;
    }

    function setNextFailureCode(int64 code) external {
        nextFailureCode = code;
    }

    function callCount() external view returns (uint256) {
        return calls.length;
    }

    function scheduleCall(address to, uint256 expirySecond, uint256, uint64, bytes memory callData)
        external
        returns (int64, address)
    {
        if (nextFailureCode != 0) {
            int64 code = nextFailureCode;
            nextFailureCode = 0;
            return (code, address(0));
        }
        calls.push(Call(to, expirySecond, callData, false));
        return (22, address(uint160(0x1000 + calls.length)));
    }

    function hasScheduleCapacity(uint256, uint256) external view returns (bool) {
        return !capacityBlocked;
    }

    function deleteSchedule(address scheduleAddress) external returns (int64) {
        uint256 index = uint160(scheduleAddress) - 0x1000;
        calls[index - 1].deleted = true;
        return 22;
    }

    /// @notice Simulate the network executing scheduled call number `index` (0-based).
    function fire(uint256 index) external returns (bool ok, bytes memory ret) {
        Call storage c = calls[index];
        (ok, ret) = c.to.call(c.callData);
    }
}
