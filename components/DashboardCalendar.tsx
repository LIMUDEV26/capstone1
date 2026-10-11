import { ChevronLeft, ChevronRight, ChevronsLeft, ChevronsRight, Maximize2, X } from 'lucide-react';
import { useState, useEffect, useRef, type CSSProperties } from 'react';

export type CalendarManagementDot = {
    color: string;
    label: string;
    kind: 'holiday' | 'birthday' | 'event';
};

export type DashboardCalendarEvent = {
    start?: boolean;
    end?: boolean;
    projectIds: number[];
    // management entries — all dates from calendar management appear as colored dots
    managementDots?: CalendarManagementDot[];
    managementTitles?: string[];
};

export type DashboardCalendarEventMap = Record<string, DashboardCalendarEvent>;

// Google-Calendar color map reused from calendar management for dot color
const GOOGLE_COLOR_HEX: Record<string, string> = {
    tomato: '#d50000',
    flamingo: '#e67c73',
    tangerine: '#f4511e',
    banana: '#f6bf26',
    sage: '#33b679',
    basil: '#0b8043',
    peacock: '#039be5',
    blueberry: '#3f51b5',
    lavender: '#7986cb',
    grape: '#8e24aa',
    graphite: '#616161',
    blue: '#3f51b5',
};
export function resolveCalendarEventHex(color?: string | null): string {
    if (!color) return GOOGLE_COLOR_HEX.blue;
    return GOOGLE_COLOR_HEX[color] || GOOGLE_COLOR_HEX.blue;
}
export const CALENDAR_DOT_COLOR = {
    projectStart: '#22c55e',
    projectEnd: '#ef4444',
    holiday: GOOGLE_COLOR_HEX.tomato,
    birthday: GOOGLE_COLOR_HEX.grape,
} as const;

// ---------- Management → Dashboard dot conversion ----------

export type RawManagementPayload = {
    holidays?: Array<{ holiday_date: string; holiday_name: string }>;
    events?: Array<{ event_date: string; end_date?: string | null; title: string; color?: string | null; category?: string | null }>;
    birthdays?: Array<{ birthday_date: string; full_name: string }>;
};

/**
 * Convert holidays / birthdays / calendar_events into DashboardCalendarEventMap dots.
 * All dates from calendar management appear as colored dots; clicking floats the maximize overlay.
 */
export function buildManagementEventMap(payload: RawManagementPayload): DashboardCalendarEventMap {
    const map: DashboardCalendarEventMap = {};
    const pushDot = (dateKey: string, dot: CalendarManagementDot) => {
        if (!dateKey || !/^\d{4}-\d{2}-\d{2}$/.test(dateKey)) return;
        const entry = (map[dateKey] = map[dateKey] || { projectIds: [] });
        entry.managementDots = entry.managementDots || [];
        entry.managementTitles = entry.managementTitles || [];
        entry.managementDots.push(dot);
        entry.managementTitles.push(dot.label);
    };

    (payload.holidays || []).forEach((h) => {
        if (!h.holiday_date) return;
        pushDot(h.holiday_date.slice(0, 10), {
            color: CALENDAR_DOT_COLOR.holiday,
            label: `Holiday: ${h.holiday_name}`,
            kind: 'holiday',
        });
    });

    (payload.birthdays || []).forEach((b) => {
        if (!b.birthday_date) return;
        pushDot(b.birthday_date.slice(0, 10), {
            color: CALENDAR_DOT_COLOR.birthday,
            label: `Birthday: ${b.full_name}`,
            kind: 'birthday',
        });
    });

    (payload.events || []).forEach((ev) => {
        if (!ev.event_date) return;
        const hex = resolveCalendarEventHex(ev.color || undefined);
        const datesToMark: string[] = [];
        // mark start date
        datesToMark.push(ev.event_date.slice(0, 10));
        // if multi-day (end_date different), mark end date as second dot too (same color)
        if (ev.end_date && ev.end_date.slice(0, 10) !== ev.event_date.slice(0, 10)) {
            datesToMark.push(ev.end_date.slice(0, 10));
        }
        datesToMark.forEach((d) => pushDot(d, {
            color: hex,
            label: `${ev.category || 'Event'}: ${ev.title}`,
            kind: 'event',
        }));
    });

    return map;
}

export function mergeDashboardCalendarMaps(...maps: DashboardCalendarEventMap[]): DashboardCalendarEventMap {
    const out: DashboardCalendarEventMap = {};
    for (const map of maps) {
        for (const [date, ev] of Object.entries(map)) {
            const cur = (out[date] = out[date] || { projectIds: [] });
            if (ev.start) cur.start = true;
            if (ev.end) cur.end = true;
            if (ev.projectIds?.length) {
                cur.projectIds = Array.from(new Set([...(cur.projectIds || []), ...ev.projectIds]));
            }
            if (ev.managementDots?.length) {
                cur.managementDots = [...(cur.managementDots || []), ...ev.managementDots];
                cur.managementTitles = [...(cur.managementTitles || []), ...(ev.managementTitles || ev.managementDots.map((d) => d.label))];
            }
        }
    }
    return out;
}

/**
 * Fetch holidays + calendar_events + birthdays for a wide window so the mini calendar
 * can show dots even when user navigates months. Uses current year ±1.
 */
export async function fetchManagementCalendarMaps(apiBase: string): Promise<DashboardCalendarEventMap> {
    const now = new Date();
    const y = now.getFullYear();
    const dateFrom = `${y - 1}-01-01`;
    const dateTo = `${y + 1}-12-31`;
    const years = [y - 1, y, y + 1];

    const holidayFetches = years.map(async (yr) => {
        try {
            const r = await fetch(`${apiBase}/holidays.php?year=${yr}`, { credentials: 'include' });
            const j = await r.json();
            return Array.isArray(j?.data) ? j.data : [];
        } catch { return []; }
    });

    let holidays: Array<{ holiday_date: string; holiday_name: string }> = [];
    try {
        const results = await Promise.all(holidayFetches);
        holidays = results.flat();
    } catch { /* ignore */ }

    let events: Array<{ event_date: string; end_date?: string | null; title: string; color?: string | null; category?: string | null }> = [];
    let birthdays: Array<{ birthday_date: string; full_name: string }> = [];
    try {
        const r = await fetch(`${apiBase}/calendar-events.php?date_from=${dateFrom}&date_to=${dateTo}`, { credentials: 'include' });
        const j = await r.json();
        if (j?.success && j?.data) {
            events = Array.isArray(j.data.events) ? j.data.events : [];
            birthdays = Array.isArray(j.data.birthdays) ? j.data.birthdays : [];
        }
    } catch { /* ignore */ }

    return buildManagementEventMap({ holidays, events, birthdays });
}

type CalDay = { day: number; current: boolean };

function buildMonth(year: number, month: number): CalDay[][] {
    const first = new Date(year, month, 1);
    const last  = new Date(year, month + 1, 0);
    const startDay   = first.getDay();          // 0=Sun
    const daysInMonth = last.getDate();

    // days from previous month to fill leading slots
    const prevLast = new Date(year, month, 0).getDate();
    const cells: CalDay[] = [];
    for (let i = startDay - 1; i >= 0; i--) {
        cells.push({ day: prevLast - i, current: false });
    }
    // current month
    for (let d = 1; d <= daysInMonth; d++) {
        cells.push({ day: d, current: true });
    }
    // days from next month to fill trailing slots
    let next = 1;
    while (cells.length % 7 !== 0) {
        cells.push({ day: next++, current: false });
    }

    const weeks: CalDay[][] = [];
    for (let i = 0; i < cells.length; i += 7) {
        weeks.push(cells.slice(i, i + 7));
    }
    return weeks;
}

// ─── DashboardClock ────────────────────────────────────────────────────────────

type DashboardClockProps = {
    events?: DashboardCalendarEventMap;
    onDayClick?: (date: string) => void;
    onExpandCalendar?: () => void;
    theme?: 'dark' | 'light';
};

function pad2(n: number) { return String(n).padStart(2, '0'); }

const DAY_NAMES  = ['Sunday','Monday','Tuesday','Wednesday','Thursday','Friday','Saturday'];
const MON_NAMES  = ['January','February','March','April','May','June','July','August','September','October','November','December'];
const MON_SHORT  = ['Jan','Feb','Mar','Apr','May','Jun','Jul','Aug','Sep','Oct','Nov','Dec'];

export function DashboardClock({ events = {}, onDayClick, onExpandCalendar, theme = 'dark' }: DashboardClockProps) {
    const [now, setNow] = useState(() => new Date());
    const [open, setOpen] = useState(false);
    const overlayRef = useRef<HTMLDivElement>(null);

    // tick every second
    useEffect(() => {
        const id = setInterval(() => setNow(new Date()), 1000);
        return () => clearInterval(id);
    }, []);

    // close on outside click — but not when clicking inside a portal that opted-out
    useEffect(() => {
        if (!open) return;
        const handler = (e: MouseEvent) => {
            const target = e.target as Node;
            if (overlayRef.current && !overlayRef.current.contains(target)) {
                // If the click landed inside a modal that opted-out, keep the float open
                const el = e.target as HTMLElement | null;
                if (el?.closest?.('[data-no-clock-close]')) return;
                setOpen(false);
            }
        };
        document.addEventListener('mousedown', handler);
        return () => document.removeEventListener('mousedown', handler);
    }, [open]);

    // close on Escape
    useEffect(() => {
        if (!open) return;
        const handler = (e: KeyboardEvent) => { if (e.key === 'Escape') setOpen(false); };
        document.addEventListener('keydown', handler);
        return () => document.removeEventListener('keydown', handler);
    }, [open]);

    const isLight = theme === 'light';

    const h24  = now.getHours();
    const h12  = h24 % 12 || 12;
    const mins = pad2(now.getMinutes());
    const secs = pad2(now.getSeconds());
    const ampm = h24 < 12 ? 'AM' : 'PM';
    const dayName  = DAY_NAMES[now.getDay()];
    const monShort = MON_SHORT[now.getMonth()];
    const monFull  = MON_NAMES[now.getMonth()];
    const date     = now.getDate();
    const year     = now.getFullYear();

    // ── Tiny widget colours ──────────────────────────────────────────────────
    const widgetBg     = isLight ? '#ffffff'                      : 'rgba(255,255,255,0.12)';
    const widgetBorder = isLight ? '#e5e7eb'                      : 'rgba(255,255,255,0.22)';
    const widgetText   = isLight ? '#0f172a'                      : '#ffffff';
    const widgetMuted  = isLight ? '#6b7280'                      : 'rgba(255,255,255,0.6)';
    const widgetAccent = isLight ? '#2563eb'                      : 'rgba(147,197,253,1)';

    // ── Expanded modal colours (light card) ─────────────────────────────────
    const modalBg       = '#ffffff';
    const modalBorder   = '#e5e7eb';
    const modalText     = '#0f172a';
    const modalMuted    = '#64748b';
    const modalAccent   = '#2563eb';
    const modalSep      = '#e5e7eb';

    // calendar colours inside modal
    const calBg         = 'transparent';
    void calBg;
    const calText       = modalText;
    const calMuted      = modalMuted;
    const calTodayBg    = '#2563eb';

    // rebuild mini calendar for modal
    const [calYear,  setCalYear]  = useState(now.getFullYear());
    const [calMonth, setCalMonth] = useState(now.getMonth());
    const weeks = buildMonth(calYear, calMonth);
    const isToday = (d: number, current: boolean) =>
        current && calYear === now.getFullYear() && calMonth === now.getMonth() && d === now.getDate();

    const prevCalMonth = () => { if (calMonth === 0) { setCalMonth(11); setCalYear(y => y - 1); } else setCalMonth(m => m - 1); };
    const nextCalMonth = () => { if (calMonth === 11) { setCalMonth(0);  setCalYear(y => y + 1); } else setCalMonth(m => m + 1); };

    const navBtn: CSSProperties = {
        width: 26, height: 26, display: 'inline-flex', alignItems: 'center', justifyContent: 'center',
        background: '#f1f5f9', color: modalText, border: '1px solid #e2e8f0',
        borderRadius: 6, padding: 0, cursor: 'pointer', flexShrink: 0,
    };

    return (
        <>
            {/* ── Tiny widget ─────────────────────────────────────────────── */}
            <div
                onClick={() => setOpen(true)}
                title="Click to expand clock & calendar"
                style={{
                    width: '100%', height: '100%',
                    background: widgetBg,
                    border: `1px solid ${widgetBorder}`,
                    borderRadius: 10,
                    padding: '6px 8px',
                    boxSizing: 'border-box',
                    display: 'flex',
                    flexDirection: 'column',
                    alignItems: 'center',
                    justifyContent: 'center',
                    gap: 3,
                    cursor: 'pointer',
                    userSelect: 'none',
                    transition: 'box-shadow 0.15s ease, transform 0.15s ease',
                    boxShadow: isLight ? '0 1px 4px rgba(0,0,0,0.06)' : undefined,
                }}
                onMouseEnter={e => { (e.currentTarget as HTMLDivElement).style.transform = 'translateY(-1px)'; (e.currentTarget as HTMLDivElement).style.boxShadow = '0 4px 14px rgba(0,0,0,0.15)'; }}
                onMouseLeave={e => { (e.currentTarget as HTMLDivElement).style.transform = ''; (e.currentTarget as HTMLDivElement).style.boxShadow = isLight ? '0 1px 4px rgba(0,0,0,0.06)' : ''; }}
            >
                {/* big time */}
                <div style={{ fontFamily: "'SF Mono','Fira Code','Consolas',monospace", fontSize: 32, fontWeight: 800, color: widgetAccent, letterSpacing: '-1px', lineHeight: 1 }}>
                    {pad2(h12)}:{mins}
                    <span style={{ fontSize: 14, fontWeight: 600, color: widgetMuted, marginLeft: 3 }}>{ampm}</span>
                </div>
                {/* seconds */}
                <div style={{ fontFamily: "'SF Mono','Fira Code','Consolas',monospace", fontSize: 12, color: widgetMuted, letterSpacing: 2, lineHeight: 1 }}>
                    :{secs}
                </div>
                {/* date */}
                <div style={{ fontSize: 11, color: widgetText, fontWeight: 700, lineHeight: 1, marginTop: 2 }}>
                    {monShort} {date}, {year}
                </div>
                {/* day */}
                <div style={{ fontSize: 10, color: widgetMuted, letterSpacing: '0.08em', textTransform: 'uppercase', lineHeight: 1 }}>
                    {dayName}
                </div>
            </div>

            {/* ── Expanded float ──────────────────────────────────────────── */}
            {open && (
                <div style={{
                    position: 'fixed', inset: 0,
                    background: 'rgba(2,6,23,0.65)',
                    zIndex: 99000,
                    display: 'flex', alignItems: 'center', justifyContent: 'center',
                    padding: 20,
                    backdropFilter: 'blur(4px)',
                    WebkitBackdropFilter: 'blur(4px)',
                    animation: 'fadeIn 120ms ease',
                }}>
                    <div ref={overlayRef} style={{
                        background: modalBg,
                        border: `1px solid ${modalBorder}`,
                        borderRadius: 18,
                        padding: '20px 22px 18px',
                        width: '100%',
                        maxWidth: 480,
                        boxShadow: '0 24px 64px rgba(0,0,0,0.5)',
                        display: 'flex',
                        flexDirection: 'column',
                        gap: 16,
                        position: 'relative',
                    }}>
                        {/* close btn */}
                        <button type="button" data-dark-btn onClick={() => setOpen(false)} style={{
                            position: 'absolute', top: 12, right: 12,
                            width: 26, height: 26, display: 'inline-flex', alignItems: 'center', justifyContent: 'center',
                            background: '#ffffff', color: '#1e293b',
                            border: 'none', borderRadius: 6, cursor: 'pointer', padding: 0,
                            fontSize: 13, lineHeight: 1, fontWeight: 900,
                        }}>
                            ✕
                        </button>

                        {/* ── Big clock ─────────────────────────────────────── */}
                        <div style={{ textAlign: 'center', paddingBottom: 14, borderBottom: `1px solid ${modalSep}` }}>
                            <div style={{ fontSize: 8, fontWeight: 700, letterSpacing: '0.18em', textTransform: 'uppercase', color: modalMuted, marginBottom: 6 }}>
                                {dayName}, {monFull} {date}, {year}
                            </div>
                            <div style={{ fontFamily: "'SF Mono','Fira Code','Consolas',monospace", fontSize: 52, fontWeight: 900, color: modalText, letterSpacing: '-2px', lineHeight: 1 }}>
                                {pad2(h12)}:{mins}
                                <span style={{ fontSize: 20, fontWeight: 600, color: modalMuted, marginLeft: 4, letterSpacing: 0 }}>{ampm}</span>
                            </div>
                            <div style={{ fontFamily: "'SF Mono','Fira Code','Consolas',monospace", fontSize: 13, color: modalAccent, letterSpacing: '0.15em', marginTop: 4 }}>
                                :{secs}
                            </div>
                        </div>

                        {/* ── Calendar ──────────────────────────────────────── */}
                        <div>
                            {/* calendar header */}
                            <div style={{ display: 'grid', gridTemplateColumns: '26px 1fr 26px', alignItems: 'center', gap: 6, marginBottom: 10 }}>
                                <button type="button" data-dark-btn onClick={prevCalMonth} style={{ ...navBtn, fontSize: 16, fontWeight: 700, lineHeight: 1 }}>
                                    ‹
                                </button>
                                <div style={{ textAlign: 'center' }}>
                                    <span style={{ fontSize: 12, fontWeight: 700, color: modalText }}>{MON_NAMES[calMonth]}</span>
                                    <span style={{ fontSize: 11, color: modalMuted, marginLeft: 5 }}>{calYear}</span>
                                </div>
                                <button type="button" data-dark-btn onClick={nextCalMonth} style={{ ...navBtn, fontSize: 16, fontWeight: 700, lineHeight: 1 }}>
                                    ›
                                </button>
                            </div>

                            {/* day headers */}
                            <div style={{ display: 'grid', gridTemplateColumns: 'repeat(7, 1fr)', gap: 4, marginBottom: 6 }}>
                                {['Su','Mo','Tu','We','Th','Fr','Sa'].map(d => (
                                    <div key={d} style={{ textAlign: 'center', fontSize: 12, fontWeight: 700, color: modalMuted, letterSpacing: '0.04em' }}>{d}</div>
                                ))}
                            </div>

                            {/* day cells */}
                            <div style={{ display: 'grid', gridTemplateColumns: 'repeat(7, 1fr)', gap: 4 }}>
                                {weeks.flat().map(({ day, current }, idx) => {
                                    const dateStr = current ? `${calYear}-${pad2(calMonth + 1)}-${pad2(day)}` : '';
                                    const event   = dateStr ? events[dateStr] : undefined;
                                    const clickable = current && !!(event?.projectIds?.length || event?.managementDots?.length);
                                    const todayCell = isToday(day, current);
                                    const hasDots = current && !!(event?.start || event?.end || event?.managementDots?.length);
                                    return (
                                        <div key={dateStr || `e-${idx}`}
                                            onClick={() => { if (clickable && onDayClick) { onDayClick(dateStr); } }}
                                            style={{
                                                position: 'relative',
                                                display: 'flex', alignItems: 'center', justifyContent: 'center',
                                                aspectRatio: '1',
                                                minHeight: 38,
                                                borderRadius: 8,
                                                fontSize: 13,
                                                fontWeight: todayCell ? 800 : 500,
                                                color: todayCell ? '#fff' : (current ? calText : calMuted),
                                                background: todayCell ? calTodayBg : (clickable ? 'rgba(255,255,255,0.05)' : 'transparent'),
                                                cursor: clickable ? 'pointer' : 'default',
                                                lineHeight: 1,
                                                opacity: current ? 1 : 0.35,
                                            }}>
                                            {day}
                                            {hasDots && (
                                                <span style={{ position: 'absolute', bottom: 1, left: '50%', transform: 'translateX(-50%)', display: 'flex', gap: 2 }}>
                                                    {event?.start && <span style={{ display: 'inline-block', width: 4, height: 4, borderRadius: '50%', background: CALENDAR_DOT_COLOR.projectStart, flexShrink: 0 }} />}
                                                    {event?.end   && <span style={{ display: 'inline-block', width: 4, height: 4, borderRadius: '50%', background: CALENDAR_DOT_COLOR.projectEnd, flexShrink: 0 }} />}
                                                    {event?.managementDots?.slice(0, 2).map((d, i) => (
                                                        <span key={i} style={{ display: 'inline-block', width: 4, height: 4, borderRadius: '50%', background: d.color, flexShrink: 0 }} />
                                                    ))}
                                                </span>
                                            )}
                                        </div>
                                    );
                                })}
                            </div>
                        </div>

                        {/* ── Footer: dot legend + open full calendar ────────── */}
                        <div style={{ display: 'flex', flexDirection: 'column', gap: 8, paddingTop: 10, borderTop: `1px solid ${modalSep}` }}>
                            <div style={{ display: 'flex', gap: 10, flexWrap: 'wrap' }}>
                                {[
                                    { color: CALENDAR_DOT_COLOR.projectStart, label: 'Start' },
                                    { color: CALENDAR_DOT_COLOR.projectEnd,   label: 'Due'   },
                                    { color: CALENDAR_DOT_COLOR.holiday,      label: 'Holiday' },
                                    { color: CALENDAR_DOT_COLOR.birthday,     label: 'Bday'  },
                                ].map(({ color, label }) => (
                                    <span key={label} style={{ display: 'flex', alignItems: 'center', gap: 4 }}>
                                        <span style={{ width: 6, height: 6, borderRadius: '50%', background: color, flexShrink: 0, display: 'inline-block' }} />
                                        <span style={{ fontSize: 9, color: calMuted }}>{label}</span>
                                    </span>
                                ))}
                            </div>
                            {onExpandCalendar && (
                                <button type="button" data-dark-btn onClick={() => { setOpen(false); onExpandCalendar(); }} style={{
                                    background: '#f1f5f9', color: modalText,
                                    border: '1px solid #e2e8f0', borderRadius: 6,
                                    padding: '5px 10px', fontSize: 10, fontWeight: 600,
                                    cursor: 'pointer', display: 'flex', alignItems: 'center', justifyContent: 'center', gap: 4,
                                    width: '100%',
                                }}>
                                    ⤢ Full Calendar
                                </button>
                            )}
                        </div>
                    </div>
                </div>
            )}
        </>
    );
}

// ── (original CalendarMini props, kept for DashboardCalendarMini below) ────────

type CalendarProps = {
    events?: DashboardCalendarEventMap;
    onDayClick?: (date: string) => void;
};

type CalendarMiniProps = CalendarProps & {
    onExpand: () => void;
    theme?: 'dark' | 'light';
};

export function DashboardCalendarMini({
    onExpand,
    events = {},
    onDayClick,
    theme = 'dark',
}: CalendarMiniProps) {
    const today = new Date();
    const [year, setYear] = useState(today.getFullYear());
    const [month, setMonth] = useState(today.getMonth());
    const weeks = buildMonth(year, month);

    const isLight = theme === 'light';

    // Colours
    const bg         = isLight ? 'linear-gradient(135deg, #f9fafb 0%, #f3f4f6 45%, #e5e7eb 100%)'              : 'rgba(255,255,255,0.12)';
    const border      = isLight ? '#d1d5db'              : 'rgba(255,255,255,0.22)';
    const textPrimary = isLight ? '#111827'              : '#ffffff';
    const textMuted   = isLight ? '#6b7280'              : 'rgba(255,255,255,0.55)';
    const navBg       = isLight ? '#f3f4f6'              : 'rgba(255,255,255,0.12)';
    const navColor    = isLight ? '#374151'              : 'rgba(255,255,255,0.85)';
    const navHoverBg  = isLight ? '#e5e7eb'              : 'rgba(255,255,255,0.2)';
    void navHoverBg; // used via CSS class below

    const navBtnStyle: CSSProperties = {
        width: 22,
        height: 22,
        display: 'inline-flex',
        alignItems: 'center',
        justifyContent: 'center',
        background: navBg,
        color: navColor,
        border: 'none',
        borderRadius: 6,
        padding: 0,
        cursor: 'pointer',
        flexShrink: 0,
        lineHeight: 1,
        transition: 'background 120ms',
    };

    const isToday = (day: number, current: boolean) =>
        current &&
        year === today.getFullYear() &&
        month === today.getMonth() &&
        day === today.getDate();

    const prevMonth = () => {
        if (month === 0) { setMonth(11); setYear(y => y - 1); }
        else setMonth(m => m - 1);
    };
    const nextMonth = () => {
        if (month === 11) { setMonth(0); setYear(y => y + 1); }
        else setMonth(m => m + 1);
    };

    const renderDayCell = ({ day, current }: CalDay, index: number) => {
        const dateStr = current
            ? `${year}-${String(month + 1).padStart(2, '0')}-${String(day).padStart(2, '0')}`
            : '';
        const event    = dateStr ? events[dateStr] : undefined;
        const hasProject = current && !!(event?.projectIds.length);
        const hasManagement = current && !!((event?.managementDots?.length || 0) > 0);
        const clickable = hasProject || hasManagement;
        const isTodayDay = isToday(day, current);

        const tooltipParts: string[] = [];
        if (event?.start) tooltipParts.push('Project start');
        if (event?.end) tooltipParts.push('Due date');
        if (event?.managementTitles?.length) tooltipParts.push(...event.managementTitles);
        else if (event?.managementDots?.length) tooltipParts.push(...event.managementDots.map(d => d.label));
        const title = tooltipParts.filter(Boolean).join(' • ') || (clickable ? dateStr : '');

        // build dot list in priority order: project start/end + management (capped to 4)
        const allDots: { color: string; key: string }[] = [];
        if (event?.start) allDots.push({ color: isTodayDay ? 'rgba(255,255,255,0.9)' : CALENDAR_DOT_COLOR.projectStart, key: 'ps' });
        if (event?.end) allDots.push({ color: isTodayDay ? 'rgba(255,255,255,0.9)' : CALENDAR_DOT_COLOR.projectEnd, key: 'pe' });
        if (event?.managementDots) {
            event.managementDots.forEach((d, idx) => {
                allDots.push({ color: isTodayDay ? 'rgba(255,255,255,0.9)' : d.color, key: `m-${idx}-${d.kind}` });
            });
        }
        const visibleDots = allDots.slice(0, 4);
        const overflow = allDots.length - visibleDots.length;

        const cellKey = dateStr || `empty-${index}`;
        return (
            <div
                key={cellKey}
                role={clickable ? 'button' : undefined}
                tabIndex={clickable ? 0 : undefined}
                aria-label={clickable ? title || dateStr : undefined}
                onClick={() => clickable && onDayClick?.(dateStr)}
                onKeyDown={(e) => { if (clickable && (e.key === 'Enter' || e.key === ' ')) { e.preventDefault(); onDayClick?.(dateStr); } }}
                title={title}
                style={{
                    position: 'relative',
                    display: 'flex',
                    alignItems: 'center',
                    justifyContent: 'center',
                    aspectRatio: '1',
                    borderRadius: 6,
                    fontSize: 10,
                    fontWeight: isTodayDay ? 700 : 400,
                    color: isTodayDay
                        ? '#ffffff'
                        : (current ? textPrimary : textMuted),
                    background: isTodayDay
                        ? '#2563eb'
                        : 'transparent',
                    cursor: clickable ? 'pointer' : 'default',
                    lineHeight: 1,
                    opacity: current ? 1 : 0.35,
                }}
            >
                {day}
                {visibleDots.length > 0 && (
                    <span style={{
                        position: 'absolute',
                        bottom: 1,
                        left: '50%',
                        transform: 'translateX(-50%)',
                        display: 'flex',
                        gap: 1.5,
                        alignItems: 'center',
                    }}>
                        {visibleDots.map((dot) => (
                            <span key={dot.key} style={{ display: 'inline-block', width: 4, height: 4, borderRadius: '50%', background: dot.color, flexShrink: 0 }} />
                        ))}
                        {overflow > 0 && (
                            <span style={{ fontSize: 5, lineHeight: 1, color: isTodayDay ? 'rgba(255,255,255,0.9)' : textMuted, fontWeight: 700 }}>+{overflow}</span>
                        )}
                    </span>
                )}
            </div>
        );
    };

    const monthLabel = new Date(year, month, 1).toLocaleString(undefined, { month: 'long' });
    const DAY_LABELS = ['Su', 'Mo', 'Tu', 'We', 'Th', 'Fr', 'Sa'];

    return (
        <div style={{
            background: bg,
            border: `1px solid ${border}`,
            borderRadius: 10,
            padding: '8px 8px 6px',
            width: '100%',
            height: '100%',
            minWidth: 0,
            boxSizing: 'border-box',
            display: 'flex',
            flexDirection: 'column',
            gap: 5,
            boxShadow: isLight ? '0 2px 12px rgba(15,23,42,0.07)' : undefined,
            backdropFilter: isLight ? undefined : 'blur(6px)',
            WebkitBackdropFilter: isLight ? undefined : 'blur(6px)',
        }}>
            {/* Header: nav + month + year — fixed grid so < > never shift with long month */}
            <div style={{ display: 'grid', gridTemplateColumns: '22px 1fr 22px', alignItems: 'center', gap: 4 }}>
                <button type="button" onClick={prevMonth} title="Previous month" aria-label="Previous month" style={navBtnStyle}>
                    <ChevronLeft size={12} strokeWidth={2.5} />
                </button>
                <div style={{ textAlign: 'center', minWidth: 0, whiteSpace: 'nowrap', overflow: 'hidden', textOverflow: 'ellipsis' }}>
                    <span style={{ fontSize: 10.5, fontWeight: 700, color: textPrimary, letterSpacing: 0.1 }}>
                        {monthLabel}
                    </span>
                    <span style={{ fontSize: 9.5, color: textMuted, marginLeft: 4 }}>{year}</span>
                </div>
                <button type="button" onClick={nextMonth} title="Next month" aria-label="Next month" style={navBtnStyle}>
                    <ChevronRight size={12} strokeWidth={2.5} />
                </button>
            </div>

            {/* Day-of-week labels */}
            <div style={{ display: 'grid', gridTemplateColumns: 'repeat(7, 1fr)', gap: 1 }}>
                {DAY_LABELS.map((d) => (
                    <div key={d} style={{ textAlign: 'center', fontSize: 8.5, fontWeight: 600, color: textMuted, paddingBottom: 2 }}>
                        {d}
                    </div>
                ))}
            </div>

            {/* Day cells */}
            <div style={{ display: 'grid', gridTemplateColumns: 'repeat(7, 1fr)', gap: 1, flex: 1 }}>
                {weeks.flat().map((cell, index) => renderDayCell(cell, index))}
            </div>

            {/* Footer */}
            <div style={{ display: 'flex', alignItems: 'center', justifyContent: 'space-between', paddingTop: 2, borderTop: `1px solid ${border}`, gap: 4 }}>
                <div style={{ display: 'flex', alignItems: 'center', gap: 5, flexWrap: 'wrap' }}>
                    <span style={{ display: 'flex', alignItems: 'center', gap: 3 }}>
                        <span style={{ width: 5, height: 5, borderRadius: '50%', background: CALENDAR_DOT_COLOR.projectStart, display: 'inline-block' }} />
                        <span style={{ fontSize: 7, color: textMuted }}>Start</span>
                    </span>
                    <span style={{ display: 'flex', alignItems: 'center', gap: 3 }}>
                        <span style={{ width: 5, height: 5, borderRadius: '50%', background: CALENDAR_DOT_COLOR.projectEnd, display: 'inline-block' }} />
                        <span style={{ fontSize: 7, color: textMuted }}>Due</span>
                    </span>
                    <span style={{ display: 'flex', alignItems: 'center', gap: 3 }}>
                        <span style={{ width: 5, height: 5, borderRadius: '50%', background: CALENDAR_DOT_COLOR.holiday, display: 'inline-block' }} />
                        <span style={{ fontSize: 7, color: textMuted }}>Holiday</span>
                    </span>
                    <span style={{ display: 'flex', alignItems: 'center', gap: 3 }}>
                        <span style={{ width: 5, height: 5, borderRadius: '50%', background: CALENDAR_DOT_COLOR.birthday, display: 'inline-block' }} />
                        <span style={{ fontSize: 7, color: textMuted }}>Bday</span>
                    </span>
                    <span style={{ display: 'flex', alignItems: 'center', gap: 3 }}>
                        <span style={{ width: 5, height: 5, borderRadius: '50%', background: GOOGLE_COLOR_HEX.blueberry, display: 'inline-block' }} />
                        <span style={{ fontSize: 7, color: textMuted }}>Event</span>
                    </span>
                </div>
                <button type="button" onClick={onExpand} title="Expand calendar" aria-label="Expand calendar" style={{ ...navBtnStyle, width: 20, height: 20, flexShrink: 0 }}>
                    <Maximize2 size={10} strokeWidth={2.5} />
                </button>
            </div>
        </div>
    );
}

type CalendarOverlayProps = CalendarProps & {
    open: boolean;
    onClose: () => void;
};

export function DashboardCalendarOverlay({
    open,
    onClose,
    events = {},
    onDayClick,
}: CalendarOverlayProps) {
    const today = new Date();
    const [year, setYear] = useState(today.getFullYear());
    const [month, setMonth] = useState(today.getMonth());
    const weeks = buildMonth(year, month);
    const monthName = new Date(year, month, 1).toLocaleString(undefined, {
        month: 'long',
        year: 'numeric',
    });
    const isToday = (day: number, current: boolean) => {
        return current
            && year === today.getFullYear()
            && month === today.getMonth()
            && day === today.getDate();
    };

    const prevMonth = () => {
        const nextMonth = month - 1;
        if (nextMonth < 0) {
            setMonth(11);
            setYear(year - 1);
            return;
        }
        setMonth(nextMonth);
    };

    const nextMonth = () => {
        const nextMonthValue = month + 1;
        if (nextMonthValue > 11) {
            setMonth(0);
            setYear(year + 1);
            return;
        }
        setMonth(nextMonthValue);
    };

    const prevYear = () => setYear(year - 1);
    const nextYear = () => setYear(year + 1);

    const overlayIconButtonStyle: CSSProperties = {
        width: 30,
        height: 30,
        display: 'inline-flex',
        alignItems: 'center',
        justifyContent: 'center',
        background: '#f8fafc',
        border: '1px solid #cbd5e1',
        color: '#111827',
        borderRadius: 6,
        padding: 0,
        cursor: 'pointer',
        lineHeight: 1,
    };

    if (!open) return null;

    const renderDayCell = ({ day, current }: CalDay, index: number) => {
        const dateStr = current
            ? `${year}-${String(month + 1).padStart(2, '0')}-${String(day).padStart(2, '0')}`
            : '';
        const event = dateStr ? events[dateStr] : undefined;
        const hasProject = current && !!(event && event.projectIds.length);
        const hasManagement = current && !!((event?.managementDots?.length || 0) > 0);
        const clickable = hasProject || hasManagement;
        const tooltipParts: string[] = [];
        if (event?.start) tooltipParts.push('Project start');
        if (event?.end) tooltipParts.push('Due date');
        if (event?.managementTitles?.length) tooltipParts.push(...event.managementTitles);
        else if (event?.managementDots?.length) tooltipParts.push(...event.managementDots.map(d => d.label));
        const cellTitle = tooltipParts.filter(Boolean).join(' • ') || (clickable ? dateStr : '');
        const cellKey = dateStr || `empty-${index}`;

        const allDots: { color: string; key: string }[] = [];
        if (event?.start) allDots.push({ color: '#22c55e', key: 'ps' });
        if (event?.end) allDots.push({ color: '#ef4444', key: 'pe' });
        if (event?.managementDots) {
            event.managementDots.forEach((d, idx) => allDots.push({ color: d.color, key: `m-${idx}-${d.kind}` }));
        }
        const visibleDots = allDots.slice(0, 6);
        const overflow = allDots.length - visibleDots.length;

        return (
            <div
                key={cellKey}
                role={clickable ? 'button' : undefined}
                tabIndex={clickable ? 0 : undefined}
                aria-label={clickable ? cellTitle || dateStr : undefined}
                onClick={() => clickable && onDayClick && onDayClick(dateStr)}
                onKeyDown={(e) => { if (clickable && (e.key === 'Enter' || e.key === ' ')) { e.preventDefault(); onDayClick?.(dateStr); } }}
                title={cellTitle}
                style={{
                    textAlign: 'center',
                    padding: '10px 0 12px',
                    borderRadius: 6,
                    background: isToday(day, current)
                        ? 'rgba(30,58,138,0.15)'
                        : 'rgba(255,255,255,0.6)',
                    border: '1px solid #e5e7eb',
                    fontWeight: isToday(day, current) ? 700 : 500,
                    cursor: clickable ? 'pointer' : 'default',
                    position: 'relative',
                    opacity: current ? 1 : 0.4,
                    color: current ? undefined : '#9ca3af',
                }}
            >
                {day}
                {visibleDots.length > 0 && (
                    <div
                        style={{
                            position: 'absolute',
                            left: '50%',
                            bottom: 4,
                            transform: 'translateX(-50%)',
                            display: 'flex',
                            gap: 3,
                            alignItems: 'center',
                        }}
                    >
                        {visibleDots.map((dot) => (
                            <span key={dot.key} style={{ display: 'inline-block', width: 6, height: 6, background: dot.color, borderRadius: '50%', flexShrink: 0 }} />
                        ))}
                        {overflow > 0 && (
                            <span style={{ fontSize: 9, fontWeight: 700, color: '#475569' }}>+{overflow}</span>
                        )}
                    </div>
                )}
            </div>
        );
    };

    return (
        <div style={{ position: 'fixed', inset: 0, background: 'rgba(0,0,0,0.4)', zIndex: 15000, display: 'flex', alignItems: 'center', justifyContent: 'center' }}>
            <div
                style={{
                    width: '90%',
                    maxWidth: 800,
                    background: 'rgba(255,255,255,0.85)',
                    border: '1px solid #e5e7eb',
                    borderRadius: 12,
                    padding: 12,
                    boxShadow: '0 10px 25px rgba(0,0,0,0.2)',
                    backdropFilter: 'blur(6px)',
                    WebkitBackdropFilter: 'blur(6px)',
                }}
            >
                <div style={{ display: 'flex', alignItems: 'center', justifyContent: 'space-between', marginBottom: 8, gap: 8 }}>
                    <div style={{ display: 'flex', alignItems: 'center', gap: 6 }}>
                        <button type="button" onClick={prevYear} title="Previous year" aria-label="Previous year" style={overlayIconButtonStyle}>
                            <ChevronsLeft size={16} strokeWidth={2.4} />
                        </button>
                        <button type="button" onClick={prevMonth} title="Previous month" aria-label="Previous month" style={overlayIconButtonStyle}>
                            <ChevronLeft size={16} strokeWidth={2.4} />
                        </button>
                    </div>
                    <div style={{ fontWeight: 700, color: '#111827' }}>{monthName}</div>
                    <div style={{ display: 'flex', alignItems: 'center', gap: 6 }}>
                        <button type="button" onClick={nextMonth} title="Next month" aria-label="Next month" style={overlayIconButtonStyle}>
                            <ChevronRight size={16} strokeWidth={2.4} />
                        </button>
                        <button type="button" onClick={nextYear} title="Next year" aria-label="Next year" style={overlayIconButtonStyle}>
                            <ChevronsRight size={16} strokeWidth={2.4} />
                        </button>
                    </div>
                </div>
                <div style={{ display: 'grid', gridTemplateColumns: 'repeat(7, 1fr)', gap: 6, fontSize: 12, color: '#111827' }}>
                    {['Sun', 'Mon', 'Tue', 'Wed', 'Thu', 'Fri', 'Sat'].map((dayLabel) => (
                        <div key={dayLabel} style={{ textAlign: 'center', opacity: 0.7, fontWeight: 600 }}>
                            {dayLabel}
                        </div>
                    ))}
                    {weeks.flat().map((cell, index) => renderDayCell(cell, index))}
                </div>
                <div style={{ display: 'flex', justifyContent: 'flex-end', marginTop: 10 }}>
                    <button type="button" onClick={onClose} style={{ background: 'transparent', border: '1px solid #9ca3af', color: '#111827', borderRadius: 6, padding: '6px 12px', cursor: 'pointer' }}>Close</button>
                </div>
            </div>
        </div>
    );
}
