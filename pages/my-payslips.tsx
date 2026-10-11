import { type CSSProperties, useCallback, useEffect, useMemo, useState } from 'react';
import Head from 'next/head';
import { useRouter } from 'next/router';
import Layout from '../components/Layout';
import Pagination from '../components/Pagination';
import CrudActionIcon from '../components/CrudActionIcon';
import { getBackendBaseUrl } from '@/utils/network';
import { confirmAction, notifyError } from '@/utils/notify';
import { usePaginationSetting } from '@/utils/usePaginationSetting';
import SearchBar from '../components/SearchBar';
import ZeroResults from '../components/ZeroResults';
import { collectSearchTerms, getAlternativeSuggestions } from '@/utils/search';
import { downloadHtmlAsPdf } from '@/utils/reportExport';

const API_BASE_URL = getBackendBaseUrl();

type SessionUser = {
    id?: number;
    role?: string;
    employee_id?: number;
    [key: string]: unknown;
};

type PayrollRow = {
    id: number;
    employee_id: number;
    employee_name?: string;
    full_employee_name?: string;
    employee_date_id?: string | null;
    pay_period_start: string;
    pay_period_end: string;
    position?: string | null;
    branch_name?: string | null;
    basic_salary?: number | string;
    overtime_hours?: number | string;
    overtime_rate?: number | string;
    overtime_pay?: number | string;
    bonus?: number | string;
    clothing_allowance?: number | string;
    travel_allowance?: number | string;
    salary_adjustment?: number | string;
    gross_pay: number;
    total_deductions: number;
    net_pay: number;
    status: string;
    user_is_archived?: number | boolean;
    user_is_deleted?: number | boolean;
    user_archived_at?: string | null;
    created_at?: string;
    notes?: string | null;
    late_deduction?: number | string;
    absence_deduction?: number | string;
    tax?: number | string;
    sss_contribution?: number | string;
    pagibig_contribution?: number | string;
    philhealth_contribution?: number | string;
    cash_advance_manual_deduction?: number | string;
    cash_advance_deduction?: number | string;
    cash_advance_request_count?: number | string;
    cash_advance_request_total?: number | string;
    laptop_loan_deduction?: number | string;
    other_deductions?: number | string;
    attendance_days_worked?: number | string | null;
    attendance_overtime_hours?: number | string | null;
    attendance_late_minutes?: number | string | null;
    attendance_absent_days?: number | string | null;
    attendance_leave_days?: number | string | null;
};

type DownloadFormat = 'pdf' | 'xls';

type ApiResponse<T> = {
    success?: boolean;
    message?: string;
    data?: T;
};

type PayslipEarningRow = {
    label: string;
    monthly: string;
    daily: string;
    semi: string;
};

type PayslipDeductionRow = {
    label: string;
    amount: string;
};

type PayslipDisplay = {
    periodLabel: string;
    employeeName: string;
    designation: string;
    idNumber: string;
    daysWorked: string;
    overtimeRegular: string;
    overtimeRest: string;
    overtimeNight: string;
    overtimeRegularHoliday: string;
    overtimeSpecialHoliday: string;
    absencesWithoutPay: string;
    tardinessUndertime: string;
    vacationLeave: string;
    sickLeave: string;
    earnedCreditHours: string;
    attendanceNote: string;
    earnings: PayslipEarningRow[];
    deductions: PayslipDeductionRow[];
    grossPay: string;
    totalDeductions: string;
    netPay: string;
    employeeSignature: string;
    certifiedName: string;
    certifiedTitle: string;
};

export default function MyPayslipsPage() {
    const ITEMS_PER_PAGE = usePaginationSetting();
    const router = useRouter();
    const [user, setUser] = useState<SessionUser | null>(null);
    const [rows, setRows] = useState<PayrollRow[]>([]);
    const [loading, setLoading] = useState(true);
    const [error, setError] = useState('');
    const [employeeId, setEmployeeId] = useState<number | null>(null);
    const [statusFilter, setStatusFilter] = useState('all');
    const [currentPage, setCurrentPage] = useState(1);
    const [viewRow, setViewRow] = useState<PayrollRow | null>(null);
    const [downloadFormat, setDownloadFormat] = useState<DownloadFormat>('pdf');
    const [showArchiveStorage, setShowArchiveStorage] = useState(false);
    const [actioningPayrollId, setActioningPayrollId] = useState<number | null>(null);
    const [searchTerm, setSearchTerm] = useState('');

    useEffect(() => {
        const init = async () => {
            try {
                const sessionRes = await fetch(`${API_BASE_URL}/api/auth.php`, { credentials: 'include' });
                const sessionData = (await sessionRes.json()) as ApiResponse<SessionUser>;
                if (!sessionData.success || !sessionData.data) {
                    router.push('/');
                    return;
                }

                const sessionUser = sessionData.data;
                setUser(sessionUser);

                const directEmployeeId = Number(sessionUser.employee_id || 0);
                if (directEmployeeId > 0) {
                    setEmployeeId(directEmployeeId);
                } else if (sessionUser.id) {
                    try {
                        const detailRes = await fetch(`${API_BASE_URL}/api/users.php?id=${sessionUser.id}`, { credentials: 'include' });
                        const detailData = (await detailRes.json()) as ApiResponse<{ employee_id?: number | string | null }>;
                        const resolved = Number(detailData?.data?.employee_id || 0);
                        if (resolved > 0) {
                            setEmployeeId(resolved);
                        } else {
                            setEmployeeId(null);
                            setError('Your account is not linked to an employee record.');
                        }
                    } catch {
                        setEmployeeId(null);
                        setError('Failed to resolve your employee record.');
                    }
                } else {
                    setEmployeeId(null);
                    setError('Your account is not linked to an employee record.');
                }
            } catch {
                router.push('/');
            } finally {
                setLoading(false);
            }
        };

        init();
    }, [router]);

    const fetchPayslips = useCallback(async (targetEmployeeId?: number | null) => {
        if (!targetEmployeeId) {
            setRows([]);
            setError('Your account is not linked to an employee record.');
            return;
        }

        setError('');
        const params = new URLSearchParams({
            released_only: '1',
            include_archived: '1',
            my_payslip_scope: showArchiveStorage ? 'archived' : 'active',
        });
        if (statusFilter !== 'all') params.set('status', statusFilter);

        try {
            const res = await fetch(`${API_BASE_URL}/api/payroll.php?${params.toString()}`, { credentials: 'include' });
            const data = (await res.json()) as ApiResponse<PayrollRow[]>;
            if (data.success && Array.isArray(data.data)) {
                setRows(data.data);
            } else {
                setRows([]);
                setError(data.message || 'Failed to load payslips.');
            }
        } catch {
            setRows([]);
            setError('Failed to load payslips.');
        }
    }, [showArchiveStorage, statusFilter]);

    useEffect(() => {
        if (employeeId) {
            fetchPayslips(employeeId);
        }
    }, [fetchPayslips, employeeId]);

    const handleLogout = async () => {
        await fetch(`${API_BASE_URL}/api/auth.php?action=logout`, { method: 'POST', credentials: 'include' });
        router.push('/');
    };

    const refreshPayslips = useCallback(async () => {
        if (!employeeId) return;
        await fetchPayslips(employeeId);
    }, [employeeId, fetchPayslips]);

    const archivePayslip = useCallback(async (row: PayrollRow) => {
        const confirmed = await confirmAction({
            title: 'Archive this payslip?',
            text: `Move the payslip for ${formatPeriodLabel(row.pay_period_start, row.pay_period_end)} to your archive storage.`,
            confirmButtonText: 'Archive',
            icon: 'warning',
        });
        if (!confirmed) return;

        setActioningPayrollId(row.id);
        try {
            const res = await fetch(`${API_BASE_URL}/api/payroll.php?action=my_payslip_archive`, {
                method: 'PUT',
                headers: { 'Content-Type': 'application/json' },
                credentials: 'include',
                body: JSON.stringify({
                    payroll_id: row.id,
                    action: 'archive',
                }),
            });
            const data = (await res.json()) as ApiResponse<PayrollRow>;
            if (!res.ok || !data.success) return;

            setViewRow((prev) => (prev?.id === row.id ? { ...prev, user_is_archived: 1 } : prev));
            setRows((prev) => prev.map((r) => (r.id === row.id ? { ...r, user_is_archived: 1 } : r)));
            // Reconcile with server truth in the background so counts and
            // the archive storage view stay live without a manual reload.
            void refreshPayslips();
        } catch {
            // Mutation errors are already surfaced by the global notification wrapper.
        } finally {
            setActioningPayrollId(null);
        }
    }, [refreshPayslips]);

    const restorePayslip = useCallback(async (row: PayrollRow) => {
        const confirmed = await confirmAction({
            title: 'Restore this archived payslip?',
            text: `Return the payslip for ${formatPeriodLabel(row.pay_period_start, row.pay_period_end)} to your main payslip list.`,
            confirmButtonText: 'Restore',
            icon: 'question',
        });
        if (!confirmed) return;

        setActioningPayrollId(row.id);
        try {
            const res = await fetch(`${API_BASE_URL}/api/payroll.php?action=my_payslip_archive`, {
                method: 'PUT',
                headers: { 'Content-Type': 'application/json' },
                credentials: 'include',
                body: JSON.stringify({
                    payroll_id: row.id,
                    action: 'restore',
                }),
            });
            const data = (await res.json()) as ApiResponse<PayrollRow>;
            if (!res.ok || !data.success) return;

            setViewRow((prev) => (prev?.id === row.id ? { ...prev, user_is_archived: 0 } : prev));
            setRows((prev) => prev.map((r) => (r.id === row.id ? { ...r, user_is_archived: 0 } : r)));
            // Reconcile with server truth in the background so counts and
            // the main list stay live without a manual reload.
            void refreshPayslips();
        } catch {
            // Mutation errors are already surfaced by the global notification wrapper.
        } finally {
            setActioningPayrollId(null);
        }
    }, [refreshPayslips]);

    const downloadPayslip = async (row: PayrollRow, format: DownloadFormat) => {
        // Export from the same display model the on-screen sheet renders,
        // so PDF/Excel match what the user sees in the system.
        const display = buildPayslipDisplay(row);
        const employee = row.full_employee_name || row.employee_name || 'Employee';
        const filename = buildPayslipFilename(employee, row.pay_period_start, row.pay_period_end, format);

        try {
            if (format === 'pdf') {
                await downloadPayslipVisualPdf(display, filename);
            } else {
                const html = buildPayslipExcelHtml(display);
                const blob = new Blob(['\ufeff' + html], { type: 'application/vnd.ms-excel;charset=utf-8' });
                const url = URL.createObjectURL(blob);
                const link = document.createElement('a');
                link.href = url;
                link.download = filename;
                link.click();
                URL.revokeObjectURL(url);
            }
        } catch {
            void notifyError('Failed to generate the payslip file. Please try again.');
        }
    };

    const printPayslip = (row: PayrollRow) => {
        const html = buildPayslipPrintHtml(buildPayslipDisplay(row));
        const popup = window.open('', '_blank', 'width=900,height=700');
        if (!popup) {
            void notifyError('Please allow pop-ups to print payslips.');
            return;
        }
        popup.document.open();
        popup.document.write(html);
        popup.document.close();
        popup.focus();
        setTimeout(() => popup.print(), 250);
    };

    // Client-side filtering for search. The archived flag is also applied
    // locally (on top of the server scope) so archive/restore actions move
    // rows between views instantly without waiting for a refetch.
    const filteredRows = useMemo(() => {
        const inScope = rows.filter((row) =>
            showArchiveStorage ? Number(row.user_is_archived) === 1 : Number(row.user_is_archived) !== 1
        );
        if (!searchTerm.trim()) return inScope;

        const term = searchTerm.toLowerCase().trim();
        return inScope.filter((row) => {
            const payPeriod = `${row.pay_period_start} - ${row.pay_period_end}`.toLowerCase();
            const status = (row.status || '').toLowerCase();
            const grossPay = toCurrency(row.gross_pay).toLowerCase();
            const netPay = toCurrency(row.net_pay).toLowerCase();
            const deductions = toCurrency(row.total_deductions).toLowerCase();
            
            return (
                payPeriod.includes(term) ||
                status.includes(term) ||
                grossPay.includes(term) ||
                netPay.includes(term) ||
                deductions.includes(term)
            );
        });
    }, [rows, searchTerm, showArchiveStorage]);

    const totals = useMemo(() => {
        return filteredRows.reduce(
            (acc, row) => {
                acc.gross += Number(row.gross_pay || 0);
                acc.deductions += Number(row.total_deductions || 0);
                acc.net += Number(row.net_pay || 0);
                return acc;
            },
            { gross: 0, deductions: 0, net: 0 }
        );
    }, [filteredRows]);

    const paginatedRows = filteredRows.slice((currentPage - 1) * ITEMS_PER_PAGE, currentPage * ITEMS_PER_PAGE);

    useEffect(() => {
        setCurrentPage(1);
    }, [rows.length, showArchiveStorage, statusFilter, searchTerm]);

    useEffect(() => {
        const totalPages = Math.max(1, Math.ceil(filteredRows.length / ITEMS_PER_PAGE));
        if (currentPage > totalPages) setCurrentPage(totalPages);
    }, [filteredRows.length, currentPage]);

    useEffect(() => {
        if (!error) return;
        void notifyError(error);
        setError('');
    }, [error]);

    const payslipPreview = viewRow ? buildPayslipDisplay(viewRow) : null;
    const pageHeading = showArchiveStorage ? 'My Payslip Archive Storage' : 'My Payslips';
    const pageDescription = showArchiveStorage
        ? 'Restore archived payslips or remove them from your personal archive storage.'
        : 'Review your payroll history and move payslips into your personal archive storage.';

    if (loading) {

      return (

        <Layout role={String(user?.role || '')} user={user} onLogout={handleLogout}>

          <div style={{ padding: 20 }}>Loading...</div>

        </Layout>

      );

    }

    return (
        <Layout role={user?.role as string | undefined} user={user} onLogout={handleLogout}>
            <Head><title>{pageHeading}</title></Head>
            <div style={{ padding: 16, maxWidth: 1200, margin: '0 auto' }}>
                <div style={{ marginBottom: 12 }}>
                    <div style={{ display: 'flex', alignItems: 'flex-start', justifyContent: 'space-between', marginBottom: 12 }}>
                        <div>
                            <h1 style={{ margin: '0 0 6px 0', fontSize: 14, color: '#1f2937' }}>My Payslips</h1>
                            <p style={{ margin: 0, color: '#64748b', fontSize: 13 }}>
                                {pageDescription}
                            </p>
                        </div>
                        <button
                            type="button"
                            onClick={() => setShowArchiveStorage((prev) => !prev)}
                            style={{...archiveStorageBtnStyle(showArchiveStorage), flexShrink: 0, marginLeft: 12 }}
                            title={showArchiveStorage ? 'Back to active payslips' : 'Open archive storage'}
                            aria-label={showArchiveStorage ? 'Back to active payslips' : 'Open archive storage'}
                        >
                            <CrudActionIcon action="archive" size={15} />
                            {showArchiveStorage ? 'Back to Active' : 'Archive'}
                        </button>
                    </div>
                    <div style={{ display: 'grid', gridTemplateColumns: 'minmax(250px, 2fr) repeat(2, minmax(120px, 1fr))', gap: 12, alignItems: 'flex-end', background: '#fff', padding: '14px 16px', borderRadius: 12, border: '1px solid #e2e8f0' }}>
                        <div style={{ display: 'flex', flexDirection: 'column', gap: 6, minWidth: 0 }}>
                            <label style={{ fontSize: 11, fontWeight: 600, color: '#64748b', textTransform: 'uppercase', letterSpacing: '0.04em' }}>
                                Search Payslips
                            </label>
                            <SearchBar
                                storageKey="mypayslips:list"
                                placeholder="Search by period, status, or amount..."
                                ariaLabel="Search payslips"
                                value={searchTerm}
                                onChange={setSearchTerm}
                                suggestions={collectSearchTerms(rows, [
                                    (r: any) => `${r.pay_period_start || ''} - ${r.pay_period_end || ''}`,
                                    (r: any) => r.status,
                                ])}
                                inputStyle={{ fontSize: 13 }}
                            />
                        </div>
                        <div style={{ display: 'flex', flexDirection: 'column', gap: 6, minWidth: 0 }}>
                            <label style={{ fontSize: 11, fontWeight: 600, color: '#64748b', textTransform: 'uppercase', letterSpacing: '0.04em' }}>
                                Status
                            </label>
                            <select value={statusFilter} onChange={(e) => setStatusFilter(e.target.value)} style={inputStyle}>
                                <option value="all">All Statuses</option>
                                <option value="approved">Approved</option>
                                <option value="paid">Paid</option>
                                <option value="archived">Archived</option>
                            </select>
                        </div>
                        <button type="button" onClick={() => void refreshPayslips()} style={{...toolbarButtonStyle, width: '100%', justifyContent: 'center' }}>
                            Refresh
                        </button>
                    </div>
                </div>

                <div style={{ display: 'grid', gridTemplateColumns: 'repeat(auto-fit, minmax(170px, 1fr))', gap: 10, marginBottom: 12 }}>
                    <SummaryCard label="Total Gross" value={totals.gross} color="#1e3a8a" background="#dbeafe" />
                    <SummaryCard label="Total Deductions" value={totals.deductions} color="#b91c1c" background="#fee2e2" />
                    <SummaryCard label="Total Net Pay" value={totals.net} color="#166534" background="#dcfce7" />
                </div>

                <div style={{ background: '#fff', border: '1px solid #e2e8f0', borderRadius: 12, overflow: 'hidden' }}>
                    <table className="llb-table" style={{ width: '100%', borderCollapse: 'collapse' }}>
                        <thead style={{ background: '#f8fafc' }}>
                            <tr>
                                <th style={thStyle}>Pay Period</th>
                                <th style={thStyle} className="llb-num">Gross</th>
                                <th style={thStyle} className="llb-num">Deductions</th>
                                <th style={thStyle} className="llb-num">Net Pay</th>
                                <th style={thStyle}>Status</th>
                                <th style={thStyle}>Issued At</th>
                                <th style={thStyle}>Action</th>
                            </tr>
                        </thead>
                        <tbody>
                            {filteredRows.length === 0 ? (
                                <tr>
                                    <td colSpan={7} style={{ padding: 12, textAlign: 'center', color: '#64748b' }}>
                                        {rows.length === 0
                                            ? (showArchiveStorage ? 'No archived payslips found.' : 'No payslips found.')
                                            : (
                                                <ZeroResults
                                                    query={searchTerm}
                                                    itemLabel="payslips"
                                                    alternatives={getAlternativeSuggestions(searchTerm, collectSearchTerms(rows, [
                                                        (r: any) => `${r.pay_period_start || ''} - ${r.pay_period_end || ''}`,
                                                        (r: any) => r.status,
                                                    ]))}
                                                    onPickAlternative={(term) => setSearchTerm(term)}
                                                    onClear={() => setSearchTerm('')}
                                                />
                                            )}
                                    </td>
                                </tr>
                            ) : (
                                paginatedRows.map((row) => {
                                    const rowBusy = actioningPayrollId === row.id;
                                    return (
                                        <tr key={row.id} style={{ borderTop: '1px solid #eef2f7' }}>
                                            <td style={tdStyle}>{row.pay_period_start} - {row.pay_period_end}</td>
                                            <td style={tdStyle} className="llb-num">{toCurrency(row.gross_pay)}</td>
                                            <td style={tdStyle} className="llb-num">{toCurrency(row.total_deductions)}</td>
                                            <td style={{ ...tdStyle, fontWeight: 700, color: '#166534' }} className="llb-num">{toCurrency(row.net_pay)}</td>
                                            <td style={tdStyle}><span style={statusPill(row.status)}>{row.status}</span></td>
                                            <td style={tdStyle}>{row.created_at ? new Date(row.created_at).toLocaleDateString() : '-'}</td>
                                            <td style={tdStyle} className="llb-actions">
                                                <div style={{ display: 'flex', flexWrap: 'wrap', gap: 8 }}>
                                                    <button
                                                        type="button"
                                                        onClick={() => setViewRow(row)}
                                                        style={secondaryActionBtnStyle}
                                                        disabled={rowBusy}
                                                    >
                                                        View
                                                    </button>
                                                    {!showArchiveStorage ? (
                                                        <>
                                                            <button
                                                                type="button"
                                                                onClick={() => void archivePayslip(row)}
                                                                style={archiveActionBtnStyle}
                                                                disabled={rowBusy}
                                                                title="Archive payslip"
                                                                aria-label={`Archive payslip for ${formatPeriodLabel(row.pay_period_start, row.pay_period_end)}`}
                                                            >
                                                                <CrudActionIcon action="archive" size={14} />
                                                                {rowBusy ? 'Working...' : 'Archive'}
                                                            </button>
                                                        </>
                                                    ) : (
                                                        <>
                                                            <button
                                                                type="button"
                                                                onClick={() => void restorePayslip(row)}
                                                                style={restoreActionBtnStyle}
                                                                disabled={rowBusy}
                                                                title="Restore payslip"
                                                                aria-label={`Restore payslip for ${formatPeriodLabel(row.pay_period_start, row.pay_period_end)}`}
                                                            >
                                                                <CrudActionIcon action="restore" size={14} />
                                                                {rowBusy ? 'Working...' : 'Restore'}
                                                            </button>
                                                        </>
                                                    )}
                                                </div>
                                            </td>
                                        </tr>
                                    );
                                })
                            )}
                        </tbody>
                    </table>
                </div>

                <Pagination
                    currentPage={currentPage}
                    totalItems={filteredRows.length}
                    itemsPerPage={ITEMS_PER_PAGE}
                    onPageChange={setCurrentPage}
                    label={showArchiveStorage ? 'archived payslips' : 'payslips'}
                />

                {viewRow && payslipPreview && (
                    <div style={modalOverlayStyle} onClick={() => setViewRow(null)}>
                        <div style={modalStyle} onClick={(e) => e.stopPropagation()}>
                            <div style={modalHeaderStyle}>
                                <h2 style={{ margin: 0, fontSize: 14, color: '#0f172a' }}>Payslip</h2>
                                <button onClick={() => setViewRow(null)} style={modalCloseStyle}>X</button>
                            </div>
                            <div style={modalBodyStyle}>
                                <PayslipSheet data={payslipPreview} />
                            </div>
                            <div style={modalFooterStyle}>
                                <div style={{ display: 'flex', alignItems: 'center', gap: 8, flexWrap: 'wrap' }}>
                                    <span style={{ fontSize: 12, color: '#475569', fontWeight: 600 }}>Download format</span>
                                    <select
                                        value={downloadFormat}
                                        onChange={(e) => setDownloadFormat(e.target.value as DownloadFormat)}
                                        style={{ ...inputStyle, padding: '6px 10px', fontSize: 12 }}
                                    >
                                        <option value="pdf">PDF</option>
                                        <option value="xls">Excel</option>
                                    </select>
                                    <button
                                        onClick={() => void downloadPayslip(viewRow, downloadFormat)}
                                        style={modalActionBtnStyle}
                                    >
                                        Download
                                    </button>
                                </div>
                                <div style={{ display: 'flex', alignItems: 'center', gap: 8 }}>
                                    <button onClick={() => printPayslip(viewRow)} style={modalActionPrimaryStyle}>Print</button>
                                    <button onClick={() => setViewRow(null)} style={modalActionBtnStyle}>Close</button>
                                </div>
                            </div>
                        </div>
                    </div>
                )}
            </div>
        </Layout>
    );
}

function toCurrency(value: number) {
    return `PHP ${Number(value || 0).toLocaleString(undefined, { minimumFractionDigits: 2, maximumFractionDigits: 2 })}`;
}

function SummaryCard({ label, value, color, background }: { label: string; value: number; color: string; background: string }) {
    return (
        <div style={{ background, border: '1px solid rgba(15,23,42,0.06)', borderRadius: 10, padding: '10px 12px' }}>
            <div style={{ fontSize: 12, color }}>{label}</div>
            <div style={{ fontSize: 14, fontWeight: 700, color }}>{toCurrency(value)}</div>
        </div>
    );
}

function PayslipSheet({ data }: { data: PayslipDisplay }) {
    const leftMeta = [
        { label: 'No. of days worked', value: data.daysWorked },
        { label: 'Overtime Hours - Regular Day', value: data.overtimeRegular },
        { label: 'Overtime Hours - Rest day', value: data.overtimeRest },
        { label: 'Overtime Hours - Night Differential', value: data.overtimeNight },
        { label: 'Overtime Hours - Regular Holiday', value: data.overtimeRegularHoliday },
        { label: 'Overtime Hours - Special Holiday', value: data.overtimeSpecialHoliday },
    ];

    const rightMeta = [
        { label: 'Absences/Leaves/SH without pay - no. of days', value: data.absencesWithoutPay },
        { label: 'Tardiness/Undertime - No. of hours and minutes', value: data.tardinessUndertime },
        { label: 'Vacation Leave/Special Holiday with pay - no. of days', value: data.vacationLeave },
        { label: 'Sick Leave with pay - no. of days', value: data.sickLeave },
        { label: 'Leaves / Special Holidays charged to earned credit hours', value: data.earnedCreditHours },
    ];

    const metaRows = Array.from({ length: Math.max(leftMeta.length, rightMeta.length) }, (_, idx) => ({
        left: leftMeta[idx],
        right: rightMeta[idx],
    }));

    const earningsRows = Array.from(
        { length: Math.max(data.earnings.length, data.deductions.length) },
        (_, idx) => ({
            earning: data.earnings[idx],
            deduction: data.deductions[idx],
        })
    );

    return (
        <div style={payslipSheetStyle}>
            <div style={payslipTitleStyle}>SAMPLE PAYSLIP</div>
            <div style={payslipDividerStyle} />
            <table style={payslipInfoTableStyle}>
                <tbody>
                    <tr>
                        <td style={payslipInfoLabelStyle}>Period:</td>
                        <td style={payslipInfoValueStyle}>{data.periodLabel}</td>
                        <td style={{ width: 16 }} />
                        <td style={payslipInfoLabelStyle}>Designation</td>
                        <td style={payslipInfoValueStyle}>{data.designation}</td>
                    </tr>
                    <tr>
                        <td style={payslipInfoLabelStyle}>Employee&apos;s Name:</td>
                        <td style={payslipInfoValueStyle}>{data.employeeName}</td>
                        <td />
                        <td style={payslipInfoLabelStyle}>I.D. No.:</td>
                        <td style={payslipInfoValueStyle}>{data.idNumber}</td>
                    </tr>
                </tbody>
            </table>
            <div style={payslipDividerStyle} />
            <table style={payslipMetaTableStyle}>
                <tbody>
                    {metaRows.map((row, idx) => (
                        <tr key={`meta-${idx}`}>
                            <td style={payslipMetaLabelStyle}>{row.left?.label || ''}</td>
                            <td style={payslipMetaValueStyle}>{row.left?.value || ''}</td>
                            <td style={payslipMetaRightLabelStyle}>{row.right?.label || ''}</td>
                            <td style={payslipMetaValueStyle}>{row.right?.value || ''}</td>
                        </tr>
                    ))}
                    <tr>
                        <td colSpan={4} style={payslipNoteStyle}>{data.attendanceNote}</td>
                    </tr>
                </tbody>
            </table>
            <div style={payslipDividerStyle} />
            <table style={payslipEarningsTableStyle}>
                <thead>
                    <tr>
                        <th style={payslipThStyle}>EARNINGS</th>
                        <th style={payslipThStyle}>Monthly</th>
                        <th style={payslipThStyle}>Daily Rate</th>
                        <th style={payslipThStyle}>Semi-Monthly</th>
                        <th style={{ ...payslipThStyle, borderLeft: '1px solid #111' }}>DEDUCTIONS</th>
                        <th style={payslipThStyle}>Amount</th>
                    </tr>
                </thead>
                <tbody>
                    {earningsRows.map((row, idx) => (
                        <tr key={`earn-${idx}`}>
                            <td style={payslipTdStyle}>{row.earning?.label || ''}</td>
                            <td style={payslipMoneyStyle}>{row.earning?.monthly || ''}</td>
                            <td style={payslipMoneyStyle}>{row.earning?.daily || ''}</td>
                            <td style={payslipMoneyStyle}>{row.earning?.semi || ''}</td>
                            <td style={{ ...payslipTdStyle, borderLeft: '1px solid #111' }}>{row.deduction?.label || ''}</td>
                            <td style={payslipMoneyStyle}>{row.deduction?.amount || ''}</td>
                        </tr>
                    ))}
                    <tr>
                        <td style={payslipGrossLabelStyle}>Gross Pay</td>
                        <td style={payslipGrossLabelStyle}></td>
                        <td style={payslipGrossLabelStyle}></td>
                        <td style={payslipGrossValueStyle}>{data.grossPay}</td>
                        <td style={{ ...payslipGrossLabelStyle, borderLeft: '1px solid #111' }}>Total Deductions</td>
                        <td style={payslipGrossValueStyle}>{data.totalDeductions}</td>
                    </tr>
                    <tr>
                        <td colSpan={6} style={payslipNetRowStyle}>
                            <div style={{ display: 'flex', justifyContent: 'space-between', alignItems: 'center' }}>
                                <span>NET PAY</span>
                                <span>{data.netPay}</span>
                            </div>
                        </td>
                    </tr>
                </tbody>
            </table>
            <div style={payslipDividerStyle} />
            <table style={payslipSignatureTableStyle}>
                <tbody>
                    <tr>
                        <td style={{ width: '60%', verticalAlign: 'top', paddingRight: 12 }}>
                            <div style={payslipAckStyle}>
                                I hereby acknowledge receipt of my salaries as indicated in the Net Pay portion
                                representing payment for my services rendered in the payroll period as specified in this payslip
                            </div>
                            <div style={payslipSignatureLineStyle}>{data.employeeSignature}</div>
                            <div style={payslipSignatureLabelStyle}>Employee&apos;s Signature Over Printed Name</div>
                        </td>
                        <td style={{ width: '40%', textAlign: 'center', verticalAlign: 'top' }}>
                            <div style={payslipCertLabelStyle}>Certified correct by:</div>
                            <div style={payslipSignatureLineStyle}>{data.certifiedName}</div>
                            <div style={payslipSignatureLabelStyle}>{data.certifiedTitle}</div>
                        </td>
                    </tr>
                </tbody>
            </table>
        </div>
    );
}

function buildPayslipDisplay(row: PayrollRow): PayslipDisplay {
    const employeeName = row.full_employee_name || row.employee_name || 'Employee';
    const designation = row.position || '-';
    const idNumber = String(row.employee_date_id || row.employee_id || '-');
    const periodLabel = formatPeriodLabel(row.pay_period_start, row.pay_period_end);
    const attendanceNote = formatAttendanceNote(row.pay_period_start, row.pay_period_end);
    const periodDays = calculatePeriodDays(row.pay_period_start, row.pay_period_end);
    const basicSemi = toNumber(row.basic_salary);
    const isSemiMonthly = periodDays > 0 && periodDays <= 16;
    const monthlyBasic = isSemiMonthly ? basicSemi * 2 : basicSemi;
    const dailyRate = periodDays > 0 ? basicSemi / periodDays : 0;

    // True attendance figures from the import record when one exists for
    // this employee + period; otherwise fall back to prior display behavior.
    const hasAttendance = row.attendance_days_worked !== null
        && row.attendance_days_worked !== undefined
        && String(row.attendance_days_worked).trim() !== '';
    const workedDays = hasAttendance ? toNumber(row.attendance_days_worked) : periodDays;
    const absentDays = row.attendance_absent_days !== null
        && row.attendance_absent_days !== undefined
        && String(row.attendance_absent_days).trim() !== ''
        ? toNumber(row.attendance_absent_days)
        : null;
    const lateMinutes = row.attendance_late_minutes !== null
        && row.attendance_late_minutes !== undefined
        && String(row.attendance_late_minutes).trim() !== ''
        ? Math.max(0, Math.trunc(Number(row.attendance_late_minutes) || 0))
        : null;
    const leaveDays = row.attendance_leave_days !== null
        && row.attendance_leave_days !== undefined
        && String(row.attendance_leave_days).trim() !== ''
        ? toNumber(row.attendance_leave_days)
        : null;
    const tardinessLabel = lateMinutes === null
        ? '-'
        : `${Math.floor(lateMinutes / 60)}h ${String(lateMinutes % 60).padStart(2, '0')}m`;

    const earnings: PayslipEarningRow[] = [
        {
            label: 'Basic Taxable Salary',
            monthly: formatMoneyPlainOrDash(monthlyBasic),
            daily: formatMoneyPlainOrDash(dailyRate),
            semi: formatMoneyPlainOrDash(basicSemi),
        },
        { label: 'De Minimis', monthly: '-', daily: '-', semi: formatMoneyPlainOrDash(row.clothing_allowance) },
        {
            label: 'Non-Taxable Benefit',
            monthly: '-',
            daily: '-',
            semi: formatMoneyPlainOrDash(toNumber(row.travel_allowance) + toNumber(row.salary_adjustment)),
        },
        { label: 'OT - Regular Day', monthly: '-', daily: '-', semi: formatMoneyPlainOrDash(row.overtime_pay) },
        { label: 'OT - Rest Day', monthly: '-', daily: '-', semi: '-' },
        { label: 'OT - Night Differential', monthly: '-', daily: '-', semi: '-' },
        { label: 'OT - Regular Holiday', monthly: '-', daily: '-', semi: '-' },
        { label: 'OT - Special Holiday', monthly: '-', daily: '-', semi: '-' },
        { label: 'Bonus', monthly: '-', daily: '-', semi: formatMoneyPlainOrDash(row.bonus) },
    ];

    const deductions: PayslipDeductionRow[] = [
        { label: 'Withholding tax', amount: formatMoneyPlainOrDash(row.tax) },
        { label: 'Pag-ibig Premium', amount: formatMoneyPlainOrDash(row.pagibig_contribution) },
        { label: 'SSS Regular Contributions', amount: formatMoneyPlainOrDash(row.sss_contribution) },
        { label: 'Other Deductions', amount: formatMoneyPlainOrDash(row.other_deductions) },
        { label: 'Philhealth', amount: formatMoneyPlainOrDash(row.philhealth_contribution) },
        { label: buildCashAdvanceDeductionLabel(row), amount: formatMoneyPlainOrDash(row.cash_advance_deduction) },
        { label: 'Laptop Loan', amount: formatMoneyPlainOrDash(row.laptop_loan_deduction) },
        { label: 'Absences/Leaves without pay', amount: formatMoneyPlainOrDash(row.absence_deduction) },
        { label: 'Late Deduction', amount: formatMoneyPlainOrDash(row.late_deduction) },
    ];

    return {
        periodLabel,
        employeeName,
        designation,
        idNumber,
        daysWorked: formatNumberOrDash(workedDays),
        overtimeRegular: formatNumberOrDash(row.overtime_hours),
        overtimeRest: '-',
        overtimeNight: '-',
        overtimeRegularHoliday: '-',
        overtimeSpecialHoliday: '-',
        absencesWithoutPay: absentDays === null ? '-' : formatNumberOrDash(absentDays),
        tardinessUndertime: tardinessLabel,
        vacationLeave: '-',
        sickLeave: '-',
        earnedCreditHours: leaveDays === null ? '-' : formatNumberOrDash(leaveDays),
        attendanceNote,
        earnings,
        deductions,
        grossPay: formatMoneyPlain(row.gross_pay),
        totalDeductions: formatMoneyPlain(row.total_deductions),
        netPay: formatMoneyPlain(row.net_pay),
        employeeSignature: employeeName,
        certifiedName: 'Human Resources Department',
        certifiedTitle: 'Head, Human Resources Department',
    };
}

function toNumber(value: number | string | null | undefined) {
    const parsed = Number(value || 0);
    return Number.isFinite(parsed) ? parsed : 0;
}

function formatMoneyPlain(value: number | string | null | undefined) {
    const amount = toNumber(value);
    return amount.toLocaleString(undefined, { minimumFractionDigits: 2, maximumFractionDigits: 2 });
}

function formatMoneyPlainOrDash(value: number | string | null | undefined) {
    const amount = toNumber(value);
    if (!amount) return '-';
    return formatMoneyPlain(amount);
}

function formatNumberOrDash(value: number | string | null | undefined, decimals = 2) {
    const amount = toNumber(value);
    if (!amount) return '-';
    return amount.toFixed(decimals);
}

function calculatePeriodDays(start: string, end: string) {
    const startDate = new Date(`${start}T00:00:00`);
    const endDate = new Date(`${end}T00:00:00`);
    if (Number.isNaN(startDate.getTime()) || Number.isNaN(endDate.getTime())) return 0;
    const diff = endDate.getTime() - startDate.getTime();
    if (diff < 0) return 0;
    return Math.floor(diff / 86400000) + 1;
}

function formatPeriodLabel(start: string, end: string) {
    const startDate = new Date(`${start}T00:00:00`);
    const endDate = new Date(`${end}T00:00:00`);
    if (Number.isNaN(startDate.getTime()) || Number.isNaN(endDate.getTime())) {
        return `${start} - ${end}`.trim();
    }

    const sameMonth = startDate.getMonth() === endDate.getMonth();
    const sameYear = startDate.getFullYear() === endDate.getFullYear();
    const monthStart = startDate.toLocaleString('en-US', { month: 'long' });
    const monthEnd = endDate.toLocaleString('en-US', { month: 'long' });

    const label = sameMonth && sameYear
        ? `${monthStart} ${startDate.getDate()}-${endDate.getDate()}, ${startDate.getFullYear()}`
        : `${monthStart} ${startDate.getDate()}, ${startDate.getFullYear()} - ${monthEnd} ${endDate.getDate()}, ${endDate.getFullYear()}`;

    return label.toUpperCase();
}

function formatAttendanceNote(start: string, end: string) {
    const startDate = new Date(`${start}T00:00:00`);
    const endDate = new Date(`${end}T00:00:00`);
    if (Number.isNaN(startDate.getTime()) || Number.isNaN(endDate.getTime())) {
        return '(Based on payroll attendance record)';
    }

    const sameMonth = startDate.getMonth() === endDate.getMonth();
    const sameYear = startDate.getFullYear() === endDate.getFullYear();
    const monthStart = startDate.toLocaleString('en-US', { month: 'long' });
    const monthEnd = endDate.toLocaleString('en-US', { month: 'long' });

    const label = sameMonth && sameYear
        ? `${startDate.getDate()}-${endDate.getDate()} ${monthStart} ${startDate.getFullYear()}`
        : `${startDate.getDate()} ${monthStart} ${startDate.getFullYear()} - ${endDate.getDate()} ${monthEnd} ${endDate.getFullYear()}`;

    return `(Based on ${label} Attendance record)`;
}

function buildCashAdvanceDeductionLabel(row: PayrollRow) {
    const requestCount = Math.max(0, Math.floor(toNumber(row.cash_advance_request_count)));
    const manualAmount = toNumber(row.cash_advance_manual_deduction);

    if (requestCount > 0 && manualAmount > 0) {
        return `Cash Advance (${requestCount} approved request${requestCount === 1 ? '' : 's'} + manual)`;
    }
    if (requestCount > 0) {
        return `Cash Advance (${requestCount} approved request${requestCount === 1 ? '' : 's'})`;
    }
    if (manualAmount > 0) {
        return 'Cash Advance (manual)';
    }

    return 'Cash Advance';
}

function archiveStorageBtnStyle(active: boolean): CSSProperties {
    return {
        display: 'inline-flex',
        alignItems: 'center',
        gap: 8,
        padding: '10px 14px',
        borderRadius: 8,
        border: `1px solid ${active ? '#bfdbfe' : '#cbd5e1'}`,
        background: active ? '#eff6ff' : '#fff',
        color: active ? '#1d4ed8' : '#334155',
        cursor: 'pointer',
        fontSize: 13,
        fontWeight: 700,
    };
}

const toolbarButtonStyle: CSSProperties = {
    border: '1px solid #1e3a8a',
    background: '#1e3a8a',
    color: '#fff',
    borderRadius: 8,
    padding: '10px 14px',
    cursor: 'pointer',
    fontSize: 13,
    fontWeight: 700,
};

const secondaryActionBtnStyle: CSSProperties = {
    border: '1px solid #cbd5e1',
    background: '#fff',
    color: '#334155',
    borderRadius: 8,
    padding: '6px 10px',
    cursor: 'pointer',
    fontSize: 12,
    fontWeight: 600,
};

const primaryOutlineActionBtnStyle: CSSProperties = {
    border: '1px solid #1e3a8a',
    background: '#fff',
    color: '#1e3a8a',
    borderRadius: 8,
    padding: '6px 10px',
    cursor: 'pointer',
    fontSize: 12,
    fontWeight: 600,
};

const archiveActionBtnStyle: CSSProperties = {
    border: '1px solid #fbcfe8',
    background: '#fff1f2',
    color: '#be123c',
    borderRadius: 8,
    padding: '6px 10px',
    cursor: 'pointer',
    fontSize: 12,
    fontWeight: 600,
    display: 'inline-flex',
    alignItems: 'center',
    gap: 6,
};

const restoreActionBtnStyle: CSSProperties = {
    border: '1px solid #bbf7d0',
    background: '#f0fdf4',
    color: '#166534',
    borderRadius: 8,
    padding: '6px 10px',
    cursor: 'pointer',
    fontSize: 12,
    fontWeight: 600,
    display: 'inline-flex',
    alignItems: 'center',
    gap: 6,
};

const deleteActionBtnStyle: CSSProperties = {
    border: '1px solid #fecaca',
    background: '#fef2f2',
    color: '#b91c1c',
    borderRadius: 8,
    padding: '6px 10px',
    cursor: 'pointer',
    fontSize: 12,
    fontWeight: 600,
    display: 'inline-flex',
    alignItems: 'center',
    gap: 6,
};

const inputStyle: CSSProperties = {
    padding: '10px 12px',
    borderRadius: 8,
    border: '1px solid #cbd5e1',
    background: '#fff',
    color: '#1f2937',
};

const thStyle: CSSProperties = {
    padding: '12px 14px',
    textAlign: 'left',
    color: '#475569',
    fontSize: 13,
    fontWeight: 700,
};

const tdStyle: CSSProperties = {
    padding: '12px 14px',
    color: '#334155',
    fontSize: 13,
};

function statusPill(status: string): CSSProperties {
    const value = String(status || '').toLowerCase();
    if (value === 'approved' || value === 'paid') {
        return { background: '#dcfce7', color: '#166534', borderRadius: 999, padding: '3px 10px', fontSize: 12, fontWeight: 700, textTransform: 'capitalize' };
    }
    if (value === 'draft') {
        return { background: '#fef3c7', color: '#92400e', borderRadius: 999, padding: '3px 10px', fontSize: 12, fontWeight: 700, textTransform: 'capitalize' };
    }
    return { background: '#e5e7eb', color: '#4b5563', borderRadius: 999, padding: '3px 10px', fontSize: 12, fontWeight: 700, textTransform: 'capitalize' };
}

function buildPayslipFilename(employee: string, start: string, end: string, format: DownloadFormat) {
    const safeEmployee = String(employee || 'employee')
        .toLowerCase()
        .replace(/[^a-z0-9]+/g, '-')
        .replace(/(^-|-$)/g, '');
    const safeStart = String(start || '').replace(/[^0-9-]+/g, '');
    const safeEnd = String(end || '').replace(/[^0-9-]+/g, '');
    const period = safeStart && safeEnd ? `${safeStart}_to_${safeEnd}` : 'period';
    return `payslip_${safeEmployee || 'employee'}_${period}.${format}`;
}

function buildPayslipPrintHtml(payload: PayslipDisplay) {
    const title = `Payslip - ${payload.employeeName || 'Employee'}`;

    const leftMeta = [
        ['No. of days worked', payload.daysWorked],
        ['Overtime Hours - Regular Day', payload.overtimeRegular],
        ['Overtime Hours - Rest day', payload.overtimeRest],
        ['Overtime Hours - Night Differential', payload.overtimeNight],
        ['Overtime Hours - Regular Holiday', payload.overtimeRegularHoliday],
        ['Overtime Hours - Special Holiday', payload.overtimeSpecialHoliday],
    ];

    const rightMeta = [
        ['Absences/Leaves/SH without pay - no. of days', payload.absencesWithoutPay],
        ['Tardiness/Undertime - No. of hours and minutes', payload.tardinessUndertime],
        ['Vacation Leave/Special Holiday with pay - no. of days', payload.vacationLeave],
        ['Sick Leave with pay - no. of days', payload.sickLeave],
        ['Leaves / Special Holidays charged to earned credit hours', payload.earnedCreditHours],
    ];

    const metaRows = Array.from({ length: Math.max(leftMeta.length, rightMeta.length) }, (_, idx) => {
        const left = leftMeta[idx] || ['', ''];
        const right = rightMeta[idx] || ['', ''];
        return `
            <tr>
                <td class="meta-label">${escapeHtml(left[0])}</td>
                <td class="meta-value">${escapeHtml(String(left[1] ?? ''))}</td>
                <td class="meta-label right">${escapeHtml(right[0])}</td>
                <td class="meta-value">${escapeHtml(String(right[1] ?? ''))}</td>
            </tr>
        `;
    }).join('');

    const maxRows = Math.max(payload.earnings.length, payload.deductions.length);
    const earningsRows = Array.from({ length: maxRows }, (_, idx) => {
        const earning = payload.earnings[idx];
        const deduction = payload.deductions[idx];
        return `
            <tr>
                <td>${escapeHtml(earning?.label || '')}</td>
                <td class="money">${escapeHtml(earning?.monthly || '')}</td>
                <td class="money">${escapeHtml(earning?.daily || '')}</td>
                <td class="money">${escapeHtml(earning?.semi || '')}</td>
                <td class="right-divider">${escapeHtml(deduction?.label || '')}</td>
                <td class="money">${escapeHtml(deduction?.amount || '')}</td>
            </tr>
        `;
    }).join('');

    return `
        <!doctype html>
        <html lang="en">
            <head>
                <meta charset="utf-8" />
                <title>${escapeHtml(title)}</title>
                <style>
                    * { box-sizing: border-box; }
                    body { font-family: "Times New Roman", serif; padding: 24px; color: #111; }
                    .payslip { border: 2px solid #111; padding: 10px 12px; font-size: 12px; }
                    .title { font-weight: 700; font-size: 14px; margin-bottom: 6px; }
                    .divider { border-top: 1px solid #111; margin: 6px 0; }
                    table { width: 100%; border-collapse: collapse; font-size: 12px; }
                    .info td { padding: 2px 4px; }
                    .info .label { font-weight: 600; white-space: nowrap; }
                    .info .value { font-weight: 700; }
                    .meta td { padding: 2px 4px; vertical-align: top; }
                    .meta .meta-label { white-space: normal; }
                    .meta .meta-value { text-align: right; font-weight: 700; }
                    .meta .right { border-left: 1px solid #111; }
                    .note { font-style: italic; text-align: right; padding: 4px; }
                    .earnings th { font-weight: 700; text-transform: uppercase; border-bottom: 1px solid #111; padding: 2px 4px; font-size: 11px; }
                    .earnings td { padding: 2px 4px; vertical-align: top; }
                    .earnings .money { text-align: right; font-weight: 700; }
                    .earnings .right-divider { border-left: 1px solid #111; }
                    .gross-row td { border-top: 1px solid #111; font-weight: 700; }
                    .net-row td { border-top: 1px solid #111; font-weight: 700; font-size: 14px; padding: 6px 4px; }
                    .net-row .net-inner { display: flex; justify-content: space-between; align-items: center; }
                    .signature td { padding-top: 8px; vertical-align: top; }
                    .signature .ack { font-size: 11px; line-height: 1.3; }
                    .signature .line { border-top: 1px solid #111; margin-top: 20px; padding-top: 4px; font-weight: 700; text-align: center; }
                    .signature .label { font-size: 11px; text-align: center; }
                </style>
            </head>
            <body>
                <div class="payslip">
                    <div class="title">SAMPLE PAYSLIP</div>
                    <div class="divider"></div>
                    <table class="info">
                        <tbody>
                            <tr>
                                <td class="label">Period:</td>
                                <td class="value">${escapeHtml(payload.periodLabel)}</td>
                                <td style="width:16px;"></td>
                                <td class="label">Designation</td>
                                <td class="value">${escapeHtml(payload.designation)}</td>
                            </tr>
                            <tr>
                                <td class="label">Employee's Name:</td>
                                <td class="value">${escapeHtml(payload.employeeName)}</td>
                                <td></td>
                                <td class="label">I.D. No.:</td>
                                <td class="value">${escapeHtml(payload.idNumber)}</td>
                            </tr>
                        </tbody>
                    </table>
                    <div class="divider"></div>
                    <table class="meta">
                        <tbody>
                            ${metaRows}
                            <tr>
                                <td colspan="4" class="note">${escapeHtml(payload.attendanceNote)}</td>
                            </tr>
                        </tbody>
                    </table>
                    <div class="divider"></div>
                    <table class="earnings">
                        <thead>
                            <tr>
                                <th>EARNINGS</th>
                                <th>Monthly</th>
                                <th>Daily Rate</th>
                                <th>Semi-Monthly</th>
                                <th class="right-divider">DEDUCTIONS</th>
                                <th>Amount</th>
                            </tr>
                        </thead>
                        <tbody>
                            ${earningsRows}
                            <tr class="gross-row">
                                <td>Gross Pay</td>
                                <td></td>
                                <td></td>
                                <td class="money">${escapeHtml(payload.grossPay)}</td>
                                <td class="right-divider">Total Deductions</td>
                                <td class="money">${escapeHtml(payload.totalDeductions)}</td>
                            </tr>
                            <tr class="net-row">
                                <td colspan="6">
                                    <div class="net-inner">
                                        <span>NET PAY</span>
                                        <span>${escapeHtml(payload.netPay)}</span>
                                    </div>
                                </td>
                            </tr>
                        </tbody>
                    </table>
                    <div class="divider"></div>
                    <table class="signature">
                        <tbody>
                            <tr>
                                <td style="width:60%; padding-right:12px;">
                                    <div class="ack">
                                        I hereby acknowledge receipt of my salaries as indicated in the Net Pay portion
                                        representing payment for my services rendered in the payroll period as specified in this payslip
                                    </div>
                                    <div class="line">${escapeHtml(payload.employeeSignature)}</div>
                                    <div class="label">Employee's Signature Over Printed Name</div>
                                </td>
                                <td style="width:40%; text-align:center;">
                                    <div class="ack">Certified correct by:</div>
                                    <div class="line">${escapeHtml(payload.certifiedName)}</div>
                                    <div class="label">${escapeHtml(payload.certifiedTitle)}</div>
                                </td>
                            </tr>
                        </tbody>
                    </table>
                </div>
            </body>
        </html>
    `;
}

function escapeHtml(value: string) {
    return value
        .replace(/&/g, '&amp;')
        .replace(/</g, '&lt;')
        .replace(/>/g, '&gt;')
        .replace(/"/g, '&quot;')
        .replace(/'/g, '&#39;');
}

async function downloadPayslipVisualPdf(display: PayslipDisplay, filename: string) {
    // The PDF is captured from the same HTML/CSS document used for Print,
    // avoiding the layout drift caused by separately drawing every field.
    try {
        await downloadHtmlAsPdf(buildPayslipPrintHtml(display), filename, 900);
    } catch {
        // Keep the previous vector renderer as a compatibility fallback for
        // older embedded browsers that cannot capture an HTML canvas.
        await downloadPayslipPdf(display, filename);
    }
}

async function downloadPayslipPdf(display: PayslipDisplay, filename: string) {
    const { jsPDF } = await import('jspdf');
    const doc = new jsPDF({ orientation: 'portrait', unit: 'mm', format: 'a4' });
    const pageW = doc.internal.pageSize.getWidth();
    const pageH = doc.internal.pageSize.getHeight();
    const margin = 12;
    const right = pageW - margin;
    let y = margin;

    const ensureSpace = (needed: number) => {
        if (y + needed > pageH - margin) {
            doc.addPage();
            y = margin;
        }
    };

    const divider = () => {
        doc.setDrawColor(17, 17, 17);
        doc.setLineWidth(0.4);
        doc.line(margin, y, right, y);
        y += 4;
    };

    // Title — mirrors the on-screen sheet header.
    doc.setFont('times', 'bold');
    doc.setFontSize(14);
    doc.setTextColor(17, 17, 17);
    doc.text('SAMPLE PAYSLIP', pageW / 2, y, { align: 'center' });
    y += 6;
    divider();

    // Info block: Period / Designation / Employee's Name / I.D. No.
    const infoRow = (labelA: string, valueA: string, labelB: string, valueB: string) => {
        ensureSpace(6);
        doc.setFont('times', 'normal');
        doc.setFontSize(9);
        doc.text(labelA, margin, y);
        doc.setFont('times', 'bold');
        doc.text(doc.splitTextToSize(valueA, 62), margin + 32, y);
        doc.setFont('times', 'normal');
        doc.text(labelB, 118, y);
        doc.setFont('times', 'bold');
        doc.text(doc.splitTextToSize(valueB, 62), 150, y);
        y += 6;
    };
    infoRow('Period:', display.periodLabel, 'Designation', display.designation);
    infoRow("Employee's Name:", display.employeeName, 'I.D. No.:', display.idNumber);
    divider();

    // Attendance meta block (two columns, values right-aligned).
    const metaRow = (labelA: string, valueA: string, labelB: string, valueB: string) => {
        ensureSpace(6);
        doc.setFont('times', 'normal');
        doc.setFontSize(8.5);
        doc.text(doc.splitTextToSize(labelA, 58), margin, y);
        doc.setFont('times', 'bold');
        doc.text(valueA, 100, y, { align: 'right' });
        doc.setFont('times', 'normal');
        doc.text(doc.splitTextToSize(labelB, 58), 104, y);
        doc.setFont('times', 'bold');
        doc.text(valueB, right, y, { align: 'right' });
        y += 5;
    };
    const leftMeta: Array<[string, string]> = [
        ['No. of days worked', display.daysWorked],
        ['Overtime Hours - Regular Day', display.overtimeRegular],
        ['Overtime Hours - Rest day', display.overtimeRest],
        ['Overtime Hours - Night Differential', display.overtimeNight],
        ['Overtime Hours - Regular Holiday', display.overtimeRegularHoliday],
        ['Overtime Hours - Special Holiday', display.overtimeSpecialHoliday],
    ];
    const rightMeta: Array<[string, string]> = [
        ['Absences/Leaves/SH without pay - no. of days', display.absencesWithoutPay],
        ['Tardiness/Undertime - No. of hours and minutes', display.tardinessUndertime],
        ['Vacation Leave/Special Holiday with pay - no. of days', display.vacationLeave],
        ['Sick Leave with pay - no. of days', display.sickLeave],
        ['Leaves / Special Holidays charged to earned credit hours', display.earnedCreditHours],
    ];
    for (let i = 0; i < Math.max(leftMeta.length, rightMeta.length); i++) {
        metaRow(leftMeta[i]?.[0] || '', leftMeta[i]?.[1] || '', rightMeta[i]?.[0] || '', rightMeta[i]?.[1] || '');
    }
    ensureSpace(6);
    doc.setFont('times', 'italic');
    doc.setFontSize(8.5);
    doc.text(display.attendanceNote, right, y, { align: 'right' });
    y += 5;
    divider();

    // Earnings / deductions table header.
    ensureSpace(8);
    doc.setFont('times', 'bold');
    doc.setFontSize(8.5);
    doc.text('EARNINGS', margin, y);
    doc.text('Monthly', 94, y, { align: 'right' });
    doc.text('Daily Rate', 118, y, { align: 'right' });
    doc.text('Semi-Monthly', 144, y, { align: 'right' });
    doc.text('DEDUCTIONS', 148, y);
    doc.text('Amount', right, y, { align: 'right' });
    y += 2;
    doc.setDrawColor(17, 17, 17);
    doc.setLineWidth(0.3);
    doc.line(margin, y, right, y);
    y += 4;

    const maxRows = Math.max(display.earnings.length, display.deductions.length);
    doc.setFontSize(8.5);
    for (let i = 0; i < maxRows; i++) {
        ensureSpace(6);
        const earning = display.earnings[i];
        const deduction = display.deductions[i];
        doc.setFont('times', 'normal');
        doc.text(doc.splitTextToSize(earning?.label || '', 54), margin, y);
        doc.setFont('times', 'bold');
        doc.text(earning?.monthly || '', 94, y, { align: 'right' });
        doc.text(earning?.daily || '', 118, y, { align: 'right' });
        doc.text(earning?.semi || '', 144, y, { align: 'right' });
        doc.setFont('times', 'normal');
        doc.text(doc.splitTextToSize(deduction?.label || '', 40), 148, y);
        doc.setFont('times', 'bold');
        doc.text(deduction?.amount || '', right, y, { align: 'right' });
        y += 5;
    }

    // Gross pay row.
    ensureSpace(7);
    doc.setDrawColor(17, 17, 17);
    doc.setLineWidth(0.3);
    doc.line(margin, y, right, y);
    y += 5;
    doc.setFont('times', 'bold');
    doc.setFontSize(8.5);
    doc.text('Gross Pay', margin, y);
    doc.text(display.grossPay, 144, y, { align: 'right' });
    doc.text('Total Deductions', 148, y);
    doc.text(display.totalDeductions, right, y, { align: 'right' });
    y += 2;

    // Net pay row.
    ensureSpace(9);
    doc.line(margin, y, right, y);
    y += 6;
    doc.setFontSize(12);
    doc.text('NET PAY', margin, y);
    doc.text(display.netPay, right, y, { align: 'right' });
    y += 6;
    divider();

    // Acknowledgement + signatures.
    ensureSpace(30);
    doc.setFont('times', 'normal');
    doc.setFontSize(8.5);
    const ack = 'I hereby acknowledge receipt of my salaries as indicated in the Net Pay portion representing payment for my services rendered in the payroll period as specified in this payslip';
    const ackLines = doc.splitTextToSize(ack, 108);
    doc.text(ackLines, margin, y);
    doc.text('Certified correct by:', 148, y);
    y += ackLines.length * 4 + 12;
    doc.setDrawColor(17, 17, 17);
    doc.setLineWidth(0.3);
    doc.line(margin, y, 120, y);
    doc.line(134, y, right, y);
    y += 5;
    doc.setFont('times', 'bold');
    doc.setFontSize(8.5);
    doc.text(display.employeeSignature, (margin + 120) / 2, y, { align: 'center', maxWidth: 104 });
    doc.text(display.certifiedName, (134 + right) / 2, y, { align: 'center', maxWidth: 60 });
    y += 4;
    doc.setFont('times', 'normal');
    doc.setFontSize(8);
    doc.text("Employee's Signature Over Printed Name", (margin + 120) / 2, y, { align: 'center' });
    doc.text(display.certifiedTitle, (134 + right) / 2, y, { align: 'center' });

    doc.save(filename);
}

function buildPayslipExcelHtml(display: PayslipDisplay): string {
    const leftMeta: Array<[string, string]> = [
        ['No. of days worked', display.daysWorked],
        ['Overtime Hours - Regular Day', display.overtimeRegular],
        ['Overtime Hours - Rest day', display.overtimeRest],
        ['Overtime Hours - Night Differential', display.overtimeNight],
        ['Overtime Hours - Regular Holiday', display.overtimeRegularHoliday],
        ['Overtime Hours - Special Holiday', display.overtimeSpecialHoliday],
    ];
    const rightMeta: Array<[string, string]> = [
        ['Absences/Leaves/SH without pay - no. of days', display.absencesWithoutPay],
        ['Tardiness/Undertime - No. of hours and minutes', display.tardinessUndertime],
        ['Vacation Leave/Special Holiday with pay - no. of days', display.vacationLeave],
        ['Sick Leave with pay - no. of days', display.sickLeave],
        ['Leaves / Special Holidays charged to earned credit hours', display.earnedCreditHours],
    ];
    const metaRows = Array.from({ length: Math.max(leftMeta.length, rightMeta.length) }, (_, idx) => {
        const left = leftMeta[idx] || ['', ''];
        const rightSide = rightMeta[idx] || ['', ''];
        return `<tr>`
            + `<td style="border:1px solid #111111;">${escapeHtml(left[0])}</td>`
            + `<td style="border:1px solid #111111;text-align:right;font-weight:bold;">${escapeHtml(String(left[1] ?? ''))}</td>`
            + `<td style="border:1px solid #111111;border-left:2px solid #111111;">${escapeHtml(rightSide[0])}</td>`
            + `<td style="border:1px solid #111111;text-align:right;font-weight:bold;">${escapeHtml(String(rightSide[1] ?? ''))}</td>`
            + `</tr>`;
    }).join('');

    const maxRows = Math.max(display.earnings.length, display.deductions.length);
    const earningRows = Array.from({ length: maxRows }, (_, idx) => {
        const earning = display.earnings[idx];
        const deduction = display.deductions[idx];
        return `<tr>`
            + `<td style="border:1px solid #111111;">${escapeHtml(earning?.label || '')}</td>`
            + `<td style="border:1px solid #111111;text-align:right;font-weight:bold;">${escapeHtml(earning?.monthly || '')}</td>`
            + `<td style="border:1px solid #111111;text-align:right;font-weight:bold;">${escapeHtml(earning?.daily || '')}</td>`
            + `<td style="border:1px solid #111111;text-align:right;font-weight:bold;">${escapeHtml(earning?.semi || '')}</td>`
            + `<td style="border:1px solid #111111;border-left:2px solid #111111;">${escapeHtml(deduction?.label || '')}</td>`
            + `<td style="border:1px solid #111111;text-align:right;font-weight:bold;">${escapeHtml(deduction?.amount || '')}</td>`
            + `</tr>`;
    }).join('');

    return `<html xmlns:o="urn:schemas-microsoft-com:office:office" xmlns:x="urn:schemas-microsoft-com:office:excel" xmlns="http://www.w3.org/TR/REC-html40">`
        + `<head><meta charset="UTF-8" /></head>`
        + `<body style="font-family:'Times New Roman',serif;color:#111111;">`
        + `<table border="0" cellspacing="0" cellpadding="4" style="border:2px solid #111111;border-collapse:collapse;width:100%;">`
        + `<tbody>`
        + `<tr><td colspan="6" style="font-size:14pt;font-weight:bold;text-align:center;">SAMPLE PAYSLIP</td></tr>`
        + `<tr>`
        + `<td style="font-weight:bold;">Period:</td><td style="font-weight:bold;">${escapeHtml(display.periodLabel)}</td><td></td>`
        + `<td style="font-weight:bold;">Designation</td><td colspan="2" style="font-weight:bold;">${escapeHtml(display.designation)}</td>`
        + `</tr>`
        + `<tr>`
        + `<td style="font-weight:bold;">Employee&apos;s Name:</td><td style="font-weight:bold;">${escapeHtml(display.employeeName)}</td><td></td>`
        + `<td style="font-weight:bold;">I.D. No.:</td><td colspan="2" style="font-weight:bold;">${escapeHtml(display.idNumber)}</td>`
        + `</tr>`
        + metaRows
        + `<tr><td colspan="6" style="font-style:italic;text-align:right;">${escapeHtml(display.attendanceNote)}</td></tr>`
        + `<tr>`
        + `<td style="font-weight:bold;border-top:2px solid #111111;">EARNINGS</td>`
        + `<td style="font-weight:bold;text-align:right;border-top:2px solid #111111;">Monthly</td>`
        + `<td style="font-weight:bold;text-align:right;border-top:2px solid #111111;">Daily Rate</td>`
        + `<td style="font-weight:bold;text-align:right;border-top:2px solid #111111;">Semi-Monthly</td>`
        + `<td style="font-weight:bold;border-top:2px solid #111111;border-left:2px solid #111111;">DEDUCTIONS</td>`
        + `<td style="font-weight:bold;text-align:right;border-top:2px solid #111111;">Amount</td>`
        + `</tr>`
        + earningRows
        + `<tr>`
        + `<td style="font-weight:bold;border-top:2px solid #111111;">Gross Pay</td><td style="border-top:2px solid #111111;"></td><td style="border-top:2px solid #111111;"></td>`
        + `<td style="font-weight:bold;text-align:right;border-top:2px solid #111111;">${escapeHtml(display.grossPay)}</td>`
        + `<td style="font-weight:bold;border-top:2px solid #111111;border-left:2px solid #111111;">Total Deductions</td>`
        + `<td style="font-weight:bold;text-align:right;border-top:2px solid #111111;">${escapeHtml(display.totalDeductions)}</td>`
        + `</tr>`
        + `<tr><td colspan="6" style="font-weight:bold;font-size:14pt;border-top:2px solid #111111;">NET PAY&nbsp;&nbsp;&nbsp;${escapeHtml(display.netPay)}</td></tr>`
        + `<tr>`
        + `<td colspan="4">I hereby acknowledge receipt of my salaries as indicated in the Net Pay portion representing payment for my services rendered in the payroll period as specified in this payslip<br /><br /><strong>${escapeHtml(display.employeeSignature)}</strong><br />Employee&apos;s Signature Over Printed Name</td>`
        + `<td colspan="2" style="text-align:center;">Certified correct by:<br /><br /><strong>${escapeHtml(display.certifiedName)}</strong><br />${escapeHtml(display.certifiedTitle)}</td>`
        + `</tr>`
        + `</tbody></table></body></html>`;
}

const modalOverlayStyle: CSSProperties = {
    position: 'fixed',
    inset: 0,
    background: 'rgba(15, 23, 42, 0.45)',
    display: 'flex',
    alignItems: 'center',
    justifyContent: 'center',
    zIndex: 1000,
};

const modalStyle: CSSProperties = {
    background: '#fff',
    borderRadius: 'var(--modal-radius)',
    width: 920,
    maxWidth: '96vw',
    maxHeight: '90vh',
    overflowY: 'auto',
    boxShadow: '0 20px 60px rgba(15, 23, 42, 0.2)',
};

const modalHeaderStyle: CSSProperties = {
    display: 'flex',
    alignItems: 'center',
    justifyContent: 'space-between',
    padding: '18px 22px',
    borderBottom: '1px solid #e2e8f0',
};

const modalBodyStyle: CSSProperties = {
    padding: '18px 22px',
};

const modalFooterStyle: CSSProperties = {
    display: 'flex',
    justifyContent: 'space-between',
    alignItems: 'center',
    flexWrap: 'wrap',
    gap: 12,
    padding: '16px 22px',
    borderTop: '1px solid #e2e8f0',
};

const modalCloseStyle: CSSProperties = {
    border: 'none',
    background: 'transparent',
    fontSize: 14,
    color: '#94a3b8',
    cursor: 'pointer',
};




const modalActionBtnStyle: CSSProperties = {
    border: '1px solid #cbd5e1',
    background: '#fff',
    color: '#334155',
    borderRadius: 8,
    padding: '8px 12px',
    cursor: 'pointer',
    fontSize: 12,
    fontWeight: 600,
};

const modalActionPrimaryStyle: CSSProperties = {
    border: '1px solid #1e3a8a',
    background: '#1e3a8a',
    color: '#fff',
    borderRadius: 8,
    padding: '8px 12px',
    cursor: 'pointer',
    fontSize: 12,
    fontWeight: 600,
};

const payslipSheetStyle: CSSProperties = {
    border: '2px solid #111',
    padding: '10px 12px',
    background: '#fff',
    fontFamily: '"Times New Roman", serif',
    fontSize: 12,
    color: '#111',
};

const payslipTitleStyle: CSSProperties = {
    fontWeight: 700,
    fontSize: 14,
    marginBottom: 6,
};

const payslipDividerStyle: CSSProperties = {
    borderTop: '1px solid #111',
    margin: '6px 0',
};

const payslipInfoTableStyle: CSSProperties = {
    width: '100%',
    borderCollapse: 'collapse',
};

const payslipInfoLabelStyle: CSSProperties = {
    padding: '2px 4px',
    fontWeight: 600,
    whiteSpace: 'nowrap',
};

const payslipInfoValueStyle: CSSProperties = {
    padding: '2px 4px',
    fontWeight: 700,
};

const payslipMetaTableStyle: CSSProperties = {
    width: '100%',
    borderCollapse: 'collapse',
};

const payslipMetaLabelStyle: CSSProperties = {
    padding: '2px 4px',
    whiteSpace: 'normal',
};

const payslipMetaRightLabelStyle: CSSProperties = {
    padding: '2px 4px',
    borderLeft: '1px solid #111',
};

const payslipMetaValueStyle: CSSProperties = {
    padding: '2px 4px',
    textAlign: 'right',
    fontWeight: 700,
    whiteSpace: 'nowrap',
};

const payslipNoteStyle: CSSProperties = {
    fontStyle: 'italic',
    textAlign: 'right',
    padding: '4px 4px 2px',
};

const payslipEarningsTableStyle: CSSProperties = {
    width: '100%',
    borderCollapse: 'collapse',
};

const payslipThStyle: CSSProperties = {
    padding: '2px 4px',
    fontWeight: 700,
    fontSize: 11,
    textTransform: 'uppercase',
    borderBottom: '1px solid #111',
};

const payslipTdStyle: CSSProperties = {
    padding: '2px 4px',
    verticalAlign: 'top',
};

const payslipMoneyStyle: CSSProperties = {
    padding: '2px 4px',
    textAlign: 'right',
    fontWeight: 700,
};

const payslipGrossLabelStyle: CSSProperties = {
    padding: '3px 4px',
    fontWeight: 700,
    borderTop: '1px solid #111',
};

const payslipGrossValueStyle: CSSProperties = {
    padding: '3px 4px',
    textAlign: 'right',
    fontWeight: 700,
    borderTop: '1px solid #111',
};

const payslipNetRowStyle: CSSProperties = {
    borderTop: '1px solid #111',
    fontWeight: 700,
    fontSize: 14,
    padding: '6px 4px',
};

const payslipSignatureTableStyle: CSSProperties = {
    width: '100%',
    borderCollapse: 'collapse',
};

const payslipAckStyle: CSSProperties = {
    fontSize: 11,
    lineHeight: 1.35,
};

const payslipSignatureLineStyle: CSSProperties = {
    borderTop: '1px solid #111',
    marginTop: 20,
    paddingTop: 4,
    fontWeight: 700,
    textAlign: 'center',
};

const payslipSignatureLabelStyle: CSSProperties = {
    fontSize: 11,
    textAlign: 'center',
};

const payslipCertLabelStyle: CSSProperties = {
    fontSize: 11,
    textAlign: 'center',
};

