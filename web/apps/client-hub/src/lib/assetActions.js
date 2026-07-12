export const webAssetActions = {
    download: async (asset) => {
        const url = asset.downloadUrl;
        if (!url) {
            // A missing URL means the desktop pipeline hasn't published this original yet.
            console.warn(`Asset "${asset.name}" (${asset.id}) has no download_url`);
            window.alert('This file has no download available yet — it will appear after the next publish run.');
            return;
        }
        try {
            // The anchor `download` attribute is ignored for cross-origin URLs (the CDN),
            // so fetch to a blob first. Requires CORS on the R2 public domain.
            const res = await fetch(url);
            if (!res.ok)
                throw new Error(`HTTP ${res.status}`);
            const blob = await res.blob();
            const objectUrl = URL.createObjectURL(blob);
            const a = document.createElement('a');
            a.href = objectUrl;
            a.download = asset.name;
            document.body.appendChild(a);
            a.click();
            a.remove();
            URL.revokeObjectURL(objectUrl);
        }
        catch (err) {
            // No CORS or network failure — hand the URL to the browser directly so the
            // user still gets the file, just without a forced save dialog.
            console.error('Blob download failed, opening directly:', err);
            window.open(url, '_blank', 'noopener');
        }
    },
    // openInFolder: desktop only — not available in the web build
};
