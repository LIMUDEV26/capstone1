import { useCallback, useEffect, useRef, useState } from 'react';

type EditedId = string | number;

export function useEditedIndicator(durationMs = 30000) {
    const [editedItems, setEditedItems] = useState<Map<EditedId, number>>(new Map());
    const timersRef = useRef<Map<EditedId, ReturnType<typeof setTimeout>>>(new Map());

    const markEdited = useCallback((id: EditedId) => {
        const editedAt = Date.now();

        setEditedItems((prev) => {
            const next = new Map(prev);
            next.set(id, editedAt);
            return next;
        });

        const existingTimer = timersRef.current.get(id);
        if (existingTimer) clearTimeout(existingTimer);

        const timer = setTimeout(() => {
            setEditedItems((prev) => {
                const next = new Map(prev);
                next.delete(id);
                return next;
            });
            timersRef.current.delete(id);
        }, durationMs);

        timersRef.current.set(id, timer);
    }, [durationMs]);

    useEffect(() => {
        const timers = timersRef.current;
        return () => {
            timers.forEach((timer) => clearTimeout(timer));
            timers.clear();
        };
    }, []);

    return { editedItems, markEdited };
}
