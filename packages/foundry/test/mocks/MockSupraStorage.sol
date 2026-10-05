// SPDX-License-Identifier: MIT
pragma solidity ^0.8.28;

import { ISupraSValueFeed } from "../../contracts/interfaces/ISupraSValueFeed.sol";

/// @dev Stands in for Supra's price storage contract. Tests set the price and its publish time directly.
contract MockSupraStorage is ISupraSValueFeed {
    PriceFeed public feed;
    bool public broken;

    function set(uint256 price, uint256 decimals, uint256 timeMs) external {
        feed = PriceFeed({ round: feed.round + 1, decimals: decimals, time: timeMs, price: price });
    }

    function feed_price() external view returns (uint256) {
        return feed.price;
    }

    function setBroken(bool value) external {
        broken = value;
    }

    function getSvalue(uint256) external view returns (PriceFeed memory) {
        require(!broken, "oracle down");
        return feed;
    }
}
