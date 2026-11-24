import type { AdminCommandInputProvider } from '@workspace/api-client-react';

export type RouteOperatorOption = {
  /** Operator name used by Mulapay's customer checkout. */
  operator: string;
  /** Exact operator identifier expected by the selected provider. */
  providerOperator: string;
};

const DRIMPAY_OPTIONS: Record<string, RouteOperatorOption[]> = {
  TG: [
    { operator: 'Mixx by Yas', providerOperator: 'tmoney' },
    { operator: 'Moov Money', providerOperator: 'moov' },
  ],
  BJ: [
    { operator: 'MTN MoMo', providerOperator: 'mtn' },
    { operator: 'Moov Money', providerOperator: 'moov' },
    { operator: 'Celtiis Money', providerOperator: 'celtiis' },
  ],
  CI: [
    { operator: 'MTN MoMo', providerOperator: 'mtn' },
    { operator: 'Orange Money', providerOperator: 'orange' },
    { operator: 'Wave', providerOperator: 'wave' },
    { operator: 'Moov Money', providerOperator: 'moov' },
  ],
  BF: [
    { operator: 'Orange Money', providerOperator: 'orange' },
    { operator: 'Moov Money', providerOperator: 'moov' },
    { operator: 'Wave', providerOperator: 'wave' },
  ],
  SN: [
    { operator: 'Orange Money', providerOperator: 'orange' },
    { operator: 'Wave', providerOperator: 'wave' },
    { operator: 'Free Money', providerOperator: 'free' },
  ],
  ML: [
    { operator: 'Orange Money', providerOperator: 'orange' },
    { operator: 'Moov Money', providerOperator: 'moov' },
  ],
};

const ASHTECHPAY_OPTIONS: Record<string, RouteOperatorOption[]> = {
  TG: [
    { operator: 'Moov Money', providerOperator: 'Moov Money' },
    { operator: 'Mixx by Yas', providerOperator: 'T-Money' },
  ],
  BJ: [
    { operator: 'Celtiis Money', providerOperator: 'Celtiis Money' },
    { operator: 'Coris Money', providerOperator: 'Coris Money' },
    { operator: 'Moov Money', providerOperator: 'Moov Money' },
    { operator: 'MTN MoMo', providerOperator: 'MTN Money' },
  ],
  CI: [
    { operator: 'Moov Money', providerOperator: 'Moov Money' },
    { operator: 'MTN MoMo', providerOperator: 'MTN Money' },
    { operator: 'Orange Money', providerOperator: 'Orange (OTP)' },
    { operator: 'Wave', providerOperator: 'Wave Money' },
  ],
  BF: [
    { operator: 'Moov Money', providerOperator: 'Moov Money' },
    { operator: 'Orange Money', providerOperator: 'Orange Money (OTP)' },
    { operator: 'Wallet LigdiCash', providerOperator: 'Wallet LigdiCash' },
  ],
  SN: [
    { operator: 'E-money', providerOperator: 'E-money' },
    { operator: 'Free Money', providerOperator: 'Free Money' },
    { operator: 'Orange Money', providerOperator: 'Orange Money (OTP)' },
    { operator: 'Wave', providerOperator: 'Wave Money' },
  ],
  ML: [
    { operator: 'Moov Money', providerOperator: 'Moov Money' },
    { operator: 'Orange Money', providerOperator: 'Orange Money' },
  ],
  NE: [
    { operator: 'Airtel Money', providerOperator: 'Airtel Money' },
  ],
};

export function routeOperatorOptions(provider: AdminCommandInputProvider, countryCode: string) {
  return (provider === 'DRIMPAY' ? DRIMPAY_OPTIONS : ASHTECHPAY_OPTIONS)[countryCode] ?? [];
}
