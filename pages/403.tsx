import Head from 'next/head';
import { useRouter } from 'next/router';
import { useAuth } from '@/components/AuthProvider';

export default function AccessDenied() {
    const router = useRouter();
    const { user } = useAuth();

    const dashboardPath =
        user?.role === 'admin'
            ? '/admin/dashboard'
            : user?.role === 'manager'
              ? '/manager/dashboard'
              : '/dashboard';

    return (
        <>
            <Head>
                <title>403 — Access Denied</title>
            </Head>
            <div style={{
                display: 'flex', flexDirection: 'column', alignItems: 'center', justifyContent: 'center',
                minHeight: '100vh', background: '#f1f5f9', fontFamily: "'Segoe UI', system-ui, sans-serif", padding: 24,
            }}>
                <div style={{
                    background: '#fff', borderRadius: 16, boxShadow: '0 4px 24px rgba(15,23,42,.10)',
                    padding: '48px 40px', maxWidth: 420, width: '100%', textAlign: 'center',
                }}>
                    <div style={{ fontSize: 64, fontWeight: 900, color: '#dc2626', lineHeight: 1, marginBottom: 8 }}>403</div>
                    <h1 style={{ margin: '0 0 10px', fontSize: 22, fontWeight: 700, color: '#0f172a' }}>Access Denied</h1>
                    <p style={{ margin: '0 0 28px', color: '#64748b', fontSize: 14, lineHeight: 1.6 }}>
                        You do not have permission to view this page.<br />
                        Please contact your system administrator if you believe this is a mistake.
                    </p>
                    <button
                        onClick={() => void router.replace(dashboardPath)}
                        style={{
                            padding: '10px 28px', background: '#1e3a8a', color: '#fff', border: 'none',
                            borderRadius: 8, fontSize: 14, fontWeight: 600, cursor: 'pointer',
                        }}
                    >
                        Return to Dashboard
                    </button>
                </div>
                <p style={{ marginTop: 20, color: '#94a3b8', fontSize: 12 }}>
                    Capstone System &mdash; Unauthorized Access
                </p>
            </div>
        </>
    );
}
