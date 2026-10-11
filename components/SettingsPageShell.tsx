import { useEffect, useRef, type ReactNode } from 'react';
import Head from 'next/head';
import Layout from './Layout';

type SessionUserLike = {
    role?: string;
    [key: string]: unknown;
} | null | undefined;

type SettingsPageShellProps = {
    embedded: boolean;
    title: string;
    user: SessionUserLike;
    onLogout: () => void | Promise<void>;
    maxWidth?: number;
    children: ReactNode;
};

type SettingsPageHeaderProps = {
    embedded: boolean;
    title: string;
    onBack: () => void;
    actions?: ReactNode;
};

export function SettingsPageHeader({ embedded, title, onBack, actions }: SettingsPageHeaderProps) {
    return (
        <div
            style={{
                display: 'flex',
                alignItems: 'center',
                gap: 12,
                marginBottom: embedded ? 18 : 24,
                flexWrap: 'wrap',
                minWidth: 0,
            }}
        >
            {!embedded && (
                <button
                        type="button"
                        onClick={onBack}
                        style={{
                        background: '#f1f5f9',
                        border: 'none',
                        borderRadius: 8,
                        padding: '8px 12px',
                        cursor: 'pointer',
                        display: 'flex',
                        alignItems: 'center',
                        gap: 6,
                        color: '#475569',
                        fontSize: 13,
                        fontWeight: 600,
                    }}
                >
                    <svg width="16" height="16" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="2" strokeLinecap="round" strokeLinejoin="round">
                        <polyline points="15 18 9 12 15 6" />
                    </svg>
                    Back to Settings
                </button>
            )}
            {embedded ? (
                <h2
                    style={{
                        margin: 0,
                        fontSize: 14,
                        fontWeight: 700,
                        lineHeight: 1.15,
                        letterSpacing: '-0.02em',
                        color: '#0f172a',
                    }}
                >
                    {title}
                </h2>
            ) : (
                <h1
                    style={{
                        margin: 0,
                        fontSize: 14,
                        fontWeight: 700,
                        lineHeight: 1.15,
                        letterSpacing: '-0.02em',
                        color: '#0f172a',
                    }}
                >
                    {title}
                </h1>
            )}
            {actions ? (
                <div
                    style={{
                        marginLeft: 'auto',
                        display: 'flex',
                        alignItems: 'center',
                        gap: 8,
                    }}
                >
                    {actions}
                </div>
            ) : null}
        </div>
    );
}

export default function SettingsPageShell({
    embedded,
    title,
    user,
    onLogout,
    maxWidth = 760,
    children,
}: SettingsPageShellProps) {
    const contentRef = useRef<HTMLDivElement | null>(null);

    useEffect(() => {
        if (!embedded || typeof window === 'undefined') return;

        const htmlStyle = document.documentElement.style;
        const bodyStyle = document.body.style;
        const nextRoot = document.getElementById('__next') as HTMLDivElement | null;
        const previousStyles = {
            htmlMargin: htmlStyle.margin,
            htmlPadding: htmlStyle.padding,
            htmlHeight: htmlStyle.height,
            htmlMinHeight: htmlStyle.minHeight,
            htmlWidth: htmlStyle.width,
            htmlMaxWidth: htmlStyle.maxWidth,
            htmlOverflowX: htmlStyle.overflowX,
            bodyMargin: bodyStyle.margin,
            bodyPadding: bodyStyle.padding,
            bodyHeight: bodyStyle.height,
            bodyMinHeight: bodyStyle.minHeight,
            bodyWidth: bodyStyle.width,
            bodyMaxWidth: bodyStyle.maxWidth,
            bodyOverflowX: bodyStyle.overflowX,
            nextHeight: nextRoot?.style.height || '',
            nextMinHeight: nextRoot?.style.minHeight || '',
            nextWidth: nextRoot?.style.width || '',
            nextMaxWidth: nextRoot?.style.maxWidth || '',
        };

        htmlStyle.margin = '0';
        htmlStyle.padding = '0';
        htmlStyle.height = 'auto';
        htmlStyle.minHeight = '0';
        htmlStyle.width = '100%';
        htmlStyle.maxWidth = '100%';
        htmlStyle.overflowX = 'hidden';
        bodyStyle.margin = '0';
        bodyStyle.padding = '0';
        bodyStyle.height = 'auto';
        bodyStyle.minHeight = '0';
        bodyStyle.width = '100%';
        bodyStyle.maxWidth = '100%';
        bodyStyle.overflowX = 'hidden';
        if (nextRoot) {
            nextRoot.style.height = 'auto';
            nextRoot.style.minHeight = '0';
            nextRoot.style.width = '100%';
            nextRoot.style.maxWidth = '100%';
        }

        const postHeight = () => {
            const wrapper = contentRef.current;
            const wrapperHeight = wrapper
                ? Math.max(wrapper.scrollHeight, wrapper.offsetHeight, wrapper.getBoundingClientRect().height)
                : 0;
            const fallbackHeight = Math.max(
                document.documentElement?.scrollHeight || 0,
                document.body?.scrollHeight || 0,
                nextRoot?.scrollHeight || 0
            );
            const height = Math.ceil(wrapperHeight || fallbackHeight);

            window.parent.postMessage(
                {
                    type: 'settings-embed-height',
                    height,
                    path: window.location.pathname,
                },
                window.location.origin
            );
        };

        const observer = new MutationObserver(() => postHeight());
        if (contentRef.current) {
            observer.observe(contentRef.current, { childList: true, subtree: true, attributes: true, characterData: true });
        }

        const resizeObserver = typeof ResizeObserver !== 'undefined' && contentRef.current
            ? new ResizeObserver(() => postHeight())
            : null;
        if (resizeObserver && contentRef.current) {
            resizeObserver.observe(contentRef.current);
        }

        const timeoutId = window.setTimeout(postHeight, 0);
        window.addEventListener('resize', postHeight);

        return () => {
            observer.disconnect();
            resizeObserver?.disconnect();
            window.clearTimeout(timeoutId);
            window.removeEventListener('resize', postHeight);
            htmlStyle.margin = previousStyles.htmlMargin;
            htmlStyle.padding = previousStyles.htmlPadding;
            htmlStyle.height = previousStyles.htmlHeight;
            htmlStyle.minHeight = previousStyles.htmlMinHeight;
            htmlStyle.width = previousStyles.htmlWidth;
            htmlStyle.maxWidth = previousStyles.htmlMaxWidth;
            htmlStyle.overflowX = previousStyles.htmlOverflowX;
            bodyStyle.margin = previousStyles.bodyMargin;
            bodyStyle.padding = previousStyles.bodyPadding;
            bodyStyle.height = previousStyles.bodyHeight;
            bodyStyle.minHeight = previousStyles.bodyMinHeight;
            bodyStyle.width = previousStyles.bodyWidth;
            bodyStyle.maxWidth = previousStyles.bodyMaxWidth;
            bodyStyle.overflowX = previousStyles.bodyOverflowX;
            if (nextRoot) {
                nextRoot.style.height = previousStyles.nextHeight;
                nextRoot.style.minHeight = previousStyles.nextMinHeight;
                nextRoot.style.width = previousStyles.nextWidth;
                nextRoot.style.maxWidth = previousStyles.nextMaxWidth;
            }
        };
    }, [embedded]);

    const content = (
        <div
            ref={contentRef}
            style={{
                padding: embedded ? '18px 20px 20px' : '20px',
                width: '100%',
                boxSizing: 'border-box',
                minWidth: 0,
                maxWidth: embedded ? '100%' : maxWidth,
                overflowX: embedded ? 'hidden' : undefined,
            }}
        >
            {children}
        </div>
    );

    if (embedded) {
        return content;
    }

    return (
        <Layout role={user?.role} user={user} onLogout={onLogout}>
            <Head><title>{title}</title></Head>
            {content}
        </Layout>
    );
}
