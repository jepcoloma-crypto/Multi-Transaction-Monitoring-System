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
