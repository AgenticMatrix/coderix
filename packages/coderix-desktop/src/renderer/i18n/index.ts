import { useMemo } from 'react';
import { useUIStore } from '../store/uiStore.js';
import { zh } from './zh';
import { en, type TranslationKey } from './en';

export type { Language } from './types';
export type { TranslationKey } from './en';

const DICTS = { zh, en } as const;

export type TParams = Record<string, string | number>;

function interpolate(template: string, params?: TParams): string {
  if (!params) return template;
  let out = template;
  for (const [key, value] of Object.entries(params)) {
    out = out.replaceAll(`{${key}}`, String(value));
  }
  return out;
}

/** 非 React 上下文(回调 / store / 原生 tooltip)使用的翻译函数。 */
export function t(key: TranslationKey, params?: TParams): string {
  const lang = useUIStore.getState().language;
  return interpolate(DICTS[lang][key], params);
}

/** React hook:订阅语言,返回随语言切换重渲染的翻译函数。 */
export function useT(): (key: TranslationKey, params?: TParams) => string {
  const lang = useUIStore((s) => s.language);
  return useMemo(() => {
    return (key: TranslationKey, params?: TParams) => interpolate(DICTS[lang][key], params);
  }, [lang]);
}

function currentLocale(): string {
  return useUIStore.getState().language === 'zh' ? 'zh-CN' : 'en-US';
}

/** 相对时间(刚刚 / 5 分钟前 / 昨天 …),按当前语言用 Intl.RelativeTimeFormat 输出。 */
export function formatRelativeTime(input: Date | number | string): string {
  const rtf = new Intl.RelativeTimeFormat(currentLocale(), { numeric: 'auto' });
  const date = new Date(input);
  const diff = date.getTime() - Date.now();
  const abs = Math.abs(diff);
  const units: Array<[Intl.RelativeTimeFormatUnit, number]> = [
    ['year', 31536000],
    ['month', 2592000],
    ['week', 604800],
    ['day', 86400],
    ['hour', 3600],
    ['minute', 60],
    ['second', 1],
  ];
  for (const [unit, seconds] of units) {
    if (abs >= seconds * 1000 || unit === 'second') {
      return rtf.format(Math.round(diff / (seconds * 1000)), unit);
    }
  }
  return rtf.format(0, 'second');
}
