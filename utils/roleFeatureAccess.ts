export type RoleFeatureKey =
    | 'calendar'
    | 'analytics'
    | 'my_tasks'
    | 'tasks_board'
    | 'leave_requests'
    | 'my_payslips'
    | 'clients'
    | 'contract_management'
    | 'services'
    | 'employees'
    | 'shift_schedules'
    | 'projects'
    | 'payroll'
    | 'payroll_precheck'
    | 'overtime_requests'
    | 'cash_advance'
    | 'approval_inbox'
    | 'edit_requests'
    | 'documents';

export type FeatureManagedRole = 'manager' | 'staff';
export type RoleFeatureAccessMap = Partial<Record<RoleFeatureKey, boolean>>;

export type RoleFeatureDefinition = {
    key: RoleFeatureKey;
    label: string;
    description: string;
    group: 'Workspace' | 'Operations' | 'Requests';
    supportedRoles: FeatureManagedRole[];
    routePaths: string[];
};

export const roleFeatureDefinitions: RoleFeatureDefinition[] = [
    {
        key: 'calendar',
        label: 'Calendar',
        description: 'Holiday calendar visibility and holiday comment access.',
        group: 'Workspace',
        supportedRoles: ['manager', 'staff'],
        routePaths: ['/calendar'],
    },
    {
        key: 'analytics',
        label: 'Analytics',
        description: 'Analytics dashboard for staff-level operational summaries.',
        group: 'Workspace',
        supportedRoles: ['staff'],
        routePaths: ['/analytics'],
    },
    {
        key: 'my_tasks',
        label: 'My Tasks',
        description: 'Personal task list and status workflows.',
        group: 'Workspace',
        supportedRoles: ['manager', 'staff'],
        routePaths: ['/my-tasks'],
    },
    {
        key: 'tasks_board',
        label: 'Tasks Board',
        description: 'Kanban-style task board with drag-and-drop workflow management.',
        group: 'Workspace',
        supportedRoles: ['manager', 'staff'],
        routePaths: ['/tasks'],
    },
    {
        key: 'leave_requests',
        label: 'Leave Requests',
        description: 'Leave filing, review, and approval actions on the leave request page.',
        group: 'Requests',
        supportedRoles: ['manager', 'staff'],
        routePaths: ['/leave-requests'],
    },
    {
        key: 'my_payslips',
        label: 'My Payslips',
        description: 'Payslip viewing and self-archive actions.',
        group: 'Workspace',
        supportedRoles: ['manager', 'staff'],
        routePaths: ['/my-payslips'],
    },
    {
        key: 'clients',
        label: 'Clients',
        description: 'Client master file access and maintenance.',
        group: 'Operations',
        supportedRoles: ['manager'],
        routePaths: ['/clients'],
    },
    {
        key: 'contract_management',
        label: 'Contract Management',
        description: 'Contract list and contract detail viewing. Contract creation and edits remain admin-only.',
        group: 'Operations',
        supportedRoles: ['manager', 'staff'],
        routePaths: ['/contracts'],
    },
    {
        key: 'services',
        label: 'Services',
        description: 'Service master file and checklist maintenance.',
        group: 'Operations',
        supportedRoles: ['manager'],
        routePaths: ['/services'],
    },
    {
        key: 'employees',
        label: 'Employees',
        description: 'Employee directory view available to managers.',
        group: 'Operations',
        supportedRoles: ['manager'],
        routePaths: ['/employees'],
    },
    {
        key: 'shift_schedules',
        label: 'Shift Schedules',
        description: 'Shift schedule viewing and manager scheduling actions.',
        group: 'Operations',
        supportedRoles: ['manager'],
        routePaths: ['/shift-schedules'],
    },
    {
        key: 'projects',
        label: 'Projects',
        description: 'Project list, project detail, and shared project task access.',
        group: 'Operations',
        supportedRoles: ['manager', 'staff'],
        routePaths: ['/projects', '/projects/detail'],
    },
    {
        key: 'payroll',
        label: 'Payroll',
        description: 'Payroll management workspace for managers.',
        group: 'Operations',
        supportedRoles: ['manager'],
        routePaths: ['/payroll-management'],
    },
    {
        key: 'payroll_precheck',
        label: 'Payroll Pre-check',
        description: 'Payroll anomaly review before finalization.',
        group: 'Operations',
        supportedRoles: ['manager'],
        routePaths: ['/manager/payroll-precheck'],
    },
    {
        key: 'overtime_requests',
        label: 'Overtime Requests',
        description: 'Overtime filing, review, and approval workflows.',
        group: 'Requests',
        supportedRoles: ['manager', 'staff'],
        routePaths: ['/overtime-requests'],
    },
    {
        key: 'cash_advance',
        label: 'Cash Advance',
        description: 'Cash advance filing, review, and approval workflows.',
        group: 'Requests',
        supportedRoles: ['manager', 'staff'],
        routePaths: ['/cash-advance'],
    },
    {
        key: 'approval_inbox',
        label: 'Approval Inbox',
        description: 'Unified manager approval queue for leave and overtime items.',
        group: 'Operations',
        supportedRoles: ['manager'],
        routePaths: ['/manager/approval-inbox'],
    },
    {
        key: 'edit_requests',
        label: 'Edit Request',
        description: 'Profile edit access approval queue for admin reviewers only.',
        group: 'Requests',
        supportedRoles: [],
        routePaths: ['/edit-requests'],
    },
    {
        key: 'documents',
        label: 'Documents',
        description: 'Document receiving, submission tracking, and related document workflows.',
        group: 'Workspace',
        supportedRoles: ['manager', 'staff'],
        routePaths: ['/documents'],
    },
];

export function normalizeFeatureRole(value: unknown) {
    const normalized = String(value || '').trim().toLowerCase();
    if (normalized === 'admin' || normalized === 'manager' || normalized === 'staff') {
        return normalized;
    }
    return '';
}

export function getRoleFallbackPath(role: unknown) {
    const normalized = normalizeFeatureRole(role);
    if (normalized === 'admin') return '/admin/dashboard';
    if (normalized === 'manager') return '/manager/dashboard';
    return '/dashboard';
}

export function hasRoleFeatureAccess(
    role: unknown,
    featureKey: RoleFeatureKey | null | undefined,
    featureAccess?: RoleFeatureAccessMap | null,
) {
    const normalizedRole = normalizeFeatureRole(role);
    if (!featureKey) return true;
    if (normalizedRole === 'admin') return true;
    if (normalizedRole !== 'manager' && normalizedRole !== 'staff') return false;
    return Boolean(featureAccess?.[featureKey]);
}

export function getFeatureDefinition(featureKey: RoleFeatureKey) {
    return roleFeatureDefinitions.find((definition) => definition.key === featureKey) || null;
}

export function getFeatureKeyForPath(pathname: string) {
    const normalizedPath = String(pathname || '').trim();
    if (!normalizedPath) return null;

    const matched = [...roleFeatureDefinitions]
        .sort((left, right) => {
            const leftMax = Math.max(...left.routePaths.map((path) => path.length));
            const rightMax = Math.max(...right.routePaths.map((path) => path.length));
            return rightMax - leftMax;
        })
        .find((definition) =>
            definition.routePaths.some((candidate) =>
                normalizedPath === candidate || normalizedPath.startsWith(`${candidate}/`)
            )
        );

    return matched?.key || null;
}

export function createEmptyRoleFeatureAccessMap(role: FeatureManagedRole): RoleFeatureAccessMap {
    const access: RoleFeatureAccessMap = {};
    roleFeatureDefinitions.forEach((definition) => {
        if (definition.supportedRoles.includes(role)) {
            access[definition.key] = true;
        }
    });
    return access;
}
