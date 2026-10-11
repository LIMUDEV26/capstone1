/**
 * Strong password generator for "suggest a password" UX (Google-style).
 *
 * Generated passwords always satisfy the server policy enforced in
 * api/password_policy_utils.php + api/auth.php:
 * - at least 8 characters
 * - at least one uppercase letter
 * - at least one number
 * - at least one special character
 */

const LOWER = 'abcdefghjkmnpqrstuvwxyz';
const UPPER = 'ABCDEFGHJKMNPQRSTUVWXYZ';
const DIGITS = '23456789';
const SYMBOLS = '!@#$%^&*()-_=+[]{};:,.<>?';

const ALL = LOWER + UPPER + DIGITS + SYMBOLS;

export const SUGGESTED_PASSWORD_LENGTH = 14;
export const SUGGESTED_PASSWORD_COUNT = 3;

function randomInt(max: number): number {
    if (max <= 0) return 0;
    // Crypto-strength randomness when available (browser / Node 19+).
    try {
        const cryptoObj =
            (typeof globalThis !== 'undefined' &&
                (globalThis as unknown as { crypto?: Crypto }).crypto) ||
            undefined;
        if (cryptoObj && typeof cryptoObj.getRandomValues === 'function') {
            const buf = new Uint32Array(1);
            // Rejection sampling to avoid modulo bias.
            const limit = Math.floor(0xffffffff / max) * max;
            for (;;) {
                cryptoObj.getRandomValues(buf);
                const v = buf[0];
                if (v < limit) return v % max;
            }
        }
    } catch {
        /* fall through to Math.random */
    }
    return Math.floor(Math.random() * max);
}

function pickFrom(chars: string): string {
    return chars[randomInt(chars.length)];
}

/** Generate one strong password with a guaranteed mix of character classes. */
export function generateStrongPassword(length: number = SUGGESTED_PASSWORD_LENGTH): string {
    const size = Math.max(12, Math.floor(length) || SUGGESTED_PASSWORD_LENGTH);
    const chars: string[] = [
        pickFrom(UPPER),
        pickFrom(LOWER),
        pickFrom(DIGITS),
        pickFrom(SYMBOLS),
    ];
    while (chars.length < size) {
        chars.push(pickFrom(ALL));
    }
    // Fisher–Yates shuffle so the guaranteed classes are not in fixed positions.
    for (let i = chars.length - 1; i > 0; i -= 1) {
        const j = randomInt(i + 1);
        [chars[i], chars[j]] = [chars[j], chars[i]];
    }
    return chars.join('');
}

/** Generate N distinct strong password suggestions. */
export function generatePasswordSuggestions(count: number = SUGGESTED_PASSWORD_COUNT): string[] {
    const total = Math.max(1, Math.min(5, Math.floor(count) || SUGGESTED_PASSWORD_COUNT));
    const seen = new Set<string>();
    const out: string[] = [];
    let guard = 0;
    while (out.length < total && guard < 50) {
        guard += 1;
        const pwd = generateStrongPassword();
        if (!seen.has(pwd)) {
            seen.add(pwd);
            out.push(pwd);
        }
    }
    return out;
}

/** Client-side mirror of the server password policy check. */
export function isPolicyCompliantPassword(value: string): boolean {
    return (
        value.length >= 8 &&
        /[A-Z]/.test(value) &&
        /[0-9]/.test(value) &&
        /[^A-Za-z0-9]/.test(value)
    );
}
