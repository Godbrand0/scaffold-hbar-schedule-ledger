// Booking a schedule through the Hedera Schedule Service costs about 1.6M gas (measured on testnet), which is more
// than a wallet's gas estimate is reliable for. Calls that book a schedule therefore send an explicit gas limit.
// The network also needs `gasLimit * gasPrice` available up front, so keep this close to the real cost.
export const BOOKING_GAS_LIMIT = 2_000_000n;

// Recommended per-run network fee reserve, in HBAR. The contract is the payer of its own scheduled calls and the
// network requires it to hold gasLimit (2M) * gasPrice at execution. At the testnet price of 83 tinybar per gas that
// is about 1.66 HBAR. Check the current price with `cast gas-price` and adjust.
export const SUGGESTED_FEE_RESERVE_HBAR = "1.7";
