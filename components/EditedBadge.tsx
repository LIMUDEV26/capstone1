import { type CSSProperties, useEffect, useState } from 'react';

type EditedBadgeProps = {
    editedAt?: number;
    compact?: boolean;
    style?: CSSProperties;
};

export default function EditedBadge({ editedAt, compact = false, style }: EditedBadgeProps) {
    const [timeState, setTimeState] = useState({ editedAt: 0, secondsAgo: 0 });

    useEffect(() => {
        if (!editedAt) return;

        const interval = window.setInterval(() => {
            setTimeState({
                editedAt,
                secondsAgo: Math.max(0, Math.floor((Date.now() - editedAt) / 1000))
            });
        }, 1000);

        return () => window.clearInterval(interval);
    }, [editedAt]);

    if (!editedAt) return null;

    const secondsAgo = timeState.editedAt === editedAt ? timeState.secondsAgo : 0;

    return (
        <span
            title={`Edited ${secondsAgo} second${secondsAgo === 1 ? '' : 's'} ago`}
            style={{
                display: 'inline-flex',
                alignItems: 'center',
                justifyContent: 'center',
                gap: 4,
                marginLeft: compact ? 6 : 8,
                padding: compact ? '2px 6px' : '3px 8px',
                borderRadius: 999,
                border: '1px solid #bbf7d0',
                background: '#dcfce7',
                color: '#166534',
                fontSize: compact ? 10 : 11,
                fontWeight: 800,
                lineHeight: 1.2,
                whiteSpace: 'nowrap',
                boxShadow: '0 6px 16px rgba(22, 101, 52, 0.12)',
                ...style
            }}
        >
            Edited ({secondsAgo}s)
        </span>
    );
}
