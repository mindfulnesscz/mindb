import { useState, useEffect, useRef } from 'react';
import { MOCK_ASSETS, applyFilters } from '@dc-hub/asset-library';
import { fetchAssets } from '../services/assetService';
import { isConfigured } from '../lib/supabase';
export function useAssets(filters, role, clientId) {
    const [assets, setAssets] = useState([]);
    const [allAssets, setAllAssets] = useState([]);
    const [total, setTotal] = useState(0);
    const [loading, setLoading] = useState(true);
    const [error, setError] = useState(null);
    const [rev, setRev] = useState(0);
    const usingMock = !isConfigured();
    // Track whether we've received at least one successful response
    const hasData = useRef(false);
    const filtersKey = JSON.stringify({ filters, role, clientId, rev });
    // No ref-based dedupe here: the filtersKey dependency already re-runs the
    // effect only on value changes, and a ref guard breaks under StrictMode's
    // dev double-mount — run #1's fetch gets cancelled by the cleanup, run #2
    // sees the same key and skips, and `loading` never resolves.
    useEffect(() => {
        let cancelled = false;
        // Show skeleton only on the very first load; keep stale assets visible during re-fetch
        if (!hasData.current)
            setLoading(true);
        setError(null);
        if (usingMock) {
            const result = applyFilters(MOCK_ASSETS, filters, role, clientId);
            if (!cancelled) {
                setAssets(result);
                setAllAssets(MOCK_ASSETS);
                setTotal(MOCK_ASSETS.length);
                setLoading(false);
                hasData.current = true;
            }
            return;
        }
        fetchAssets({ filters, role, clientId })
            .then(({ assets: data, allAssets: all }) => {
            if (!cancelled) {
                setAssets(data);
                setAllAssets(all);
                setTotal(data.length);
                setLoading(false);
                hasData.current = true;
            }
        })
            .catch(err => {
            if (!cancelled) {
                setError(err instanceof Error ? err.message : String(err));
                setLoading(false);
            }
        });
        return () => { cancelled = true; };
    }, [filtersKey, usingMock]);
    return {
        assets,
        allAssets,
        total,
        loading,
        error,
        usingMock,
        reload: () => { hasData.current = false; setRev(r => r + 1); },
    };
}
