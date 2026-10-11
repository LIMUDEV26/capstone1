import { FormEvent, useCallback, useEffect, useMemo, useRef, useState } from 'react';
import Head from 'next/head';
import { useRouter } from 'next/router';
import Layout from '../../components/Layout';
import CrudActionIcon from '../../components/CrudActionIcon';
import styles from '../../styles/CalendarManagement.module.css';
import { confirmAction, notifyError, notifySuccess } from '@/utils/notify';
import { getApiBaseUrl } from '@/utils/network';
import SearchBar from '../../components/SearchBar';
import { collectSearchTerms } from '@/utils/search';

const API_BASE = getApiBaseUrl();
const HOLIDAY_SYNC_STORAGE_KEY = 'capstone_holidays_sync';
const HOLIDAY_SYNC_EVENT = 'capstone:holidays-sync';

interface SessionUser {
    role?: string;
    [key: string]: unknown;
}

interface Holiday {
    holiday_id: number;
    holiday_name: string;
    holiday_date: string;
    holiday_type: string;
    holiday_scope: string;
    description?: string | null;
    source?: string | null;
    is_system?: number;
}

interface HolidayComment {
    comment_id: number;
    holiday_id: number;
    parent_comment_id?: number | null;
    comment_text: string;
    commenter_name?: string;
    commenter_role?: string;
    created_at?: string;
}

interface HolidayForm {
    holiday_name: string;
    holiday_date: string;
    holiday_type: string;
    holiday_scope: string;
    description: string;
    source: string;
}

interface CalendarEvent {
    event_id: number;
    title: string;
    description?: string | null;
    location?: string | null;
    event_date: string;
    end_date?: string | null;
    all_day: number;
    start_time?: string | null;
    end_time?: string | null;
    color: string;
    category: string;
    recurrence: string;
    creator_name?: string | null;
    created_at?: string | null;
    updated_at?: string | null;
    is_recurring_yearly?: boolean;
}

interface BirthdayEntry {
    birthday_id: number;
    user_id: number;
    first_name?: string;
    last_name?: string;
    full_name: string;
    role?: string;
    date_of_birth: string;
    birthday_date: string;
    turning_age?: number;
    is_recurring_yearly?: boolean;
}

interface EventForm {
    title: string;
    event_date: string;
    end_date: string;
    all_day: boolean;
    start_time: string;
    end_time: string;
    category: string;
    recurrence: string;
    location: string;
    description: string;
    color: string;
}

interface ApiResponse<T> {
    success?: boolean;
    data?: T;
    message?: string;
    error?: string;
}

type CalendarView = 'day' | 'week' | 'month' | 'year' | 'agenda';

type EntryKind = 'holiday' | 'birthday' | 'event';

interface CalendarEntry {
    key: string;
    kind: EntryKind;
    date: string;
    endDate?: string | null;
    title: string;
    subtitle?: string;
    allDay: boolean;
    startTime?: string | null;
    endTime?: string | null;
    color: string;
    raw?: Holiday | CalendarEvent | BirthdayEntry;
}

const decodeHtmlEntities = (value: string) => {
    const text = String(value || '');
    if (!text.includes('&')) return text;
    return text
        .replace(/&amp;/g, '&')
        .replace(/&quot;/g, '"')
        .replace(/&#34;/g, '"')
        .replace(/&#x22;/gi, '"')
        .replace(/&apos;/g, "'")
        .replace(/&#39;/g, "'")
        .replace(/&#x27;/gi, "'")
        .replace(/&lt;/g, '<')
        .replace(/&gt;/g, '>')
        .replace(/&nbsp;/g, ' ');
};

const pad2 = (value: number) => String(value).padStart(2, '0');

const dateKey = (date: Date) =>
    `${date.getFullYear()}-${pad2(date.getMonth() + 1)}-${pad2(date.getDate())}`;

const parseDateKey = (key: string) => new Date(`${key}T00:00:00`);

const toInputDate = (date: Date) => dateKey(date);

const addDays = (date: Date, amount: number) => {
    const next = new Date(date);
    next.setDate(next.getDate() + amount);
    return next;
};

const addMonths = (date: Date, amount: number) => {
    const next = new Date(date);
    const dayOfMonth = next.getDate();
    next.setDate(1);
    next.setMonth(next.getMonth() + amount);
    const lastDay = new Date(next.getFullYear(), next.getMonth() + 1, 0).getDate();
    next.setDate(Math.min(dayOfMonth, lastDay));
    return next;
};

const startOfWeek = (date: Date) => addDays(date, -date.getDay());

const isSameDay = (a: Date, b: Date) =>
    a.getFullYear() === b.getFullYear() && a.getMonth() === b.getMonth() && a.getDate() === b.getDate();

const formatLongDate = (value: string) =>
    parseDateKey(value).toLocaleDateString('en-PH', {
        weekday: 'long',
        year: 'numeric',
        month: 'long',
        day: 'numeric',
    });

const formatShortDate = (value: string) =>
    parseDateKey(value).toLocaleDateString('en-PH', { month: 'short', day: 'numeric' });

const formatTimeLabel = (time?: string | null) => {
    if (!time) return '';
    const parts = String(time).split(':');
    const hours = parseInt(parts[0] || '0', 10);
    const minutes = parseInt(parts[1] || '0', 10);
    if (Number.isNaN(hours)) return '';
    const suffix = hours >= 12 ? 'PM' : 'AM';
    const displayHours = hours % 12 === 0 ? 12 : hours % 12;
    return `${displayHours}:${pad2(minutes)} ${suffix}`;
};

const hourLabel = (hour: number) => {
    if (hour === 0) return '12 AM';
    if (hour < 12) return `${hour} AM`;
    if (hour === 12) return '12 PM';
    return `${hour - 12} PM`;
};

interface GoogleColor {
    main: string;
    soft: string;
    text: string;
}

const GOOGLE_COLORS: Record<string, GoogleColor> = {
    tomato: { main: '#d50000', soft: '#fce8e6', text: '#c5221f' },
    flamingo: { main: '#e67c73', soft: '#fbe9e7', text: '#bf4b40' },
    tangerine: { main: '#f4511e', soft: '#fbe5da', text: '#d24b12' },
    banana: { main: '#f6bf26', soft: '#fef7d9', text: '#b07d09' },
    sage: { main: '#33b679', soft: '#e3f4ec', text: '#12864f' },
    basil: { main: '#0b8043', soft: '#e1f0e7', text: '#0b6b39' },
    peacock: { main: '#039be5', soft: '#e1f2fa', text: '#0b7cb5' },
    blueberry: { main: '#3f51b5', soft: '#e8eaf6', text: '#3c4aa8' },
    lavender: { main: '#7986cb', soft: '#eaecf8', text: '#5c6bc0' },
    grape: { main: '#8e24aa', soft: '#f4e5f7', text: '#7b1fa2' },
    graphite: { main: '#616161', soft: '#eeeeee', text: '#4b4b4f' },
};

const colorOptions = Object.keys(GOOGLE_COLORS);

const entryColor = (color: string): GoogleColor =>
    GOOGLE_COLORS[color] || GOOGLE_COLORS.blueberry;

const HOLIDAY_COLOR = 'tomato';
const BIRTHDAY_COLOR = 'grape';

const holidayTypeOptions = [
    'Regular Holiday',
    'Special Non-Working Day',
    'Additional Special Non-Working Day',
    'Special Working Day',
    'Observance',
];

const scopeOptions = [
    'National Capital Region (NCR)',
    'Cordillera Administrative Region (CAR)',
    'Region I - Ilocos Region',
    'Region II - Cagayan Valley',
    'Region III - Central Luzon',
    'Region IV-A - CALABARZON',
    'Region IV-B - MIMAROPA',
    'Region V - Bicol Region',
    'Region VI - Western Visayas',
    'Region VII - Central Visayas',
    'Region VIII - Eastern Visayas',
    'Region IX - Zamboanga Peninsula',
    'Region X - Northern Mindanao',
    'Region XI - Davao Region',
    'Region XII - SOCCSKSARGEN',
    'Region XIII - Caraga',
    'Bangsamoro Autonomous Region in Muslim Mindanao (BARMM)',
];

const sourceOptions = [
    'Official Gazette',
    'Presidential Proclamation',
    'DOLE Advisory',
    'LGU Ordinance',
    'Company Policy',
    'Other',
];

const eventCategoryOptions = [
    'Meeting',
    'Company Event',
    'Training',
    'Deadline',
    'Team Building',
    'Announcement',
    'Other',
];

const recurrenceOptions = [
    { value: 'none', label: 'Does not repeat' },
    { value: 'daily', label: 'Daily' },
    { value: 'weekly', label: 'Weekly on this day' },
    { value: 'monthly', label: 'Monthly on this date' },
    { value: 'yearly', label: 'Annually' },
];

const initialHolidayForm = (): HolidayForm => ({
    holiday_name: '',
    holiday_date: toInputDate(new Date()),
    holiday_type: 'Regular Holiday',
    holiday_scope: 'National',
    description: '',
    source: '',
});

const initialEventForm = (date: Date): EventForm => ({
    title: '',
    event_date: toInputDate(date),
    end_date: '',
    all_day: true,
    start_time: '09:00',
    end_time: '10:00',
    category: 'Meeting',
    recurrence: 'none',
    location: '',
    description: '',
    color: 'blueberry',
});

const getHolidayBadgeClass = (type: string) => {
    const text = type.toLowerCase();
    if (text.includes('regular')) return styles.badgeRegular;
    if (text.includes('working')) return styles.badgeWorking;
    return styles.badgeSpecial;
};

export default function CalendarManagementPage() {
    const router = useRouter();
    const [user, setUser] = useState<SessionUser | null>(null);
    const [loading, setLoading] = useState(true);
    const [fetching, setFetching] = useState(false);

    const [view, setView] = useState<CalendarView>('month');
    const [selectedDate, setSelectedDate] = useState(() => new Date());
    const [holidays, setHolidays] = useState<Holiday[]>([]);
    const [events, setEvents] = useState<CalendarEvent[]>([]);
    const [birthdays, setBirthdays] = useState<BirthdayEntry[]>([]);
    const [showHolidays, setShowHolidays] = useState(true);
    const [showBirthdays, setShowBirthdays] = useState(true);
    const [showEvents, setShowEvents] = useState(true);
    const [searchQuery, setSearchQuery] = useState('');

    const [holidayModalOpen, setHolidayModalOpen] = useState(false);
    const [holidayModalMode, setHolidayModalMode] = useState<'view' | 'edit' | 'create'>('view');
    const [selectedHoliday, setSelectedHoliday] = useState<Holiday | null>(null);
    const [holidayForm, setHolidayForm] = useState<HolidayForm>(initialHolidayForm());
    const [savingHoliday, setSavingHoliday] = useState(false);
    const [comments, setComments] = useState<HolidayComment[]>([]);
    const [commentsLoading, setCommentsLoading] = useState(false);
    const [commentSaving, setCommentSaving] = useState(false);
    const [commentText, setCommentText] = useState('');
    const [replyTarget, setReplyTarget] = useState<HolidayComment | null>(null);
    const [sourceOption, setSourceOption] = useState('Other');
    const [customSource, setCustomSource] = useState('');
    const [scopeMode, setScopeMode] = useState<'list' | 'manual'>('list');
    const [customScope, setCustomScope] = useState('');
    const holidayDateInputRef = useRef<HTMLInputElement | null>(null);

    const [eventModalOpen, setEventModalOpen] = useState(false);
    const [eventModalMode, setEventModalMode] = useState<'view' | 'edit' | 'create'>('create');
    const [selectedEvent, setSelectedEvent] = useState<CalendarEntry | null>(null);
    const [eventForm, setEventForm] = useState<EventForm>(() => initialEventForm(new Date()));
    const [savingEvent, setSavingEvent] = useState(false);
    // Inline per-field "Required" messages for the event/holiday/comment forms.
    const [eventFieldErrors, setEventFieldErrors] = useState<Record<string, string>>({});
    const [holidayFieldErrors, setHolidayFieldErrors] = useState<Record<string, string>>({});
    const [commentFieldError, setCommentFieldError] = useState('');

    const clearEventFieldError = (name: string) => {
        setEventFieldErrors((prev) => {
            if (!prev[name]) return prev;
            const next = { ...prev };
            delete next[name];
            return next;
        });
    };

    const clearHolidayFieldError = (name: string) => {
        setHolidayFieldErrors((prev) => {
            if (!prev[name]) return prev;
            const next = { ...prev };
            delete next[name];
            return next;
        });
    };

    const [dayPeekDate, setDayPeekDate] = useState<string | null>(null);
    const [showAllUpcoming, setShowAllUpcoming] = useState(false);
    const [showPastUpcoming, setShowPastUpcoming] = useState(false);
    const [pastDayFilter, setPastDayFilter] = useState('');
    const [pastMonthFilter, setPastMonthFilter] = useState('');
    const [pastYearFilter, setPastYearFilter] = useState('');
    const [pastSearchInput, setPastSearchInput] = useState('');
    const [pastSearchApplied, setPastSearchApplied] = useState('');

    const role = String(user?.role || '').toLowerCase();
    const isAdmin = role === 'admin';
    const canManage = isAdmin;
    const canComment = ['admin', 'manager', 'staff'].includes(role);

    const currentYear = selectedDate.getFullYear();
    const currentMonth = selectedDate.getMonth();

    const visibleRange = useMemo(() => {
        if (view === 'agenda') {
            const today = new Date();
            return { from: dateKey(today), to: dateKey(addDays(today, 90)) };
        }
        if (view === 'year') {
            return { from: `${currentYear}-01-01`, to: `${currentYear}-12-31` };
        }
        if (view === 'week') {
            const weekStart = startOfWeek(selectedDate);
            return { from: dateKey(weekStart), to: dateKey(addDays(weekStart, 6)) };
        }
        if (view === 'day') {
            return { from: dateKey(selectedDate), to: dateKey(selectedDate) };
        }
        const first = new Date(currentYear, currentMonth, 1);
        const last = new Date(currentYear, currentMonth + 1, 0);
        const gridStart = startOfWeek(first);
        const gridEnd = addDays(startOfWeek(last), 6);
        return { from: dateKey(gridStart), to: dateKey(gridEnd) };
    }, [currentMonth, currentYear, selectedDate, view]);

    // Upcoming-this-month needs the full selected month in memory even when
    // the grid view only fetches a week/day/agenda slice. Expand the fetch
    // range to the union of visibleRange + full month + past 180 days (for
    // the Previous dates view) so items never vanish.
    const fetchRange = useMemo(() => {
        const monthStart = dateKey(new Date(currentYear, currentMonth, 1));
        const monthEnd = dateKey(new Date(currentYear, currentMonth + 1, 0));
        const pastFloor = dateKey(addDays(new Date(), -180));
        let from = visibleRange.from < monthStart ? visibleRange.from : monthStart;
        if (pastFloor < from) from = pastFloor;
        const to = visibleRange.to > monthEnd ? visibleRange.to : monthEnd;
        return { from, to };
    }, [currentMonth, currentYear, visibleRange.from, visibleRange.to]);

    const normalizedEvents = useMemo(
        () =>
            events.map((event) => ({
                ...event,
                title: decodeHtmlEntities(event.title),
                description: decodeHtmlEntities(String(event.description || '')),
                location: decodeHtmlEntities(String(event.location || '')),
                category: decodeHtmlEntities(event.category || ''),
            })),
        [events]
    );

    // Distinct colors used by the loaded events so the "My calendars" panel
    // reflects whatever color was picked when an event was created.
    const eventColorLegend = useMemo(() => {
        const counts = new Map<string, number>();
        normalizedEvents.forEach((event) => {
            const key = GOOGLE_COLORS[event.color] ? event.color : 'blueberry';
            counts.set(key, (counts.get(key) || 0) + 1);
        });
        return [...counts.entries()]
            .map(([color, count]) => ({ color, count }))
            .sort((a, b) => b.count - a.count);
    }, [normalizedEvents]);

    const normalizedHolidays = useMemo(
        () =>
            holidays.map((holiday) => ({
                ...holiday,
                holiday_name: decodeHtmlEntities(holiday.holiday_name),
                holiday_type: decodeHtmlEntities(holiday.holiday_type || ''),
                holiday_scope: decodeHtmlEntities(holiday.holiday_scope || ''),
                description: decodeHtmlEntities(String(holiday.description || '')),
                source: decodeHtmlEntities(String(holiday.source || '')),
            })),
        [holidays]
    );

    const searchLower = searchQuery.trim().toLowerCase();

    const entriesByDate = useMemo(() => {
        const map = new Map<string, CalendarEntry[]>();
        const push = (entry: CalendarEntry) => {
            if (!map.has(entry.date)) map.set(entry.date, []);
            map.get(entry.date)?.push(entry);
        };

        if (showHolidays) {
            normalizedHolidays.forEach((holiday) => {
                push({
                    key: `holiday-${holiday.holiday_id}`,
                    kind: 'holiday',
                    date: holiday.holiday_date,
                    endDate: holiday.holiday_date,
                    title: holiday.holiday_name,
                    subtitle: holiday.holiday_type,
                    allDay: true,
                    color: HOLIDAY_COLOR,
                    raw: holiday,
                });
            });
        }

        if (showBirthdays) {
            birthdays.forEach((birthday) => {
                push({
                    key: `birthday-${birthday.birthday_date}-${birthday.user_id}`,
                    kind: 'birthday',
                    date: birthday.birthday_date,
                    endDate: birthday.birthday_date,
                    title: `${birthday.full_name}'s Birthday`,
                    subtitle:
                        typeof birthday.turning_age === 'number' && birthday.turning_age > 0
                            ? `Turns ${birthday.turning_age}`
                            : 'Birthday',
                    allDay: true,
                    color: BIRTHDAY_COLOR,
                    raw: birthday,
                });
            });
        }

        if (showEvents) {
            normalizedEvents.forEach((event) => {
                const matchesSearch =
                    !searchLower ||
                    event.title.toLowerCase().includes(searchLower) ||
                    String(event.description || '').toLowerCase().includes(searchLower) ||
                    String(event.location || '').toLowerCase().includes(searchLower) ||
                    String(event.category || '').toLowerCase().includes(searchLower);
                if (searchLower && !matchesSearch) return;
                push({
                    key: `event-${event.event_id}-${event.event_date}`,
                    kind: 'event',
                    date: event.event_date,
                    endDate: event.end_date || event.event_date,
                    title: event.title,
                    subtitle: event.all_day ? undefined : formatTimeLabel(event.start_time),
                    allDay: Boolean(event.all_day),
                    startTime: event.start_time,
                    endTime: event.end_time,
                    color: entryColor(event.color) ? event.color : 'blueberry',
                    raw: event,
                });
            });
        }

        map.forEach((list) =>
            list.sort((a, b) => {
                if (a.kind !== b.kind) {
                    const order: Record<EntryKind, number> = { birthday: 0, holiday: 1, event: 2 };
                    return order[a.kind] - order[b.kind];
                }
                if (a.allDay !== b.allDay) return a.allDay ? -1 : 1;
                return String(a.startTime || '').localeCompare(String(b.startTime || ''));
            })
        );

        return map;
    }, [birthdays, holidays, normalizedEvents, normalizedHolidays, searchLower, showBirthdays, showEvents, showHolidays]);

    const entriesForDate = useCallback(
        (date: string): CalendarEntry[] => {
            const list = entriesByDate.get(date) || [];
            return [...list].sort((a, b) => {
                if (a.kind !== b.kind) {
                    const order: Record<EntryKind, number> = { birthday: 0, holiday: 1, event: 2 };
                    return order[a.kind] - order[b.kind];
                }
                if (a.allDay !== b.allDay) return a.allDay ? -1 : 1;
                return String(a.startTime || '').localeCompare(String(b.startTime || ''));
            });
        },
        [entriesByDate]
    );

    const checkSession = useCallback(async () => {
        try {
            const res = await fetch(`${API_BASE}/auth.php`, { credentials: 'include' });
            const data = (await res.json()) as ApiResponse<SessionUser>;
            if (!data?.success || !data.data) {
                router.push('/');
                return;
            }
            setUser(data.data);
        } catch {
            router.push('/');
        } finally {
            setLoading(false);
        }
    }, [router]);

    const handleLogout = async () => {
        await fetch(`${API_BASE}/auth.php?action=logout`, { method: 'POST', credentials: 'include' });
        router.push('/');
    };

    const notifyCalendarSync = useCallback(() => {
        if (typeof window === 'undefined') return;
        const stamp = String(Date.now());
        try {
            localStorage.setItem(HOLIDAY_SYNC_STORAGE_KEY, stamp);
        } catch {
            // Ignore storage errors in restricted browser contexts.
        }
        window.dispatchEvent(new CustomEvent(HOLIDAY_SYNC_EVENT, { detail: { source: 'calendar', stamp } }));
    }, []);

    const fetchHolidays = useCallback(async (year: number, options?: { silent?: boolean }) => {
        try {
            const res = await fetch(`${API_BASE}/holidays.php?year=${year}`, { credentials: 'include' });
            const data = (await res.json()) as ApiResponse<Holiday[]>;
            if (data?.success && Array.isArray(data.data)) {
                setHolidays(data.data);
                return true;
            }
            if (!options?.silent) {
                void notifyError(String(data?.message || data?.error || 'Failed to load holidays.'));
            }
            return false;
        } catch {
            if (!options?.silent) void notifyError('Network error while loading holidays.');
            return false;
        }
    }, []);

    const fetchCalendarData = useCallback(async (from: string, to: string, options?: { silent?: boolean }) => {
        if (!options?.silent) setFetching(true);
        try {
            const res = await fetch(
                `${API_BASE}/calendar-events.php?date_from=${from}&date_to=${to}`,
                { credentials: 'include' }
            );
            const data = (await res.json()) as ApiResponse<{ events: CalendarEvent[]; birthdays: BirthdayEntry[] }>;
            if (data?.success && data.data) {
                setEvents(Array.isArray(data.data.events) ? data.data.events : []);
                setBirthdays(Array.isArray(data.data.birthdays) ? data.data.birthdays : []);
            } else if (!options?.silent) {
                void notifyError(String(data?.message || data?.error || 'Failed to load calendar data.'));
            }
        } catch {
            if (!options?.silent) void notifyError('Network error while loading calendar data.');
        } finally {
            if (!options?.silent) setFetching(false);
        }
    }, []);

    useEffect(() => {
        checkSession();
    }, [checkSession]);

    useEffect(() => {
        void fetchHolidays(currentYear, { silent: true });
    }, [currentYear, fetchHolidays]);

    useEffect(() => {
        if (!user) return;
        void fetchCalendarData(fetchRange.from, fetchRange.to);
    }, [fetchCalendarData, user, fetchRange.from, fetchRange.to]);

    useEffect(() => {
        if (!user) return;

        const refreshViews = () => {
            if (fetching || savingEvent || savingHoliday) return;
            void fetchHolidays(currentYear, { silent: true });
            void fetchCalendarData(fetchRange.from, fetchRange.to, { silent: true });
        };

        const onFocus = () => refreshViews();
        const onVisibilityChange = () => {
            if (!document.hidden) refreshViews();
        };
        const onCustomSync = (event: Event) => {
            const customEvent = event as CustomEvent<{ source?: string }>;
            if (customEvent.detail?.source === 'calendar') return;
            refreshViews();
        };
        const onStorageSync = (event: StorageEvent) => {
            if (event.key === HOLIDAY_SYNC_STORAGE_KEY) refreshViews();
        };

        window.addEventListener('focus', onFocus);
        document.addEventListener('visibilitychange', onVisibilityChange);
        window.addEventListener(HOLIDAY_SYNC_EVENT, onCustomSync as EventListener);
        window.addEventListener('storage', onStorageSync);

        return () => {
            window.removeEventListener('focus', onFocus);
            document.removeEventListener('visibilitychange', onVisibilityChange);
            window.removeEventListener(HOLIDAY_SYNC_EVENT, onCustomSync as EventListener);
            window.removeEventListener('storage', onStorageSync);
        };
    }, [
        currentYear,
        fetchCalendarData,
        fetchHolidays,
        fetching,
        savingEvent,
        savingHoliday,
        user,
        fetchRange.from,
        fetchRange.to,
    ]);

    const openDatePicker = (ref: React.RefObject<HTMLInputElement | null>) => {
        const input = ref.current;
        if (!input) return;
        const anyInput = input as HTMLInputElement & { showPicker?: () => void };
        if (typeof anyInput.showPicker === 'function') {
            anyInput.showPicker();
            return;
        }
        input.focus();
    };

    const goPrev = () => {
        if (view === 'day') setSelectedDate((d) => addDays(d, -1));
        else if (view === 'week') setSelectedDate((d) => addDays(d, -7));
        else if (view === 'agenda') setSelectedDate((d) => addDays(d, -30));
        else setSelectedDate((d) => addMonths(d, -1));
    };

    const goNext = () => {
        if (view === 'day') setSelectedDate((d) => addDays(d, 1));
        else if (view === 'week') setSelectedDate((d) => addDays(d, 7));
        else if (view === 'agenda') setSelectedDate((d) => addDays(d, 30));
        else setSelectedDate((d) => addMonths(d, 1));
    };

    const goToday = () => setSelectedDate(new Date());

    const headerTitle = useMemo(() => {
        if (view === 'day') {
            return selectedDate.toLocaleDateString('en-PH', { weekday: 'long', month: 'long', day: 'numeric', year: 'numeric' });
        }
        if (view === 'week') {
            const weekStart = startOfWeek(selectedDate);
            const weekEnd = addDays(weekStart, 6);
            const sameMonth = weekStart.getMonth() === weekEnd.getMonth();
            const startLabel = weekStart.toLocaleDateString('en-PH', { month: 'short' });
            const endLabel = weekEnd.toLocaleDateString('en-PH', sameMonth ? undefined : { month: 'short' });
            return `${startLabel} ${weekStart.getDate()} \u2013 ${endLabel} ${weekEnd.getDate()}`;
        }
        if (view === 'year') return String(currentYear);
        if (view === 'agenda') return 'Schedule';
        return selectedDate.toLocaleDateString('en-PH', { month: 'long', year: 'numeric' });
    }, [currentYear, selectedDate, view]);

    const openEventCreate = (date?: Date) => {
        if (!canManage) return;
        const target = date || selectedDate;
        setSelectedEvent(null);
        setEventForm(initialEventForm(target));
        setEventModalMode('create');
        setEventModalOpen(true);
    };

    const openEventDetails = (entry: CalendarEntry) => {
        if (!entry.raw || entry.kind !== 'event') return;
        const event = entry.raw as CalendarEvent;
        setSelectedEvent(entry);
        setEventModalMode('view');
        setEventForm({
            title: event.title,
            event_date: event.event_date,
            end_date: event.end_date || '',
            all_day: Boolean(event.all_day),
            start_time: String(event.start_time || '').slice(0, 5) || '09:00',
            end_time: String(event.end_time || '').slice(0, 5) || '10:00',
            category: event.category || 'Other',
            recurrence: event.recurrence || 'none',
            location: event.location || '',
            description: event.description || '',
            color: event.color || 'blueberry',
        });
        setEventModalOpen(true);
    };

    const closeEventModal = () => {
        setEventModalOpen(false);
        setEventModalMode('create');
        setSelectedEvent(null);
        setEventFieldErrors({});
    };

    const handleEventSave = async (formEvent: FormEvent) => {
        formEvent.preventDefault();
        if (!canManage) return;
        const isCreate = eventModalMode === 'create';
        if (!isCreate && !selectedEvent) {
            notifyError('No event selected.');
            return;
        }

        // Required-field check with inline per-field messages.
        const eventMissing: Record<string, string> = {};
        if (!eventForm.title.trim()) eventMissing.title = 'Required.';
        if (!eventForm.event_date) eventMissing.event_date = 'Required.';
        if (!eventForm.all_day) {
            if (!eventForm.start_time) eventMissing.start_time = 'Required.';
            if (!eventForm.end_time) eventMissing.end_time = 'Required.';
        }
        if (Object.keys(eventMissing).length > 0) {
            setEventFieldErrors(eventMissing);
            return;
        }
        setEventFieldErrors({});

        setSavingEvent(true);
        const payload: Record<string, unknown> = {
            title: eventForm.title.trim(),
            event_date: eventForm.event_date,
            end_date: eventForm.end_date || null,
            all_day: eventForm.all_day,
            start_time: eventForm.all_day ? null : eventForm.start_time,
            end_time: eventForm.all_day ? null : eventForm.end_time,
            category: eventForm.category,
            recurrence: eventForm.recurrence,
            location: eventForm.location,
            description: eventForm.description,
            color: eventForm.color,
        };
        if (!isCreate && selectedEvent?.raw) {
            payload.event_id = (selectedEvent.raw as CalendarEvent).event_id;
        }

        try {
            const res = await fetch(`${API_BASE}/calendar-events.php`, {
                method: isCreate ? 'POST' : 'PUT',
                headers: { 'Content-Type': 'application/json' },
                credentials: 'include',
                body: JSON.stringify(payload),
            });
            const data = (await res.json()) as ApiResponse<unknown>;
            if (!data?.success) {
                notifyError(String(data?.message || data?.error || `Failed to ${isCreate ? 'add' : 'save'} event.`));
                return;
            }
            notifySuccess(isCreate ? 'Event added successfully.' : 'Event updated successfully.');
            closeEventModal();
            notifyCalendarSync();
            await fetchCalendarData(fetchRange.from, fetchRange.to, { silent: true });
        } catch {
            notifyError(`Network error while ${isCreate ? 'adding' : 'saving'} event.`);
        } finally {
            setSavingEvent(false);
        }
    };

    const handleEventDelete = async () => {
        if (!selectedEvent?.raw || !canManage) return;
        const event = selectedEvent.raw as CalendarEvent;
        const confirmed = await confirmAction({
            title: 'Delete event?',
            text: `"${event.title}" will be removed from the calendar.`,
            confirmButtonText: 'Delete event',
            icon: 'warning',
            danger: true,
        });
        if (!confirmed) return;

        setSavingEvent(true);
        try {
            const res = await fetch(`${API_BASE}/calendar-events.php?id=${event.event_id}`, {
                method: 'DELETE',
                credentials: 'include',
            });
            const data = (await res.json()) as ApiResponse<unknown>;
            if (!data?.success) {
                notifyError(String(data?.message || data?.error || 'Failed to delete event.'));
                return;
            }
            notifySuccess('Event deleted.');
            closeEventModal();
            notifyCalendarSync();
            await fetchCalendarData(fetchRange.from, fetchRange.to, { silent: true });
        } catch {
            notifyError('Network error while deleting event.');
        } finally {
            setSavingEvent(false);
        }
    };

    const handleDayCellClick = (date: Date) => {
        if (canManage) {
            openEventCreate(date);
            return;
        }
        setDayPeekDate(dateKey(date));
    };

    const openHoliday = (holiday: Holiday) => {
        const resolvedSource = holiday.source || '';
        const resolvedSourceOption = sourceOptions.includes(resolvedSource) ? resolvedSource : 'Other';
        const resolvedScope = holiday.holiday_scope || 'National';
        const resolvedScopeMode = scopeOptions.includes(resolvedScope) ? 'list' : 'manual';
        setSelectedHoliday(holiday);
        setHolidayForm({
            holiday_name: holiday.holiday_name || '',
            holiday_date: holiday.holiday_date || '',
            holiday_type: holiday.holiday_type || 'Regular Holiday',
            holiday_scope: holiday.holiday_scope || 'National',
            description: holiday.description || '',
            source: holiday.source || '',
        });
        setSourceOption(resolvedSourceOption);
        setCustomSource(resolvedSourceOption === 'Other' ? resolvedSource : '');
        setScopeMode(resolvedScopeMode);
        setCustomScope(resolvedScopeMode === 'manual' ? resolvedScope : '');
        setHolidayModalMode('view');
        setHolidayModalOpen(true);
        setCommentText('');
        setReplyTarget(null);
        setComments([]);
        void loadComments(holiday.holiday_id);
    };

    const openCreateHoliday = () => {
        if (!canManage) return;
        const today = new Date();
        const defaultDate =
            today.getFullYear() === currentYear ? today : new Date(currentYear, currentMonth, 1);
        setSelectedHoliday(null);
        setHolidayForm({ ...initialHolidayForm(), holiday_date: toInputDate(defaultDate) });
        setSourceOption('Other');
        setCustomSource('');
        setScopeMode('list');
        setCustomScope('');
        setHolidayModalMode('create');
        setHolidayModalOpen(true);
        setCommentText('');
        setReplyTarget(null);
        setComments([]);
    };

    const closeHolidayModal = () => {
        setHolidayModalOpen(false);
        setHolidayModalMode('view');
        setSelectedHoliday(null);
        setComments([]);
        setCommentText('');
        setReplyTarget(null);
        setHolidayFieldErrors({});
        setCommentFieldError('');
    };

    const handleHolidayFormChange = (field: keyof HolidayForm, value: string) => {
        setHolidayForm((prev) => ({ ...prev, [field]: value }));
        clearHolidayFieldError(field);
    };

    const handleSaveHoliday = async (formEvent: FormEvent) => {
        formEvent.preventDefault();
        if (!canManage) return;
        const isCreate = holidayModalMode === 'create';
        if (!isCreate && !selectedHoliday) {
            notifyError('No holiday selected.');
            return;
        }
        // Required-field check with inline per-field messages.
        const holidayMissing: Record<string, string> = {};
        if (!holidayForm.holiday_name.trim()) holidayMissing.holiday_name = 'Required.';
        if (!holidayForm.holiday_date) holidayMissing.holiday_date = 'Required.';
        if (Object.keys(holidayMissing).length > 0) {
            setHolidayFieldErrors(holidayMissing);
            return;
        }
        setHolidayFieldErrors({});

        setSavingHoliday(true);

        const payload = {
            holiday_name: holidayForm.holiday_name.trim(),
            holiday_date: holidayForm.holiday_date,
            holiday_type: holidayForm.holiday_type,
            holiday_scope: holidayForm.holiday_scope,
            description: holidayForm.description,
            source: holidayForm.source,
        } as Record<string, unknown>;
        if (!isCreate && selectedHoliday) {
            payload.holiday_id = selectedHoliday.holiday_id;
        }

        try {
            const res = await fetch(`${API_BASE}/holidays.php`, {
                method: isCreate ? 'POST' : 'PUT',
                headers: { 'Content-Type': 'application/json' },
                credentials: 'include',
                body: JSON.stringify(payload),
            });
            const data = (await res.json()) as ApiResponse<{ holiday_id?: number }>;
            if (!data?.success) {
                notifyError(
                    String(data?.message || data?.error || `Failed to ${isCreate ? 'add' : 'save'} holiday.`)
                );
                return;
            }
            notifySuccess(isCreate ? 'Holiday added successfully.' : 'Holiday updated successfully.');
            closeHolidayModal();
            notifyCalendarSync();
            await fetchHolidays(currentYear, { silent: true });
        } catch {
            notifyError(`Network error while ${isCreate ? 'adding' : 'saving'} holiday.`);
        } finally {
            setSavingHoliday(false);
        }
    };

    const handleDeleteHoliday = async () => {
        if (!selectedHoliday || !canManage) return;
        const confirmed = await confirmAction({
            title: 'Delete holiday?',
            text: 'This will remove the holiday from the calendar.',
            confirmButtonText: 'Delete holiday',
            icon: 'warning',
            danger: true,
        });
        if (!confirmed) return;

        setSavingHoliday(true);
        try {
            const res = await fetch(`${API_BASE}/holidays.php?id=${selectedHoliday.holiday_id}`, {
                method: 'DELETE',
                credentials: 'include',
            });
            const data = (await res.json()) as ApiResponse<unknown>;
            if (!data?.success) {
                notifyError(String(data?.message || data?.error || 'Failed to delete holiday.'));
                return;
            }
            notifySuccess('Holiday deleted.');
            closeHolidayModal();
            notifyCalendarSync();
            await fetchHolidays(currentYear, { silent: true });
        } catch {
            notifyError('Network error while deleting holiday.');
        } finally {
            setSavingHoliday(false);
        }
    };

    const loadComments = useCallback(async (holidayId: number) => {
        if (!holidayId) return;
        setCommentsLoading(true);
        try {
            const res = await fetch(`${API_BASE}/holiday-comments.php?holiday_id=${holidayId}`, {
                credentials: 'include',
            });
            const data = (await res.json()) as ApiResponse<HolidayComment[]>;
            if (data?.success && Array.isArray(data.data)) {
                setComments(data.data);
            } else {
                setComments([]);
                notifyError(String(data?.message || data?.error || 'Failed to load comments.'));
            }
        } catch {
            setComments([]);
            notifyError('Failed to load comments.');
        } finally {
            setCommentsLoading(false);
        }
    }, []);

    const submitComment = async () => {
        if (!selectedHoliday || !canComment) return;
        const text = commentText.trim();
        if (!text) {
            setCommentFieldError('Required.');
            return;
        }
        setCommentFieldError('');

        setCommentSaving(true);
        try {
            const res = await fetch(`${API_BASE}/holiday-comments.php`, {
                method: 'POST',
                headers: { 'Content-Type': 'application/json' },
                credentials: 'include',
                body: JSON.stringify({
                    holiday_id: selectedHoliday.holiday_id,
                    comment_text: text,
                    parent_comment_id: replyTarget?.comment_id ?? null,
                }),
            });
            const data = (await res.json()) as ApiResponse<{ comment_id: number }>;
            if (!data?.success) {
                notifyError(String(data?.message || data?.error || 'Failed to post comment.'));
                return;
            }

            setCommentText('');
            setReplyTarget(null);
            notifySuccess('Comment posted.');
            await loadComments(selectedHoliday.holiday_id);
        } catch {
            notifyError('Failed to post comment.');
        } finally {
            setCommentSaving(false);
        }
    };

    const handleDeleteComment = async (comment: HolidayComment) => {
        if (!isAdmin || !comment?.comment_id) return;
        const confirmed = await confirmAction({
            title: 'Delete comment?',
            text: 'This will remove the comment from the discussion.',
            confirmButtonText: 'Delete comment',
            icon: 'warning',
            danger: true,
        });
        if (!confirmed) return;

        try {
            const res = await fetch(`${API_BASE}/holiday-comments.php?comment_id=${comment.comment_id}`, {
                method: 'DELETE',
                credentials: 'include',
            });
            const data = (await res.json()) as ApiResponse<unknown>;
            if (!data?.success) {
                notifyError(String(data?.message || data?.error || 'Failed to delete comment.'));
                return;
            }
            notifySuccess('Comment deleted.');
            if (selectedHoliday) {
                await loadComments(selectedHoliday.holiday_id);
            }
        } catch {
            notifyError('Failed to delete comment.');
        }
    };

    const monthGridDays = useMemo(() => {
        const first = new Date(currentYear, currentMonth, 1);
        const gridStart = startOfWeek(first);
        const cells: Date[] = [];
        for (let i = 0; i < 42; i++) {
            cells.push(addDays(gridStart, i));
        }
        return cells;
    }, [currentMonth, currentYear]);

    const weekDays = useMemo(() => {
        const weekStart = startOfWeek(selectedDate);
        return Array.from({ length: 7 }, (_, i) => addDays(weekStart, i));
    }, [selectedDate]);

    const HOURS = Array.from({ length: 24 }, (_, i) => i);

    const minutesOfDay = (time?: string | null) => {
        if (!time) return 0;
        const [h, m] = String(time).split(':');
        return parseInt(h || '0', 10) * 60 + parseInt(m || '0', 10);
    };

    interface LaneLayout {
        lanes: Map<CalendarEntry, number>;
        laneCount: number;
    }

    const layoutTimedEntries = (entries: CalendarEntry[]): LaneLayout => {
        const sorted = [...entries].sort(
            (a, b) => minutesOfDay(a.startTime) - minutesOfDay(b.startTime)
        );
        const laneEnds: number[] = [];
        const lanes = new Map<CalendarEntry, number>();
        sorted.forEach((entry) => {
            const start = minutesOfDay(entry.startTime);
            const end = Math.max(start + 30, minutesOfDay(entry.endTime) || start + 60);
            let assigned = -1;
            for (let i = 0; i < laneEnds.length; i++) {
                if (laneEnds[i] <= start) {
                    laneEnds[i] = end;
                    assigned = i;
                    break;
                }
            }
            if (assigned === -1) {
                laneEnds.push(end);
                assigned = laneEnds.length - 1;
            }
            lanes.set(entry, assigned);
        });
        return { lanes, laneCount: Math.max(1, laneEnds.length) };
    };

    const renderTimedColumn = (day: Date, columnIndex: number, totalDays: number) => {
        const key = dateKey(day);
        const dayEntries = entriesForDate(key);
        const timed = dayEntries.filter((e) => !e.allDay && e.startTime);
        const layout = layoutTimedEntries(timed);
        const HOUR_HEIGHT = 44;
        const laneWidth = 100 / layout.laneCount;

        return (
            <div
                className={styles.dayGridColumn}
                style={{ gridColumn: totalDays === 1 ? 2 : columnIndex + 2 }}
                key={`timed-${key}`}
            >

                <div className={styles.timeGridBody}>
                    {HOURS.map((hour) => (
                        <div key={hour} className={styles.timeGridSlot} />
                    ))}
                    {timed.map((entry) => {
                        const start = minutesOfDay(entry.startTime);
                        const endRaw = minutesOfDay(entry.endTime);
                        const end = endRaw > start ? endRaw : start + 60;
                        const lane = layout.lanes.get(entry) || 0;
                        const colors = entryColor(entry.color);
                        return (
                            <button
                                key={entry.key}
                                type="button"
                                className={styles.timedEvent}
                                style={{
                                    top: (start / 60) * HOUR_HEIGHT,
                                    height: Math.max(20, ((end - start) / 60) * HOUR_HEIGHT - 2),
                                    left: `calc(${lane * laneWidth}% + 2px)`,
                                    width: `calc(${laneWidth}% - 4px)`,
                                    background: colors.soft,
                                    color: colors.text,
                                    borderLeft: `3px solid ${colors.main}`,
                                }}
                                onClick={(e) => {
                                    e.stopPropagation();
                                    if (entry.kind === 'event') openEventDetails(entry);
                                }}
                            >
                                <span className={styles.timedEventTitle}>{entry.title}</span>
                                <span className={styles.timedEventTime}>
                                    {formatTimeLabel(entry.startTime)}
                                </span>
                            </button>
                        );
                    })}
                </div>
            </div>
        );
    };

    const yearMonths = useMemo(
        () =>
            Array.from({ length: 12 }, (_, m) => {
                const first = new Date(currentYear, m, 1);
                const daysInMonth = new Date(currentYear, m + 1, 0).getDate();
                const lead = first.getDay();
                const cells: (number | null)[] = [];
                for (let i = 0; i < lead; i++) cells.push(null);
                for (let d = 1; d <= daysInMonth; d++) cells.push(d);
                while (cells.length % 7 !== 0) cells.push(null);
                return { monthIndex: m, label: first.toLocaleDateString('en-PH', { month: 'short' }), cells };
            }),
        [currentYear]
    );

    const agendaGroups = useMemo(() => {
        const groups: { date: string; entries: CalendarEntry[] }[] = [];
        const today = new Date();
        for (let i = 0; i <= 90; i++) {
            const day = addDays(today, i);
            const key = dateKey(day);
            const entries = entriesForDate(key);
            if (entries.length > 0) {
                groups.push({ date: key, entries });
            }
        }
        return groups.slice(0, 40);
    }, [entriesForDate]);

    // Upcoming panel split: main list = today onwards (current + future),
    // past items move behind the "⋯" overlay so elapsed birthdays/events
    // no longer sit in Upcoming. Ongoing multi-day events (end >= today) stay.
    const monthAllItems = useMemo(() => {
        const items: CalendarEntry[] = [];
        for (let d = 1; d <= 31; d++) {
            const probe = new Date(currentYear, currentMonth, d);
            if (probe.getMonth() !== currentMonth) break;
            items.push(...entriesForDate(dateKey(probe)));
        }
        return items;
    }, [currentMonth, currentYear, entriesForDate]);

    const panelTodayKey = dateKey(new Date());
    const monthUpcomingItems = useMemo(
        () => monthAllItems.filter((e) => (e.endDate || e.date) >= panelTodayKey),
        [monthAllItems, panelTodayKey]
    );
    const monthPastItems = useMemo(
        () => monthAllItems.filter((e) => (e.endDate || e.date) < panelTodayKey),
        [monthAllItems, panelTodayKey]
    );

    // Previous dates view: all elapsed items in loaded range (newest first),
    // filterable by day / month / year + search.
    const allPreviousItems = useMemo(() => {
        const items: CalendarEntry[] = [];
        entriesByDate.forEach((list, date) => {
            if (date < panelTodayKey) items.push(...list);
        });
        return items.sort((a, b) => b.date.localeCompare(a.date));
    }, [entriesByDate, panelTodayKey]);

    const pastYearOptions = useMemo(() => {
        const years = new Set<number>();
        allPreviousItems.forEach((e) => {
            const y = parseDateKey(e.date).getFullYear();
            if (Number.isFinite(y)) years.add(y);
        });
        years.add(new Date().getFullYear());
        return [...years].sort((a, b) => b - a);
    }, [allPreviousItems]);

    const filteredPreviousItems = useMemo(() => {
        const term = pastSearchApplied.trim().toLowerCase();
        return allPreviousItems.filter((e) => {
            const d = parseDateKey(e.date);
            if (pastDayFilter !== '' && d.getDate() !== Number(pastDayFilter)) return false;
            if (pastMonthFilter !== '' && d.getMonth() !== Number(pastMonthFilter)) return false;
            if (pastYearFilter !== '' && d.getFullYear() !== Number(pastYearFilter)) return false;
            if (term) {
                const hay = [e.title, e.subtitle || '', e.kind, e.date].join(' ').toLowerCase();
                if (!hay.includes(term)) return false;
            }
            return true;
        });
    }, [allPreviousItems, pastDayFilter, pastMonthFilter, pastYearFilter, pastSearchApplied]);

    const clearPastFilters = () => {
        setPastDayFilter('');
        setPastMonthFilter('');
        setPastYearFilter('');
        setPastSearchInput('');
        setPastSearchApplied('');
    };

    const renderEntryChip = (entry: CalendarEntry, compact?: boolean) => {
        const colors = entryColor(entry.color);
        const handleOpen = () => {
            if (entry.kind === 'holiday' && entry.raw) openHoliday(entry.raw as Holiday);
            else if (entry.kind === 'event') openEventDetails(entry);
            else setDayPeekDate(entry.date);
        };
        return (
            <button
                key={entry.key}
                type="button"
                className={`${styles.entryChip} ${compact ? styles.entryChipCompact : ''}`}
                style={{
                    background: colors.soft,
                    color: colors.text,
                }}
                onClick={(e) => {
                    e.stopPropagation();
                    handleOpen();
                }}
            >
                <span
                    className={styles.chipDot}
                    style={{ background: entry.kind === 'birthday' ? colors.main : colors.main }}
                />
                <span className={styles.chipText}>
                    {!entry.allDay && entry.startTime && (
                        <span className={styles.chipTime}>{formatTimeLabel(entry.startTime)}</span>
                    )}
                    {entry.title}
                </span>
            </button>
        );
    };

    if (loading) {
        return (
            <Layout role={user?.role as string | undefined} user={user} onLogout={handleLogout}>
                <div className={styles.page}>Loading calendar...</div>
            </Layout>
        );
    }

    const today = new Date();

    return (
        <Layout role={user?.role as string | undefined} user={user} onLogout={handleLogout}>
            <Head>
                <title>Calendar Management</title>
            </Head>
            <div className={styles.page}>
                <section className={styles.hero} data-static-hover="true">
                    <div className={styles.heroTop}>
                        <div className={styles.heroLeft}>
                            <div className={styles.heroHeading}>
                                <h1 className={styles.title}>Company Calendar</h1>
                                <p className={styles.subtitle}>
                                    {isAdmin
                                        ? 'Full access: create and manage events, holidays, and see every birthday.'
                                        : 'View company events, Philippines holidays, and everyone\u2019s birthdays. Only admins can edit.'}
                                </p>
                            </div>
                            <div style={{ flex: '1 1 320px', minWidth: 220, maxWidth: 520 }}>
                                <SearchBar
                                    storageKey="calendar:events"
                                    placeholder="Search events..."
                                    ariaLabel="Search events"
                                    value={searchQuery}
                                    onChange={setSearchQuery}
                                    suggestions={collectSearchTerms([...normalizedEvents, ...normalizedHolidays], [
                                        (e: any) => e.title,
                                        (e: any) => e.holiday_name,
                                        (e: any) => e.subtitle,
                                        (e: any) => e.location,
                                        (e: any) => e.category,
                                    ])}
                                />
                            </div>
                        </div>
                        <div className={styles.heroActions}>
                            {canManage && (
                                <>
                                    <button type="button" className={styles.primaryButton} onClick={() => openEventCreate()}>
                                        + Create
                                    </button>
                                    <button type="button" className={styles.secondaryButton} onClick={openCreateHoliday}>
                                        Add Holiday
                                    </button>
                                </>
                            )}
                        </div>
                    </div>
                    <div className={styles.toolbarRow}>
                        <div className={styles.navGroup}>
                            <button type="button" className={styles.calendarButton} onClick={goToday}>
                                Today
                            </button>
                            <button
                                type="button"
                                className={`${styles.iconNav}`}
                                onClick={goPrev}
                                aria-label="Previous"
                            >
                                &#8249;
                            </button>
                            <button
                                type="button"
                                className={`${styles.iconNav}`}
                                onClick={goNext}
                                aria-label="Next"
                            >
                                &#8250;
                            </button>
                            <span className={styles.headerTitle}>{headerTitle}</span>
                        </div>
                        <div className={styles.viewSwitcher}>
                            {(['day', 'week', 'month', 'year', 'agenda'] as CalendarView[]).map((option) => (
                                <button
                                    key={option}
                                    type="button"
                                    className={`${styles.viewChip} ${view === option ? styles.viewChipActive : ''}`}
                                    onClick={() => setView(option)}
                                >
                                    {option === 'agenda' ? 'Schedule' : option.charAt(0).toUpperCase() + option.slice(1)}
                                </button>
                            ))}
                        </div>
                    </div>
                </section>

                <div className={styles.contentGrid}>
                    <aside className={styles.sidePanel}>
                        <div className={styles.filterPanel}>
                            <h4>My calendars</h4>
                            <label className={styles.filterItem}>
                                <input
                                    type="checkbox"
                                    checked={showEvents}
                                    onChange={(e) => setShowEvents(e.target.checked)}
                                />
                                <span className={styles.filterSwatch} style={{ background: GOOGLE_COLORS.blueberry.main }} />
                                Company Events {!canManage && <em>(view only)</em>}
                            </label>
                            <label className={styles.filterItem}>
                                <input
                                    type="checkbox"
                                    checked={showHolidays}
                                    onChange={(e) => setShowHolidays(e.target.checked)}
                                />
                                <span className={styles.filterSwatch} style={{ background: GOOGLE_COLORS.tomato.main }} />
                                Holidays {!canManage && <em>(view only)</em>}
                            </label>
                            <label className={styles.filterItem}>
                                <input
                                    type="checkbox"
                                    checked={showBirthdays}
                                    onChange={(e) => setShowBirthdays(e.target.checked)}
                                />
                                <span className={styles.filterSwatch} style={{ background: GOOGLE_COLORS.grape.main }} />
                                Birthdays
                            </label>
                            {eventColorLegend.length > 0 && (
                                <>
                                    <div style={{ fontSize: 11, fontWeight: 700, color: '#64748b', textTransform: 'uppercase', letterSpacing: '0.06em', marginTop: 4 }}>
                                        Event colors
                                    </div>
                                    {eventColorLegend.map(({ color, count }) => (
                                        <div key={color} className={styles.filterItem} style={{ cursor: 'default' }}>
                                            <span className={styles.filterSwatch} style={{ background: GOOGLE_COLORS[color].main }} />
                                            {color.charAt(0).toUpperCase() + color.slice(1)}
                                            <span style={{ marginLeft: 'auto', fontSize: 11, color: '#94a3b8', fontWeight: 700 }}>{count}</span>
                                        </div>
                                    ))}
                                </>
                            )}
                        </div>

                        <div className={styles.sideNote}>
                            {isAdmin
                                ? 'You are signed in as admin. You can add, edit, and delete events and holidays.'
                                : 'You have view-only access. Contact an admin to make changes to the calendar.'}
                        </div>
                    </aside>

                    <section className={styles.panel}>
                        {view === 'month' && (
                            <>
                                <div className={styles.calendarGrid}>
                                    {['SUN', 'MON', 'TUE', 'WED', 'THU', 'FRI', 'SAT'].map((day) => (
                                        <div key={day} className={styles.weekday}>
                                            {day}
                                        </div>
                                    ))}
                                    {monthGridDays.map((day, index) => {
                                        const key = dateKey(day);
                                        const dayEntries = entriesForDate(key);
                                        const inMonth = day.getMonth() === currentMonth;
                                        const isTodayCell = isSameDay(day, today);
                                        return (
                                            <div
                                                key={`${key}-${index}`}
                                                className={[
                                                    styles.dayCell,
                                                    !inMonth ? styles.dayCellMuted : '',
                                                    isTodayCell ? styles.today : '',
                                                ].join(' ')}
                                                onClick={() => handleDayCellClick(day)}
                                                role="presentation"
                                            >
                                                <div className={styles.dayNumberRow}>
                                                    <span className={[styles.dayNumber, isTodayCell ? styles.dayNumberToday : ''].join(' ')}>
                                                        {day.getDate()}
                                                    </span>
                                                </div>
                                                <div className={styles.holidayStack}>
                                                    {dayEntries.slice(0, 3).map((entry) => renderEntryChip(entry, true))}
                                                    {dayEntries.length > 3 && (
                                                        <button
                                                            type="button"
                                                            className={styles.entryChipMore}
                                                            onClick={(e) => {
                                                                e.stopPropagation();
                                                                setDayPeekDate(key);
                                                            }}
                                                        >
                                                            +{dayEntries.length - 3} more
                                                        </button>
                                                    )}
                                                </div>
                                            </div>
                                        );
                                    })}
                                </div>
                                {!canManage && (
                                    <div className={styles.note}>
                                        View-only mode: staff and managers can browse all events, holidays, and birthdays.
                                        Editing is reserved for admins.
                                    </div>
                                )}
                            </>
                        )}

                        {(view === 'week' || view === 'day') && (
                            (() => {
                                const days = view === 'day' ? [selectedDate] : weekDays;
                                const singleDayClass = view === 'day' ? ` ${styles.singleColumn}` : '';
                                return (
                                    <div className={`${styles.weekWrapper}${singleDayClass}`}>

                                        <div className={styles.weekHeader}>
                                            <div className={styles.gutterSpacer} />
                                            {days.map((day) => (
                                                <button
                                                    key={`wh-${dateKey(day)}`}
                                                    type="button"
                                                    className={[styles.weekHeaderDay, isSameDay(day, today) ? styles.weekHeaderToday : ''].join(' ')}
                                                    onClick={() => { setSelectedDate(day); setView('day'); }}
                                                >
                                                    <span>{day.toLocaleDateString('en-PH', { weekday: 'short' })}</span>
                                                    <strong>{day.getDate()}</strong>
                                                </button>
                                            ))}
                                        </div>
                                        <div className={styles.allDayRow}>
                                            <div className={styles.allDayGutter}>All day</div>
                                            {days.map((day) => (
                                                <div
                                                    key={`ad-${dateKey(day)}`}
                                                    className={styles.allDayCell}
                                                    onClick={() => handleDayCellClick(day)}
                                                    role="presentation"
                                                >
                                                    {entriesForDate(dateKey(day))
                                                        .filter((e) => e.allDay)
                                                        .map((entry) => renderEntryChip(entry))}
                                                </div>
                                            ))}
                                        </div>
                                        <div className={styles.timeGridScroll}>
                                            <div className={styles.timeGrid}>
                                                {HOURS.map((hour) => (
                                                    <div key={`hour-${hour}`} className={styles.hourGutter}>
                                                        {hourLabel(hour)}
                                                    </div>
                                                ))}
                                                {days.map((day, idx) => renderTimedColumn(day, idx, days.length))}
                                            </div>
                                        </div>
                                    </div>
                                );
                            })()
                        )}

                        {view === 'year' && (
                            <div className={styles.yearGrid}>
                                {yearMonths.map((month) => (
                                    <div key={`year-${month.monthIndex}`} className={styles.yearMonth}>
                                        <button
                                            type="button"
                                            className={styles.yearMonthTitle}
                                            onClick={() => {
                                                setSelectedDate(new Date(currentYear, month.monthIndex, 1));
                                                setView('month');
                                            }}
                                        >
                                            {month.label}
                                        </button>
                                        <div className={styles.miniWeekdays}>
                                            {['S', 'M', 'T', 'W', 'T', 'F', 'S'].map((d, i) => (
                                                <span key={`ym-${month.monthIndex}-wd-${i}`}>{d}</span>
                                            ))}
                                        </div>
                                        <div className={styles.miniGrid}>
                                            {month.cells.map((day, index) => {
                                                if (!day) return <span key={`ym-${month.monthIndex}-e-${index}`} />;
                                                const cellDate = new Date(currentYear, month.monthIndex, day);
                                                const cellKey = dateKey(cellDate);
                                                const hasEntries = entriesForDate(cellKey).length > 0;
                                                return (
                                                    <button
                                                        key={`ym-${month.monthIndex}-${cellKey}`}
                                                        type="button"
                                                        className={[
                                                            styles.miniDay,
                                                            isSameDay(cellDate, today) ? styles.miniToday : '',
                                                            hasEntries ? styles.miniHasEntries : '',
                                                        ].join(' ')}
                                                        onClick={() => {
                                                            setSelectedDate(cellDate);
                                                            setView('day');
                                                        }}
                                                    >
                                                        {day}
                                                        {hasEntries && <span className={styles.miniDot} />}
                                                    </button>
                                                );
                                            })}
                                        </div>
                                    </div>
                                ))}
                            </div>
                        )}

                        {view === 'agenda' && (
                            <div className={styles.agendaList}>
                                {agendaGroups.length === 0 && (
                                    <div className={styles.emptyState}>
                                        No upcoming events in the next 90 days.
                                    </div>
                                )}
                                {agendaGroups.map(({ date, entries }) => (
                                    <div key={`agenda-${date}`} className={styles.agendaGroup}>
                                        <div className={styles.agendaDateCol}>
                                            <span className={styles.agendaWeekday}>
                                                {parseDateKey(date).toLocaleDateString('en-PH', { weekday: 'short' })}
                                            </span>
                                            <strong className={isSameDay(parseDateKey(date), today) ? styles.agendaDayToday : ''}>
                                                {parseDateKey(date).getDate()}
                                            </strong>
                                        </div>
                                        <div className={styles.agendaEntries}>
                                            {entries.map((entry) => {
                                                const colors = entryColor(entry.color);
                                                return (
                                                    <button
                                                        key={`ag-${entry.key}`}
                                                        type="button"
                                                        className={styles.agendaEntry}
                                                        style={{ borderLeft: `4px solid ${colors.main}` }}
                                                        onClick={() => {
                                                            if (entry.kind === 'holiday' && entry.raw) openHoliday(entry.raw as Holiday);
                                                            else if (entry.kind === 'event') openEventDetails(entry);
                                                            else setDayPeekDate(entry.date);
                                                        }}
                                                    >
                                                        <div>
                                                            <span className={styles.agendaTitle}>{entry.title}</span>
                                                            <span className={styles.agendaMeta}>
                                                                {entry.kind === 'birthday'
                                                                    ? 'Birthday'
                                                                    : entry.kind === 'holiday'
                                                                      ? entry.subtitle || 'Holiday'
                                                                      : [entry.subtitle, entry.allDay ? null : formatTimeLabel(entry.endTime)].filter(Boolean).join(' \u2013 ') || 'All day'}
                                                            </span>
                                                        </div>
                                                        <span className={styles.agendaKind}>{entry.kind}</span>
                                                    </button>
                                                );
                                            })}
                                        </div>
                                    </div>
                                ))}
                            </div>
                        )}
                    </section>

                    <section className={styles.panel}>
                        <div className={styles.panelHead}>
                            <div>
                                <h2>Upcoming this month</h2>
                                <p>
                                    {`${monthUpcomingItems.length} item${monthUpcomingItems.length === 1 ? '' : 's'} scheduled${allPreviousItems.length > 0 ? ` · ${allPreviousItems.length} previous` : ''}`}
                                </p>
                            </div>
                            <button
                                type="button"
                                className={styles.calendarButton}
                                onClick={() => {
                                    if (fetching) return;
                                    void fetchHolidays(currentYear, { silent: true });
                                    void fetchCalendarData(fetchRange.from, fetchRange.to, { silent: true });
                                }}
                                disabled={fetching}
                            >
                                {fetching ? 'Refreshing...' : 'Refresh'}
                            </button>
                        </div>
                        <div className={styles.holidayList}>
                            {(() => {
                                const items = monthUpcomingItems;
                                const pastCount = allPreviousItems.length;
                                if (items.length === 0) {
                                    return (
                                        <>
                                            <div className={styles.emptyState}>
                                                {pastCount > 0 ? 'Nothing upcoming — all caught up.' : 'Nothing scheduled this month yet.'}
                                            </div>
                                            {pastCount > 0 && (
                                                <button
                                                    type="button"
                                                    className={styles.holidayCard}
                                                    onClick={() => setShowPastUpcoming(true)}
                                                    aria-label={`Show ${pastCount} previous dates`}
                                                    title={`Show ${pastCount} previous dates`}
                                                    style={{ textAlign: 'center', justifyContent: 'center' }}
                                                >
                                                    <div className={styles.holidayCardHead} style={{ justifyContent: 'center' }}>
                                                        <h3 className={styles.holidayName} style={{ fontSize: 20, letterSpacing: 2 }}>⋯</h3>
                                                    </div>
                                                    <div className={styles.holidayMeta} style={{ justifyContent: 'center' }}>
                                                        <span className={styles.badge}>View {pastCount} previous</span>
                                                    </div>
                                                </button>
                                            )}
                                        </>
                                    );
                                }
                                return (
                                    <>
                                        {items.slice(0, 5).map((entry) => {
                                            const colors = entryColor(entry.color);
                                            return (
                                                <button
                                                    key={`side-${entry.key}`}
                                                    type="button"
                                                    className={styles.holidayCard}
                                                    onClick={() => {
                                                        if (entry.kind === 'holiday' && entry.raw) openHoliday(entry.raw as Holiday);
                                                        else if (entry.kind === 'event') openEventDetails(entry);
                                                        else setDayPeekDate(entry.date);
                                                    }}
                                                >
                                                    <div className={styles.holidayCardHead}>
                                                        <h3 className={styles.holidayName}>{entry.title}</h3>
                                                        <span className={styles.holidayDate}>{formatShortDate(entry.date)}</span>
                                                    </div>
                                                    <div className={styles.holidayMeta}>
                                                        <span className={styles.badge} style={{ background: colors.soft, color: colors.text }}>
                                                            {entry.kind === 'birthday' ? 'Birthday' : entry.subtitle || (entry.allDay ? 'All day' : formatTimeLabel(entry.startTime))}
                                                        </span>
                                                    </div>
                                                </button>
                                            );
                                        })}
                                        {items.length > 5 && (
                                            <button
                                                type="button"
                                                className={styles.holidayCard}
                                                onClick={() => setShowAllUpcoming(true)}
                                                aria-label={`Show all ${items.length} upcoming items`}
                                                title={`Show all ${items.length} upcoming items`}
                                                style={{ textAlign: 'center', justifyContent: 'center' }}
                                            >
                                                <div className={styles.holidayCardHead} style={{ justifyContent: 'center' }}>
                                                    <h3 className={styles.holidayName} style={{ fontSize: 20, letterSpacing: 2 }}>⋯</h3>
                                                </div>
                                                <div className={styles.holidayMeta} style={{ justifyContent: 'center' }}>
                                                    <span className={styles.badge}>+{items.length - 5} more</span>
                                                </div>
                                            </button>
                                        )}
                                        {pastCount > 0 && (
                                            <button
                                                type="button"
                                                className={styles.holidayCard}
                                                onClick={() => setShowPastUpcoming(true)}
                                                aria-label={`Show ${pastCount} previous dates`}
                                                title={`Show ${pastCount} previous dates`}
                                                style={{ textAlign: 'center', justifyContent: 'center' }}
                                            >
                                                <div className={styles.holidayCardHead} style={{ justifyContent: 'center' }}>
                                                    <h3 className={styles.holidayName} style={{ fontSize: 20, letterSpacing: 2 }}>⋯</h3>
                                                </div>
                                                <div className={styles.holidayMeta} style={{ justifyContent: 'center' }}>
                                                    <span className={styles.badge}>View {pastCount} previous</span>
                                                </div>
                                            </button>
                                        )}
                                    </>
                                );
                            })()}
                        </div>
                    </section>
                </div>
                {showAllUpcoming && (
                    <div className={styles.modalBackdrop} onClick={() => setShowAllUpcoming(false)}>
                        <div
                            className={styles.modalCard}
                            onClick={(event) => event.stopPropagation()}
                            style={{ width: 'min(380px, calc(100vw - 24px))', maxHeight: 'min(70vh, 520px)', display: 'flex', flexDirection: 'column', padding: '12px 14px' }}
                        >
                            <div className={styles.modalHead} style={{ marginBottom: 8, paddingBottom: 8 }}>
                                <h3>Upcoming this month</h3>
                                <button type="button" onClick={() => setShowAllUpcoming(false)}>
                                    x
                                </button>
                            </div>
                            {(() => {
                                const allItems = monthUpcomingItems;
                                if (allItems.length === 0) {
                                    return <div className={styles.emptyState}>Nothing upcoming this month.</div>;
                                }
                                return (
                                    <div className={styles.dayPeekList} style={{ maxHeight: '48vh' }}>
                                        {allItems.map((entry) => {
                                            return (
                                                <button
                                                    key={`all-${entry.key}`}
                                                    type="button"
                                                    className={styles.agendaEntry}
                                                    onClick={() => {
                                                        if (entry.kind === 'holiday' && entry.raw) openHoliday(entry.raw as Holiday);
                                                        else if (entry.kind === 'event') openEventDetails(entry);
                                                        else setDayPeekDate(entry.date);
                                                    }}
                                                >
                                                    <div>
                                                        <span className={styles.agendaTitle}>{entry.title}</span>
                                                        <span className={styles.agendaMeta}>
                                                            {formatShortDate(entry.date)}
                                                            {entry.kind === 'birthday'
                                                                ? ' • Birthday'
                                                                : entry.subtitle
                                                                  ? ` • ${entry.subtitle}`
                                                                  : entry.allDay ? ' • All day' : ` • ${formatTimeLabel(entry.startTime)}`}
                                                        </span>
                                                    </div>
                                                    <span className={styles.agendaKind}>{entry.kind}</span>
                                                </button>
                                            );
                                        })}
                                    </div>
                                );
                            })()}
                        </div>
                    </div>
                )}
                {showPastUpcoming && (
                    <div className={styles.modalBackdrop} onClick={() => setShowPastUpcoming(false)}>
                        <div
                            className={styles.modalCard}
                            onClick={(event) => event.stopPropagation()}
                            style={{ width: 'min(460px, calc(100vw - 24px))', maxHeight: 'min(78vh, 600px)', display: 'flex', flexDirection: 'column', padding: '12px 14px' }}
                        >
                            <div className={styles.modalHead} style={{ marginBottom: 8, paddingBottom: 8 }}>
                                <h3>Previous dates</h3>
                                <button type="button" onClick={() => setShowPastUpcoming(false)}>
                                    x
                                </button>
                            </div>
                            <div style={{ display: 'flex', gap: 6, flexWrap: 'wrap', marginBottom: 8 }}>
                                <select
                                    value={pastDayFilter}
                                    onChange={(e) => setPastDayFilter(e.target.value)}
                                    aria-label="Filter by day"
                                    style={{ flex: '1 1 70px', minWidth: 70, padding: '6px 8px', borderRadius: 8, border: '1px solid #e2e8f0', fontSize: 12 }}
                                >
                                    <option value="">All days</option>
                                    {Array.from({ length: 31 }, (_, i) => i + 1).map((d) => (
                                        <option key={d} value={String(d)}>Day {d}</option>
                                    ))}
                                </select>
                                <select
                                    value={pastMonthFilter}
                                    onChange={(e) => setPastMonthFilter(e.target.value)}
                                    aria-label="Filter by month"
                                    style={{ flex: '1 1 110px', minWidth: 110, padding: '6px 8px', borderRadius: 8, border: '1px solid #e2e8f0', fontSize: 12 }}
                                >
                                    <option value="">All months</option>
                                    {['January', 'February', 'March', 'April', 'May', 'June', 'July', 'August', 'September', 'October', 'November', 'December'].map((m, i) => (
                                        <option key={m} value={String(i)}>{m}</option>
                                    ))}
                                </select>
                                <select
                                    value={pastYearFilter}
                                    onChange={(e) => setPastYearFilter(e.target.value)}
                                    aria-label="Filter by year"
                                    style={{ flex: '1 1 90px', minWidth: 90, padding: '6px 8px', borderRadius: 8, border: '1px solid #e2e8f0', fontSize: 12 }}
                                >
                                    <option value="">All years</option>
                                    {pastYearOptions.map((y) => (
                                        <option key={y} value={String(y)}>{y}</option>
                                    ))}
                                </select>
                            </div>
                            <div style={{ display: 'flex', gap: 6, marginBottom: 8 }}>
                                <input
                                    type="search"
                                    value={pastSearchInput}
                                    onChange={(e) => setPastSearchInput(e.target.value)}
                                    onKeyDown={(e) => { if (e.key === 'Enter') setPastSearchApplied(pastSearchInput); }}
                                    placeholder="Search title..."
                                    aria-label="Search previous dates"
                                    style={{ flex: 1, minWidth: 0, padding: '6px 8px', borderRadius: 8, border: '1px solid #e2e8f0', fontSize: 12 }}
                                />
                                <button
                                    type="button"
                                    className={styles.calendarButton}
                                    onClick={() => setPastSearchApplied(pastSearchInput)}
                                >
                                    Search
                                </button>
                                <button
                                    type="button"
                                    className={styles.calendarButton}
                                    onClick={clearPastFilters}
                                >
                                    Clear
                                </button>
                            </div>
                            <div style={{ fontSize: 11, color: '#64748b', marginBottom: 6 }}>
                                {filteredPreviousItems.length} previous item{filteredPreviousItems.length === 1 ? '' : 's'}
                            </div>
                            {filteredPreviousItems.length === 0 ? (
                                <div className={styles.emptyState}>No previous dates match your filters.</div>
                            ) : (
                                <div className={styles.dayPeekList} style={{ maxHeight: '48vh' }}>
                                    {filteredPreviousItems.map((entry) => (
                                        <button
                                            key={`past-${entry.key}`}
                                            type="button"
                                            className={styles.agendaEntry}
                                            onClick={() => {
                                                if (entry.kind === 'holiday' && entry.raw) openHoliday(entry.raw as Holiday);
                                                else if (entry.kind === 'event') openEventDetails(entry);
                                                else setDayPeekDate(entry.date);
                                            }}
                                        >
                                            <div>
                                                <span className={styles.agendaTitle}>{entry.title}</span>
                                                <span className={styles.agendaMeta}>
                                                    {formatShortDate(entry.date)}
                                                    {entry.kind === 'birthday'
                                                        ? ' • Birthday'
                                                        : entry.subtitle
                                                          ? ` • ${entry.subtitle}`
                                                          : entry.allDay ? ' • All day' : ` • ${formatTimeLabel(entry.startTime)}`}
                                                </span>
                                            </div>
                                            <span className={styles.agendaKind}>{entry.kind}</span>
                                        </button>
                                    ))}
                                </div>
                            )}
                        </div>
                    </div>
                )}
                {dayPeekDate && (
                    <div className={styles.modalBackdrop} onClick={() => setDayPeekDate(null)}>
                        <div className={styles.modalCard} onClick={(event) => event.stopPropagation()}>
                            <div className={styles.modalHead}>
                                <h3>{formatLongDate(dayPeekDate)}</h3>
                                <button type="button" onClick={() => setDayPeekDate(null)}>
                                    x
                                </button>
                            </div>
                            {(() => {
                                const items = entriesForDate(dayPeekDate);
                                if (items.length === 0) {
                                    return <div className={styles.emptyState}>Nothing scheduled for this day.</div>;
                                }
                                return (
                                    <div className={styles.dayPeekList}>
                                        {items.map((entry) => {
                                            const colors = entryColor(entry.color);
                                            return (
                                                <button
                                                    key={`peek-${entry.key}`}
                                                    type="button"
                                                    className={styles.agendaEntry}
                                                    style={{ borderLeft: `4px solid ${colors.main}` }}
                                                    onClick={() => {
                                                        setDayPeekDate(null);
                                                        if (entry.kind === 'holiday' && entry.raw) openHoliday(entry.raw as Holiday);
                                                        else if (entry.kind === 'event') openEventDetails(entry);
                                                    }}
                                                >
                                                    <div>
                                                        <span className={styles.agendaTitle}>{entry.title}</span>
                                                        <span className={styles.agendaMeta}>
                                                            {entry.kind === 'birthday'
                                                                ? `${entry.subtitle || 'Birthday'}${(entry.raw as BirthdayEntry | undefined)?.role ? ` \u2022 ${String((entry.raw as BirthdayEntry).role).charAt(0).toUpperCase()}${String((entry.raw as BirthdayEntry).role).slice(1)}` : ''}`
                                                                : entry.subtitle || (entry.allDay ? 'All day' : `${formatTimeLabel(entry.startTime)} \u2013 ${formatTimeLabel(entry.endTime)}`)}
                                                        </span>
                                                    </div>
                                                    <span className={styles.agendaKind}>{entry.kind}</span>
                                                </button>
                                            );
                                        })}
                                    </div>
                                );
                            })()}
                            {canManage && (
                                <div className={styles.modalActions}>
                                    <button
                                        type="button"
                                        className={styles.primaryButton}
                                        onClick={() => {
                                            const target = parseDateKey(dayPeekDate);
                                            setDayPeekDate(null);
                                            openEventCreate(target);
                                        }}
                                    >
                                        + Add event on this day
                                    </button>
                                </div>
                            )}
                        </div>
                    </div>
                )}

                {eventModalOpen && (
                    <div className={styles.modalBackdrop} onClick={closeEventModal}>
                        <div className={styles.modalCard} onClick={(event) => event.stopPropagation()}>
                            <div className={styles.modalHead}>
                                <h3>
                                    {eventModalMode === 'create'
                                        ? 'New Event'
                                        : eventModalMode === 'edit'
                                          ? 'Edit Event'
                                          : 'Event Details'}
                                </h3>
                                <button type="button" onClick={closeEventModal}>
                                    x
                                </button>
                            </div>

                            {eventModalMode === 'view' && selectedEvent && (
                                <>
                                    <div className={styles.viewGrid}>
                                        <div className={styles.viewItem}>
                                            <span>Title</span>
                                            <p>{selectedEvent.title}</p>
                                        </div>
                                        <div className={styles.viewItem}>
                                            <span>When</span>
                                            <p>
                                                {selectedEvent.endDate && selectedEvent.endDate !== selectedEvent.date
                                                    ? `${formatShortDate(selectedEvent.date)} \u2013 ${formatShortDate(selectedEvent.endDate)}`
                                                    : formatLongDate(selectedEvent.date)}
                                                {!selectedEvent.allDay &&
                                                    ` \u2022 ${formatTimeLabel(selectedEvent.startTime)}${selectedEvent.endTime ? ` \u2013 ${formatTimeLabel(selectedEvent.endTime)}` : ''}`}
                                            </p>
                                        </div>
                                        <div className={styles.viewItem}>
                                            <span>Category</span>
                                            <p>{(selectedEvent.raw as CalendarEvent)?.category || '-'}</p>
                                        </div>
                                        {(selectedEvent.raw as CalendarEvent)?.location && (
                                            <div className={styles.viewItem}>
                                                <span>Location</span>
                                                <p>{(selectedEvent.raw as CalendarEvent).location}</p>
                                            </div>
                                        )}
                                        {(selectedEvent.raw as CalendarEvent)?.recurrence &&
                                            (selectedEvent.raw as CalendarEvent).recurrence !== 'none' && (
                                            <div className={styles.viewItem}>
                                                <span>Repeats</span>
                                                <p>{recurrenceOptions.find((r) => r.value === (selectedEvent.raw as CalendarEvent).recurrence)?.label || 'Repeats'}</p>
                                            </div>
                                        )}
                                        {(selectedEvent.raw as CalendarEvent)?.creator_name && (
                                            <div className={styles.viewItem}>
                                                <span>Created by</span>
                                                <p>{(selectedEvent.raw as CalendarEvent).creator_name}</p>
                                            </div>
                                        )}
                                    </div>
                                    {(selectedEvent.raw as CalendarEvent)?.description && (
                                        <div className={styles.note}>{(selectedEvent.raw as CalendarEvent).description}</div>
                                    )}
                                    {canManage ? (
                                        <div className={styles.modalActions}>
                                            <button
                                                type="button"
                                                className={styles.secondaryButton}
                                                onClick={() => setEventModalMode('edit')}
                                            >
                                                <CrudActionIcon action="edit" />
                                                &nbsp;Edit
                                            </button>
                                            <button
                                                type="button"
                                                className={styles.dangerButton}
                                                onClick={() => void handleEventDelete()}
                                                disabled={savingEvent}
                                            >
                                                <CrudActionIcon action="delete" />
                                                &nbsp;Delete
                                            </button>
                                        </div>
                                    ) : (
                                        <div className={styles.note}>Only admins can edit or delete events.</div>
                                    )}
                                </>
                            )}

                            {eventModalMode !== 'view' && (
                                <form className={styles.modalForm} onSubmit={handleEventSave} noValidate>
                                    <div className={styles.formRow}>
                                        <label className={styles.formLabel} htmlFor="event-title">
                                            Title
                                        </label>
                                        <div className={styles.formField}>
                                            <input
                                                id="event-title"
                                                className={styles.input}
                                                value={eventForm.title}
                                                onChange={(e) => {
                                                    setEventForm((prev) => ({ ...prev, title: e.target.value }));
                                                    clearEventFieldError('title');
                                                }}
                                                placeholder="Add title"
                                                required
                                                aria-required="true"
                                                aria-invalid={eventFieldErrors.title ? true : undefined}
                                                style={eventFieldErrors.title ? { border: '2px solid #ef4444' } : undefined}
                                            />
                                            {eventFieldErrors.title && <div style={{ marginTop: 4, fontSize: 12, color: '#b91c1c' }}>{eventFieldErrors.title}</div>}
                                        </div>
                                    </div>
                                    <div className={styles.formRow}>
                                        <label className={styles.formLabel} htmlFor="event-date">
                                            Date
                                        </label>
                                        <div className={styles.formFieldInline}>
                                            <div style={{ flex: 1, minWidth: 0 }}>
                                            <input
                                                id="event-date"
                                                type="date"
                                                className={styles.input}
                                                value={eventForm.event_date}
                                                onChange={(e) => {
                                                    setEventForm((prev) => ({ ...prev, event_date: e.target.value }));
                                                    clearEventFieldError('event_date');
                                                }}
                                                required
                                                aria-required="true"
                                                aria-invalid={eventFieldErrors.event_date ? true : undefined}
                                                style={eventFieldErrors.event_date ? { border: '2px solid #ef4444' } : undefined}
                                            />
                                            {eventFieldErrors.event_date && <div style={{ marginTop: 4, fontSize: 12, color: '#b91c1c' }}>{eventFieldErrors.event_date}</div>}
                                            </div>
                                            <input
                                                type="date"
                                                className={styles.input}
                                                value={eventForm.end_date}
                                                onChange={(e) =>
                                                    setEventForm((prev) => ({ ...prev, end_date: e.target.value }))
                                                }
                                                aria-label="End date (multi-day)"
                                                placeholder="End date"
                                            />
                                        </div>
                                    </div>
                                    <div className={styles.formRow}>
                                        <label className={`${styles.formLabel}`} htmlFor="event-allday">
                                            Time
                                        </label>
                                        <div className={styles.formFieldInline}>
                                            <label className={styles.radioOption}>
                                                <input
                                                    id="event-allday"
                                                    type="checkbox"
                                                    checked={eventForm.all_day}
                                                    onChange={(e) =>
                                                        setEventForm((prev) => ({ ...prev, all_day: e.target.checked }))
                                                    }
                                                />
                                                <span>All day</span>
                                            </label>
                                            {!eventForm.all_day && (
                                                <>
                                                    <div style={{ flex: 1, minWidth: 0 }}>
                                                    <input
                                                        type="time"
                                                        className={styles.input}
                                                        value={eventForm.start_time}
                                                        onChange={(e) => {
                                                            setEventForm((prev) => ({ ...prev, start_time: e.target.value }));
                                                            clearEventFieldError('start_time');
                                                        }}
                                                        required
                                                        aria-required="true"
                                                        aria-label="Start time (required)"
                                                        aria-invalid={eventFieldErrors.start_time ? true : undefined}
                                                        style={eventFieldErrors.start_time ? { border: '2px solid #ef4444' } : undefined}
                                                    />
                                                    {eventFieldErrors.start_time && <div style={{ marginTop: 4, fontSize: 12, color: '#b91c1c' }}>{eventFieldErrors.start_time}</div>}
                                                    </div>
                                                    <div style={{ flex: 1, minWidth: 0 }}>
                                                    <input
                                                        type="time"
                                                        className={styles.input}
                                                        value={eventForm.end_time}
                                                        onChange={(e) => {
                                                            setEventForm((prev) => ({ ...prev, end_time: e.target.value }));
                                                            clearEventFieldError('end_time');
                                                        }}
                                                        required
                                                        aria-required="true"
                                                        aria-label="End time (required)"
                                                        aria-invalid={eventFieldErrors.end_time ? true : undefined}
                                                        style={eventFieldErrors.end_time ? { border: '2px solid #ef4444' } : undefined}
                                                    />
                                                    {eventFieldErrors.end_time && <div style={{ marginTop: 4, fontSize: 12, color: '#b91c1c' }}>{eventFieldErrors.end_time}</div>}
                                                    </div>
                                                </>
                                            )}
                                        </div>
                                    </div>
                                    <div className={styles.formRow}>
                                        <label className={styles.formLabel} htmlFor="event-recurrence">
                                            Repeat
                                        </label>
                                        <div className={styles.formField}>
                                            <select
                                                id="event-recurrence"
                                                className={styles.select}
                                                value={eventForm.recurrence}
                                                onChange={(e) =>
                                                    setEventForm((prev) => ({ ...prev, recurrence: e.target.value }))
                                                }
                                            >
                                                {recurrenceOptions.map((option) => (
                                                    <option key={option.value} value={option.value}>
                                                        {option.label}
                                                    </option>
                                                ))}
                                            </select>
                                        </div>
                                    </div>
                                    <div className={styles.formRow}>
                                        <label className={styles.formLabel} htmlFor="event-category">
                                            Category
                                        </label>
                                        <div className={styles.formField}>
                                            <select
                                                id="event-category"
                                                className={styles.select}
                                                value={eventCategoryOptions.includes(eventForm.category) ? eventForm.category : 'Other'}
                                                onChange={(e) =>
                                                    setEventForm((prev) => ({ ...prev, category: e.target.value }))
                                                }
                                            >
                                                {eventCategoryOptions.map((option) => (
                                                    <option key={option} value={option}>
                                                        {option}
                                                    </option>
                                                ))}
                                            </select>
                                        </div>
                                    </div>
                                    <div className={styles.formRow}>
                                        <label className={styles.formLabel} htmlFor="event-location">
                                            Location
                                        </label>
                                        <div className={styles.formField}>
                                            <input
                                                id="event-location"
                                                className={styles.input}
                                                value={eventForm.location}
                                                onChange={(e) =>
                                                    setEventForm((prev) => ({ ...prev, location: e.target.value }))
                                                }
                                                placeholder="Add location (optional)"
                                            />
                                        </div>
                                    </div>
                                    <div className={styles.formRow}>
                                        <span className={styles.formLabel}>Color</span>
                                        <div className={styles.formField}>
                                            <div className={styles.colorSwatches}>
                                                {colorOptions.map((colorKey) => (
                                                    <button
                                                        key={`swatch-${colorKey}`}
                                                        type="button"
                                                        className={[
                                                            styles.colorSwatch,
                                                            eventForm.color === colorKey ? styles.colorSwatchActive : '',
                                                        ].join(' ')}
                                                        style={{ background: GOOGLE_COLORS[colorKey].main }}
                                                        onClick={() => setEventForm((prev) => ({ ...prev, color: colorKey }))}
                                                        aria-label={colorKey}
                                                    />
                                                ))}
                                            </div>
                                        </div>
                                    </div>
                                    <div className={`${styles.formRow} ${styles.formRowTop}`}>
                                        <label className={styles.formLabel} htmlFor="event-notes">
                                            Description
                                        </label>
                                        <div className={styles.formField}>
                                            <textarea
                                                id="event-notes"
                                                className={styles.textarea}
                                                value={eventForm.description}
                                                onChange={(e) =>
                                                    setEventForm((prev) => ({ ...prev, description: e.target.value }))
                                                }
                                            />
                                        </div>
                                    </div>
                                    <div className={`${styles.modalActions} ${styles.formActions}`}>
                                        <button
                                            type="button"
                                            className={styles.ghostButton}
                                            onClick={closeEventModal}
                                            disabled={savingEvent}
                                        >
                                            Cancel
                                        </button>
                                        <button
                                            type="submit"
                                            className={`${styles.primaryButton} ${styles.modalPrimary}`}
                                            disabled={savingEvent}
                                        >
                                            {savingEvent
                                                ? 'Saving...'
                                                : eventModalMode === 'create'
                                                  ? 'Create Event'
                                                  : 'Save Changes'}
                                        </button>
                                    </div>
                                </form>
                            )}
                        </div>
                    </div>
                )}
                {holidayModalOpen && (
                    <div className={styles.modalBackdrop} onClick={closeHolidayModal}>
                        <div className={styles.modalCard} onClick={(event) => event.stopPropagation()}>
                            <div className={styles.modalHead}>
                                <h3>
                                    {holidayModalMode === 'create'
                                        ? 'Add Calendar Holiday'
                                        : holidayModalMode === 'edit'
                                          ? 'Edit Holiday'
                                          : 'Holiday Details'}
                                </h3>
                                <button type="button" onClick={closeHolidayModal}>
                                    x
                                </button>
                            </div>

                            {holidayModalMode === 'view' && selectedHoliday && (
                                <>
                                    <div className={styles.viewGrid}>
                                        <div className={styles.viewItem}>
                                            <span>Holiday</span>
                                            <p>{selectedHoliday.holiday_name}</p>
                                        </div>
                                        <div className={styles.viewItem}>
                                            <span>Date</span>
                                            <p>{formatLongDate(selectedHoliday.holiday_date)}</p>
                                        </div>
                                        <div className={styles.viewItem}>
                                            <span>Type</span>
                                            <p>{selectedHoliday.holiday_type || 'Holiday'}</p>
                                        </div>
                                        <div className={styles.viewItem}>
                                            <span>Scope</span>
                                            <p>{selectedHoliday.holiday_scope || 'National'}</p>
                                        </div>
                                        <div className={styles.viewItem}>
                                            <span>Source</span>
                                            <p>{selectedHoliday.source || 'N/A'}</p>
                                        </div>
                                    </div>
                                    {selectedHoliday.description && (
                                        <div className={styles.note}>{selectedHoliday.description}</div>
                                    )}

                                    {canManage ? (
                                        <div className={styles.modalActions}>
                                            <button
                                                type="button"
                                                className={styles.secondaryButton}
                                                onClick={() => setHolidayModalMode('edit')}
                                            >
                                                <CrudActionIcon action="edit" />
                                                &nbsp;Edit
                                            </button>
                                            <button
                                                type="button"
                                                className={styles.dangerButton}
                                                onClick={() => void handleDeleteHoliday()}
                                                disabled={savingHoliday}
                                            >
                                                <CrudActionIcon action="delete" />
                                                &nbsp;Delete
                                            </button>
                                        </div>
                                    ) : (
                                        <div className={styles.note}>Only admins can edit or delete holidays.</div>
                                    )}

                                    <div className={styles.commentSection}>
                                        <div className={styles.commentHead}>
                                            <span className={styles.commentTitle}>Comments</span>
                                            <button
                                                type="button"
                                                className={styles.commentRefresh}
                                                onClick={() => void loadComments(selectedHoliday.holiday_id)}
                                                disabled={commentsLoading}
                                            >
                                                {commentsLoading ? 'Refreshing...' : 'Refresh'}
                                            </button>
                                        </div>

                                        <div className={styles.commentList}>
                                            {commentsLoading ? (
                                                <div className={styles.commentEmpty}>Loading comments...</div>
                                            ) : comments.length === 0 ? (
                                                <div className={styles.commentEmpty}>No comments yet.</div>
                                            ) : (
                                                comments.map((comment) => {
                                                    const isReply = Boolean(comment.parent_comment_id);
                                                    const isAdminComment =
                                                        String(comment.commenter_role || '').toLowerCase() === 'admin';
                                                    return (
                                                        <div
                                                            key={comment.comment_id}
                                                            className={`${styles.commentCard} ${isReply ? styles.commentReply : ''} ${isAdminComment ? styles.adminComment : ''}`}
                                                        >
                                                            <div className={styles.commentHeader}>
                                                                <div className={styles.commentMeta}>
                                                                    <span className={styles.commentName}>
                                                                        {comment.commenter_name || 'User'}
                                                                    </span>
                                                                    <span className={styles.commentRole}>
                                                                        {comment.commenter_role || '-'}
                                                                    </span>
                                                                    {isAdminComment && (
                                                                        <span className={styles.adminBadge}>Admin</span>
                                                                    )}
                                                                    {isReply && (
                                                                        <span className={styles.commentBadge}>Reply</span>
                                                                    )}
                                                                </div>
                                                                <span className={styles.commentDate}>
                                                                    {comment.created_at
                                                                        ? new Date(comment.created_at).toLocaleString()
                                                                        : '-'}
                                                                </span>
                                                            </div>
                                                            <div className={styles.commentText}>{comment.comment_text}</div>
                                                            <div className={styles.commentActionsRow}>
                                                                <button
                                                                    type="button"
                                                                    className={styles.commentActionButton}
                                                                    onClick={() => setReplyTarget(comment)}
                                                                >
                                                                    Reply
                                                                </button>
                                                                {isAdmin && (
                                                                    <button
                                                                        type="button"
                                                                        className={styles.commentDeleteButton}
                                                                        onClick={() => void handleDeleteComment(comment)}
                                                                    >
                                                                        Delete
                                                                    </button>
                                                                )}
                                                            </div>
                                                        </div>
                                                    );
                                                })
                                            )}
                                        </div>

                                        {canComment && (
                                            <div className={styles.commentForm}>
                                                {replyTarget && (
                                                    <div className={styles.replyBanner}>
                                                        <span>
                                                            Replying to {replyTarget.commenter_name || 'User'}:{' '}
                                                            &quot;{replyTarget.comment_text}&quot;
                                                        </span>
                                                        <button
                                                            type="button"
                                                            className={styles.replyClear}
                                                            onClick={() => setReplyTarget(null)}
                                                        >
                                                            Clear
                                                        </button>
                                                    </div>
                                                )}
                                                <textarea
                                                    className={`${styles.textarea} ${styles.commentTextarea}`}
                                                    value={commentText}
                                                    onChange={(event) => { setCommentText(event.target.value); if (commentFieldError) setCommentFieldError(''); }}
                                                    placeholder="Write a comment or reply..."
                                                    required
                                                    aria-required="true"
                                                    aria-label="Comment (required)"
                                                    aria-invalid={commentFieldError ? true : undefined}
                                                    style={commentFieldError ? { border: '2px solid #ef4444' } : undefined}
                                                />
                                                {commentFieldError && <div style={{ marginTop: 4, fontSize: 12, color: '#b91c1c' }}>{commentFieldError}</div>}
                                                <div className={styles.commentFormActions}>
                                                    <button
                                                        type="button"
                                                        className={styles.primaryButton}
                                                        onClick={() => void submitComment()}
                                                        disabled={commentSaving || !commentText.trim()}
                                                    >
                                                        {commentSaving ? 'Posting...' : 'Post Comment'}
                                                    </button>
                                                </div>
                                            </div>
                                        )}
                                    </div>
                                </>
                            )}

                            {holidayModalMode !== 'view' && (
                                <form className={styles.modalForm} onSubmit={handleSaveHoliday} noValidate>
                                    <div className={styles.formRow}>
                                        <label className={styles.formLabel} htmlFor="holiday-name">
                                            Holiday Name
                                        </label>
                                        <div className={styles.formField}>
                                            <input
                                                id="holiday-name"
                                                className={styles.input}
                                                value={holidayForm.holiday_name}
                                                onChange={(event) => handleHolidayFormChange('holiday_name', event.target.value)}
                                                required
                                                aria-required="true"
                                                aria-invalid={holidayFieldErrors.holiday_name ? true : undefined}
                                                style={holidayFieldErrors.holiday_name ? { border: '2px solid #ef4444' } : undefined}
                                            />
                                            {holidayFieldErrors.holiday_name && <div style={{ marginTop: 4, fontSize: 12, color: '#b91c1c' }}>{holidayFieldErrors.holiday_name}</div>}
                                        </div>
                                    </div>
                                    <div className={styles.formRow}>
                                        <label className={styles.formLabel} htmlFor="holiday-type">
                                            Type
                                        </label>
                                        <div className={styles.formField}>
                                            <select
                                                id="holiday-type"
                                                className={styles.select}
                                                value={holidayForm.holiday_type}
                                                onChange={(event) => handleHolidayFormChange('holiday_type', event.target.value)}
                                            >
                                                {holidayTypeOptions.map((option) => (
                                                    <option key={option} value={option}>
                                                        {option}
                                                    </option>
                                                ))}
                                            </select>
                                        </div>
                                    </div>
                                    <div className={styles.formRow}>
                                        <span className={styles.formLabel}>Scope</span>
                                        <div className={styles.formField}>
                                            <div className={styles.radioGroup}>
                                                <label className={styles.radioOption}>
                                                    <input
                                                        type="radio"
                                                        name="holiday_scope"
                                                        value="National"
                                                        checked={holidayForm.holiday_scope.trim().toLowerCase() === 'national'}
                                                        onChange={() => {
                                                            setHolidayForm((prev) => ({ ...prev, holiday_scope: 'National' }));
                                                            setScopeMode('list');
                                                            setCustomScope('');
                                                        }}
                                                    />
                                                    <span>National</span>
                                                </label>
                                                <label className={styles.radioOption}>
                                                    <input
                                                        type="radio"
                                                        name="holiday_scope"
                                                        value="Other"
                                                        checked={holidayForm.holiday_scope.trim().toLowerCase() !== 'national'}
                                                        onChange={() => {
                                                            const fallback = scopeOptions[0] || 'Other';
                                                            setHolidayForm((prev) => ({
                                                                ...prev,
                                                                holiday_scope:
                                                                    prev.holiday_scope.trim().toLowerCase() === 'national'
                                                                        ? fallback
                                                                        : prev.holiday_scope,
                                                            }));
                                                        }}
                                                    />
                                                    <span>Other</span>
                                                </label>
                                            </div>
                                            {holidayForm.holiday_scope.trim().toLowerCase() !== 'national' && (
                                                <div className={styles.scopePicker}>
                                                    <div className={styles.scopeModeToggle}>
                                                        <label className={styles.radioOption}>
                                                            <input
                                                                type="radio"
                                                                name="holiday_scope_mode"
                                                                value="list"
                                                                checked={scopeMode === 'list'}
                                                                onChange={() => {
                                                                    setScopeMode('list');
                                                                    if (!scopeOptions.includes(holidayForm.holiday_scope)) {
                                                                        handleHolidayFormChange('holiday_scope', scopeOptions[0]);
                                                                    }
                                                                }}
                                                            />
                                                            <span>Regional Source</span>
                                                        </label>
                                                        <label className={styles.radioOption}>
                                                            <input
                                                                type="radio"
                                                                name="holiday_scope_mode"
                                                                value="manual"
                                                                checked={scopeMode === 'manual'}
                                                                onChange={() => {
                                                                    setScopeMode('manual');
                                                                    if (scopeOptions.includes(holidayForm.holiday_scope) || !holidayForm.holiday_scope) {
                                                                        setCustomScope('');
                                                                        handleHolidayFormChange('holiday_scope', '');
                                                                    }
                                                                }}
                                                            />
                                                            <span>Manual input</span>
                                                        </label>
                                                    </div>
                                                    {scopeMode === 'list' ? (
                                                        <label style={{ display: 'grid', gap: 4, marginTop: 8 }}>
                                                            <span style={{ fontSize: 11, color: '#374151', fontWeight: 600 }}>Scope detail</span>
                                                            <select
                                                                className={`${styles.select} ${styles.scopeSelect}`}
                                                                style={{ marginTop: 0 }}
                                                                aria-label="Scope detail"
                                                                value={
                                                                    scopeOptions.includes(holidayForm.holiday_scope)
                                                                        ? holidayForm.holiday_scope
                                                                        : scopeOptions[0]
                                                                }
                                                                onChange={(event) => handleHolidayFormChange('holiday_scope', event.target.value)}
                                                            >
                                                                {scopeOptions.map((option) => (
                                                                    <option key={option} value={option}>
                                                                        {option}
                                                                    </option>
                                                                ))}
                                                            </select>
                                                        </label>
                                                    ) : (
                                                        <label style={{ display: 'grid', gap: 4, marginTop: 8 }}>
                                                            <span style={{ fontSize: 11, color: '#374151', fontWeight: 600 }}>Scope detail</span>
                                                            <input
                                                                className={`${styles.input} ${styles.scopeManualInput}`}
                                                                value={customScope}
                                                                onChange={(event) => {
                                                                    setCustomScope(event.target.value);
                                                                    handleHolidayFormChange('holiday_scope', event.target.value);
                                                                }}
                                                                placeholder="Enter scope"
                                                                aria-label="Scope detail"
                                                            />
                                                        </label>
                                                    )}
                                                </div>
                                            )}
                                        </div>
                                    </div>
                                    <div className={styles.formRow}>
                                        <label className={styles.formLabel} htmlFor="holiday-date">
                                            Date
                                        </label>
                                        <div className={styles.formField}>
                                            <div className={styles.dateField}>
                                                <button
                                                    type="button"
                                                    className={styles.dateIconButton}
                                                    onClick={() => openDatePicker(holidayDateInputRef)}
                                                    aria-label="Open calendar"
                                                    style={{ width: 18, height: 18, flexShrink: 0 }}
                                                >
                                                    <svg width="18" height="18" viewBox="0 0 24 24" role="presentation" aria-hidden="true" style={{ display: 'block' }}>
                                                        <path
                                                            d="M7 3a1 1 0 0 1 1 1v1h8V4a1 1 0 1 1 2 0v1h1.5A2.5 2.5 0 0 1 22 7.5v10A2.5 2.5 0 0 1 19.5 20h-15A2.5 2.5 0 0 1 2 17.5v-10A2.5 2.5 0 0 1 4.5 5H6V4a1 1 0 0 1 1-1Zm12.5 7H4.5v7.5c0 .55.45 1 1 1h14c.55 0 1-.45 1-1V10ZM4.5 7a1 1 0 0 0-1 1v.5h17V8a1 1 0 0 0-1-1H18v1a1 1 0 1 1-2 0V7H8v1a1 1 0 1 1-2 0V7H4.5Z"
                                                            fill="currentColor"
                                                        />
                                                    </svg>
                                                </button>
                                                <input
                                                    id="holiday-date"
                                                    type="date"
                                                    className={styles.dateInput}
                                                    ref={holidayDateInputRef}
                                                    value={holidayForm.holiday_date}
                                                    onChange={(event) => handleHolidayFormChange('holiday_date', event.target.value)}
                                                    required
                                                    aria-required="true"
                                                    aria-invalid={holidayFieldErrors.holiday_date ? true : undefined}
                                                    style={holidayFieldErrors.holiday_date ? { border: '2px solid #ef4444' } : undefined}
                                                />
                                                {holidayFieldErrors.holiday_date && <div style={{ marginTop: 4, fontSize: 12, color: '#b91c1c' }}>{holidayFieldErrors.holiday_date}</div>}
                                            </div>
                                        </div>
                                    </div>
                                    <div className={styles.formRow}>
                                        <label className={styles.formLabel} htmlFor="holiday-source">
                                            Source
                                        </label>
                                        <div className={styles.formField}>
                                            <select
                                                id="holiday-source"
                                                className={styles.select}
                                                value={sourceOption}
                                                onChange={(event) => {
                                                    const value = event.target.value;
                                                    setSourceOption(value);
                                                    if (value === 'Other') {
                                                        handleHolidayFormChange('source', customSource);
                                                    } else {
                                                        setCustomSource('');
                                                        handleHolidayFormChange('source', value);
                                                    }
                                                }}
                                            >
                                                {sourceOptions.map((option) => (
                                                    <option key={option} value={option}>
                                                        {option}
                                                    </option>
                                                ))}
                                            </select>
                                            {sourceOption === 'Other' && (
                                                <label style={{ display: 'grid', gap: 4, marginTop: 8 }}>
                                                    <span style={{ fontSize: 11, color: '#374151', fontWeight: 600 }}>Source detail</span>
                                                    <input
                                                        className={`${styles.input} ${styles.sourceOtherInput}`}
                                                        value={customSource}
                                                        onChange={(event) => {
                                                            setCustomSource(event.target.value);
                                                            handleHolidayFormChange('source', event.target.value);
                                                        }}
                                                        placeholder="Enter source"
                                                        aria-label="Source detail"
                                                    />
                                                </label>
                                            )}
                                        </div>
                                    </div>
                                    <div className={`${styles.formRow} ${styles.formRowTop}`}>
                                        <label className={styles.formLabel} htmlFor="holiday-notes">
                                            Notes
                                        </label>
                                        <div className={styles.formField}>
                                            <textarea
                                                id="holiday-notes"
                                                className={styles.textarea}
                                                value={holidayForm.description}
                                                onChange={(event) => handleHolidayFormChange('description', event.target.value)}
                                            />
                                        </div>
                                    </div>
                                    <div className={`${styles.modalActions} ${styles.formActions}`}>
                                        <button
                                            type="button"
                                            className={styles.ghostButton}
                                            onClick={closeHolidayModal}
                                            disabled={savingHoliday}
                                        >
                                            Cancel
                                        </button>
                                        <button
                                            type="submit"
                                            className={`${styles.primaryButton} ${styles.modalPrimary}`}
                                            disabled={savingHoliday}
                                        >
                                            {savingHoliday
                                                ? holidayModalMode === 'create'
                                                    ? 'Adding...'
                                                    : 'Saving...'
                                                : holidayModalMode === 'create'
                                                  ? 'Add Holiday'
                                                  : 'Save Holiday'}
                                        </button>
                                    </div>
                                </form>
                            )}
                        </div>
                    </div>
                )}
            </div>
        </Layout>
    );
}
