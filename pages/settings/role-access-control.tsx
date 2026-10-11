import { useEffect, useMemo, useState } from 'react';
import SettingsLayout from '../../components/SettingsLayout';
import SettingsToggle from '../../components/SettingsToggle';
import TinyReloadButton from '../../components/TinyReloadButton';
import { SettingsPageHeader } from '../../components/SettingsPageShell';
import { useAdminSettingsPage } from '../../components/useAdminSettingsPage';
import { notifyError, notifySuccess } from '@/utils/notify';
import { getApiBaseUrl } from '@/utils/network';
import { roleFeatureDefinitions, type FeatureManagedRole, type RoleFeatureAccessMap, type RoleFeatureKey } from '@/utils/roleFeatureAccess';

const API_BASE = getApiBaseUrl();
const managedRoles: FeatureManagedRole[] = ['manager', 'staff'];

type FeatureCatalog = Record<string, { label?: string; roles?: Record<string, boolean> }>;
type RoleAccessPayload = {
    catalog?: FeatureCatalog;
    roles?: Partial<Record<FeatureManagedRole, RoleFeatureAccessMap>>;
};

export default function RoleAccessControlSettingsPage() {
    const { user, loading: authLoading, logout } = useAdminSettingsPage();
    const [loading, setLoading] = useState(true);
    const [savingRole, setSavingRole] = useState<FeatureManagedRole | null>(null);
    const [catalog, setCatalog] = useState<FeatureCatalog>({});
    const [accessByRole, setAccessByRole] = useState<Record<FeatureManagedRole, RoleFeatureAccessMap>>({
        manager: {},
        staff: {},
    });

    const definitions = useMemo(() => {
        return roleFeatureDefinitions.filter((definition) => definition.supportedRoles.length > 0);
    }, []);

    // Render the page shell immediately after auth resolves; data loads in
    // the background. Never trap on full-page "Loading..." for data fetch.
    const userId = user?.id;
    useEffect(() => {
        if (authLoading || !userId) return;
        void loadAccess();
    }, [authLoading, userId]);

    const loadAccess = async () => {
        setLoading(true);
        try {
            const response = await fetch(`${API_BASE}/role-feature-access.php`, { credentials: 'include' });
            const result = await response.json();
            if (!response.ok || !result.success) {
                notifyError(result.message || 'Failed to load role access settings.');
                return;
            }
            applyPayload(result.data || {});
        } catch {
            notifyError('Unable to load role access settings right now.');
        } finally {
            setLoading(false);
        }
    };

    const applyPayload = (payload: RoleAccessPayload) => {
        setCatalog(payload.catalog || {});
        setAccessByRole({
            manager: payload.roles?.manager || {},
            staff: payload.roles?.staff || {},
        });
    };

    const roleSupportsFeature = (role: FeatureManagedRole, featureKey: RoleFeatureKey) => {
        const catalogSupport = catalog[featureKey]?.roles?.[role];
        if (typeof catalogSupport === 'boolean') return catalogSupport;
        return definitions.some((definition) => definition.key === featureKey && definition.supportedRoles.includes(role));
    };

    const setRoleFeature = (role: FeatureManagedRole, featureKey: RoleFeatureKey, enabled: boolean) => {
        setAccessByRole((current) => ({
            ...current,
            [role]: {
                ...current[role],
                [featureKey]: enabled,
            },
        }));
    };

    const saveRole = async (role: FeatureManagedRole) => {
        setSavingRole(role);
        try {
            const response = await fetch(`${API_BASE}/role-feature-access.php`, {
                method: 'PUT',
                headers: { 'Content-Type': 'application/json' },
                credentials: 'include',
                body: JSON.stringify({ role, feature_access: accessByRole[role] }),
            });
            const result = await response.json();
            if (!response.ok || !result.success) {
                notifyError(result.message || 'Failed to save role access settings.');
                return;
            }
            applyPayload(result.data || {});
            notifySuccess(result.message || 'Role access settings updated.');
        } catch {
            notifyError('Unable to save role access settings right now.');
        } finally {
            setSavingRole(null);
        }
    };

    if (authLoading) {
        return (
            <SettingsLayout activeSection="role-access-control" user={user} onLogout={logout}>
                <div style={{ padding: 20 }}>Loading...</div>
            </SettingsLayout>
        );
    }

    return (
        <SettingsLayout activeSection="role-access-control" user={user} onLogout={logout}>
            {loading && <div style={{ padding: '8px 0', fontSize: 12, color: '#6b7280' }}>Loading settings...</div>}
            <div style={{ display: 'flex', alignItems: 'center', gap: 10, marginBottom: 12, flexWrap: 'wrap' }}>
                <SettingsPageHeader embedded title="Role-Based Access Control" onBack={() => {}} />
                <TinyReloadButton onClick={() => void loadAccess()} loading={loading} title="Reload role access control" />
            </div>
            <div style={{ display: 'grid', gridTemplateColumns: 'repeat(auto-fit, minmax(340px, 1fr))', gap: 8, alignItems: 'start' }}>
                {managedRoles.map((role) => (
                    <section key={role} style={{ background: '#fff', border: '1px solid #e5e7eb', borderRadius: 12, padding: 14 }}>
                        <div style={{ display: 'flex', alignItems: 'center', justifyContent: 'space-between', gap: 12, marginBottom: 12, flexWrap: 'wrap' }}>
                            <div>
                                <h3 style={{ margin: 0, fontSize: 14, fontWeight: 800, color: '#0f172a', textTransform: 'capitalize' }}>{role}</h3>
                                <p style={{ margin: '4px 0 0', fontSize: 12, color: '#64748b' }}>Toggle feature visibility for this role.</p>
                            </div>
                            <button
                                type="button"
                                onClick={() => saveRole(role)}
                                disabled={savingRole === role}
                                style={{ padding: '7px 12px', background: '#1e3a8a', color: '#fff', border: 'none', borderRadius: 8, fontSize: 12, fontWeight: 700, cursor: savingRole === role ? 'default' : 'pointer', opacity: savingRole === role ? 0.65 : 1 }}
                            >
                                {savingRole === role ? 'Saving...' : 'Save'}
                            </button>
                        </div>
                        <div style={{ display: 'grid', gridTemplateColumns: 'repeat(auto-fit, minmax(230px, 1fr))', gap: 10 }}>
                            {definitions.map((definition) => {
                                const supported = roleSupportsFeature(role, definition.key);
                                const enabled = Boolean(accessByRole[role]?.[definition.key]);
                                return (
                                    <div
                                        key={`${role}-${definition.key}`}
                                        style={{
                                            display: 'flex', gap: 12, alignItems: 'center', justifyContent: 'space-between',
                                            border: '1px solid #e2e8f0', borderRadius: 10, padding: 10,
                                            background: supported ? '#fff' : '#f8fafc',
                                            opacity: supported ? 1 : 0.55,
                                        }}
                                    >
                                        <span style={{ display: 'grid', gap: 3, minWidth: 0 }}>
                                            <span style={{ fontSize: 13, fontWeight: 700, color: '#0f172a' }}>{catalog[definition.key]?.label || definition.label}</span>
                                            <span style={{ fontSize: 11, lineHeight: 1.45, color: '#64748b' }}>{definition.description}</span>
                                        </span>
                                        <SettingsToggle
                                            checked={supported && enabled}
                                            onChange={(next) => setRoleFeature(role, definition.key, next)}
                                            disabled={!supported}
                                            size="small"
                                            ariaLabel={`${catalog[definition.key]?.label || definition.label} for ${role}`}
                                        />
                                    </div>
                                );
                            })}
                        </div>
                    </section>
                ))}
            </div>
        </SettingsLayout>
    );
}
