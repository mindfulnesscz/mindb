import { useState } from 'react';
import { useSettingsStore } from '../../store/settingsStore';
import css from './SettingsView.module.css';

export function SettingsView() {
  const { settings, setField, markClean } = useSettingsStore();
  const [savedMsg, setSavedMsg] = useState('');

  function handleSave() {
    markClean();
    setSavedMsg('Saved');
    setTimeout(() => setSavedMsg(''), 2000);
  }

  return (
    <div className={css.root}>
      <div className={css.header}>
        <span className={css.title}>Settings</span>
        <div className={css.headerActions}>
          {savedMsg && <span className={css.savedMsg}>{savedMsg}</span>}
          <button className={css.btnSave} onClick={handleSave}>Save</button>
        </div>
      </div>

      <div className={css.scroll}>
        <div className={css.grid}>
          {/* Folder patterns */}
          <div className={css.card}>
            <div className={css.cardTitle}>Folder patterns</div>
            <div className={css.fields}>
              <div className={css.field}>
                <span className={css.fieldLabel}>Filter mode</span>
                <div className={css.segmentedControl}>
                  {(['blacklist', 'whitelist'] as const).map(mode => (
                    <button
                      key={mode}
                      className={`${css.segment}${settings.filterMode === mode ? ` ${css.active}` : ''}`}
                      onClick={() => setField('filterMode', mode)}
                    >
                      {mode.charAt(0).toUpperCase() + mode.slice(1)}
                    </button>
                  ))}
                </div>
              </div>
              <Field
                label="Package folder prefix"
                value={settings.packagePrefix}
                onChange={v => setField('packagePrefix', v)}
                mono
              />
              <Field
                label="Output folder name"
                value={settings.outFolder}
                onChange={v => setField('outFolder', v)}
                mono
              />
              <Field
                label="Exclude mark (blacklist)"
                value={settings.excludeMark}
                onChange={v => setField('excludeMark', v)}
                mono
              />
              <Field
                label="Include mark (whitelist)"
                value={settings.includeMark}
                onChange={v => setField('includeMark', v)}
                mono
              />
            </div>
          </div>

          {/* Thumbnails & DAM */}
          <div className={css.card}>
            <div className={css.cardTitle}>Thumbnails & DAM</div>
            <div className={css.fields}>
              <Field
                label="Thumbnail width (px)"
                value={settings.thumbWidth}
                onChange={v => setField('thumbWidth', v)}
                type="number"
                hint="Width of generated WebP thumbnails"
              />
              <Field
                label="Thumbnail quality (0–100)"
                value={settings.thumbQuality}
                onChange={v => setField('thumbQuality', v)}
                type="number"
                hint="WebP quality. 70 is a good default."
              />
              <Field
                label="DAM folder depth"
                value={settings.damDepth}
                onChange={v => setField('damDepth', v)}
                type="number"
                hint="0 = flat vault. 1 = one folder level per scope."
              />
            </div>
          </div>

          {/* Cloud credentials — full width */}
          <div className={css.card} style={{ gridColumn: '1 / -1' }}>
            <div className={css.cardTitle}>Cloud credentials</div>
            <div className={css.fields} style={{ display: 'grid', gridTemplateColumns: '1fr 1fr', gap: 'var(--sp-4)' }}>
              <Field
                label="Dropbox app key"
                value={settings.dropboxAppKey}
                onChange={v => setField('dropboxAppKey', v)}
                password
              />
              <Field
                label="Dropbox access token"
                value={settings.dropboxToken}
                onChange={v => setField('dropboxToken', v)}
                password
                hint="Stored locally. Keep this confidential."
              />
              <Field
                label="OneDrive client ID"
                value={settings.onedriveClientId}
                onChange={v => setField('onedriveClientId', v)}
                mono
              />
              <Field
                label="OneDrive tenant ID"
                value={settings.onedriveTenantId}
                onChange={v => setField('onedriveTenantId', v)}
                mono
                hint="Use 'common' for personal accounts."
              />
            </div>
          </div>
        </div>
      </div>
    </div>
  );
}

function Field({
  label, value, onChange, type = 'text', hint, mono, password,
}: {
  label:    string;
  value:    string;
  onChange: (v: string) => void;
  type?:    string;
  hint?:    string;
  mono?:    boolean;
  password?: boolean;
}) {
  return (
    <div className={css.field}>
      <span className={css.fieldLabel}>{label}</span>
      <input
        className={`${css.input}${mono ? ` ${css.inputMono}` : ''}${password ? ` ${css.inputPassword}` : ''}`}
        type={password ? 'password' : type}
        value={value}
        onChange={e => onChange(e.target.value)}
      />
      {hint && <span className={css.fieldHint}>{hint}</span>}
    </div>
  );
}
