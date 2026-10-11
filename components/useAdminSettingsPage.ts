import { useProtectedPage } from '@/components/AuthProvider';

export function useAdminSettingsPage() {
    return useProtectedPage({
        allowedRoles: ['admin'],
        unauthorizedRedirect: '/dashboard',
    });
}
