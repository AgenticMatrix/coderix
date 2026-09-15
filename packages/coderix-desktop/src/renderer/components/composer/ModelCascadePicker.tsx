import React, { useState, useRef, useEffect, useMemo } from 'react';
import { Cpu, ChevronDown, Check } from 'lucide-react';
import { useSettingsStore } from '../../store/settingsStore.js';
import type { ProviderConfig } from '../../store/settingsStore.js';
import { setSessionModel } from '../../ipc-client.js';
import { providerLabel, ProviderLogo } from './providerMeta.js';
import { useT } from '../../i18n/index.js';
import './ModelCascadePicker.css';

/**
 * Stable empty array for the store selector. Returning a fresh `[]` from a
 * zustand v5 selector makes `useSyncExternalStore` see a "changed" snapshot on
 * every render (Object.is comparison), which drives an infinite re-render loop
 * ("Maximum update depth exceeded") while `settings` is still null/loading.
 */
const EMPTY_PROVIDERS: ProviderConfig[] = [];

export interface ModelCascadePickerProps {
  /** Current model, "provider/model" or a bare model name. */
  model?: string;
  /** Notifies the parent when a model is selected, so the per-session model
   *  label can update without re-reading the global default. */
  onModelChange?: (model: string) => void;
}

/**
 * Two-step model picker for the composer: click → provider list → click a
 * provider → that provider's model list. Selecting a model binds it to the
 * active session (per-session model switch) and refreshes the settings store.
 *
 * Mirrors the agentstation-app cascade picker (ModelButton / ModelCascadePicker),
 * adapted to read providers/models from the settings store instead of a model
 * registry.
 */
export function ModelCascadePicker({ model = '', onModelChange }: ModelCascadePickerProps): React.ReactElement {
  const t = useT();
  const providers = useSettingsStore((s) => s.settings?.providers ?? EMPTY_PROVIDERS);
  const [open, setOpen] = useState(false);
  const [selectedProvider, setSelectedProvider] = useState<string | null>(null);
  const popupRef = useRef<HTMLDivElement>(null);

  // Current provider slug, if the model is already in "provider/model" form.
  const currentProvider = useMemo(() => {
    const idx = model.indexOf('/');
    return idx > 0 ? model.slice(0, idx).toLowerCase() : null;
  }, [model]);

  const providerModels = useMemo(() => {
    if (!selectedProvider) return [];
    const p = providers.find((pr) => pr.name.toLowerCase() === selectedProvider);
    return p?.models ?? [];
  }, [providers, selectedProvider]);

  // Close on outside click.
  useEffect(() => {
    if (!open) return;
    const handler = (e: MouseEvent) => {
      if (popupRef.current && !popupRef.current.contains(e.target as Node)) setOpen(false);
    };
    document.addEventListener('mousedown', handler);
    return () => document.removeEventListener('mousedown', handler);
  }, [open]);

  const toggleOpen = () => {
    if (!open) {
      const slugs = providers.map((p) => p.name.toLowerCase());
      setSelectedProvider(currentProvider && slugs.includes(currentProvider) ? currentProvider : (slugs[0] ?? null));
    }
    setOpen((prev) => !prev);
  };

  const handleSelect = (providerName: string, modelName: string) => {
    setOpen(false);
    const full = `${providerName}/${modelName}`;
    setSessionModel(full)
      .then(() => onModelChange?.(full))
      .catch(() => {});
  };

  return (
    <div className="model-cascade-wrap" ref={popupRef}>
      <button
        type="button"
        className="model-picker-btn"
        onClick={toggleOpen}
        title={t('modelpicker.switch')}
      >
        <Cpu size={13} />
        <span className="model-cascade-label">{model || t('modelpicker.unconfigured')}</span>
        <ChevronDown size={10} />
      </button>

      {open && (
        <div className="model-cascade-popup">
          <div className="model-cascade-header">{t('modelpicker.switch')}</div>
          <div className="model-cascade-body">
            <div className="model-cascade-providers">
              {providers.map((p) => (
                <button
                  key={p.name}
                  type="button"
                  className={`model-cascade-provider${selectedProvider === p.name.toLowerCase() ? ' active' : ''}`}
                  onClick={() => setSelectedProvider(p.name.toLowerCase())}
                >
                  <ProviderLogo provider={p.name} size={18} />
                  <span className="model-cascade-provider-label">{providerLabel(p.name)}</span>
                </button>
              ))}
            </div>
            <div className="model-cascade-models">
              {providerModels.length === 0 ? (
                <div className="model-cascade-empty">{t('modelpicker.noModels')}</div>
              ) : (
                providerModels.map((m) => {
                  const active = selectedProvider
                    ? model.toLowerCase() === `${selectedProvider}/${m.name}`.toLowerCase()
                    : false;
                  return (
                    <button
                      key={m.name}
                      type="button"
                      className={`model-cascade-model${active ? ' active' : ''}`}
                      onClick={() => selectedProvider && handleSelect(selectedProvider, m.name)}
                    >
                      <span className="model-cascade-model-name">{m.name}</span>
                      {active && <Check size={14} className="model-cascade-check" />}
                    </button>
                  );
                })
              )}
            </div>
          </div>
        </div>
      )}
    </div>
  );
}

ModelCascadePicker.displayName = 'ModelCascadePicker';
