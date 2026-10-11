import { KeyboardEvent } from 'react';
import styles from '../styles/SettingsToggle.module.css';

interface SettingsToggleProps {
    checked: boolean;
    onChange: (next: boolean) => void;
    disabled?: boolean;
    size?: 'medium' | 'small';
    showStatus?: boolean;
    statusOnLabel?: string;
    statusOffLabel?: string;
    ariaLabel?: string;
}

export default function SettingsToggle({
    checked,
    onChange,
    disabled = false,
    size = 'medium',
    showStatus = false,
    statusOnLabel = 'Active',
    statusOffLabel = 'Disabled',
    ariaLabel,
}: SettingsToggleProps) {
    const handleKeyDown = (event: KeyboardEvent<HTMLSpanElement>) => {
        if (disabled) return;
        if (event.key === 'Enter' || event.key === ' ' || event.key === 'Spacebar') {
            event.preventDefault();
            onChange(!checked);
        }
    };

    return (
        <span style={{ display: 'inline-flex', alignItems: 'center', gap: 10 }}>
            <span
                role="switch"
                aria-checked={checked}
                aria-label={ariaLabel}
                aria-disabled={disabled || undefined}
                tabIndex={disabled ? -1 : 0}
                className={[styles.track, checked ? styles.trackOn : '', size === 'small' ? styles.small : ''].join(' ')}
                onClick={() => {
                    if (!disabled) onChange(!checked);
                }}
                onKeyDown={handleKeyDown}
                style={disabled ? { opacity: 0.55, cursor: 'not-allowed' } : undefined}
            >
                <span className={`${styles.trackLabel} ${styles.labelOn}`}>ON</span>
                <span className={`${styles.trackLabel} ${styles.labelOff}`}>OFF</span>
                <span className={styles.knob}>
                    <span className={styles.knobGloss} />
                </span>
            </span>
            {showStatus && (
                <span className={[styles.status, checked ? styles.statusOn : styles.statusOff].join(' ')}>
                    <span className={styles.statusDot} />
                    {checked ? statusOnLabel : statusOffLabel}
                </span>
            )}
        </span>
    );
}
