import { useEffect, useRef, useState } from 'react';
import { useGetBootstrap } from '@workspace/api-client-react';
import { keepPreviousData, useQueryClient } from '@tanstack/react-query';
import {
  getGetAdminConsoleQueryKey,
  getGetBootstrapQueryKey,
  getListAnnouncementsQueryKey,
  useExecuteAdminCommand,
  useGetAdminConsole,
} from '@workspace/api-client-react';
import type { AdminCommandInput, GetAdminConsoleParams, GetAdminConsoleSection } from '@workspace/api-client-react';
import { useToast } from '@/hooks/use-toast';

export const TZ = 'Africa/Lome';

export function fmtNumber(value: number | null | undefined) {
  if (value === null || value === undefined || Number.isNaN(value)) return '—';
  return new Intl.NumberFormat('fr-FR', { maximumFractionDigits: 2 }).format(value);
}

export function fmtMoney(value: number | null | undefined, currency = 'XOF') {
  if (value === null || value === undefined || Number.isNaN(value)) return '—';
  return `${new Intl.NumberFormat('fr-FR', { maximumFractionDigits: 0 }).format(value)} ${currency}`;
}

export function fmtDate(value: string | null | undefined, withTime = true) {
  if (!value) return '—';
  const d = new Date(value);
  if (Number.isNaN(d.getTime())) return value;
  return new Intl.DateTimeFormat('fr-FR', { timeZone: TZ, day: '2-digit', month: 'short', year: 'numeric', ...(withTime ? { hour: '2-digit', minute: '2-digit' } : {}) }).format(d);
}

export function errorMessage(error: unknown, fallback: string) {
  if (error && typeof error === 'object' && 'data' in error) {
    const data = (error as { data?: unknown }).data;
    if (data && typeof data === 'object' && 'error' in data && typeof (data as { error?: unknown }).error === 'string') return (data as { error: string }).error;
    if (typeof data === 'string' && data.trim()) return data;
  }
  if (error instanceof Error && error.message) return error.message;
  return fallback;
}

export const COUNTRIES = [
  { code: 'TG', name: 'Togo', flag: 'togo.png' },
  { code: 'BJ', name: 'Bénin', flag: 'benin.png' },
  { code: 'CI', name: 'Côte d’Ivoire', flag: 'cote-divoire.png' },
  { code: 'BF', name: 'Burkina Faso', flag: 'burkina-faso.png' },
  { code: 'SN', name: 'Sénégal', flag: 'senegal.png' },
  { code: 'ML', name: 'Mali', flag: 'mali.png' },
  { code: 'NE', name: 'Niger', flag: 'niger.png' },
];

export function countryInfo(value?: string | null) {
  if (!value) return undefined;
  const v = value.toLowerCase();
  return COUNTRIES.find(c => c.code.toLowerCase() === v || c.name.toLowerCase() === v || c.name.normalize('NFD').replace(/[\u0300-\u036f]/g, '').toLowerCase() === v.normalize('NFD').replace(/[\u0300-\u036f]/g, ''));
}

export function flagUrl(value?: string | null) {
  const c = countryInfo(value);
  return c ? `${import.meta.env.BASE_URL}countries/${c.flag}` : undefined;
}

export function useIsSuperAdmin() {
  const { data } = useGetBootstrap({ query: { queryKey: getGetBootstrapQueryKey() } });
  return data?.profile.role === 'SUPER_ADMIN';
}

export function useDebounced<T>(value: T, delay = 320) {
  const [v, setV] = useState(value);
  useEffect(() => { const t = window.setTimeout(() => setV(value), delay); return () => window.clearTimeout(t); }, [value, delay]);
  return v;
}

export type ConsoleFilters = { q?: string; status?: string; country?: string; type?: string; page?: number };

export function useConsole(section: GetAdminConsoleSection, filters: ConsoleFilters = {}) {
  const params: GetAdminConsoleParams = { section };
  if (filters.q?.trim()) params.q = filters.q.trim();
  if (filters.status) params.status = filters.status;
  if (filters.country) params.country = filters.country;
  if (filters.type) params.type = filters.type;
  if (filters.page && filters.page > 1) params.page = filters.page;
  return useGetAdminConsole(params, { query: { queryKey: getGetAdminConsoleQueryKey(params), placeholderData: keepPreviousData, retry: 1 } });
}

export function useAdminCommand() {
  const qc = useQueryClient();
  const mutation = useExecuteAdminCommand();
  const mailAttempt = useRef<{ signature: string; key: string } | null>(null);
  const { toast } = useToast();
  const run = async (data: AdminCommandInput, fallback = 'L’opération n’a pas pu être effectuée.') => {
    try {
      let request = data;
      if (['message_send', 'password_reset'].includes(data.action)) {
        const signature = JSON.stringify(data);
        if (mailAttempt.current?.signature !== signature) mailAttempt.current = { signature, key: crypto.randomUUID() };
        request = { ...data, idempotencyKey: mailAttempt.current.key };
      }
      const result = await mutation.mutateAsync({ data: request });
      if (!result.ok) throw new Error(result.message || fallback);
      mailAttempt.current = null;
      toast({ title: 'Opération enregistrée', description: result.message });
      await Promise.all([
        qc.invalidateQueries({ queryKey: getGetAdminConsoleQueryKey() }),
        qc.invalidateQueries({ queryKey: getGetBootstrapQueryKey() }),
        qc.invalidateQueries({ queryKey: getListAnnouncementsQueryKey() }),
      ]);
      return true;
    } catch (error) {
      toast({ variant: 'destructive', title: 'Échec de l’opération', description: errorMessage(error, fallback) });
      return false;
    }
  };
  return { run, pending: mutation.isPending };
}
