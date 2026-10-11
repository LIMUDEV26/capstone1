import { useRef, type CSSProperties, type ClipboardEvent, type KeyboardEvent } from 'react';

type OtpInputProps = {
    /** Combined value across all boxes (single source of truth). */
    value: string;
    /** Called with the next combined value whenever any box changes/pastes. */
    onChange: (next: string) => void;
    /** Number of boxes. Defaults to 6. */
    length?: number;
    /** 'numeric' keeps 0-9 only; 'alpha' keeps A-Z (uppercased). Defaults to 'numeric'. */
    mode?: 'numeric' | 'alpha';
    disabled?: boolean;
    autoFocus?: boolean;
    id?: string;
    ariaLabel?: string;
    autoComplete?: string;
    containerStyle?: CSSProperties;
    inputStyle?: CSSProperties;
    placeholder?: string;
};

function sanitizeChunk(chunk: string, mode: 'numeric' | 'alpha'): string {
    if (mode === 'alpha') {
        return chunk.toUpperCase().replace(/[^A-Z]/g, '');
    }
    return chunk.replace(/\D/g, '');
}

/**
 * Split-box OTP/code input: 1 character per box, single combined value.
 * - Typing a char fills the box and auto-advances.
 * - Backspace on an empty box jumps back and clears the previous box.
 * - Pasting a full code fills all boxes from the paste position.
 */
export default function OtpInput({
    value,
    onChange,
    length = 6,
    mode = 'numeric',
    disabled = false,
    autoFocus = false,
    id,
    ariaLabel,
    autoComplete = 'one-time-code',
    containerStyle,
    inputStyle,
    placeholder,
}: OtpInputProps) {
    const inputsRef = useRef<Array<HTMLInputElement | null>>([]);
    const size = Math.max(1, Math.floor(length));

    const chars = Array.from({ length: size }, (_, i) => sanitizeChunk(String(value ?? '')[i] ?? '', mode).slice(0, 1));

    const focusBox = (index: number) => {
        const clamped = Math.max(0, Math.min(size - 1, index));
        const el = inputsRef.current[clamped];
        if (el) {
            el.focus();
            try {
                el.select();
            } catch {
                /* noop */
            }
        }
    };

    const emitChars = (nextChars: string[]) => {
        onChange(nextChars.slice(0, size).join(''));
    };

    const fillFrom = (index: number, clean: string) => {
        const incoming = clean.slice(0, size - index).split('');
        if (incoming.length === 0) return;
        const next = [...chars];
        for (let i = 0; i < incoming.length; i += 1) {
            next[index + i] = incoming[i];
        }
        emitChars(next);
        // Land on the first empty box after the pasted chunk, else the last box.
        const firstEmpty = next.findIndex((c) => !c);
        requestAnimationFrame(() => focusBox(firstEmpty === -1 ? size - 1 : firstEmpty));
    };

    const handleBoxChange = (index: number, raw: string) => {
        const clean = sanitizeChunk(raw, mode);
        if (!clean) {
            // Cleared (or invalid char typed) — clear this box only.
            if (raw === '') {
                const next = [...chars];
                next[index] = '';
                emitChars(next);
            }
            return;
        }
        if (clean.length === 1) {
            // Normal keystroke (input is select-all on focus, so typing
            // replaces the content with a single char).
            const next = [...chars];
            next[index] = clean;
            emitChars(next);
            if (index < size - 1) {
                // Defer so state paints before moving focus.
                requestAnimationFrame(() => focusBox(index + 1));
            }
            return;
        }
        if (clean.length === 2 && chars[index] !== '') {
            // Typed over a filled box without selection (e.g. "35" over "3"):
            // keep the new character, not the old one.
            const other = clean[0] === chars[index] ? clean[1] : clean[0];
            const next = [...chars];
            next[index] = other ?? clean.slice(-1);
            emitChars(next);
            if (index < size - 1) {
                requestAnimationFrame(() => focusBox(index + 1));
            }
            return;
        }
        // Multi-char (paste / autofill / drop): distribute across boxes.
        fillFrom(index, clean);
    };

    const handleBoxKeyDown = (index: number, e: KeyboardEvent<HTMLInputElement>) => {
        if (e.key === 'Backspace') {
            if (chars[index]) {
                // Box has a value — clear it and stay.
                e.preventDefault();
                const next = [...chars];
                next[index] = '';
                emitChars(next);
            } else if (index > 0) {
                // Empty box — jump back and clear the previous box.
                e.preventDefault();
                const next = [...chars];
                next[index - 1] = '';
                emitChars(next);
                requestAnimationFrame(() => focusBox(index - 1));
            }
        } else if (e.key === 'Delete') {
            if (chars[index]) {
                e.preventDefault();
                const next = [...chars];
                next[index] = '';
                emitChars(next);
            }
        } else if (e.key === 'ArrowLeft') {
            e.preventDefault();
            focusBox(index - 1);
        } else if (e.key === 'ArrowRight') {
            e.preventDefault();
            focusBox(index + 1);
        } else if (e.key === 'Home') {
            e.preventDefault();
            focusBox(0);
        } else if (e.key === 'End') {
            e.preventDefault();
            focusBox(size - 1);
        }
    };

    const handleBoxPaste = (index: number, e: ClipboardEvent<HTMLInputElement>) => {
        const text = e.clipboardData?.getData('text') ?? '';
        const clean = sanitizeChunk(text, mode);
        if (!clean) return;
        e.preventDefault();
        fillFrom(index, clean);
    };

    return (
        <div
            role="group"
            aria-label={ariaLabel ?? `Verification code, ${size} characters`}
            style={{ display: 'flex', gap: 8, ...containerStyle }}
            onPaste={(e) => {
                // Fallback: a paste landing between boxes still fills from the start.
                if ((e.target as HTMLElement)?.tagName !== 'INPUT') {
                    const text = e.clipboardData?.getData('text') ?? '';
                    const clean = sanitizeChunk(text, mode).slice(0, size);
                    if (!clean) return;
                    e.preventDefault();
                    onChange(clean);
                    requestAnimationFrame(() => focusBox(clean.length >= size ? size - 1 : clean.length));
                }
            }}
        >
            {chars.map((char, i) => (
                <input
                    key={`${id ?? 'otp'}-box-${i}`}
                    ref={(el) => {
                        inputsRef.current[i] = el;
                    }}
                    id={i === 0 && id ? id : undefined}
                    type="text"
                    inputMode={mode === 'alpha' ? 'text' : 'numeric'}
                    autoComplete={autoComplete}
                    autoCapitalize="characters"
                    autoCorrect="off"
                    spellCheck={false}
                    value={char}
                    placeholder={placeholder ?? (mode === 'alpha' ? '•' : '•')}
                    disabled={disabled}
                    autoFocus={autoFocus && i === 0}
                    aria-label={`${ariaLabel ?? 'Verification code'} digit ${i + 1}`}
                    onChange={(e) => handleBoxChange(i, e.target.value)}
                    onKeyDown={(e) => handleBoxKeyDown(i, e)}
                    onPaste={(e) => handleBoxPaste(i, e)}
                    onFocus={(e) => {
                        try {
                            e.target.select();
                        } catch {
                            /* noop */
                        }
                    }}
                    onClick={(e) => {
                        try {
                            (e.target as HTMLInputElement).select();
                        } catch {
                            /* noop */
                        }
                    }}
                    style={{
                        width: 44,
                        height: 48,
                        borderRadius: 10,
                        border: '1px solid #d1d5db',
                        background: '#fff',
                        color: '#111827',
                        fontSize: 20,
                        fontFamily: 'monospace',
                        textAlign: 'center',
                        outline: 'none',
                        textTransform: mode === 'alpha' ? 'uppercase' : undefined,
                        ...inputStyle,
                    }}
                />
            ))}
        </div>
    );
}
