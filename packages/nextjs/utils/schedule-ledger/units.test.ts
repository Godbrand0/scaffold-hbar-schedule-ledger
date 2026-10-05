import {
  formatInterval,
  formatOraclePrice,
  formatUsd,
  hbarToTinybar,
  suggestedCapTinybar,
  tinybarToHbar,
  tinybarToWeibar,
  usdToUnits,
} from "./units";
import { describe, expect, it } from "vitest";

describe("hbarToTinybar", () => {
  it("converts whole and fractional HBAR", () => {
    expect(hbarToTinybar("1")).toBe(100_000_000n);
    expect(hbarToTinybar("1.5")).toBe(150_000_000n);
    expect(hbarToTinybar("0.00000001")).toBe(1n);
    expect(hbarToTinybar(" 12.345678 ")).toBe(1_234_567_800n);
  });

  it("rejects zero, negatives, junk and more than 8 decimals", () => {
    for (const bad of ["", "0", "0.0", "-1", "abc", "1.", ".5", "1e3", "1.123456789", "1,5"]) {
      expect(hbarToTinybar(bad), bad).toBeNull();
    }
  });

  it("stays exact for amounts beyond Number precision", () => {
    expect(hbarToTinybar("90071992547.40992")).toBe(9_007_199_254_740_992_000n);
  });
});

describe("tinybarToHbar", () => {
  it("formats and trims trailing zeros", () => {
    expect(tinybarToHbar("100000000")).toBe("1");
    expect(tinybarToHbar("150000000")).toBe("1.5");
    expect(tinybarToHbar("1")).toBe("0.00000001");
    expect(tinybarToHbar(0n)).toBe("0");
  });

  it("round-trips with hbarToTinybar", () => {
    for (const value of ["0.1", "2.25", "1000000", "0.00000042"]) {
      expect(tinybarToHbar(hbarToTinybar(value)!)).toBe(value);
    }
  });
});

describe("tinybarToWeibar", () => {
  it("scales by 1e10 so 1 HBAR is 1e18 weibar", () => {
    expect(tinybarToWeibar(100_000_000n)).toBe(10n ** 18n);
    expect(tinybarToWeibar(1n)).toBe(10_000_000_000n);
  });
});

describe("formatInterval", () => {
  it("formats seconds, minutes, hours and days", () => {
    expect(formatInterval(45)).toBe("45s");
    expect(formatInterval(60)).toBe("1m");
    expect(formatInterval(3600)).toBe("1h");
    expect(formatInterval(5400)).toBe("1h 30m");
    expect(formatInterval(90_000)).toBe("1d 1h");
  });
});

describe("USD helpers", () => {
  it("parses dollars with the same 8-decimal scale as tinybar", () => {
    expect(usdToUnits("10")).toBe(1_000_000_000n);
    expect(usdToUnits("0.01")).toBe(1_000_000n);
    expect(usdToUnits("0")).toBeNull();
    expect(usdToUnits("$10")).toBeNull();
  });

  it("formats dollars with at least two decimals", () => {
    expect(formatUsd(1_000_000_000n)).toBe("$10.00");
    expect(formatUsd("1050000000")).toBe("$10.50");
    expect(formatUsd(1n)).toBe("$0.00000001");
  });

  it("formats Supra's 18-decimal HBAR price", () => {
    expect(formatOraclePrice(103_310_000_000_000_000n)).toBe("$0.1033");
    expect(formatOraclePrice(2_500_000_000_000_000_000n)).toBe("$2.50");
    expect(formatOraclePrice(10_000_000n, 8)).toBe("$0.10");
  });

  it("suggests a cap with headroom, rounded up to a whole HBAR", () => {
    // $10 at $0.1033 is 96.80 HBAR; twice that is 193.6 HBAR, so the cap is 194 HBAR.
    expect(suggestedCapTinybar(9_680_000_000n)).toBe(19_400_000_000n);
    expect(suggestedCapTinybar(10_000_000_000n)).toBe(20_000_000_000n);
    expect(suggestedCapTinybar(10_000_000_000n, 3n)).toBe(30_000_000_000n);
  });
});
