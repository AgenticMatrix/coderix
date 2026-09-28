import React from 'react';
import { useT } from '../../i18n/index.js';
import { APPS, type AppDefinition } from './registry';

/**
 * AppsView — the "应用" tab's launcher. Lists every registered app as a card;
 * opening one attaches it to the current conversation (handled by the parent
 * via `onOpenApp`): the app's skills are enabled and its display page renders
 * on the right, while the conversation continues on the left.
 */
export function AppsView({ onOpenApp }: { onOpenApp: (app: AppDefinition) => void }): React.ReactElement {
  const t = useT();

  return (
    <div className="flex-1 overflow-y-auto">
      <div className="px-6 py-6">
        <div className="text-sm font-semibold text-[var(--color-text-secondary)] mb-4">{t('nav.apps')}</div>
        <div className="grid gap-4 grid-cols-[repeat(auto-fill,minmax(220px,1fr))]">
          {APPS.map((app) => {
            const Icon = app.icon;
            return (
              <button
                key={app.id}
                type="button"
                onClick={() => onOpenApp(app)}
                className="flex flex-col items-start gap-3 p-4 rounded-[var(--radius-lg)] bg-[var(--color-bg-tertiary)] border border-[var(--color-separator)] text-left hover:bg-[var(--color-bg-secondary)] transition-colors"
              >
                <div className="flex items-center justify-center w-10 h-10 rounded-[var(--radius-md)] bg-[var(--color-brand-muted)] text-[var(--color-brand)]">
                  <Icon size={20} />
                </div>
                <div className="space-y-1">
                  <div className="text-sm font-medium text-[var(--color-text-primary)]">{app.name}</div>
                  <div className="text-xs text-[var(--color-text-tertiary)]">{app.description}</div>
                </div>
              </button>
            );
          })}
        </div>
      </div>
    </div>
  );
}

AppsView.displayName = 'AppsView';
