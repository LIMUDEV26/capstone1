import React from "react";
import { useRouter } from "next/router";
import Head from "next/head";
import Sidebar from "../components/Sidebar";
import styles from "../styles/Layout.module.css";

export default function SidebarPreview() {
    const router = useRouter();
    const collapsed = router.query.mode === "collapsed";
    const mainMargin = collapsed ? styles.mainContentCollapsed : styles.mainContentExpanded;

    return (
        <div className={styles.container}>
            <Head>
                <meta name="robots" content="noindex" />
            </Head>
            <Sidebar collapsed={collapsed} role="admin" />
            <div className={`${styles.mainContent} ${mainMargin}`}>
                <div style={{ padding: 32 }}>
                    <h1>Sidebar Preview</h1>
                    <div style={{ display: "flex", gap: 8, marginBottom: 16 }}>
                        <button type="button" onClick={() => router.push({ pathname: "/_sidebar-preview", query: { mode: "expanded" } })}>
                            Expanded
                        </button>
                        <button type="button" onClick={() => router.push({ pathname: "/_sidebar-preview", query: { mode: "collapsed" } })}>
                            Collapsed
                        </button>
                    </div>
                    <p>Temp page to verify sidebar width. Delete before deploying.</p>
                </div>
            </div>
        </div>
    );
}
