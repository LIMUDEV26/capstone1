import { useState, useEffect, useRef, useCallback, type ChangeEvent } from 'react';
import { useRouter } from 'next/router';
import Pagination from '../../components/Pagination';
import CrudActionIcon from '../../components/CrudActionIcon';
import SettingsLayout from '../../components/SettingsLayout';
import TinyReloadButton from '../../components/TinyReloadButton';
import { SettingsPageHeader } from '../../components/SettingsPageShell';
import { useAdminSettingsPage } from '../../components/useAdminSettingsPage';
import { confirmAction, notifyError, notifySuccess } from '@/utils/notify';
import { getApiBaseUrl } from '@/utils/network';
import { usePaginationSetting } from '@/utils/usePaginationSetting';

const API_BASE = getApiBaseUrl();

interface BackupFile {
    filename: string;
    size: number;
    created_at: string;
    status: 'active' | 'archived';
    archived_at?: string | null;
}

const backupMenuItemStyle = {
    width: '100%', border: 0, background: 'transparent', color: '#334155',
    borderRadius: 8, padding: '9px 10px', cursor: 'pointer', fontSize: 12,
    fontWeight: 650, display: 'flex', alignItems: 'center', gap: 9, textAlign: 'left' as const,
};

const MANILA_TIMEZONE = 'Asia/Manila';
const AUTO_BACKUP_TRIGGER_STORAGE_PREFIX = 'llb_auto_backup_last_trigger';
const BACKUP_DIRECTORY_DB = 'llb-backup-directory';
const BACKUP_DIRECTORY_STORE = 'handles';
const BACKUP_DIRECTORY_KEY = 'automatic-backup-folder';

type WritableDirectoryHandle = FileSystemDirectoryHandle & {
    queryPermission: (options: { mode: 'readwrite' }) => Promise<PermissionState>;
    requestPermission: (options: { mode: 'readwrite' }) => Promise<PermissionState>;
};

function openBackupDirectoryDb() {
    return new Promise<IDBDatabase>((resolve, reject) => {
        const request = indexedDB.open(BACKUP_DIRECTORY_DB, 1);
        request.onupgradeneeded = () => {
            if (!request.result.objectStoreNames.contains(BACKUP_DIRECTORY_STORE)) {
                request.result.createObjectStore(BACKUP_DIRECTORY_STORE);
            }
        };
        request.onsuccess = () => resolve(request.result);
        request.onerror = () => reject(request.error);
    });
}

async function storeBackupDirectoryHandle(handle: WritableDirectoryHandle | null) {
    const db = await openBackupDirectoryDb();
    await new Promise<void>((resolve, reject) => {
        const transaction = db.transaction(BACKUP_DIRECTORY_STORE, 'readwrite');
        const store = transaction.objectStore(BACKUP_DIRECTORY_STORE);
        if (handle) store.put(handle, BACKUP_DIRECTORY_KEY);
        else store.delete(BACKUP_DIRECTORY_KEY);
        transaction.oncomplete = () => resolve();
        transaction.onerror = () => reject(transaction.error);
    });
    db.close();
}

async function loadBackupDirectoryHandle() {
    const db = await openBackupDirectoryDb();
    const handle = await new Promise<WritableDirectoryHandle | null>((resolve, reject) => {
        const request = db.transaction(BACKUP_DIRECTORY_STORE, 'readonly')
            .objectStore(BACKUP_DIRECTORY_STORE)
            .get(BACKUP_DIRECTORY_KEY);
        request.onsuccess = () => resolve((request.result as WritableDirectoryHandle | undefined) || null);
        request.onerror = () => reject(request.error);
    });
    db.close();
    return handle;
}

const WEEKDAY_INDEX: Record<string, number> = {
    Sun: 0,
    Mon: 1,
    Tue: 2,
    Wed: 3,
    Thu: 4,
    Fri: 5,
    Sat: 6,
};

function getManilaTimeParts() {
    const formatter = new Intl.DateTimeFormat('en-US', {
        timeZone: MANILA_TIMEZONE,
        year: 'numeric',
        month: '2-digit',
        day: '2-digit',
        hour: '2-digit',
        minute: '2-digit',
        hourCycle: 'h23',
        weekday: 'short',
    });

    const parts = formatter.formatToParts(new Date());
    const pick = (type: Intl.DateTimeFormatPartTypes) => parts.find((part) => part.type === type)?.value ?? '';

    const year = Number(pick('year') || 0);
    const month = Number(pick('month') || 0);
    const day = Number(pick('day') || 0);
    const hour = pick('hour') || '00';
    const minute = pick('minute') || '00';
    const weekdayShort = pick('weekday');
    const weekday = WEEKDAY_INDEX[weekdayShort] ?? -1;

    return {
        year,
        month,
        day,
        hour,
        minute,
        weekday,
        slotKey: `${year}-${String(month).padStart(2, '0')}-${String(day).padStart(2, '0')} ${hour}:${minute}`,
    };
}

export default function SystemBackup() {
    const router = useRouter();
    const embedded = true;
    const ITEMS_PER_PAGE = usePaginationSetting();
    const { user, loading: authLoading, logout } = useAdminSettingsPage();
    const [pageLoading, setPageLoading] = useState(true);

    // Backup state
    const [backups, setBackups] = useState<BackupFile[]>([]);
    const [creating, setCreating] = useState(false);
    const [archiving, setArchiving] = useState<string | null>(null);
    const [historyFilter, setHistoryFilter] = useState<'active' | 'archived' | 'all'>('active');
    const [historyFiltersOpen, setHistoryFiltersOpen] = useState(false);
    const [importFile, setImportFile] = useState<File | null>(null);
    const [importingUpload, setImportingUpload] = useState(false);
    const [restoringBackup, setRestoringBackup] = useState<string | null>(null);
    const [isManualBackupOpen, setIsManualBackupOpen] = useState(false);
    const [msg, setMsg] = useState<string | null>(null);
    const [err, setErr] = useState<string | null>(null);
    const [currentPage, setCurrentPage] = useState(1);
    const [listReloading, setListReloading] = useState(false);
    const [actionMenu, setActionMenu] = useState<{ backup: BackupFile; top: number; right: number } | null>(null);

    // Schedule state
    const [frequency, setFrequency] = useState('off');
    const [backupTime, setBackupTime] = useState('02:00');
    const [dayOfWeek, setDayOfWeek] = useState('0');
    const [dayOfMonth, setDayOfMonth] = useState('1');
    const [autoSavePath, setAutoSavePath] = useState('');
    const [defaultBackupPath, setDefaultBackupPath] = useState('');
    const [deviceDirectoryHandle, setDeviceDirectoryHandle] = useState<WritableDirectoryHandle | null>(null);
    const [deviceFolderName, setDeviceFolderName] = useState('');
    const [choosingFolder, setChoosingFolder] = useState(false);
    const [savingSchedule, setSavingSchedule] = useState(false);
    const [scheduleMsg, setScheduleMsg] = useState<string | null>(null);
    const [scheduleErr, setScheduleErr] = useState<string | null>(null);
    // Inline "Required" message under the backup time field.
    const [scheduleTimeError, setScheduleTimeError] = useState('');
    const [retentionCount, setRetentionCount] = useState('10');
    const [archiveRetentionDays, setArchiveRetentionDays] = useState('180');
    const [activeStorageCount, setActiveStorageCount] = useState(0);
    const [activeStorageBytes, setActiveStorageBytes] = useState(0);
    const [archiveStorageCount, setArchiveStorageCount] = useState(0);
    const [archiveStorageBytes, setArchiveStorageBytes] = useState(0);
    const [archiveStoragePath, setArchiveStoragePath] = useState('');
    const [savingDeletionPolicy, setSavingDeletionPolicy] = useState(false);
    const [runningCleanup, setRunningCleanup] = useState(false);
    const autoBackupRunningRef = useRef(false);
    const importInputRef = useRef<HTMLInputElement | null>(null);

    useEffect(() => {
        if (!msg) return;
        void notifySuccess(msg);
        setMsg(null);
    }, [msg]);

    useEffect(() => {
        if (!err) return;
        void notifyError(err);
        setErr(null);
    }, [err]);

    useEffect(() => {
        if (!scheduleMsg) return;
        void notifySuccess(scheduleMsg);
        setScheduleMsg(null);
    }, [scheduleMsg]);

    useEffect(() => {
        if (!scheduleErr) return;
        void notifyError(scheduleErr);
        setScheduleErr(null);
    }, [scheduleErr]);

    useEffect(() => {
        if (typeof window === 'undefined' || !('indexedDB' in window)) return;
        let active = true;
        void loadBackupDirectoryHandle()
            .then((handle) => {
                if (!active || !handle) return;
                setDeviceDirectoryHandle(handle);
                setDeviceFolderName(handle.name);
            })
            .catch(() => {
                // Folder access is optional; typed server paths still work.
            });
        return () => {
            active = false;
        };
    }, []);

    useEffect(() => {
        if (!isManualBackupOpen) return;

        const handleKeyDown = (event: KeyboardEvent) => {
            if (event.key === 'Escape') {
                setIsManualBackupOpen(false);
            }
        };

        const originalOverflow = document.body.style.overflow;
        document.body.style.overflow = 'hidden';
        window.addEventListener('keydown', handleKeyDown);

        return () => {
            document.body.style.overflow = originalOverflow;
            window.removeEventListener('keydown', handleKeyDown);
        };
    }, [isManualBackupOpen]);

    const fetchBackups = useCallback(async () => {
        try {
            const res = await fetch(`${API_BASE}/backup.php?action=list`, { credentials: 'include' });
            const data = await res.json();
            if (data.success) setBackups(data.data || []);
        } catch (e) { console.error(e); }
    }, []);

    const fetchSchedule = useCallback(async () => {
        try {
            const res = await fetch(`${API_BASE}/backup.php?action=get_schedule`, { credentials: 'include', cache: 'no-store' });
            const data = await res.json();
            if (data.success && data.data) {
                setFrequency(data.data.backup_frequency || 'off');
                setBackupTime(data.data.backup_time || '02:00');
                setDayOfWeek(data.data.backup_day_of_week || '0');
                setDayOfMonth(data.data.backup_day_of_month || '1');
                setAutoSavePath(data.data.backup_auto_save_path || '');
                setDefaultBackupPath(data.data.backup_default_path || '');
            }
        } catch (e) { console.error(e); }
    }, []);

    const fetchDeletionPolicy = useCallback(async () => {
        try {
            const res = await fetch(`${API_BASE}/backup.php?action=get_deletion_policy`, { credentials: 'include', cache: 'no-store' });
            const data = await res.json();
            if (data.success && data.data) {
                setRetentionCount(String(data.data.retention_count ?? 10));
                setArchiveRetentionDays(String(data.data.archive_retention_days ?? 180));
                setActiveStorageCount(Number(data.data.active_count || 0));
                setActiveStorageBytes(Number(data.data.active_bytes || 0));
                setArchiveStorageCount(Number(data.data.archive_count || 0));
                setArchiveStorageBytes(Number(data.data.archive_bytes || 0));
                setArchiveStoragePath(String(data.data.archive_path || ''));
            }
        } catch (e) { console.error(e); }
    }, []);

    const handleReloadList = async () => {
        setListReloading(true);
        try {
            await Promise.all([fetchBackups(), fetchSchedule(), fetchDeletionPolicy()]);
        } finally {
            setListReloading(false);
        }
    };

    // Render the page shell immediately after auth resolves; data loads in
    // the background. Never trap on full-page "Loading..." for data fetch.
    const userId = user?.id;
    useEffect(() => {
        if (authLoading) return;
        if (!userId) {
            setPageLoading(false);
            return;
        }

        let active = true;
        const loadPage = async () => {
            try {
            await Promise.all([fetchBackups(), fetchSchedule(), fetchDeletionPolicy()]);
            } finally {
                if (active) {
                    setPageLoading(false);
                }
            }
        };

        void loadPage();
        return () => {
            active = false;
        };
    }, [authLoading, fetchBackups, fetchDeletionPolicy, fetchSchedule, userId]);

    const handleCreateBackup = async () => {
        setCreating(true);
        setMsg(null);
        setErr(null);
        try {
            const res = await fetch(`${API_BASE}/backup.php?action=create`, {
                method: 'POST',
                credentials: 'include',
            });
            const data = await res.json();
            if (data.success) {
                setMsg(`Backup created: ${data.data.filename}`);
                setBackups(prev => [{ ...data.data, status: 'active' }, ...prev]);
                await fetchDeletionPolicy();
                closeManualBackupDialog();
            } else {
                setErr(data.message || 'Failed to create backup.');
            }
        } catch {
            setErr('Network error.');
        } finally {
            setCreating(false);
        }
    };

    const clearImportFileSelection = () => {
        setImportFile(null);
        if (importInputRef.current) {
            importInputRef.current.value = '';
        }
    };

    const closeManualBackupDialog = () => {
        setIsManualBackupOpen(false);
        clearImportFileSelection();
    };

    const handleImportFileChange = (event: ChangeEvent<HTMLInputElement>) => {
        const file = event.target.files?.[0] || null;
        setImportFile(file);
    };

    const handleImportUpload = async () => {
        if (!importFile) {
            setErr('Please choose a .sql backup file to import.');
            return;
        }

        if (!(await confirmAction({
            title: `Import backup "${importFile.name}"?`,
            text: 'This will overwrite current database tables and data.',
            confirmButtonText: 'Import Backup',
            icon: 'warning',
            danger: true,
        }))) return;

        setImportingUpload(true);
        setErr(null);
        setMsg(null);

        try {
            const formData = new FormData();
            formData.append('backup_file', importFile);

            const res = await fetch(`${API_BASE}/backup.php?action=import`, {
                method: 'POST',
                credentials: 'include',
                body: formData,
            });
            const data = await res.json();

            if (data.success) {
                setMsg(`Backup imported: ${data.data?.source || importFile.name}`);
                await fetchBackups();
                closeManualBackupDialog();
            } else {
                setErr(data.message || 'Failed to import backup.');
            }
        } catch {
            setErr('Network error.');
        } finally {
            setImportingUpload(false);
        }
    };

    const handleRestoreBackup = async (filename: string, status: BackupFile['status']) => {
        if (!(await confirmAction({
            title: `Restore backup "${filename}"?`,
            text: 'This will overwrite current database tables and data.',
            confirmButtonText: 'Restore Backup',
            icon: 'warning',
            danger: true,
        }))) return;

        setRestoringBackup(filename);
        setErr(null);
        setMsg(null);

        try {
            const res = await fetch(`${API_BASE}/backup.php?action=import`, {
                method: 'POST',
                headers: { 'Content-Type': 'application/json' },
                credentials: 'include',
                body: JSON.stringify({ filename, status }),
            });
            const data = await res.json();

            if (data.success) {
                setMsg(`Backup restored: ${filename}`);
            } else {
                setErr(data.message || 'Failed to restore backup.');
            }
        } catch {
            setErr('Network error.');
        } finally {
            setRestoringBackup(null);
        }
    };

    const handleArchive = async (backup: BackupFile, unarchive = false) => {
        const verb = unarchive ? 'return this backup to active history' : 'archive this backup';
        if (!(await confirmAction({
            title: `${unarchive ? 'Unarchive' : 'Archive'} backup "${backup.filename}"?`,
            text: `This will ${verb}.`,
            confirmButtonText: unarchive ? 'Unarchive' : 'Archive',
            icon: 'question',
        }))) return;
        setArchiving(backup.filename);
        try {
            const res = await fetch(`${API_BASE}/backup.php?action=${unarchive ? 'unarchive' : 'archive'}`, {
                method: 'POST',
                headers: { 'Content-Type': 'application/json' },
                credentials: 'include',
                body: JSON.stringify({ filename: backup.filename }),
            });
            const data = await res.json();
            if (!data.success) throw new Error(data.message || 'Backup archive action failed.');
            await Promise.all([fetchBackups(), fetchDeletionPolicy()]);
            setMsg(unarchive ? 'Backup returned to active history.' : 'Backup archived.');
        } catch (error) {
            setErr(error instanceof Error ? error.message : 'Backup archive action failed.');
        } finally {
            setArchiving(null);
        }
    };

    const fetchBackupBlob = async (filename: string, status: BackupFile['status'] = 'active') => {
        const res = await fetch(`${API_BASE}/backup.php?action=download&file=${encodeURIComponent(filename)}&status=${status}`, {
            method: 'GET',
            credentials: 'include',
        });
        if (!res.ok) {
            throw new Error(`Download failed (${res.status})`);
        }

        return res.blob();
    };

    const downloadBackupFile = async (filename: string, status: BackupFile['status'] = 'active') => {
        const blob = await fetchBackupBlob(filename, status);
        const legacyNavigator = navigator as Navigator & { msSaveOrOpenBlob?: (value: Blob, name?: string) => boolean };
        if (legacyNavigator.msSaveOrOpenBlob) {
            legacyNavigator.msSaveOrOpenBlob(blob, filename);
            return;
        }
        const blobUrl = URL.createObjectURL(blob);
        const a = document.createElement('a');
        a.href = blobUrl;
        a.download = filename;
        a.rel = 'noopener';
        a.style.display = 'none';
        document.body.appendChild(a);
        a.click();
        // Safari and Firefox may start consuming the object URL after click()
        // returns. Delayed cleanup keeps the download valid in those browsers.
        window.setTimeout(() => {
            a.remove();
            URL.revokeObjectURL(blobUrl);
        }, 60_000);
    };

    const clearDeviceFolder = async () => {
        setDeviceDirectoryHandle(null);
        setDeviceFolderName('');
        if (typeof window !== 'undefined' && 'indexedDB' in window) {
            try {
                await storeBackupDirectoryHandle(null);
            } catch {
                // The server-path fallback remains available.
            }
        }
    };

    const handleChooseDeviceFolder = async () => {
        setChoosingFolder(true);
        setScheduleErr(null);
        try {
            if (window.capstoneDesktop?.chooseBackupFolder) {
                const selection = await window.capstoneDesktop.chooseBackupFolder();
                if (selection.canceled || !selection.path) return;
                await clearDeviceFolder();
                setAutoSavePath(selection.path);
                setScheduleMsg(`Selected device folder: ${selection.path}`);
                return;
            }

            if (window.showDirectoryPicker) {
                const handle = await window.showDirectoryPicker({ mode: 'readwrite' }) as WritableDirectoryHandle;
                const permission = await handle.requestPermission({ mode: 'readwrite' });
                if (permission !== 'granted') {
                    throw new Error('Write access to the selected folder was not granted.');
                }
                await storeBackupDirectoryHandle(handle);
                setDeviceDirectoryHandle(handle);
                setDeviceFolderName(handle.name);
                setAutoSavePath('');
                setScheduleMsg(`Selected device folder: ${handle.name}`);
                return;
            }

            throw new Error('This browser cannot write automatic backups to a selected device folder. Use Chrome, Edge, or the desktop app for direct folder saving.');
        } catch (error) {
            if (error instanceof DOMException && error.name === 'AbortError') return;
            setScheduleErr(error instanceof Error ? error.message : 'Could not select the device folder.');
        } finally {
            setChoosingFolder(false);
        }
    };

    const writeBackupToDeviceFolder = async (filename: string) => {
        if (!deviceDirectoryHandle) return '';
        let permission = await deviceDirectoryHandle.queryPermission({ mode: 'readwrite' });
        if (permission !== 'granted') {
            permission = await deviceDirectoryHandle.requestPermission({ mode: 'readwrite' });
        }
        if (permission !== 'granted') {
            throw new Error('Automatic backup needs write permission for the selected device folder. Choose the folder again.');
        }

        const blob = await fetchBackupBlob(filename);
        const fileHandle = await deviceDirectoryHandle.getFileHandle(filename, { create: true });
        const writable = await fileHandle.createWritable();
        await writable.write(blob);
        await writable.close();
        return `${deviceFolderName || deviceDirectoryHandle.name}/${filename}`;
    };

    const handleDownload = async (filename: string, status: BackupFile['status']) => {
        try {
            await downloadBackupFile(filename, status);
        } catch {
            setErr('Failed to download backup file.');
        }
    };

    const handleSaveSchedule = async () => {
        if (frequency !== 'off' && !backupTime) {
            setScheduleTimeError('Required.');
            return;
        }
        setScheduleTimeError('');
        setSavingSchedule(true);
        setScheduleMsg(null);
        setScheduleErr(null);
        try {
            const res = await fetch(`${API_BASE}/backup.php?action=set_schedule`, {
                method: 'POST',
                headers: { 'Content-Type': 'application/json' },
                credentials: 'include',
                body: JSON.stringify({
                    backup_frequency: frequency,
                    backup_time: backupTime,
                    backup_day_of_week: dayOfWeek,
                    backup_day_of_month: dayOfMonth,
                    backup_auto_save_path: deviceDirectoryHandle ? '' : autoSavePath.trim(),
                }),
            });
            const data = await res.json();
            if (data.success) {
                await fetchSchedule();
                setScheduleMsg('Schedule saved successfully.');
            } else {
                setScheduleErr(data.message || 'Failed to save schedule.');
            }
        } catch {
            setScheduleErr('Network error.');
        } finally {
            setSavingSchedule(false);
        }
    };

    const handleSaveDeletionPolicy = async () => {
        const keep = Number(retentionCount);
        const days = Number(archiveRetentionDays);
        if (!Number.isInteger(keep) || keep < 1 || keep > 500 || !Number.isInteger(days) || days < 0 || days > 3650) {
            setErr('Keep active backups must be 1–500, and archive deletion days must be 0–3650.');
            return;
        }
        setSavingDeletionPolicy(true);
        try {
            const res = await fetch(`${API_BASE}/backup.php?action=set_deletion_policy`, {
                method: 'POST',
                headers: { 'Content-Type': 'application/json' },
                credentials: 'include',
                body: JSON.stringify({ retention_count: keep, archive_retention_days: days }),
            });
            const data = await res.json();
            if (!data.success) throw new Error(data.message || 'Failed to save data deletion controls.');
            setMsg('Data deletion controls saved.');
        } catch (error) {
            setErr(error instanceof Error ? error.message : 'Failed to save data deletion controls.');
        } finally {
            setSavingDeletionPolicy(false);
        }
    };

    const handleRunCleanup = async () => {
        if (!(await confirmAction({
            title: 'Run backup cleanup now?',
            text: 'Excess active backups will be archived. Archived backups older than the configured period will be permanently deleted.',
            confirmButtonText: 'Run Cleanup',
            icon: 'warning',
            danger: true,
        }))) return;
        setRunningCleanup(true);
        try {
            const res = await fetch(`${API_BASE}/backup.php?action=cleanup`, { method: 'POST', credentials: 'include' });
            const data = await res.json();
            if (!data.success) throw new Error(data.message || 'Backup cleanup failed.');
            await Promise.all([fetchBackups(), fetchDeletionPolicy()]);
            setMsg(`Cleanup complete: ${data.data?.archived || 0} archived, ${data.data?.deleted || 0} permanently deleted.`);
        } catch (error) {
            setErr(error instanceof Error ? error.message : 'Backup cleanup failed.');
        } finally {
            setRunningCleanup(false);
        }
    };

    const userRole = user?.role;
    useEffect(() => {
        if (authLoading || pageLoading) return;
        if (frequency === 'off') return;
        if (!userId || userRole !== 'admin') return;

        const scheduleSignature = [frequency, backupTime, dayOfWeek, dayOfMonth, autoSavePath.trim(), deviceFolderName].join('|');
        const storageKey = `${AUTO_BACKUP_TRIGGER_STORAGE_PREFIX}:${scheduleSignature}`;

        const isDueNow = () => {
            const now = getManilaTimeParts();
            const nowTime = `${now.hour}:${now.minute}`;
            if (nowTime !== backupTime) return { due: false, slotKey: now.slotKey };

            if (frequency === 'daily') return { due: true, slotKey: now.slotKey };
            if (frequency === 'weekly') {
                return { due: now.weekday === Number(dayOfWeek), slotKey: now.slotKey };
            }
            if (frequency === 'monthly') {
                return { due: now.day === Number(dayOfMonth), slotKey: now.slotKey };
            }
            return { due: false, slotKey: now.slotKey };
        };

        const runAutomaticBackupIfDue = async () => {
            if (autoBackupRunningRef.current) return;

            const due = isDueNow();
            if (!due.due) return;

            let lastTriggered = '';
            try {
                lastTriggered = localStorage.getItem(storageKey) || '';
            } catch {
                lastTriggered = '';
            }
            if (lastTriggered === due.slotKey) {
                return;
            }

            autoBackupRunningRef.current = true;
            try {
                const res = await fetch(`${API_BASE}/backup.php?action=create`, {
                    method: 'POST',
                    headers: { 'Content-Type': 'application/json' },
                    credentials: 'include',
                    body: JSON.stringify({ automatic: !deviceDirectoryHandle }),
                });
                const data = await res.json();
                if (!data.success) {
                    throw new Error(data.message || 'Automatic backup failed.');
                }

                const filename = String(data?.data?.filename || '');
                if (!filename) {
                    throw new Error('Automatic backup created without filename.');
                }

                const deviceSavedPath = deviceDirectoryHandle
                    ? await writeBackupToDeviceFolder(filename)
                    : '';
                if (!deviceDirectoryHandle) {
                    await downloadBackupFile(filename);
                }
                await fetchBackups();
                const savedPath = deviceSavedPath || String(data?.data?.saved_path || filename);
                setMsg(deviceSavedPath
                    ? `Automatic backup saved: ${savedPath}`
                    : `Automatic backup created and downloaded: ${filename}`);
                try {
                    localStorage.setItem(storageKey, due.slotKey);
                } catch {
                    // Non-fatal if local storage is unavailable.
                }
            } catch (e) {
                const message = e instanceof Error ? e.message : 'Automatic backup failed.';
                setErr(message);
            } finally {
                autoBackupRunningRef.current = false;
            }
        };

        void runAutomaticBackupIfDue();
        const timer = window.setInterval(() => {
            void runAutomaticBackupIfDue();
        }, 15000);

        return () => {
            window.clearInterval(timer);
        };
    }, [authLoading, autoSavePath, backupTime, dayOfMonth, dayOfWeek, deviceDirectoryHandle, deviceFolderName, fetchBackups, frequency, pageLoading, userId, userRole]);

    const formatSize = (bytes: number) => {
        if (bytes < 1024) return bytes + ' B';
        if (bytes < 1024 * 1024) return (bytes / 1024).toFixed(1) + ' KB';
        return (bytes / (1024 * 1024)).toFixed(2) + ' MB';
    };

    const weekDays = ['Sunday', 'Monday', 'Tuesday', 'Wednesday', 'Thursday', 'Friday', 'Saturday'];
    const filteredBackups = historyFilter === 'all' ? backups : backups.filter((backup) => backup.status === historyFilter);
    const paginatedBackups = filteredBackups.slice((currentPage - 1) * ITEMS_PER_PAGE, currentPage * ITEMS_PER_PAGE);

    useEffect(() => {
        const totalPages = Math.max(1, Math.ceil(filteredBackups.length / ITEMS_PER_PAGE));
        if (currentPage > totalPages) setCurrentPage(totalPages);
    }, [currentPage, filteredBackups.length]);

    useEffect(() => {
        setCurrentPage(1);
    }, [historyFilter]);

    if (authLoading) {
        return (
            <SettingsLayout activeSection="system-backup" user={user} onLogout={logout}>
                <div style={{ padding: 20 }}>Loading...</div>
            </SettingsLayout>
        );
    }

    return (
        <SettingsLayout activeSection="system-backup" user={user} onLogout={logout}>
            {pageLoading && <div style={{ padding: '8px 0', fontSize: 12, color: '#6b7280' }}>Loading settings...</div>}
            <SettingsPageHeader
                embedded={embedded}
                title="System Backup"
                onBack={() => router.push('/settings')}
                actions={(
                    <div style={{ display: 'inline-flex', alignItems: 'center', gap: 8 }}>
                        <TinyReloadButton onClick={handleReloadList} loading={listReloading} title="Reload backups" />
                        <button
                            type="button"
                            onClick={() => setIsManualBackupOpen(true)}
                            style={{
                                background: 'transparent',
                                color: '#1e3a8a',
                                border: 'none',
                                padding: '4px 0',
                                cursor: 'pointer',
                                fontWeight: 700,
                                fontSize: 13,
                                display: 'inline-flex',
                                alignItems: 'center',
                                gap: 6,
                                textDecoration: 'underline',
                            }}
                        >
                            Manual Backup
                        </button>
                    </div>
                )}
            />

            {isManualBackupOpen ? (
                <div
                    role="presentation"
                    onClick={closeManualBackupDialog}
                    style={{
                        position: 'fixed',
                        inset: 0,
                        background: 'rgba(15, 23, 42, 0.5)',
                        zIndex: 1200,
                        display: 'flex',
                        alignItems: 'center',
                        justifyContent: 'center',
                        padding: 16,
                    }}
                >
                    <div
                        role="dialog"
                        aria-modal="true"
                        aria-label="Manual Backup"
                        onClick={(event) => event.stopPropagation()}
                        style={{
                            width: '100%',
                            maxWidth: 560,
                            background: '#fff',
                            borderRadius: 'var(--modal-radius)',
                            border: '1px solid #e5e7eb',
                            boxShadow: '0 20px 45px rgba(15, 23, 42, 0.25)',
                            overflow: 'hidden',
                        }}
                    >
                        <div style={{ padding: '16px 18px', borderBottom: '1px solid #e5e7eb', display: 'flex', alignItems: 'center', justifyContent: 'space-between', gap: 12 }}>
                            <div>
                                <h2 style={{ margin: 0, fontSize: 13, fontWeight: 700, color: '#111827' }}>Manual Backup</h2>
                                <p style={{ margin: '4px 0 0', fontSize: 11, color: '#6b7280' }}>Create a backup or upload a `.sql` file to import.</p>
                            </div>
                            <button
                                type="button"
                                onClick={closeManualBackupDialog}
                                aria-label="Close manual backup modal"
                                style={{
                                    border: '1px solid #d1d5db',
                                    background: '#fff',
                                    color: '#374151',
                                    width: 30,
                                    height: 30,
                                    borderRadius: 8,
                                    cursor: 'pointer',
                                    fontWeight: 700,
                                    fontSize: 14,
                                    lineHeight: 1,
                                }}
                            >
                                x
                            </button>
                        </div>
                        <div style={{ padding: 18, display: 'grid', gap: 8 }}>
                            <div style={{ border: '1px solid #e5e7eb', borderRadius: 10, padding: 14, display: 'flex', alignItems: 'center', justifyContent: 'space-between', gap: 12, flexWrap: 'wrap' }}>
                                <div style={{ minWidth: 220 }}>
                                    <div style={{ fontSize: 13, fontWeight: 700, color: '#111827' }}>Create Backup</div>
                                    <div style={{ marginTop: 4, fontSize: 12, color: '#6b7280' }}>Generate and store a new SQL backup now.</div>
                                </div>
                                <button
                                    onClick={handleCreateBackup}
                                    disabled={creating || importingUpload || restoringBackup !== null}
                                    style={{
                                        background: 'transparent',
                                        color: '#1e3a8a',
                                        border: 'none',
                                        padding: '4px 0',
                                        cursor: creating || importingUpload || restoringBackup !== null ? 'not-allowed' : 'pointer',
                                        fontWeight: 700,
                                        fontSize: 13,
                                        display: 'inline-flex',
                                        alignItems: 'center',
                                        gap: 8,
                                        opacity: creating || importingUpload || restoringBackup !== null ? 0.5 : 1,
                                        textDecoration: 'underline',
                                    }}
                                >
                                    {creating ? (
                                        <>
                                            <span style={{
                                                display: 'inline-block', width: 15, height: 15, border: '2px solid rgba(255,255,255,0.35)',
                                                borderTopColor: '#fff', borderRadius: '50%', animation: 'spin 0.8s linear infinite',
                                            }} />
                                            Creating...
                                        </>
                                    ) : (
                                        <>
                                            Backup Now
                                        </>
                                    )}
                                </button>
                            </div>

                            <div style={{ border: '1px solid #e5e7eb', borderRadius: 10, padding: 14, display: 'grid', gap: 8 }}>
                                <div style={{ fontSize: 13, fontWeight: 700, color: '#111827' }}>Import Backup</div>
                                <div style={{ fontSize: 12, color: '#6b7280' }}>Upload a `.sql` backup file to restore database tables and data.</div>
                                <input
                                    ref={importInputRef}
                                    type="file"
                                    accept=".sql"
                                    onChange={handleImportFileChange}
                                    disabled={importingUpload || creating}
                                    required
                                    aria-required="true"
                                    aria-label="Backup SQL file (required)"
                                    style={{ fontSize: 13, color: '#111827' }}
                                />
                                <div style={{ fontSize: 12, color: '#6b7280' }}>
                                    {importFile ? `Selected: ${importFile.name}` : 'No file selected.'}
                                </div>
                                <div style={{ display: 'flex', justifyContent: 'flex-end' }}>
                                    <button
                                        onClick={handleImportUpload}
                                        disabled={importingUpload || creating || restoringBackup !== null || !importFile}
                                        style={{
                                            background: '#b45309',
                                            color: '#fff',
                                            border: 'none',
                                            padding: '9px 14px',
                                            borderRadius: 8,
                                            cursor: importingUpload || creating || restoringBackup !== null || !importFile ? 'not-allowed' : 'pointer',
                                            fontWeight: 700,
                                            fontSize: 13,
                                            display: 'inline-flex',
                                            alignItems: 'center',
                                            gap: 8,
                                            opacity: importingUpload || creating || restoringBackup !== null || !importFile ? 0.7 : 1,
                                        }}
                                    >
                                        {importingUpload ? 'Importing...' : <><CrudActionIcon action="restore" /> Import Backup</>}
                                    </button>
                                </div>
                            </div>
                        </div>
                    </div>
                </div>
            ) : null}

            {/* ---- Storage Overview ---- */}
            <section className="settings-data-section" style={{ background: '#fff', border: '1px solid #dbe4f0', borderRadius: 6, padding: 16, marginBottom: 12 }}>
                <div style={{ display: 'grid', gridTemplateColumns: 'minmax(240px, 1.45fr) repeat(2, minmax(130px, 0.7fr))', gap: 0, alignItems: 'stretch' }}>
                    <div style={{ padding: '2px 20px 2px 0', borderRight: '1px solid #e5e7eb' }}>
                        <div style={{ color: '#64748b', fontSize: 11, fontWeight: 700, letterSpacing: '0.06em', textTransform: 'uppercase' }}>Archive storage used</div>
                        <div style={{ marginTop: 5, color: '#0f172a', fontSize: 30, lineHeight: 1, fontWeight: 750, fontVariantNumeric: 'tabular-nums' }}>
                            {formatSize(archiveStorageBytes)}
                        </div>
                        <div style={{ marginTop: 9, color: '#64748b', fontSize: 11, fontFamily: 'Consolas, "Courier New", monospace', overflowWrap: 'anywhere' }}>
                            {archiveStoragePath || 'Archive path unavailable'}
                        </div>
                    </div>
                    <div style={{ padding: '2px 18px', borderRight: '1px solid #e5e7eb' }}>
                        <div style={{ color: '#64748b', fontSize: 11, fontWeight: 650 }}>Archived files</div>
                        <div style={{ marginTop: 8, color: '#0f172a', fontSize: 21, fontWeight: 750, fontVariantNumeric: 'tabular-nums' }}>{archiveStorageCount}</div>
                        <div style={{ marginTop: 4, color: '#64748b', fontSize: 11 }}>Deletion after {archiveRetentionDays === '0' ? 'manual review' : `${archiveRetentionDays} days`}</div>
                    </div>
                    <div style={{ padding: '2px 0 2px 18px' }}>
                        <div style={{ color: '#64748b', fontSize: 11, fontWeight: 650 }}>Active storage</div>
                        <div style={{ marginTop: 8, color: '#0f172a', fontSize: 21, fontWeight: 750, fontVariantNumeric: 'tabular-nums' }}>{formatSize(activeStorageBytes)}</div>
                        <div style={{ marginTop: 4, color: '#64748b', fontSize: 11 }}>{activeStorageCount} files · limit {retentionCount}</div>
                    </div>
                </div>
            </section>

            {/* ---- Backup History Card ---- */}
            <div style={{
                background: '#fff', border: '1px solid #e5e7eb', borderRadius: 10, padding: 12, marginBottom: 20,
            }}>
                    <div style={{ display: 'flex', alignItems: 'center', gap: 10, marginBottom: 8, flexWrap: 'wrap' }}>
                        <h2 style={{ margin: 0, fontSize: 13, fontWeight: 700, color: '#111827' }}>Backup History</h2>
                        <span style={{
                            display: 'inline-block', padding: '2px 10px', borderRadius: 999, fontSize: 12,
                            fontWeight: 700, background: '#f0f9ff', color: '#1d4ed8',
                            border: '1px solid #93c5fd',
                        }}>
                            {backups.length}
                        </span>
                        <TinyReloadButton onClick={handleReloadList} loading={listReloading} title="Reload backups" />
                        <button
                            type="button"
                            onClick={() => setHistoryFiltersOpen((open) => !open)}
                            aria-expanded={historyFiltersOpen}
                            style={{ marginLeft: 'auto', border: historyFiltersOpen ? '1px solid #1d4ed8' : '1px solid #cbd5e1', background: historyFiltersOpen ? '#1d4ed8' : '#fff', color: historyFiltersOpen ? '#fff' : '#334155', borderRadius: 8, padding: '6px 10px', fontSize: 11, fontWeight: 700, cursor: 'pointer' }}
                        >
                            {historyFiltersOpen ? 'Hide Filters' : `Filters${historyFilter !== 'active' ? ' (1)' : ''}`}
                        </button>
                    </div>

                    {historyFiltersOpen && <div style={{ display: 'flex', gap: 6, marginBottom: 10, flexWrap: 'wrap' }}>
                        {(['active', 'archived', 'all'] as const).map((filter) => (
                            <button
                                key={filter}
                                type="button"
                                onClick={() => setHistoryFilter(filter)}
                                style={{
                                    border: historyFilter === filter ? '1px solid #1d4ed8' : '1px solid #d1d5db',
                                    background: historyFilter === filter ? '#eff6ff' : '#fff',
                                    color: historyFilter === filter ? '#1d4ed8' : '#4b5563',
                                    borderRadius: 999,
                                    padding: '5px 11px',
                                    fontSize: 11,
                                    fontWeight: 700,
                                    cursor: 'pointer',
                                    textTransform: 'capitalize',
                                }}
                            >
                                {filter} ({filter === 'all' ? backups.length : backups.filter((backup) => backup.status === filter).length})
                            </button>
                        ))}
                    </div>}

                    {filteredBackups.length === 0 ? (
                        <div style={{ padding: '30px 0', textAlign: 'center', color: '#9ca3af', fontSize: 14 }}>
                            <svg width="40" height="40" viewBox="0 0 24 24" fill="none" stroke="#d1d5db" strokeWidth="1.5" strokeLinecap="round" strokeLinejoin="round" style={{ margin: '0 auto 8px', display: 'block' }}>
                                <ellipse cx="12" cy="5" rx="9" ry="3" />
                                <path d="M21 12c0 1.66-4 3-9 3s-9-1.34-9-3" />
                                <path d="M3 5v14c0 1.66 4 3 9 3s9-1.34 9-3V5" />
                            </svg>
                            <p style={{ margin: 0 }}>No {historyFilter === 'all' ? '' : historyFilter} backups found.</p>
                        </div>
                    ) : (
                        <div style={{ overflowX: 'auto' }}>
                            <table className="llb-table" style={{ width: '100%', borderCollapse: 'collapse' }}>
                                <thead>
                                    <tr style={{ borderBottom: '2px solid #e5e7eb' }}>
                                        <th style={{ padding: '10px 12px', textAlign: 'left', color: '#6b7280', fontSize: 12, fontWeight: 700 }}>Filename</th>
                                        <th style={{ padding: '10px 12px', textAlign: 'left', color: '#6b7280', fontSize: 12, fontWeight: 700 }} className="llb-num">Size</th>
                                        <th style={{ padding: '10px 12px', textAlign: 'left', color: '#6b7280', fontSize: 12, fontWeight: 700 }}>Issued At</th>
                                        <th style={{ padding: '10px 12px', textAlign: 'left', color: '#6b7280', fontSize: 12, fontWeight: 700 }}>Status</th>
                                        <th className="llb-actions-heading" style={{ padding: '10px 12px', textAlign: 'center', color: '#6b7280', fontSize: 12, fontWeight: 700 }}>Actions</th>
                                    </tr>
                                </thead>
                                <tbody>
                                    {paginatedBackups.map(b => (
                                        <tr key={b.filename} style={{ borderBottom: '1px solid #f3f4f6' }}>
                                            <td style={{ padding: '12px', color: '#111827', fontSize: 13, fontWeight: 600 }} className="llb-trunc" title={b.filename}>
                                                <div style={{ display: 'flex', alignItems: 'center', gap: 8 }}>
                                                    <svg width="16" height="16" viewBox="0 0 24 24" fill="none" stroke="#2563eb" strokeWidth="2" strokeLinecap="round" strokeLinejoin="round">
                                                        <path d="M14 2H6a2 2 0 0 0-2 2v16a2 2 0 0 0 2 2h12a2 2 0 0 0 2-2V8z" />
                                                        <polyline points="14 2 14 8 20 8" />
                                                    </svg>
                                                    {b.filename}
                                                </div>
                                            </td>
                                            <td style={{ padding: '12px', color: '#6b7280', fontSize: 13 }} className="llb-num">
                                                {formatSize(b.size)}
                                            </td>
                                            <td style={{ padding: '12px', color: '#6b7280', fontSize: 13 }}>
                                                {b.created_at}
                                            </td>
                                            <td style={{ padding: '12px' }}>
                                                <span style={{
                                                    display: 'inline-flex',
                                                    borderRadius: 999,
                                                    padding: '3px 8px',
                                                    fontSize: 11,
                                                    fontWeight: 700,
                                                    background: b.status === 'archived' ? '#f3f4f6' : '#dcfce7',
                                                    color: b.status === 'archived' ? '#4b5563' : '#166534',
                                                }}>
                                                    {b.status === 'archived' ? 'Archived' : 'Active'}
                                                </span>
                                            </td>
                                            <td style={{ padding: '12px', textAlign: 'center' }} className="llb-actions">
                                                <button
                                                    type="button"
                                                    aria-label={`Actions for backup ${b.filename}`}
                                                    aria-haspopup="menu"
                                                    aria-expanded={actionMenu?.backup.filename === b.filename}
                                                    onClick={(event) => {
                                                        const rect = event.currentTarget.getBoundingClientRect();
                                                        setActionMenu((current) => current?.backup.filename === b.filename
                                                            ? null
                                                            : { backup: b, top: rect.bottom + 6, right: Math.max(12, window.innerWidth - rect.right) });
                                                    }}
                                                    style={{
                                                        width: 32, height: 32, borderRadius: 8, border: '1px solid #d1d5db',
                                                        background: '#fff', color: '#374151', cursor: 'pointer', fontSize: 20,
                                                        lineHeight: 1, display: 'inline-flex', alignItems: 'center', justifyContent: 'center',
                                                    }}
                                                >
                                                    &#8942;
                                                </button>
                                            </td>
                                        </tr>
                                    ))}
                                </tbody>
                            </table>
                            <Pagination
                                currentPage={currentPage}
                                totalItems={filteredBackups.length}
                                itemsPerPage={ITEMS_PER_PAGE}
                                onPageChange={setCurrentPage}
                                label="backups"
                            />
                        </div>
                    )}
            </div>

            {actionMenu && (
                <div
                    role="presentation"
                    onClick={() => setActionMenu(null)}
                    style={{ position: 'fixed', inset: 0, zIndex: 30000 }}
                >
                    <div
                        role="menu"
                        aria-label={`Actions for ${actionMenu.backup.filename}`}
                        onClick={(event) => event.stopPropagation()}
                        style={{
                            position: 'fixed', top: actionMenu.top, right: actionMenu.right, width: 190,
                            padding: 6, borderRadius: 12, background: '#fff', border: '1px solid #e5e7eb',
                            boxShadow: '0 16px 40px rgba(15, 23, 42, 0.22)', display: 'grid', gap: 3,
                        }}
                    >
                        <button role="menuitem" style={backupMenuItemStyle} onClick={() => { void handleDownload(actionMenu.backup.filename, actionMenu.backup.status); setActionMenu(null); }}>
                            <CrudActionIcon action="download" /> Download
                        </button>
                        <button role="menuitem" style={backupMenuItemStyle} disabled={restoringBackup !== null || importingUpload} onClick={() => { void handleRestoreBackup(actionMenu.backup.filename, actionMenu.backup.status); setActionMenu(null); }}>
                            <CrudActionIcon action="restore" /> Restore
                        </button>
                        <button role="menuitem" style={backupMenuItemStyle} disabled={archiving === actionMenu.backup.filename || restoringBackup !== null} onClick={() => { void handleArchive(actionMenu.backup, actionMenu.backup.status === 'archived'); setActionMenu(null); }}>
                            <CrudActionIcon action={actionMenu.backup.status === 'archived' ? 'restore' : 'archive'} />
                            {actionMenu.backup.status === 'archived' ? 'Unarchive' : 'Archive'}
                        </button>
                        {actionMenu.backup.status === 'archived' && (
                            <button role="menuitem" style={{ ...backupMenuItemStyle, color: '#b91c1c' }} onClick={() => { void router.push('/settings/data-deletion?resource=backups'); setActionMenu(null); }}>
                                <CrudActionIcon action="delete" /> Manage in Data Storage
                            </button>
                        )}
                    </div>
                </div>
            )}

            {/* ---- Backup Storage Controls ---- */}
            <div style={{
                background: '#fff', border: '1px solid #e5e7eb', borderRadius: 10, padding: 12, marginBottom: 20,
            }}>
                <h2 style={{ margin: '0 0 6px', fontSize: 13, fontWeight: 700, color: '#111827' }}>Backup Storage Controls</h2>
                <p style={{ margin: '0 0 12px', fontSize: 11, color: '#6b7280' }}>
                    Active backups are archived first. Only archived backups can be permanently deleted.
                </p>
                <div style={{ display: 'flex', alignItems: 'end', gap: 12, flexWrap: 'wrap' }}>
                    <label style={{ display: 'grid', gap: 5, fontSize: 11, color: '#374151', fontWeight: 600 }}>
                        Keep latest active backups
                        <input
                            type="number"
                            min="1"
                            max="500"
                            value={retentionCount}
                            onChange={(event) => setRetentionCount(event.target.value)}
                            style={{ width: 190, padding: '8px 10px', border: '1px solid #d1d5db', borderRadius: 8, color: '#111827' }}
                        />
                    </label>
                    <label style={{ display: 'grid', gap: 5, fontSize: 11, color: '#374151', fontWeight: 600 }}>
                        Delete archived backups after days
                        <input
                            type="number"
                            min="0"
                            max="3650"
                            value={archiveRetentionDays}
                            onChange={(event) => setArchiveRetentionDays(event.target.value)}
                            style={{ width: 220, padding: '8px 10px', border: '1px solid #d1d5db', borderRadius: 8, color: '#111827' }}
                        />
                    </label>
                    <button
                        type="button"
                        onClick={() => void handleSaveDeletionPolicy()}
                        disabled={savingDeletionPolicy || runningCleanup}
                        style={{ background: '#1e3a8a', color: '#fff', border: 0, borderRadius: 8, padding: '9px 14px', fontSize: 12, fontWeight: 700, cursor: 'pointer' }}
                    >
                        {savingDeletionPolicy ? 'Saving...' : 'Save controls'}
                    </button>
                    <button
                        type="button"
                        onClick={() => void handleRunCleanup()}
                        disabled={savingDeletionPolicy || runningCleanup}
                        style={{ background: '#fff', color: '#b91c1c', border: '1px solid #fca5a5', borderRadius: 8, padding: '8px 14px', fontSize: 12, fontWeight: 700, cursor: 'pointer' }}
                    >
                        {runningCleanup ? 'Cleaning...' : 'Run cleanup now'}
                    </button>
                </div>
                <p style={{ margin: '8px 0 0', fontSize: 11, color: '#6b7280' }}>
                    Set deletion days to 0 to disable automatic permanent deletion. Manual permanent deletion remains available from Archived history.
                </p>
            </div>

            {/* ---- Auto-Schedule Card ---- */}
            <div style={{
                background: '#fff', border: '1px solid #e5e7eb', borderRadius: 10, padding: 12,
            }}>
                    <h2 style={{ margin: '0 0 6px 0', fontSize: 13, fontWeight: 700, color: '#111827' }}>Automatic Backup Schedule</h2>
                    <p style={{ margin: '0 0 8px 0', fontSize: 11, color: '#6b7280' }}>
                        Configure the system to automatically create backups on a recurring schedule.
                    </p>

                    {/* Frequency */}
                    <div style={{ display: 'grid', gap: 8 }}>
                        <div style={{ display: 'grid', gap: 6 }}>
                            <label style={{ fontSize: 11, color: '#374151', fontWeight: 600 }}>Frequency</label>
                            <div style={{ display: 'flex', gap: 8 }}>
                                {(['off', 'daily', 'weekly', 'monthly'] as const).map(f => (
                                    <button
                                        key={f}
                                        type="button"
                                        onClick={() => setFrequency(f)}
                                        style={{
                                            padding: '8px 16px',
                                            borderRadius: 8,
                                            border: frequency === f ? '2px solid #1e3a8a' : '1px solid #d1d5db',
                                            background: frequency === f ? '#eff6ff' : '#fff',
                                            color: frequency === f ? '#1e3a8a' : '#374151',
                                            fontWeight: frequency === f ? 700 : 500,
                                            fontSize: 13,
                                            cursor: 'pointer',
                                            textTransform: 'capitalize',
                                            transition: 'all 0.15s',
                                        }}
                                    >
                                        {f}
                                    </button>
                                ))}
                            </div>
                        </div>

                        {frequency !== 'off' && (
                            <>
                                {/* Automatic save location */}
                                <div style={{ display: 'grid', gap: 6 }}>
                                    <label htmlFor="backup-auto-save-path" style={{ fontSize: 11, color: '#374151', fontWeight: 600 }}>
                                        Automatic Save Location
                                    </label>
                                    <div style={{ display: 'flex', alignItems: 'center', gap: 8, flexWrap: 'wrap' }}>
                                        <input
                                            id="backup-auto-save-path"
                                            type="text"
                                            value={autoSavePath}
                                            onChange={(event) => {
                                                setAutoSavePath(event.target.value);
                                                if (deviceDirectoryHandle) void clearDeviceFolder();
                                            }}
                                            placeholder={defaultBackupPath || 'Default backups folder'}
                                            aria-describedby="backup-auto-save-path-help"
                                            style={{
                                                width: 'min(100%, 620px)',
                                                minWidth: 260,
                                                padding: '8px 10px',
                                                borderRadius: 8,
                                                border: '1px solid #d1d5db',
                                                fontSize: 13,
                                                color: '#111827',
                                                fontFamily: 'Consolas, "Courier New", monospace',
                                            }}
                                        />
                                        <button
                                            type="button"
                                            onClick={() => void handleChooseDeviceFolder()}
                                            disabled={choosingFolder}
                                            style={{
                                                border: '1px solid #1e3a8a',
                                                background: '#1e3a8a',
                                                color: '#fff',
                                                borderRadius: 8,
                                                padding: '8px 12px',
                                                fontSize: 12,
                                                fontWeight: 600,
                                                cursor: choosingFolder ? 'wait' : 'pointer',
                                                opacity: choosingFolder ? 0.65 : 1,
                                            }}
                                        >
                                            {choosingFolder ? 'Opening...' : 'Choose device folder'}
                                        </button>
                                        <button
                                            type="button"
                                            onClick={() => {
                                                setAutoSavePath('');
                                                void clearDeviceFolder();
                                            }}
                                            disabled={!autoSavePath && !deviceDirectoryHandle}
                                            style={{
                                                border: '1px solid #d1d5db',
                                                background: '#fff',
                                                color: '#374151',
                                                borderRadius: 8,
                                                padding: '8px 12px',
                                                fontSize: 12,
                                                fontWeight: 600,
                                                cursor: autoSavePath || deviceDirectoryHandle ? 'pointer' : 'not-allowed',
                                                opacity: autoSavePath || deviceDirectoryHandle ? 1 : 0.55,
                                            }}
                                        >
                                            Use default
                                        </button>
                                    </div>
                                    <span id="backup-auto-save-path-help" style={{ fontSize: 11, color: '#6b7280' }}>
                                        {deviceDirectoryHandle
                                            ? `Selected device folder: ${deviceFolderName}. Your browser may ask you to confirm access again after it restarts.`
                                            : `Choose a folder on this device, enter an absolute server folder path, or leave blank to use ${defaultBackupPath || 'the existing backups folder'}.`}
                                    </span>
                                </div>

                                {/* Time */}
                                <div style={{ display: 'grid', gap: 6 }}>
                                    <label style={{ fontSize: 11, color: '#374151', fontWeight: 600 }}>Backup Time</label>
                                    <input
                                        type="time"
                                        value={backupTime}
                                        onChange={e => { setBackupTime(e.target.value); if (scheduleTimeError) setScheduleTimeError(''); }}
                                        required
                                        aria-required="true"
                                        aria-invalid={scheduleTimeError ? true : undefined}
                                        style={{ padding: '7px 10px', borderRadius: 8, border: scheduleTimeError ? '2px solid #ef4444' : '1px solid #d1d5db', fontSize: 14, maxWidth: 200, color: '#111' }}
                                    />
                                    {scheduleTimeError && <span style={{ fontSize: 12, color: '#b91c1c' }}>{scheduleTimeError}</span>}
                                    <span style={{ fontSize: 11, color: '#9ca3af' }}>Server timezone: Asia/Manila</span>
                                </div>

                                {/* Day of week (weekly) */}
                                {frequency === 'weekly' && (
                                    <div style={{ display: 'grid', gap: 6 }}>
                                        <label style={{ fontSize: 11, color: '#374151', fontWeight: 600 }}>Day of Week</label>
                                        <select
                                            value={dayOfWeek}
                                            onChange={e => setDayOfWeek(e.target.value)}
                                            required
                                            aria-required="true"
                                            style={{ padding: '7px 10px', borderRadius: 8, border: '1px solid #d1d5db', fontSize: 14, maxWidth: 200, color: '#111' }}
                                        >
                                            {weekDays.map((d, i) => (
                                                <option key={i} value={String(i)}>{d}</option>
                                            ))}
                                        </select>
                                    </div>
                                )}

                                {/* Day of month (monthly) */}
                                {frequency === 'monthly' && (
                                    <div style={{ display: 'grid', gap: 6 }}>
                                        <label style={{ fontSize: 11, color: '#374151', fontWeight: 600 }}>Day of Month</label>
                                        <select
                                            value={dayOfMonth}
                                            onChange={e => setDayOfMonth(e.target.value)}
                                            required
                                            aria-required="true"
                                            style={{ padding: '7px 10px', borderRadius: 8, border: '1px solid #d1d5db', fontSize: 14, maxWidth: 200, color: '#111' }}
                                        >
                                            {Array.from({ length: 28 }, (_, i) => i + 1).map(d => (
                                                <option key={d} value={String(d)}>{d}</option>
                                            ))}
                                        </select>
                                        <span style={{ fontSize: 11, color: '#9ca3af' }}>Max 28 to avoid end-of-month issues</span>
                                    </div>
                                )}

                                {/* Schedule summary */}
                                <div style={{
                                    background: '#f0f9ff', border: '1px solid #bae6fd', borderRadius: 10, padding: '12px 16px',
                                    display: 'flex', alignItems: 'center', gap: 10,
                                }}>
                                    <svg width="18" height="18" viewBox="0 0 24 24" fill="none" stroke="#0284c7" strokeWidth="2" strokeLinecap="round" strokeLinejoin="round">
                                        <circle cx="12" cy="12" r="10" />
                                        <polyline points="12 6 12 12 16 14" />
                                    </svg>
                                    <span style={{ fontSize: 13, color: '#0c4a6e', fontWeight: 600 }}>
                                        {frequency === 'daily' && `Every day at ${backupTime}`}
                                        {frequency === 'weekly' && `Every ${weekDays[parseInt(dayOfWeek)]} at ${backupTime}`}
                                        {frequency === 'monthly' && `Every month on day ${dayOfMonth} at ${backupTime}`}
                                        <span style={{ display: 'block', marginTop: 3, fontSize: 11, fontWeight: 500 }}>
                                            Saves to: {deviceDirectoryHandle
                                                ? `Device folder: ${deviceFolderName}`
                                                : autoSavePath.trim() || defaultBackupPath || 'default backups folder'}
                                        </span>
                                    </span>
                                </div>
                            </>
                        )}
                    </div>

                    <div style={{ display: 'flex', justifyContent: 'flex-end', marginTop: 10 }}>
                        <button
                            onClick={handleSaveSchedule}
                            disabled={savingSchedule}
                            title="Save Schedule"
                            aria-label="Save backup schedule"
                            style={{
                                background: 'transparent', color: '#1e3a8a', border: 'none', padding: '4px 0',
                                cursor: 'pointer', fontWeight: 600, fontSize: 14,
                                opacity: savingSchedule ? 0.5 : 1, display: 'inline-flex', alignItems: 'center', justifyContent: 'center',
                                textDecoration: 'underline',
                            }}
                        >
                            {savingSchedule ? 'Saving...' : 'Submit'}
                        </button>
                    </div>
            </div>

            <style>{`@keyframes spin { to { transform: rotate(360deg); } }`}</style>
        </SettingsLayout>
    );
}
