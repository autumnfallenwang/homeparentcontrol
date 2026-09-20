import { enrolmentCode } from "@hpc/contract";
import { describe, expect, it } from "vitest";
import {
  enrolmentCodeHint,
  generateEnrolmentCode,
  hashEnrolmentCode,
  normaliseEnrolmentCode,
} from "./enrolment-codes.js";

describe("generateEnrolmentCode", () => {
  it("matches the contract's display form", () => {
    for (let i = 0; i < 50; i++) {
      expect(enrolmentCode.safeParse(generateEnrolmentCode()).success).toBe(true);
    }
  });

  it("never emits a Crockford look-alike", () => {
    // I, L, O and U are excluded precisely so a parent reading this aloud or
    // off a screen cannot produce an ambiguous character.
    const sample = Array.from({ length: 200 }, generateEnrolmentCode).join("");
    expect(sample).not.toMatch(/[ILOU]/);
  });

  it("does not repeat", () => {
    const codes = new Set(Array.from({ length: 500 }, generateEnrolmentCode));
    expect(codes.size).toBe(500);
  });

  it("uses the whole alphabet", () => {
    // A masking bug that clipped the alphabet would still pass the regex.
    const seen = new Set(Array.from({ length: 2000 }, generateEnrolmentCode).join("").split(""));
    seen.delete("H");
    seen.delete("P");
    seen.delete("C");
    seen.delete("-");
    expect(seen.size).toBeGreaterThan(28); // 32 minus the few a sample may miss
  });
});

describe("normaliseEnrolmentCode", () => {
  const CODE = "HPC-K7QM-3ZTD-9F2W";

  it("accepts the canonical form unchanged", () => {
    expect(normaliseEnrolmentCode(CODE)).toBe(CODE);
  });

  it("forgives case, spaces and missing hyphens", () => {
    expect(normaliseEnrolmentCode("hpc-k7qm-3ztd-9f2w")).toBe(CODE);
    expect(normaliseEnrolmentCode("HPC K7QM 3ZTD 9F2W")).toBe(CODE);
    expect(normaliseEnrolmentCode("K7QM3ZTD9F2W")).toBe(CODE);
    expect(normaliseEnrolmentCode("  hpcK7QM 3ztd-9F2W  ")).toBe(CODE);
  });

  it("folds Crockford look-alikes", () => {
    // Typing O for 0 or l for 1 is the whole reason the alphabet omits them.
    expect(normaliseEnrolmentCode("HPC-O123-4567-89AB")).toBe("HPC-0123-4567-89AB");
    expect(normaliseEnrolmentCode("HPC-I123-4567-89AB")).toBe("HPC-1123-4567-89AB");
    expect(normaliseEnrolmentCode("HPC-l123-4567-89AB")).toBe("HPC-1123-4567-89AB");
  });

  it("rejects the wrong length", () => {
    expect(normaliseEnrolmentCode("HPC-K7QM-3ZTD")).toBeNull();
    expect(normaliseEnrolmentCode("HPC-K7QM-3ZTD-9F2W-EXTRA")).toBeNull();
    expect(normaliseEnrolmentCode("")).toBeNull();
  });

  it("rejects characters outside the alphabet", () => {
    expect(normaliseEnrolmentCode("HPC-K7QM-3ZTD-9F2!")).toBeNull();
    expect(normaliseEnrolmentCode("HPC-K7QM-3ZTD-9F2U")).toBeNull(); // U is not Crockford
  });

  it("round-trips anything it generates", () => {
    for (let i = 0; i < 100; i++) {
      const code = generateEnrolmentCode();
      expect(normaliseEnrolmentCode(code)).toBe(code);
      expect(normaliseEnrolmentCode(code.toLowerCase().replace(/-/g, ""))).toBe(code);
    }
  });
});

describe("hashEnrolmentCode", () => {
  it("is a 64-char hex sha256", () => {
    expect(hashEnrolmentCode("HPC-K7QM-3ZTD-9F2W")).toMatch(/^[0-9a-f]{64}$/);
  });

  it("gives every spelling of one code the SAME hash", () => {
    // The single-use guarantee is UNIQUE(code_hash). Two spellings hashing
    // differently would silently let one code be redeemed twice.
    const spellings = ["HPC-K7QM-3ZTD-9F2W", "hpc k7qm 3ztd 9f2w", "K7QM3ZTD9F2W"];
    const hashes = spellings.map((s) => hashEnrolmentCode(normaliseEnrolmentCode(s) as string));
    expect(new Set(hashes).size).toBe(1);
  });

  it("gives different codes different hashes", () => {
    expect(hashEnrolmentCode("HPC-K7QM-3ZTD-9F2W")).not.toBe(
      hashEnrolmentCode("HPC-K7QM-3ZTD-9F2X"),
    );
  });
});

describe("enrolmentCodeHint", () => {
  it("keeps the first group only", () => {
    expect(enrolmentCodeHint("HPC-K7QM-3ZTD-9F2W")).toBe("HPC-K7QM");
  });

  it("is not enough to redeem — it omits two thirds of the entropy", () => {
    const code = generateEnrolmentCode();
    expect(enrolmentCodeHint(code).length).toBeLessThan(code.length);
    expect(hashEnrolmentCode(enrolmentCodeHint(code))).not.toBe(hashEnrolmentCode(code));
  });
});
