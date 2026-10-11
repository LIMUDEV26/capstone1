import {
  type CSSProperties,
  type FocusEventHandler,
  useEffect,
  useId,
  useMemo,
  useRef,
  useState,
} from 'react';
import {
  AsYouType,
  getCountries,
  getCountryCallingCode,
  parsePhoneNumberFromString,
} from 'libphonenumber-js/min';
import type { CountryCode } from 'libphonenumber-js';
import { DEFAULT_PHONE_COUNTRY_CODE, sanitizeInternationalPhoneDraft } from '@/utils/phone';

type CountryOption = {
  country: CountryCode;
  callingCode: string;
  label: string;
};

const DEFAULT_COUNTRY: CountryCode = 'PH';
const countryNames = typeof Intl.DisplayNames === 'function'
  ? new Intl.DisplayNames(['en'], { type: 'region' })
  : null;

function countryFlag(country: CountryCode): string {
  return country
    .toUpperCase()
    .split('')
    .map((character) => String.fromCodePoint(127397 + character.charCodeAt(0)))
    .join('');
}

const COUNTRY_OPTIONS: CountryOption[] = getCountries()
  .map((country) => {
    const callingCode = getCountryCallingCode(country);
    const name = countryNames?.of(country) || country;
    return {
      country,
      callingCode,
      label: `${countryFlag(country)} ${name} (+${callingCode})`,
    };
  })
  .sort((left, right) => {
    if (left.country === DEFAULT_COUNTRY) return -1;
    if (right.country === DEFAULT_COUNTRY) return 1;
    return left.label.localeCompare(right.label);
  });

const CALLING_CODE_MATCHERS = [...COUNTRY_OPTIONS].sort(
  (left, right) => right.callingCode.length - left.callingCode.length,
);
const COUNTRY_OPTION_BY_CODE = new Map(
  COUNTRY_OPTIONS.map((option) => [option.country, option]),
);

function inferCountry(value: string, fallback: CountryCode = DEFAULT_COUNTRY): CountryCode {
  const draft = sanitizeInternationalPhoneDraft(value);
  if (!draft.startsWith('+')) return fallback;

  const parsed = parsePhoneNumberFromString(draft);
  if (parsed?.country) return parsed.country;

  const digits = draft.slice(1);
  return CALLING_CODE_MATCHERS.find((option) => digits.startsWith(option.callingCode))?.country || fallback;
}

function localDigitsFor(value: string, country: CountryCode): string {
  const draft = sanitizeInternationalPhoneDraft(value);
  const digits = draft.replace(/\D+/g, '');
  const callingCode = getCountryCallingCode(country);

  if (draft.startsWith('+') && digits.startsWith(callingCode)) {
    return digits.slice(callingCode.length);
  }

  return digits;
}

function formatNationalDraft(value: string, country: CountryCode): string {
  const localDigits = localDigitsFor(value, country);
  if (!localDigits) return '';
  return new AsYouType(country).input(localDigits);
}

function buildInternationalDraft(rawLocalValue: string, country: CountryCode): string {
  const callingCode = getCountryCallingCode(country);
  const maxLocalDigits = Math.max(1, 15 - callingCode.length);
  const localDigits = rawLocalValue.replace(/\D+/g, '').slice(0, maxLocalDigits);
  if (!localDigits) return '';

  const formatter = new AsYouType(country);
  formatter.input(localDigits);
  return formatter.getNumber()?.number || `+${callingCode}${localDigits}`;
}

export type PhoneInputProps = {
  value: string;
  onChange: (value: string) => void;
  name?: string;
  id?: string;
  required?: boolean;
  disabled?: boolean;
  invalid?: boolean;
  placeholder?: string;
  autoComplete?: string;
  ariaLabel?: string;
  countryAriaLabel?: string;
  onBlur?: FocusEventHandler<HTMLInputElement>;
  style?: CSSProperties;
  inputStyle?: CSSProperties;
  selectStyle?: CSSProperties;
};

export default function PhoneInput({
  value,
  onChange,
  name,
  id,
  required = false,
  disabled = false,
  invalid = false,
  placeholder = 'Phone number',
  autoComplete = 'tel',
  ariaLabel = 'Phone number',
  countryAriaLabel = 'Country calling code',
  onBlur,
  style,
  inputStyle,
  selectStyle,
}: PhoneInputProps) {
  const generatedId = useId();
  const inputId = id || generatedId;
  const [country, setCountry] = useState<CountryCode>(() => inferCountry(value));
  const [countryPickerOpen, setCountryPickerOpen] = useState(false);
  const [countrySearch, setCountrySearch] = useState('');
  const countryPickerRef = useRef<HTMLDivElement>(null);
  const selectedCallingCode = getCountryCallingCode(country);
  const selectedCountry = COUNTRY_OPTION_BY_CODE.get(country);
  const filteredCountries = useMemo(() => {
    const query = countrySearch.trim().toLowerCase().replace(/^\+/, '');
    if (!query) return COUNTRY_OPTIONS;

    return COUNTRY_OPTIONS.filter((option) => (
      option.label.toLowerCase().includes(query)
      || option.country.toLowerCase().includes(query)
      || option.callingCode.includes(query)
    ));
  }, [countrySearch]);

  useEffect(() => {
    const draft = sanitizeInternationalPhoneDraft(value);
    if (!draft.startsWith('+')) return;
    if (draft.slice(1).startsWith(selectedCallingCode)) return;

    const inferred = inferCountry(draft, country);
    if (inferred !== country) setCountry(inferred);
  }, [country, selectedCallingCode, value]);

  useEffect(() => {
    if (!countryPickerOpen) return;

    const closeOnOutsideClick = (event: MouseEvent) => {
      if (!countryPickerRef.current?.contains(event.target as Node)) {
        setCountryPickerOpen(false);
        setCountrySearch('');
      }
    };
    const closeOnEscape = (event: KeyboardEvent) => {
      if (event.key === 'Escape') {
        setCountryPickerOpen(false);
        setCountrySearch('');
      }
    };

    document.addEventListener('mousedown', closeOnOutsideClick);
    document.addEventListener('keydown', closeOnEscape);
    return () => {
      document.removeEventListener('mousedown', closeOnOutsideClick);
      document.removeEventListener('keydown', closeOnEscape);
    };
  }, [countryPickerOpen]);

  const handleCountryChange = (nextCountry: CountryCode) => {
    const localDigits = localDigitsFor(value, country);
    setCountry(nextCountry);
    setCountryPickerOpen(false);
    setCountrySearch('');
    onChange(buildInternationalDraft(localDigits, nextCountry));
  };

  return (
    <div
      style={{
        display: 'flex',
        width: '100%',
        minWidth: 0,
        gap: 8,
        ...style,
      }}
    >
      <div ref={countryPickerRef} style={{ position: 'relative', flexShrink: 0 }}>
        <button
          type="button"
          onClick={() => {
            setCountryPickerOpen((open) => !open);
            setCountrySearch('');
          }}
          disabled={disabled}
          aria-label={countryAriaLabel}
          aria-haspopup="listbox"
          aria-expanded={countryPickerOpen}
          aria-controls={`${inputId}-country-list`}
          title={selectedCountry?.label || `Country calling code: +${selectedCallingCode}`}
          style={{
            width: 116,
            minWidth: 108,
            height: '100%',
            padding: '9px 8px',
            borderRadius: 7,
            border: invalid ? '2px solid #ef4444' : '1px solid #d1d5db',
            color: '#111827',
            backgroundColor: disabled ? '#f1f5f9' : '#fff',
            fontSize: 13,
            cursor: disabled ? 'not-allowed' : 'pointer',
            whiteSpace: 'nowrap',
            ...selectStyle,
          }}
        >
          {countryFlag(country)} +{selectedCallingCode} <span aria-hidden="true">▾</span>
        </button>

        {countryPickerOpen ? (
          <div
            style={{
              position: 'absolute',
              top: 'calc(100% + 5px)',
              left: 0,
              zIndex: 1200,
              width: 286,
              maxWidth: 'min(286px, calc(100vw - 32px))',
              padding: 8,
              border: '1px solid #cbd5e1',
              borderRadius: 9,
              background: '#fff',
              boxShadow: '0 12px 30px rgba(15, 23, 42, 0.18)',
            }}
          >
            <input
              type="search"
              value={countrySearch}
              onChange={(event) => setCountrySearch(event.target.value)}
              placeholder="Search country or +code"
              aria-label="Search country calling codes"
              autoFocus
              style={{
                width: '100%',
                padding: '6px 8px',
                border: '1px solid #cbd5e1',
                borderRadius: 6,
                color: '#0f172a',
                background: '#fff',
                fontSize: 12,
                outline: 'none',
              }}
            />

            <div
              id={`${inputId}-country-list`}
              role="listbox"
              aria-label="Country calling codes"
              style={{ maxHeight: 220, overflowY: 'auto', marginTop: 6 }}
            >
              {filteredCountries.length > 0 ? filteredCountries.map((option) => (
                <button
                  key={option.country}
                  type="button"
                  role="option"
                  aria-selected={option.country === country}
                  onClick={() => handleCountryChange(option.country)}
                  style={{
                    display: 'block',
                    width: '100%',
                    padding: '7px 8px',
                    border: 0,
                    borderRadius: 5,
                    color: '#1e293b',
                    background: option.country === country ? '#eff6ff' : 'transparent',
                    textAlign: 'left',
                    fontSize: 12,
                    cursor: 'pointer',
                  }}
                >
                  {option.label}
                </button>
              )) : (
                <div style={{ padding: '10px 8px', color: '#64748b', fontSize: 12 }}>
                  No country code found.
                </div>
              )}
            </div>
          </div>
        ) : null}
      </div>

      <input
        id={inputId}
        type="tel"
        name={name}
        value={formatNationalDraft(value, country)}
        onChange={(event) => onChange(buildInternationalDraft(event.target.value, country))}
        onBlur={onBlur}
        inputMode="tel"
        autoComplete={autoComplete}
        placeholder={placeholder}
        maxLength={24}
        required={required}
        disabled={disabled}
        aria-required={required || undefined}
        aria-invalid={invalid || undefined}
        aria-label={ariaLabel}
        style={{
          flex: 1,
          minWidth: 0,
          padding: '9px 12px',
          borderRadius: 7,
          border: invalid ? '2px solid #ef4444' : '1px solid #d1d5db',
          color: '#111827',
          backgroundColor: disabled ? '#f1f5f9' : '#fff',
          fontSize: 13,
          ...inputStyle,
        }}
      />
    </div>
  );
}

export { DEFAULT_PHONE_COUNTRY_CODE };
