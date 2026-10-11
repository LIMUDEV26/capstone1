import React from 'react';

export type CrudAction =
    | 'create'
    | 'approve'
    | 'view'
    | 'edit'
    | 'update'
    | 'archive'
    | 'restore'
    | 'download'
    | 'delete'
    | 'save'
    | 'pin'
    | 'cancel';

type CrudActionIconProps = {
    action: CrudAction;
    size?: number;
    strokeWidth?: number;
};

export default function CrudActionIcon({ action, size = 16, strokeWidth = 2 }: CrudActionIconProps) {
    const common = {
        className: 'crud-action-icon',
        'data-crud-action': action,
        width: size,
        height: size,
        viewBox: '0 0 24 24',
        fill: 'none',
        stroke: 'currentColor',
        strokeWidth,
        strokeLinecap: 'round' as const,
        strokeLinejoin: 'round' as const,
        'aria-hidden': true,
    };

    if (action === 'create') {
        return (
            <svg {...common}>
                <line x1="12" y1="5" x2="12" y2="19" />
                <line x1="5" y1="12" x2="19" y2="12" />
            </svg>
        );
    }

    if (action === 'approve') {
        return (
            <svg {...common}>
                <polyline points="20 6 9 17 4 12" />
            </svg>
        );
    }

    if (action === 'view') {
        return (
            <svg {...common}>
                <path d="M1 12s4-8 11-8 11 8 11 8-4 8-11 8-11-8-11-8z" />
                <circle cx="12" cy="12" r="3" />
            </svg>
        );
    }

    if (action === 'edit' || action === 'update') {
        return (
            <svg {...common}>
                <path d="M12 20h9" />
                <path d="M16.5 3.5a2.1 2.1 0 0 1 3 3L7 19l-4 1 1-4 12.5-12.5z" />
            </svg>
        );
    }

    if (action === 'archive') {
        return (
            <svg {...common}>
                <polyline points="21 8 21 21 3 21 3 8" />
                <rect x="1" y="3" width="22" height="5" />
                <line x1="10" y1="12" x2="14" y2="12" />
            </svg>
        );
    }

    if (action === 'restore') {
        return (
            <svg {...common}>
                <polyline points="1 4 1 10 7 10" />
                <path d="M3.51 15a9 9 0 1 0 2.13-9.36L1 10" />
            </svg>
        );
    }

    if (action === 'download') {
        return (
            <svg {...common}>
                <path d="M21 15v4a2 2 0 0 1-2 2H5a2 2 0 0 1-2-2v-4" />
                <polyline points="7 10 12 15 17 10" />
                <line x1="12" y1="15" x2="12" y2="3" />
            </svg>
        );
    }

    if (action === 'delete') {
        return (
            <svg {...common}>
                <polyline points="3 6 5 6 21 6" />
                <path d="M19 6v14a2 2 0 0 1-2 2H7a2 2 0 0 1-2-2V6m3 0V4a2 2 0 0 1 2-2h4a2 2 0 0 1 2 2v2" />
            </svg>
        );
    }

    if (action === 'pin') {
        return (
            <svg {...common}>
                <path d="M9 10.76a2 2 0 0 1-1.11 1.79l-1.78.9A2 2 0 0 0 5 15.24V16a1 1 0 0 0 1 1h12a1 1 0 0 0 1-1v-.76a2 2 0 0 0-1.11-1.79l-1.78-.9A2 2 0 0 1 15 10.76V6h1a2 2 0 0 0 0-4H8a2 2 0 0 0 0 4h1z" />
                <line x1="12" y1="17" x2="12" y2="22" />
            </svg>
        );
    }

    if (action === 'save') {
        return (
            <svg {...common}>
                <path d="M19 21H5a2 2 0 0 1-2-2V5a2 2 0 0 1 2-2h11l5 5v11a2 2 0 0 1-2 2z" />
                <polyline points="17 21 17 13 7 13 7 21" />
                <polyline points="7 3 7 8 15 8" />
            </svg>
        );
    }

    return (
        <svg {...common}>
            <line x1="18" y1="6" x2="6" y2="18" />
            <line x1="6" y1="6" x2="18" y2="18" />
        </svg>
    );
}
