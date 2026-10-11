export const DEFAULT_PHONE_COUNTRY_CODE = '+63';

function sanitizeCountryCode(value: unknown, fallback = DEFAULT_PHONE_COUNTRY_CODE): string {
    const raw = String(value ?? '').trim();
    const digits = raw.replace(/\D+/g, '');
    if (!digits) {
        return fallback;
    }
    return `+${digits}`;
}

// E.164 permits at most 15 digits after the leading plus sign.
const E164_MAX_DIGITS = 15;
const PH_PREFIX = '+63';

export function sanitizeInternationalPhoneDraft(value: unknown): string {
    const raw = String(value ?? '');
    if (!raw) return '';

    let sanitized = raw.replace(/[^\d+]/g, '');
    if (sanitized.startsWith('00')) {
        sanitized = `+${sanitized.slice(2)}`;
    }

    if (sanitized.startsWith('+')) {
        sanitized = `+${sanitized.slice(1).replace(/\+/g, '')}`;
    } else {
        sanitized = sanitized.replace(/\+/g, '');
    }

    const hasInternationalPrefix = sanitized.startsWith('+');
    const digits = sanitized.replace(/\D+/g, '').slice(0, E164_MAX_DIGITS);
    if (!digits) {
        return hasInternationalPrefix ? '+' : '';
    }

    return hasInternationalPrefix ? `+${digits}` : digits;
}

/**
 * Sanitize a phone draft while locking the +63 prefix.
 * - Always starts with +63
 * - Only digits are allowed after the prefix
 * - Capped at +63 + 10 digits = 13 chars total
 * Use this as the onChange handler value for all PH phone inputs.
 */
export function sanitizePhoneWithPrefix(value: unknown): string {
    const raw = String(value ?? '');

    // Strip everything that isn't a digit or leading +
    let digits = raw.replace(/[^\d]/g, '');

    // If the user's input already contained the country code digits (63...) keep only what follows
    if (digits.startsWith('63')) {
        digits = digits.slice(2);
    }

    // Cap to 10 local digits
    if (digits.length > 10) {
        digits = digits.slice(0, 10);
    }

    return PH_PREFIX + digits;
}

export function isPhoneDraftEmpty(value: unknown, defaultCountryCode = DEFAULT_PHONE_COUNTRY_CODE): boolean {
    const draft = sanitizeInternationalPhoneDraft(value).trim();
    const countryCode = sanitizeCountryCode(defaultCountryCode);
    return draft === '' || draft === '+' || draft === countryCode;
}

export function normalizeInternationalPhoneNumber(
    value: unknown,
    defaultCountryCode = DEFAULT_PHONE_COUNTRY_CODE
): string {
    const fallbackCode = sanitizeCountryCode(defaultCountryCode);
    const fallbackDigits = fallbackCode.slice(1);
    let draft = sanitizeInternationalPhoneDraft(value).trim();

    if (draft === '' || draft === '+' || draft === fallbackCode) {
        return '';
    }

    if (!draft.startsWith('+')) {
        const digits = draft.replace(/\D+/g, '');
        if (!digits) return '';

        const normalizedLocalDigits = digits.replace(/^0+/, '') || digits;
        if (normalizedLocalDigits.startsWith(fallbackDigits)) {
            draft = `+${normalizedLocalDigits}`;
        } else {
            draft = `${fallbackCode}${normalizedLocalDigits}`;
        }
    }

    const digits = draft.slice(1).replace(/\D+/g, '');
    if (!/^[1-9]\d{6,14}$/.test(digits)) {
        return '';
    }

    // Philippine numbers: +63 must be followed by exactly 10 digits (e.g. +639XXXXXXXXX)
    if (digits.startsWith('63') && digits.length !== 12) {
        return '';
    }

    return `+${digits}`;
}

export function isValidInternationalPhoneNumber(
    value: unknown,
    defaultCountryCode = DEFAULT_PHONE_COUNTRY_CODE
): boolean {
    return normalizeInternationalPhoneNumber(value, defaultCountryCode) !== '';
}

export function getPhoneInputDefault(
    value: unknown,
    defaultCountryCode = DEFAULT_PHONE_COUNTRY_CODE
): string {
    const normalized = normalizeInternationalPhoneNumber(value, defaultCountryCode);
    if (normalized) return normalized;

    const draft = sanitizeInternationalPhoneDraft(value).trim();
    const countryCode = sanitizeCountryCode(defaultCountryCode);
    if (!draft) return countryCode;
    if (draft.startsWith('+')) return draft;

    const digits = draft.replace(/\D+/g, '');
    if (!digits) return countryCode;

    const normalizedLocalDigits = digits.replace(/^0+/, '') || digits;
    return `${countryCode}${normalizedLocalDigits}`;
}

// Backward-compatible aliases for existing imports.
export function normalizePhilippineMobileNumber(value: unknown): string {
    return normalizeInternationalPhoneNumber(value, DEFAULT_PHONE_COUNTRY_CODE);
}

export function isValidPhilippineMobileNumber(value: unknown): boolean {
    return isValidInternationalPhoneNumber(value, DEFAULT_PHONE_COUNTRY_CODE);
}

/**
 * Format a PH mobile number for display grouped as +63985 323 4710.
 * - Local 10 digits are grouped 3-3-4 after the +63 prefix, which renders as
 *   "+63985 323 4710" (first visual chunk is +63 + first 3 digits).
 * - This matches the local 4-3-4 grouping (e.g. 0985 323 4710) in +63 form.
 * - Partial drafts are grouped progressively while typing.
 * - Non-PH values are returned as-is (trimmed).
 * - Storage stays normalized (no spaces); use this for display/value only.
 */
export function formatInternationalPhoneDisplay(value: unknown): string {
    const raw = String(value ?? '').trim();
    if (!raw) return '';
    if (raw === '+' || raw === '+63' || raw === '+6') return raw;

    let digits = raw.replace(/\D+/g, '');
    if (!digits) return raw.startsWith('+') ? '+' : '';

    // Convert local 09XXXXXXXXX (11 digits) to 63XXXXXXXXXX for display.
    if (digits.startsWith('0') && digits.length >= 11 && digits.length <= 12) {
        const withoutZero = digits.replace(/^0+/, '');
        if (withoutZero.length === 10) {
            digits = `63${withoutZero}`;
        }
    }

    if (digits.startsWith('63')) {
        const local = digits.slice(2).slice(0, 10);
        if (!local) return PH_PREFIX;
        const p1 = local.slice(0, 3);
        const p2 = local.slice(3, 6);
        const p3 = local.slice(6, 10);
        if (local.length <= 3) return `${PH_PREFIX}${p1}`;
        if (local.length <= 6) return `${PH_PREFIX}${p1} ${p2}`;
        return `${PH_PREFIX}${p1} ${p2} ${p3}`.trimEnd();
    }

    // Non-PH: preserve a single leading + and digits.
    return raw.startsWith('+') ? `+${digits}` : digits;
}

// Convenient aliases used across mobile-number inputs and read-only views.
export function formatPhilippineMobileDisplay(value: unknown): string {
    return formatInternationalPhoneDisplay(value);
}

export function formatPhoneDisplay(value: unknown): string {
    return formatInternationalPhoneDisplay(value);
}
