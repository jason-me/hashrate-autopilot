import { bech32, bech32m } from 'bech32';

/**
 * Validate a mainnet Bitcoin **payout** address (#309).
 *
 * We accept exactly the address types the daemon's electrs payout path
 * can actually track: native SegWit bech32 (P2WPKH `bc1q…` / P2WSH) and
 * Taproot bech32m (`bc1p…`). Legacy base58 (`1…` / `3…`) and testnet
 * (`tb1…`) are rejected on purpose - `addressToScriptPubKey` in the
 * electrs client only derives a scripthash for mainnet bech32(m), so
 * accepting anything else would silently break payout tracking (and,
 * via the worker identity sent to Datum/Ocean, Ocean crediting).
 *
 * This exists because the field used to accept any non-empty string: a
 * stray `c` was saved as the payout address, the worker identity became
 * `c.plebs-pilot`, and the rented hashrate mined under an invalid
 * identity that Ocean credits to nobody. Same validator is used by the
 * Config form, the first-run wizard, and the config-save API gate.
 */
export function isValidBtcPayoutAddress(address: string): boolean {
  const addr = address.trim();
  if (!addr) return false;
  const lower = addr.toLowerCase();
  try {
    // Taproot / witness v1: bech32m, 32-byte program.
    if (lower.startsWith('bc1p')) {
      const decoded = bech32m.decode(addr);
      if (decoded.prefix !== 'bc') return false;
      const version = decoded.words[0];
      if (version === undefined) return false;
      const program = bech32m.fromWords(decoded.words.slice(1));
      return version === 1 && program.length === 32;
    }
    // Native SegWit witness v0: bech32, 20-byte (P2WPKH) or 32-byte (P2WSH).
    if (lower.startsWith('bc1')) {
      const decoded = bech32.decode(addr);
      if (decoded.prefix !== 'bc') return false;
      const version = decoded.words[0];
      if (version === undefined) return false;
      const program = bech32.fromWords(decoded.words.slice(1));
      return version === 0 && (program.length === 20 || program.length === 32);
    }
    return false;
  } catch {
    return false;
  }
}
