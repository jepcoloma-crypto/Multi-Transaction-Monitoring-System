export const formatCurrency = (amount: number): string => {
  const abs = Math.abs(amount);
  const formatted = abs.toLocaleString('en-PH', {
    minimumFractionDigits: 2,
    maximumFractionDigits: 2,
  });
  return amount < 0 ? `-₱${formatted}` : `₱${formatted}`;
};

export const formatNumber = (n: number): string =>
  n.toLocaleString('en-PH', { maximumFractionDigits: 0 });

// Browser-local parts, not UTC: the backend parses these naive strings as
// Asia/Manila, so toISOString() would shift every entry by the UTC offset.
export const localDateValue = (d: Date = new Date()): string => {
  const pad = (n: number): string => String(n).padStart(2, '0');
  return `${d.getFullYear()}-${pad(d.getMonth() + 1)}-${pad(d.getDate())}`;
};

export const localDateTimeValue = (d: Date = new Date()): string => {
  const pad = (n: number): string => String(n).padStart(2, '0');
  return `${localDateValue(d)}T${pad(d.getHours())}:${pad(d.getMinutes())}`;
};
