/**
 * Shared search helpers: recent searches, autocomplete, and zero-result
 * alternatives. Used by every list search bar in the system.
 */

const RECENT_PREFIX = 'llb_recent_search:';
const MAX_RECENTS = 6;
const MAX_CORPUS_TERMS = 600;

function readKey(key: string): string[] {
    try {
        const raw = window.localStorage.getItem(RECENT_PREFIX + key);
        if (!raw) return [];
        const parsed = JSON.parse(raw);
        return Array.isArray(parsed) ? parsed.filter((v): v is string => typeof v === 'string') : [];
    } catch {
        return [];
    }
}

function writeKey(key: string, terms: string[]) {
    try {
        window.localStorage.setItem(RECENT_PREFIX + key, JSON.stringify(terms.slice(0, MAX_RECENTS)));
    } catch {
        /* private mode — recents simply don't persist */
    }
}

export function getRecentSearches(key: string): string[] {
    return readKey(key);
}

export function saveRecentSearch(key: string, term: string) {
    const clean = String(term ?? '').trim().replace(/\s+/g, ' ');
    if (clean.length < 2) return;
    const prev = readKey(key).filter((t) => t.toLowerCase() !== clean.toLowerCase());
    writeKey(key, [clean, ...prev]);
}

export function removeRecentSearch(key: string, term: string) {
    writeKey(
        key,
        readKey(key).filter((t) => t !== term)
    );
}

export function clearRecentSearches(key: string) {
    try {
        window.localStorage.removeItem(RECENT_PREFIX + key);
    } catch {
        /* noop */
    }
}

const norm = (v: unknown) => String(v ?? '').trim().replace(/\s+/g, ' ').toLowerCase();

/**
 * Flatten searchable text from list rows into a unique term corpus.
 * pickers extract the searchable fields per row (names, titles, emails...).
 */
export function collectSearchTerms<T>(items: T[], pickers: Array<(item: T) => unknown>): string[] {
    const seen = new Set<string>();
    const out: string[] = [];
    for (const item of items || []) {
        for (const pick of pickers) {
            const raw = String(pick(item) ?? '').trim().replace(/\s+/g, ' ');
            if (!raw || seen.has(raw.toLowerCase())) continue;
            seen.add(raw.toLowerCase());
            out.push(raw);
            if (out.length >= MAX_CORPUS_TERMS) return out;
        }
    }
    return out;
}

/**
 * Autocomplete: corpus entries containing the query (prefix matches first).
 * The exact query itself is excluded.
 */
export function getAutocompleteSuggestions(query: string, corpus: string[], limit = 6): string[] {
    const q = norm(query);
    if (!q) return [];
    const starts: string[] = [];
    const contains: string[] = [];
    for (const term of corpus) {
        const t = norm(term);
        if (!t || t === q) continue;
        if (t.startsWith(q)) starts.push(term);
        else if (t.includes(q)) contains.push(term);
        if (starts.length + contains.length >= limit * 3) break;
    }
    return [...starts, ...contains].slice(0, Math.max(1, limit));
}

function isSubsequence(shorter: string, longer: string): boolean {
    let i = 0;
    for (const ch of longer) {
        if (ch === shorter[i]) i += 1;
        if (i >= shorter.length) return true;
    }
    return false;
}

function levenshtein(a: string, b: string): number {
    if (a === b) return 0;
    if (!a.length) return b.length;
    if (!b.length) return a.length;
    if (Math.abs(a.length - b.length) > 2) return 3;
    let prev = Array.from({ length: b.length + 1 }, (_, i) => i);
    let curr = new Array<number>(b.length + 1);
    for (let i = 1; i <= a.length; i += 1) {
        curr[0] = i;
        for (let j = 1; j <= b.length; j += 1) {
            const cost = a[i - 1] === b[j - 1] ? 0 : 1;
            curr[j] = Math.min(prev[j] + 1, curr[j - 1] + 1, prev[j - 1] + cost);
        }
        const tmp = prev;
        prev = curr;
        curr = tmp;
    }
    return prev[b.length];
}

/**
 * Zero-result alternatives: closest corpus terms to a query that matched
 * nothing — shared words, subsequence matches, or near-miss typos.
 */
export function getAlternativeSuggestions(query: string, corpus: string[], limit = 4): string[] {
    const q = norm(query);
    if (!q) return [];
    const qWords = q.split(' ').filter(Boolean);
    const scored: Array<{ term: string; score: number }> = [];
    for (const term of corpus) {
        const t = norm(term);
        if (!t || t === q || t.includes(q)) continue;
        const tWords = t.split(' ').filter(Boolean);
        let score = 0;
        // Shared whole words (e.g. searched "juan dela" -> "Juan Cruz").
        const shared = qWords.filter((w) => tWords.includes(w)).length;
        score += shared * 10;
        // Query word is a prefix of a corpus word.
        for (const qw of qWords) {
            if (tWords.some((tw) => tw.startsWith(qw) && tw !== qw)) score += 5;
        }
        // Near-miss typo on any word pair.
        let close = false;
        for (const qw of qWords) {
            for (const tw of tWords) {
                if (qw.length >= 3 && tw.length >= 3 && levenshtein(qw, tw) <= 2) {
                    close = true;
                    break;
                }
            }
            if (close) break;
        }
        if (close) score += 6;
        // Typo-tolerant subsequence over the whole string.
        if (score === 0 && q.length >= 3 && isSubsequence(q.replace(/\s+/g, ''), t.replace(/\s+/g, ''))) {
            score += 2;
        }
        if (score > 0) scored.push({ term, score });
    }
    scored.sort((a, b) => b.score - a.score);
    return scored.slice(0, Math.max(1, limit)).map((s) => s.term);
}
