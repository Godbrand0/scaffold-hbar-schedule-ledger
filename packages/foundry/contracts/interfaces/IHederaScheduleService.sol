// SPDX-License-Identifier: MIT
pragma solidity ^0.8.28;

/// @title IHederaScheduleService
/// @notice Subset of the Hedera Schedule Service (HSS) system contract at 0x16b used by this template.
/// @dev Defined by HIP-755 and generalized by HIP-1215. None of these calls revert: failures are returned
///      as a HAPI `ResponseCodeEnum` ordinal (22 is SUCCESS) together with a zero schedule address.
interface IHederaScheduleService {
    /// @notice Schedule a future call. The scheduled transaction executes on or after `expirySecond`.
    function scheduleCall(address to, uint256 expirySecond, uint256 gasLimit, uint64 value, bytes memory callData)
        external
        returns (int64 responseCode, address scheduleAddress);

    /// @notice True if `expirySecond` can still take a scheduled call with this gas limit.
    function hasScheduleCapacity(uint256 expirySecond, uint256 gasLimit) external view returns (bool);

    /// @notice Delete a schedule created by this contract before it executes.
    function deleteSchedule(address scheduleAddress) external returns (int64 responseCode);
}
