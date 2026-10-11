export type RouteBreadcrumb = {
  href: string;
  label: string;
};

type RouteBreadcrumbRole = string | null | undefined;

const ROUTE_LABELS: Record<string, string> = {
  '/': 'Home',
  '/dashboard': 'Dashboard',
  '/admin/dashboard': 'Admin Dashboard',
  '/manager/dashboard': 'Manager Dashboard',
  '/manager/approval-inbox': 'Approval Inbox',
  '/manager/payroll-precheck': 'Payroll Precheck',
  '/analytics': 'Analytics',
  '/branches': 'Branches',
  '/calendar': 'Calendar',
  '/cash-advance': 'Cash Advance',
  '/clients': 'Clients',
  '/create.admin': 'Create Admin',
  '/deduction-types': 'Deduction Types',
  '/documents': 'Documents',
  '/edit-requests': 'Edit Request',
  '/employees': 'Employees',
  '/leave-requests': 'Leave Requests',
  '/my-attendance': 'My Attendance',
  '/my-payslips': 'My Payslips',
  '/my-tasks': 'My Tasks',
  '/tasks': 'Tasks Board',
  '/notifications': 'Notifications',
  '/overtime-requests': 'Overtime Requests',
  '/payroll-management': 'Payroll Management',
  '/profile': 'Profile',
  '/projects': 'Projects',
  '/projects/detail': 'Project Details',
  '/reports': 'Reports',

  '/services': 'Services',
  '/settings': 'Settings',
  '/settings/account-lockout': 'Account Lockout Settings',
  '/settings/data-deletion': 'Data Storage Settings',
  '/settings/deduction-types': 'Deduction Types Settings',

  '/settings/leave-management': 'Leave Management Settings',
  '/settings/math-captcha': 'Captcha Management Settings',
  '/settings/pagination': 'Pagination Settings',
  '/settings/rate-limiting': 'Rate Limiting Settings',
  '/settings/session-timeout': 'Session Timeout Settings',
  '/settings/system-backup': 'System Backup Settings',
  '/shift-schedules': 'Shift Schedules',
  '/users': 'Users',
};

const BREADCRUMB_LABELS: Record<string, string> = {
  '/': 'Home',
  '/admin': 'Admin',
  '/admin/dashboard': 'Dashboard',
  '/manager': 'Manager',
  '/manager/dashboard': 'Dashboard',
  '/manager/approval-inbox': 'Approval Inbox',
  '/manager/payroll-precheck': 'Payroll Precheck',
  '/edit-requests': 'Edit Request',
  '/projects': 'Projects',
  '/projects/detail': 'Project Details',
  '/reports': 'Reports',
  '/settings': 'Settings',
  '/settings/account-lockout': 'Account Lockout',
  '/settings/data-deletion': 'Data Storage',
  '/settings/deduction-types': 'Deduction Types',

  '/settings/leave-management': 'Leave Management',
  '/settings/math-captcha': 'Captcha Management',
  '/settings/pagination': 'Pagination',
  '/settings/rate-limiting': 'Rate Limiting',
  '/settings/session-timeout': 'Session Timeout',
  '/settings/system-backup': 'System Backup',
};

const SETTINGS_SECTION_LABELS: Record<string, string> = {
  profile: 'Profile',
  'account-lockout': 'Account Lockout',
  'data-deletion': 'Data Storage',
  'deduction-types': 'Deduction Types',

  'leave-management': 'Leave Management',
  'math-captcha': 'Captcha Management',
  pagination: 'Pagination',
  'rate-limiting': 'Rate Limiting',
  'session-timeout': 'Session Timeout',
  'system-backup': 'System Backup',
};

function toTitleCaseSegment(segment: string) {
  return segment
    .split(/[-_.]+/)
    .filter(Boolean)
    .map((word) => word.charAt(0).toUpperCase() + word.slice(1))
    .join(' ');
}

function normalizePathname(pathname: string) {
  const normalized = pathname.replace(/\/+/g, '/').replace(/\/+$/, '');
  return normalized || '/';
}

function parseRouteLink(link?: string | null) {
  const rawLink = String(link || '').trim();
  if (!rawLink) return null;

  try {
    const parsed = new URL(rawLink, 'https://local.app');
    return {
      pathname: normalizePathname(parsed.pathname),
      searchParams: parsed.searchParams,
      rawLink,
    };
  } catch {
    return null;
  }
}

function resolveFallbackLabel(pathname: string) {
  const segments = normalizePathname(pathname)
    .split('/')
    .map((segment) => segment.trim())
    .filter(Boolean);

  if (segments.length === 0) {
    return 'Home';
  }

  return segments.map(toTitleCaseSegment).join(' / ');
}

function resolveRouteLabel(pathname: string) {
  return ROUTE_LABELS[pathname] || resolveFallbackLabel(pathname);
}

function resolveBreadcrumbLabel(pathname: string) {
  return BREADCRUMB_LABELS[pathname] || resolveRouteLabel(pathname).replace(/\s+Settings$/, '');
}

function normalizeRole(role?: RouteBreadcrumbRole) {
  return String(role || '').trim().toLowerCase();
}

function prependAdminDashboardBreadcrumbs(pathname: string, breadcrumbs: RouteBreadcrumb[]) {
  const adminDashboardHref = '/admin/dashboard';
  const prefix: RouteBreadcrumb[] = [
    { href: adminDashboardHref, label: 'Admin' },
    { href: adminDashboardHref, label: 'Dashboard' },
  ];

  if (pathname === adminDashboardHref) {
    return prefix;
  }

  const strippedBreadcrumbs = breadcrumbs.filter((breadcrumb) => breadcrumb.href !== '/admin' && breadcrumb.href !== adminDashboardHref);
  return [...prefix, ...strippedBreadcrumbs];
}

function prependStaffDashboardBreadcrumbs(pathname: string, breadcrumbs: RouteBreadcrumb[]) {
  const staffDashboardHref = '/dashboard';
  const prefix: RouteBreadcrumb[] = [
    { href: staffDashboardHref, label: 'Staff' },
    { href: staffDashboardHref, label: 'Dashboard' },
  ];

  if (pathname === staffDashboardHref) {
    return prefix;
  }

  const strippedBreadcrumbs = breadcrumbs.filter((breadcrumb) => breadcrumb.href !== staffDashboardHref);
  return [...prefix, ...strippedBreadcrumbs];
}

export function formatRouteLabel(link?: string | null) {
  const parsed = parseRouteLink(link);
  if (!parsed) {
    const rawLink = String(link || '').trim();
    return rawLink || 'No direct page is linked to this notification.';
  }

  return resolveRouteLabel(parsed.pathname);
}

export function getRouteBreadcrumbs(link?: string | null, role?: RouteBreadcrumbRole): RouteBreadcrumb[] {
  const parsed = parseRouteLink(link);
  if (!parsed) return [];

  const segments = parsed.pathname
    .split('/')
    .map((segment) => segment.trim())
    .filter(Boolean);

  const breadcrumbs: RouteBreadcrumb[] = segments.map((_, index) => {
    const href = `/${segments.slice(0, index + 1).join('/')}`;
    return {
      href,
      label: resolveBreadcrumbLabel(href),
    };
  });

  if (breadcrumbs.length === 0) {
    return [{ href: '/', label: 'Home' }];
  }

  if (parsed.pathname === '/settings') {
    const section = parsed.searchParams.get('section');
    const normalizedSection = String(section || '').trim().toLowerCase();
    if (normalizedSection && normalizedSection !== 'profile') {
      breadcrumbs.push({
        href: section ? `/settings?section=${encodeURIComponent(section)}` : '/settings',
        label: SETTINGS_SECTION_LABELS[normalizedSection] || toTitleCaseSegment(normalizedSection),
      });
    }
  }

  const normalizedRole = normalizeRole(role);

  if (normalizedRole === 'admin') {
    return prependAdminDashboardBreadcrumbs(parsed.pathname, breadcrumbs);
  }

  if (normalizedRole === 'staff') {
    return prependStaffDashboardBreadcrumbs(parsed.pathname, breadcrumbs);
  }

  return breadcrumbs;
}
