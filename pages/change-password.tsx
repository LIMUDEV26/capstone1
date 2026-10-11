import { useMemo } from 'react';
import Head from 'next/head';
import { useRouter } from 'next/router';
import { useProtectedPage } from '@/components/AuthProvider';
import Layout from '@/components/Layout';
import PasswordChangeModal from '@/components/PasswordChangeModal';

export default function ChangePasswordPage() {
    const router = useRouter();
    const { user, loading, logout } = useProtectedPage();

    const reason = useMemo(() => {
        const queryReason = typeof router.query.reason === 'string' ? router.query.reason : '';
        // URL query takes priority — first_login must not be overridden by session data
        if (queryReason === 'expired' || queryReason === 'first_login' || queryReason === 'manual') return queryReason;
        const sessionReason = String(user?.password_change_reason || '');
        if (sessionReason === 'first_login') return 'first_login';
        if (sessionReason === 'expired') return 'expired';
        return 'manual';
    }, [router.query.reason, user?.password_change_reason]);

    const getDashboardPath = () => {
        const role = String(user?.role || '').toLowerCase();
        if (role === 'admin') return '/admin/dashboard';
        if (role === 'manager') return '/manager/dashboard';
        return '/dashboard';
    };

    const onSuccess = () => {
        void router.replace(getDashboardPath());
    };

    if (loading) {
        return (
            <Layout role={String(user?.role || '')} user={user} onLogout={logout}>
                <div style={{ padding: 20 }}>Loading...</div>
            </Layout>
        );
    }

    return (
        <Layout role={user?.role} user={user} onLogout={logout}>
            <Head>
                <title>Change Password</title>
            </Head>
            <PasswordChangeModal
                open
                user={user}
                reason={reason as 'manual' | 'expired' | 'first_login'}
                allowClose={reason !== 'expired' && reason !== 'first_login'}
                onClose={() => {
                    void router.replace(getDashboardPath());
                }}
                onLogout={logout}
                onPasswordChanged={onSuccess}
            />
        </Layout>
    );
}
