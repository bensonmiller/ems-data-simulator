import seedrandom from "seedrandom";

/**
 * Seedable PRNG wrapper that mirrors Python's random.Random interface.
 * All methods are deterministic given the same seed.
 */
export class SeededRandom {
  /**
   * @param {string|number} seed - Any string or number seed.
   */
  constructor(seed) {
    this._rng = seedrandom(String(seed), { state: true });
    this._spare = null; // cached value for Box-Muller
  }

  /** Uniform float in [0, 1). */
  random() {
    return this._rng();
  }

  /**
   * Gaussian-distributed float via Box-Muller transform.
   * @param {number} mu - Mean.
   * @param {number} sigma - Standard deviation.
   */
  gauss(mu, sigma) {
    // Box-Muller produces two values; cache the spare.
    if (this._spare !== null) {
      const val = this._spare;
      this._spare = null;
      return mu + sigma * val;
    }
    let u, v, s;
    do {
      u = this._rng() * 2 - 1;
      v = this._rng() * 2 - 1;
      s = u * u + v * v;
    } while (s >= 1 || s === 0);
    const f = Math.sqrt((-2 * Math.log(s)) / s);
    this._spare = v * f;
    return mu + sigma * u * f;
  }

  /**
   * Random integer in [a, b] inclusive.
   * @param {number} a
   * @param {number} b
   */
  randint(a, b) {
    return a + Math.floor(this._rng() * (b - a + 1));
  }

  /**
   * Uniform float in [a, b].
   * @param {number} a
   * @param {number} b
   */
  uniform(a, b) {
    return a + this._rng() * (b - a);
  }

  /**
   * Poisson-distributed integer via Knuth's algorithm.
   * @param {number} lam - Lambda (expected value).
   */
  poisson(lam) {
    const L = Math.exp(-lam);
    let k = 0;
    let p = 1;
    do {
      k++;
      p *= this._rng();
    } while (p > L);
    return k - 1;
  }

  /**
   * Random element from an array.
   * @param {Array} array
   */
  choice(array) {
    if (array.length === 0) {
      throw new Error("Cannot choose from an empty array");
    }
    return array[Math.floor(this._rng() * array.length)];
  }

  /**
   * Save the full RNG state (including the Box-Muller spare).
   * @returns {object} Opaque state object.
   */
  getState() {
    return {
      rng: this._rng.state(),
      spare: this._spare,
    };
  }

  /**
   * Restore a previously saved RNG state.
   * @param {object} state - State object from getState().
   */
  setState(state) {
    this._rng = seedrandom("", { state: state.rng });
    this._spare = state.spare;
  }
}
