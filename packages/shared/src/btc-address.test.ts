import { describe, it, expect } from 'vitest';

import { isValidBtcPayoutAddress } from './btc-address.js';

describe('isValidBtcPayoutAddress', () => {
  it('accepts a valid mainnet P2WPKH (bc1q…) address', () => {
    // The operator's real Ocean payout address.
    expect(isValidBtcPayoutAddress('bc1qux2aehp5ny89l9spguf052x84zm8h9uyfqvgdg')).toBe(true);
  });

  it('accepts a valid mainnet Taproot (bc1p…) address', () => {
    expect(
      isValidBtcPayoutAddress(
        'bc1p5cyxnuxmeuwuvkwfem96lqzszd02n6xdcjrs20cac6yqjjwudpxqkedrcr',
      ),
    ).toBe(true);
  });

  it('trims surrounding whitespace before validating', () => {
    expect(isValidBtcPayoutAddress('  bc1qux2aehp5ny89l9spguf052x84zm8h9uyfqvgdg  ')).toBe(true);
  });

  it('rejects the bug that started this: a bare "c"', () => {
    expect(isValidBtcPayoutAddress('c')).toBe(false);
  });

  it('rejects empty / whitespace-only input', () => {
    expect(isValidBtcPayoutAddress('')).toBe(false);
    expect(isValidBtcPayoutAddress('   ')).toBe(false);
  });

  it('rejects an otherwise-valid address with a corrupted checksum', () => {
    // Last char flipped - valid charset, bad checksum.
    expect(isValidBtcPayoutAddress('bc1qux2aehp5ny89l9spguf052x84zm8h9uyfqvgdh')).toBe(false);
  });

  it('rejects legacy base58 addresses (electrs path cannot track them)', () => {
    expect(isValidBtcPayoutAddress('1A1zP1eP5QGefi2DMPTfTL5SLmv7DivfNa')).toBe(false); // P2PKH
    expect(isValidBtcPayoutAddress('3J98t1WpEZ73CNmQviecrnyiWrnqRhWNLy')).toBe(false); // P2SH
  });

  it('rejects testnet bech32 (tb1…)', () => {
    expect(isValidBtcPayoutAddress('tb1qw508d6qejxtdg4y5r3zarvary0c5xw7kxpjzsx')).toBe(false);
  });

  it('rejects obvious non-addresses', () => {
    expect(isValidBtcPayoutAddress('not an address')).toBe(false);
    expect(isValidBtcPayoutAddress('bc1')).toBe(false);
    expect(isValidBtcPayoutAddress('bc1qz')).toBe(false);
  });
});
