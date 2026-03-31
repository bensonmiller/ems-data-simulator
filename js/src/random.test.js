import { describe, it, expect } from "vitest";
import { SeededRandom } from "./random.js";

describe("SeededRandom", () => {
  describe("determinism", () => {
    it("same seed produces identical sequence of 100 values", () => {
      const a = new SeededRandom("test-seed");
      const b = new SeededRandom("test-seed");
      const seqA = Array.from({ length: 100 }, () => a.random());
      const seqB = Array.from({ length: 100 }, () => b.random());
      expect(seqA).toEqual(seqB);
    });

    it("different seeds produce different sequences", () => {
      const a = new SeededRandom("seed-1");
      const b = new SeededRandom("seed-2");
      const seqA = Array.from({ length: 20 }, () => a.random());
      const seqB = Array.from({ length: 20 }, () => b.random());
      expect(seqA).not.toEqual(seqB);
    });

    it("numeric seed works the same way each time", () => {
      const a = new SeededRandom(42);
      const b = new SeededRandom(42);
      expect(Array.from({ length: 50 }, () => a.random())).toEqual(
        Array.from({ length: 50 }, () => b.random()),
      );
    });
  });

  describe("gauss(mu, sigma)", () => {
    it("produces values with correct mean and std dev", () => {
      const rng = new SeededRandom("gauss-test");
      const mu = 5;
      const sigma = 2;
      const N = 10_000;
      const samples = Array.from({ length: N }, () => rng.gauss(mu, sigma));

      const mean = samples.reduce((s, v) => s + v, 0) / N;
      const variance =
        samples.reduce((s, v) => s + (v - mean) ** 2, 0) / (N - 1);
      const std = Math.sqrt(variance);

      expect(mean).toBeCloseTo(mu, 0); // within ~0.05
      expect(std).toBeCloseTo(sigma, 0);
    });
  });

  describe("poisson(lam)", () => {
    it("produces non-negative integers with correct mean", () => {
      const rng = new SeededRandom("poisson-test");
      const lam = 4;
      const N = 10_000;
      const samples = Array.from({ length: N }, () => rng.poisson(lam));

      // All non-negative integers
      for (const s of samples) {
        expect(Number.isInteger(s)).toBe(true);
        expect(s).toBeGreaterThanOrEqual(0);
      }

      const mean = samples.reduce((s, v) => s + v, 0) / N;
      expect(Math.abs(mean - lam)).toBeLessThan(0.2);
    });
  });

  describe("randint(a, b)", () => {
    it("all values in [a, b] with roughly uniform distribution", () => {
      const rng = new SeededRandom("randint-test");
      const a = 3;
      const b = 7;
      const N = 10_000;
      const counts = {};
      for (let i = a; i <= b; i++) counts[i] = 0;

      for (let i = 0; i < N; i++) {
        const v = rng.randint(a, b);
        expect(v).toBeGreaterThanOrEqual(a);
        expect(v).toBeLessThanOrEqual(b);
        expect(Number.isInteger(v)).toBe(true);
        counts[v]++;
      }

      // Each bucket should get roughly N/(b-a+1) = 2000 hits.
      // Allow +-30% tolerance.
      const expected = N / (b - a + 1);
      for (let i = a; i <= b; i++) {
        expect(counts[i]).toBeGreaterThan(expected * 0.7);
        expect(counts[i]).toBeLessThan(expected * 1.3);
      }
    });
  });

  describe("uniform(a, b)", () => {
    it("values lie within [a, b]", () => {
      const rng = new SeededRandom("uniform-test");
      for (let i = 0; i < 1000; i++) {
        const v = rng.uniform(2.5, 7.5);
        expect(v).toBeGreaterThanOrEqual(2.5);
        expect(v).toBeLessThanOrEqual(7.5);
      }
    });
  });

  describe("choice(array)", () => {
    it("returns elements from the array, deterministically", () => {
      const items = ["a", "b", "c", "d"];
      const a = new SeededRandom("choice-test");
      const b = new SeededRandom("choice-test");
      const seqA = Array.from({ length: 50 }, () => a.choice(items));
      const seqB = Array.from({ length: 50 }, () => b.choice(items));
      expect(seqA).toEqual(seqB);
      // Every result should be in the source array
      for (const v of seqA) {
        expect(items).toContain(v);
      }
    });

    it("throws on empty array", () => {
      const rng = new SeededRandom("empty");
      expect(() => rng.choice([])).toThrow();
    });
  });

  describe("getState / setState", () => {
    it("restoring state reproduces the same future sequence", () => {
      const rng = new SeededRandom("state-test");
      // Advance the RNG a bit
      for (let i = 0; i < 20; i++) rng.random();

      const state = rng.getState();
      const after = Array.from({ length: 50 }, () => rng.random());

      rng.setState(state);
      const replayed = Array.from({ length: 50 }, () => rng.random());

      expect(replayed).toEqual(after);
    });

    it("preserves gauss spare across save/restore", () => {
      const rng = new SeededRandom("spare-test");
      // Call gauss once to populate the spare
      rng.gauss(0, 1);

      const state = rng.getState();
      const val1 = rng.gauss(0, 1);

      rng.setState(state);
      const val2 = rng.gauss(0, 1);

      expect(val2).toBe(val1);
    });
  });
});
