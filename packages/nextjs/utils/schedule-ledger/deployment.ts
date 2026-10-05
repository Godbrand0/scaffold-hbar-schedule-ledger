// The reference deployment made while building this template, and the transactions that prove it works.
// Everything here is public testnet data and can be checked on Hashscan.
export const HASHSCAN = "https://hashscan.io/testnet";

export const LIVE_CONTRACT = {
  id: "0.0.10870569",
  evmAddress: "0x9Ee5C37F59A2253faE009714B0d2723C57f29b26",
  network: "Hedera testnet (chain 296)",
};

export type ProofRow = {
  scenario: string;
  outcome: string;
  links: { label: string; kind: "transaction" | "schedule"; id: string }[];
};

export const PROOF: ProofRow[] = [
  {
    scenario: "USD plan paying a brand-new address (Supra price, 2 runs)",
    outcome:
      "Each run read Supra's price of $0.1030 per HBAR and paid 2.42671325 HBAR for $0.25. The recipient had no account; the first payout created it. Run 1 booked run 2 itself.",
    links: [
      {
        label: "create",
        kind: "transaction",
        id: "0xe4e461a453856d86150efb33f484514c0267326e2a7d848e425ed13c311258e0",
      },
      { label: "run 1", kind: "transaction", id: "0xb3b4267456c842b5ec76781053d4877781f2390f376937e33d9a48509368462a" },
      { label: "run 2", kind: "transaction", id: "0x563606822b233928c9b7da24536abbd0a91ce0b760a4d5008b6eaf7d7dd28478" },
      { label: "schedule 1", kind: "schedule", id: "0.0.10870573" },
      { label: "schedule 2", kind: "schedule", id: "0.0.10870585" },
    ],
  },
  {
    scenario: "Surplus claim",
    outcome: "The unused part of the escrowed cap, 5.1465735 HBAR, was returned to the owner.",
    links: [
      {
        label: "claimSurplus",
        kind: "transaction",
        id: "0xf5eeeea4c3dac49d34d4d05940a7d8b613469576b0bc5ad9b6cdfa7aede54b10",
      },
    ],
  },
  {
    scenario: "Price guard (cap below the payout)",
    outcome:
      "The payout exceeded the cap, so the run did not pay. It emitted PriceRejected (AboveCap) and paused. cancel then refunded the full 3.3 HBAR.",
    links: [
      {
        label: "create",
        kind: "transaction",
        id: "0xf7ef562bf9427d0afdaa7cfe75b7c43b9595ef3485b8678b581a5c8c707ab9bc",
      },
      {
        label: "rejected run",
        kind: "transaction",
        id: "0x7407332123ad67d3f7b4773738c7b109cfed5887eaf155ba4c1731029644ecbd",
      },
      {
        label: "cancel",
        kind: "transaction",
        id: "0xe7ba4ff1614acf5b5f12c9806a1d9b05ac5df8f1e1affe481a567ae96385f6d1",
      },
      { label: "schedule", kind: "schedule", id: "0.0.10870578" },
    ],
  },
];

export const hashscanUrl = (kind: "transaction" | "schedule" | "contract", id: string) => `${HASHSCAN}/${kind}/${id}`;
