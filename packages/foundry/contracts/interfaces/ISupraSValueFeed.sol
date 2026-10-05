// SPDX-License-Identifier: MIT
pragma solidity ^0.8.28;

/// @notice The read side of Supra's price storage contract, which is what Supra's push oracle writes to.
/// @dev Hedera testnet storage: 0x6Cd59830AAD978446e6cc7f6cc173aF7656Fb917, mainnet:
///      0xD02cc7a670047b6b012556A88e275c685d25e0c9. HBAR_USD is pair index 432 and HBAR_USDT is 75.
///      Docs: https://docs.supra.com/oracles/data-feeds/data-feeds-index
interface ISupraSValueFeed {
    struct PriceFeed {
        uint256 round;
        /// @dev Decimals of `price`. Supra's feeds use 18.
        uint256 decimals;
        /// @dev Unix time in **milliseconds** at which the price was published.
        uint256 time;
        uint256 price;
    }

    function getSvalue(uint256 pairIndex) external view returns (PriceFeed memory);
}
