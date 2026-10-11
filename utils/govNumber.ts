/**
 * Philippine Government Number auto-dash formatting utilities.
 *
 * Official formats:
 *   SSS        : XX-XXXXXXX-X          (10 digits)
 *   Pag-IBIG   : XXXX-XXXX-XXXX        (12 digits)
 *   PhilHealth : XX-XXXXXXXXX-X        (12 digits)
 *   TIN        : XXX-XXX-XXX[-XXX]     (9–12 digits, last 3 branch code optional)
 */

export type GovNumberField = 'sss_number' | 'pagibig_number' | 'philhealth_number' | 'tin_number';

/**
 * Apply the official dash pattern for the given field as the user types.
 * Accepts a raw or already-formatted string and returns the correctly dashed version.
 */
export function formatGovNumber(field: GovNumberField, raw: string): string {
  // Strip everything except digits
  const digits = raw.replace(/\D/g, '');

  switch (field) {
    case 'sss_number': {
      // XX-XXXXXXX-X  (max 10 digits)
      const d = digits.slice(0, 10);
      if (d.length <= 2) return d;
      if (d.length <= 9) return `${d.slice(0, 2)}-${d.slice(2)}`;
      return `${d.slice(0, 2)}-${d.slice(2, 9)}-${d.slice(9)}`;
    }

    case 'pagibig_number': {
      // XXXX-XXXX-XXXX  (max 12 digits)
      const d = digits.slice(0, 12);
      if (d.length <= 4) return d;
      if (d.length <= 8) return `${d.slice(0, 4)}-${d.slice(4)}`;
      return `${d.slice(0, 4)}-${d.slice(4, 8)}-${d.slice(8)}`;
    }

    case 'philhealth_number': {
      // XX-XXXXXXXXX-X  (max 12 digits)
      const d = digits.slice(0, 12);
      if (d.length <= 2) return d;
      if (d.length <= 11) return `${d.slice(0, 2)}-${d.slice(2)}`;
      return `${d.slice(0, 2)}-${d.slice(2, 11)}-${d.slice(11)}`;
    }

    case 'tin_number': {
      // XXX-XXX-XXX[-XXX]  (9–12 digits)
      const d = digits.slice(0, 12);
      if (d.length <= 3) return d;
      if (d.length <= 6) return `${d.slice(0, 3)}-${d.slice(3)}`;
      if (d.length <= 9) return `${d.slice(0, 3)}-${d.slice(3, 6)}-${d.slice(6)}`;
      return `${d.slice(0, 3)}-${d.slice(3, 6)}-${d.slice(6, 9)}-${d.slice(9)}`;
    }

    default:
      return raw;
  }
}
