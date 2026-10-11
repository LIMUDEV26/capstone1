import { type ReactNode } from 'react';
import Head from 'next/head';
import Link from 'next/link';
import Layout from './Layout';
import styles from '../styles/Settings.module.css';
import { settingsNavItems, type SettingsSection } from './settingsNav';

type SessionUserLike = {
    role?: string;
    [key: string]: unknown;
} | null | undefined;

type SettingsLayoutProps = {
    activeSection: SettingsSection;
    user: SessionUserLike;
    onLogout: () => void | Promise<void>;
    children: ReactNode;
};

export default function SettingsLayout({ activeSection, user, onLogout, children }: SettingsLayoutProps) {
    const activeItem = settingsNavItems.find((item) => item.id === activeSection) || settingsNavItems[0];

    return (
        <Layout role={user?.role} user={user} onLogout={onLogout}>
            <Head>
                <title>Settings</title>
            </Head>

            <div className={styles.page}>
                <div className={styles.shell}>
                    <aside className={styles.sidebar}>
                        <div className={styles.navList}>
                            {settingsNavItems.map((item) => {
                                const isActive = activeSection === item.id;
                                return (
                                    <Link
                                        key={item.id}
                                        href={item.path}
                                        prefetch={false}
                                        className={isActive ? styles.navItemActive : styles.navItem}
                                        aria-current={isActive ? 'page' : undefined}
                                    >
                                        <span className={styles.navIcon}>{item.icon}</span>
                                        <span className={styles.navCopy}>
                                            <span className={styles.navLabel}>{item.label}</span>
                                        </span>
                                        {isActive && <span className={styles.navBadge}>Open</span>}
                                    </Link>
                                );
                            })}
                        </div>
                    </aside>

                    <section className={styles.content}>
                        <div className={styles.contentIntro}>
                            <div className={styles.contentIntroHeader}>
                                <div className={styles.contentEyebrow}>Admin Settings</div>
                                <h2 className={styles.contentTitle}>{activeItem.introTitle}</h2>
                            </div>
                            <div className={styles.contentIntroDetails}>
                                <p className={styles.contentText}>{activeItem.introText}</p>
                            </div>
                        </div>

                        <div className={styles.contentBody}>{children}</div>
                    </section>
                </div>
            </div>
        </Layout>
    );
}
